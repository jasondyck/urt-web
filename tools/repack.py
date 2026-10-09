#!/usr/bin/env python3
"""Repack Urban Terror 4.3 pk3s into smaller web packs.

- merges every pk3 in the engine's priority order (later pk3 names override earlier)
- textures -> lossy WebP q85 (alpha kept); the engine falls back from a missing
  .tga/.jpg to .webp on its own. At equal SSIM WebP is ~31% smaller than JPEG and
  far better than palette PNG for alpha textures (tools/imgbench.py).
- .wav -> .ogg (Vorbis; the engine falls back from a missing .wav to .ogg)
- drops bot navigation (.aas), docs, and low-detail model LODs (_1/_2.md3)
- splits assets used by only one map into that map's pack; everything else goes
  into the core pack. Maps not listed are dropped along with their exclusive assets.

usage: repack.py SRC_Q3UT4_DIR OUT_DIR map1 map2 ...   (or 'all')
Writes OUT_DIR/q3ut4/*.pk3 and OUT_DIR/manifest.json.
"""
import concurrent.futures as cf
import hashlib
import io
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import zipfile
from collections import defaultdict

from PIL import Image

WEBP_QUALITY = 85
VORBIS_QUALITY = "3"
DROP_EXT = {".aas", ".doc"}  # .txt must stay: UrT menus are ui/*.txt
# Only assets under these prefixes may move into a map pack; anything else
# (weapons, players, UI, gfx) could be used by game code, so it stays in core.
MAP_PREFIXES = ("textures/", "env/", "maps/", "levelshots/", "models/mapobjects/", "sound/")
IMAGE_EXTS = (".tga", ".jpg", ".png")
# Browser mouse input runs faster than the desktop game's, so start players at a
# lower sensitivity and give the menu slider a range where 50% is still usable
# (stock: default 5 on a 1-30 slider). A saved config still wins over default.cfg.
SENSITIVITY_SLIDER = (b'cvarfloat "sensitivity" 5 1 30', b'cvarfloat "sensitivity" 2.5 0.5 10')
TEXT_PATCHES = {
    "ui/controls.menu": [SENSITIVITY_SLIDER],
    "ui/ingame_controls.menu": [SENSITIVITY_SLIDER],
    "default.cfg": [(b'seta in_mouse "-1"', b'seta in_mouse "-1"\r\nseta sensitivity "2.5"')],
}


def pk3_priority(name):
    # FS_AddGameDirectory sorts pk3 names and searches the last one first
    return name.lower()


def load_merged(src):
    files = {}  # lower path -> (pk3 path, member name)
    for pk3 in sorted((f for f in os.listdir(src) if f.lower().endswith(".pk3")), key=pk3_priority):
        with zipfile.ZipFile(os.path.join(src, pk3)) as z:
            for info in z.infolist():
                if info.is_dir():
                    continue
                files[info.filename.lower()] = (os.path.join(src, pk3), info.filename)
    return files


def read(files, key):
    pk3, member = files[key]
    with zipfile.ZipFile(pk3) as z:
        return z.read(member)


def strip_ext(p):
    return os.path.splitext(p)[0]


# --- dependency discovery -------------------------------------------------

def parse_shaders(files):
    """shader name -> set of referenced image paths (as written, lowercased)."""
    shaders = {}
    tok = re.compile(r'"[^"]*"|\{|\}|[^\s{}]+')
    for key in files:
        if not (key.startswith("scripts/") and key.endswith(".shader")):
            continue
        text = read(files, key).decode("latin1")
        text = re.sub(r"//[^\n]*", "", text)
        toks = [t.strip('"').lower() for t in tok.findall(text)]
        i, depth, name, refs = 0, 0, None, set()
        while i < len(toks):
            t = toks[i]
            if t == "{":
                depth += 1
            elif t == "}":
                depth -= 1
                if depth == 0 and name:
                    shaders.setdefault(name, set()).update(refs)
                    name, refs = None, set()
            elif depth == 0:
                name = t
            elif t in ("map", "clampmap") and i + 1 < len(toks):
                refs.add(toks[i + 1])
            elif t == "animmap" and i + 1 < len(toks):
                j = i + 2
                while j < len(toks) and toks[j] not in ("{", "}") and "/" in toks[j]:
                    refs.add(toks[j])
                    j += 1
            elif t == "skyparms" and i + 1 < len(toks):
                base = toks[i + 1]
                if base != "-":
                    for side in ("rt", "lf", "ft", "bk", "up", "dn"):
                        refs.add(f"{base}_{side}")
            elif t in ("qer_editorimage", "q3map_lightimage"):
                i += 1  # editor/compiler only
            i += 1
    return shaders


def resolve_image(files, ref):
    base = strip_ext(ref)
    return {base + e for e in IMAGE_EXTS if base + e in files}


def md3_shaders(data):
    out = set()
    if data[:4] != b"IDP3":
        return out
    num_surfaces, ofs_surfaces = struct.unpack_from("<i", data, 84)[0], struct.unpack_from("<i", data, 100)[0]
    ofs = ofs_surfaces
    for _ in range(num_surfaces):
        if ofs + 108 > len(data):
            break
        num_shaders, ofs_shaders = struct.unpack_from("<i", data, ofs + 76)[0], struct.unpack_from("<i", data, ofs + 92)[0]
        for s in range(num_shaders):
            raw = data[ofs + ofs_shaders + s * 68: ofs + ofs_shaders + s * 68 + 64]
            out.add(raw.split(b"\0")[0].decode("latin1").lower())
        ofs += struct.unpack_from("<i", data, ofs + 104)[0]
    return out


def shader_closure(files, shaders, names):
    out = set()
    for n in names:
        n = strip_ext(n.lower())
        if n in shaders:
            for r in shaders[n]:
                out |= resolve_image(files, r)
        out |= resolve_image(files, n)
    return out


def map_refs(files, shaders, bsp_key):
    data = read(files, bsp_key)
    lumps = [struct.unpack_from("<ii", data, 8 + i * 8) for i in range(17)]
    mapname = os.path.basename(strip_ext(bsp_key))
    refs = {k for k in files if k.startswith(f"maps/{mapname}.") or k.startswith(f"maps/{mapname}/")
            or k.startswith(f"levelshots/{mapname}.")}
    so, sl = lumps[1]
    names = {data[so + i * 72: so + i * 72 + 64].split(b"\0")[0].decode("latin1") for i in range(sl // 72)}
    eo, el = lumps[0]
    ents = data[eo: eo + el].decode("latin1", "replace")
    for k, v in re.findall(r'"(model2?|noise|music|_remap|shader)"\s+"([^"]+)"', ents, re.I):
        v = v.lower().replace("\\", "/")
        if k.lower() in ("model", "model2") and v.endswith(".md3") and v in files:
            refs.add(v)
            names |= md3_shaders(read(files, v))
        elif k.lower() in ("noise", "music"):
            for e in (".wav", ".ogg"):
                if strip_ext(v) + e in files:
                    refs.add(strip_ext(v) + e)
        elif k.lower() in ("_remap", "shader"):
            names.add(v.split(";")[-1])
    refs |= shader_closure(files, shaders, names)
    return mapname, refs


# --- re-encoding -----------------------------------------------------------

def convert(job):
    key, data, may_rename = job
    ext = os.path.splitext(key)[1]
    for a, b in TEXT_PATCHES.get(key, []):
        if a not in data:
            raise ValueError(f"{key}: patch target not found: {a!r}")
        data = data.replace(a, b)
    if not may_rename:
        return key, data
    try:
        if ext in (".tga", ".jpg", ".png"):
            im = Image.open(io.BytesIO(data))
            im.load()
            has_alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
            im = im.convert("RGBA" if has_alpha else "RGB")
            if has_alpha and im.getchannel("A").getextrema()[0] == 255:
                im = im.convert("RGB")
            # exact: keep the colour under fully transparent pixels. Shaders that blend
            # by colour ignore alpha (the sniper scope is RGB art with alpha all 0), and
            # the encoder would otherwise black it out.
            exact = im.mode == "RGBA"
            buf = io.BytesIO()
            im.save(buf, "WEBP", quality=WEBP_QUALITY, method=6, exact=exact)
            best = buf.getvalue()
            if im.width * im.height <= 64 * 64:  # tiny/flat images often compress better losslessly
                buf = io.BytesIO()
                im.save(buf, "WEBP", lossless=True, method=6, exact=exact)
                if len(buf.getvalue()) < len(best):
                    best = buf.getvalue()
            # re-encoding an already lossy jpg only pays off if it shrinks a lot
            if ext == ".tga" or len(best) < 0.8 * len(data):
                return strip_ext(key) + ".webp", best
            return key, data
        if ext == ".wav":
            with tempfile.TemporaryDirectory() as d:
                src, dst = os.path.join(d, "in.wav"), os.path.join(d, "out.ogg")
                open(src, "wb").write(data)
                r = subprocess.run(["ffmpeg", "-v", "error", "-i", src, "-c:a", "libvorbis", "-q:a", VORBIS_QUALITY, dst],
                                   capture_output=True)
                if r.returncode == 0 and os.path.getsize(dst) < len(data):
                    return strip_ext(key) + ".ogg", open(dst, "rb").read()
            return key, data
    except Exception as e:  # keep the original on any decode/encode problem
        print(f"keeping {key}: {e}", file=sys.stderr)
    return key, data


def may_rename(files, key):
    """A converted file may only take a name nothing else already uses."""
    base, ext = os.path.splitext(key)
    if re.fullmatch(r"maps/[^/]+\.tga", key):
        return False  # minimaps: cgame checks for maps/<map>.tga by exact name
    if ext in IMAGE_EXTS:
        # only when this is the sole image with that base name, or two would map to one .webp
        return sum(base + e in files for e in IMAGE_EXTS + (".webp",)) == 1
    if ext == ".wav":
        return base + ".ogg" not in files
    return False


def zlib_size_hint(data):
    import zlib
    return zlib.compress(data, 6)


def main():
    src, out, *maps = sys.argv[1:]
    files = load_merged(src)
    files = {k: v for k, v in files.items() if os.path.splitext(k)[1] not in DROP_EXT}
    # Low-detail model LODs (foo_1.md3, foo_2.md3) are 37 MB, almost all player
    # animation frames; the engine renders LOD 0 at every distance without them.
    files = {k: v for k, v in files.items() if not re.search(r"_[12]\.md3$", k)}
    print(f"{len(files)} merged files")

    shaders = parse_shaders(files)
    all_maps = sorted(strip_ext(os.path.basename(k)) for k in files if k.startswith("maps/") and k.endswith(".bsp"))
    if maps == ["all"]:
        maps = all_maps
    unknown = set(maps) - set(all_maps)
    if unknown:
        sys.exit(f"unknown maps: {sorted(unknown)}; have {all_maps}")

    users = defaultdict(set)
    for m in all_maps:
        _, refs = map_refs(files, shaders, f"maps/{m}.bsp")
        for r in refs:
            users[r].add(m)

    packs = defaultdict(list)  # pack name -> keys
    for k in files:
        u = users.get(k, set())
        if len(u) == 1 and k.startswith(MAP_PREFIXES):
            (m,) = u
            if m in maps:
                packs[m].append(k)
            # else: exclusive to a dropped map
        else:
            packs["core"].append(k)

    os.makedirs(os.path.join(out, "q3ut4"), exist_ok=True)
    manifest = {"maps": maps, "packs": []}
    with cf.ProcessPoolExecutor() as ex:
        for name in ["core"] + maps:
            keys = sorted(packs[name])
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
                jobs = ((k, read(files, k), may_rename(files, k)) for k in keys)
                for newkey, data in ex.map(convert, jobs, chunksize=8):
                    stored = os.path.splitext(newkey)[1] in (".jpg", ".png", ".ogg", ".webp")
                    z.writestr(newkey, data, zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED)
            blob = buf.getvalue()
            h = hashlib.sha256(blob).hexdigest()[:12]
            fname = f"{'z' if name == 'core' else 'm'}_{name}-{h}.pk3"
            open(os.path.join(out, "q3ut4", fname), "wb").write(blob)
            manifest["packs"].append({"name": name, "file": f"q3ut4/{fname}", "size": len(blob), "files": len(keys)})
            print(f"{fname}: {len(keys)} files, {len(blob) / 1e6:.1f} MB", flush=True)
    json.dump(manifest, open(os.path.join(out, "manifest.json"), "w"), indent=1)
    total = sum(p["size"] for p in manifest["packs"])
    print(f"total {total / 1e6:.0f} MB for {len(maps)} maps")


if __name__ == "__main__":
    main()
