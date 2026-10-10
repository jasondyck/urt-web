#!/usr/bin/env python3
"""Fill the game-data volume: download Urban Terror 4.3.4 from the official
site, verify it, repack the maps in the mapcycle for the browser, and keep the
dedicated server binary. Runs in the urt-web-setup container before the gateway
starts; does nothing if the volume already matches the mapcycle.

usage: setup-data.py DATA_DIR MAPCYCLE
Leaves DATA_DIR/manifest.json, DATA_DIR/q3ut4/*.pk3 and DATA_DIR/Quake3-UrT-Ded.x86_64.
The download is kept in DATA_DIR/.download for later map changes unless
URT_KEEP_DOWNLOAD=0.
"""
import hashlib
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

URL = "https://cdn.urbanterror.info/urt/43/releases/zips/UrbanTerror434_full.zip"
SHA256 = "716669cc6c525663b791852e51ff9c94d96f382be39279dab6084dddacb5a4e7"
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_BIN = "Quake3-UrT-Ded.x86_64"


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(dst):
    if os.path.exists(dst) and sha256(dst) == SHA256:
        return
    print(f"downloading {URL} (1.4 GB)", flush=True)
    part = dst + ".part"
    # the CDN refuses Python's default User-Agent
    req = urllib.request.Request(URL, headers={"User-Agent": "urt-web-setup/1.0"})
    with urllib.request.urlopen(req) as r, open(part, "wb") as f:
        total, done, shown = int(r.headers.get("Content-Length") or 0), 0, -1
        while chunk := r.read(1 << 20):
            f.write(chunk)
            done += len(chunk)
            if total and (pct := 100 * done // total) // 10 != shown:
                shown = pct // 10
                print(f"  {pct}%", flush=True)
    if sha256(part) != SHA256:
        os.remove(part)
        sys.exit("download failed its checksum; not using it")
    os.replace(part, dst)


def main():
    data, mapcycle = sys.argv[1:]
    maps = [m.strip() for m in open(mapcycle) if m.strip()]
    if not maps:
        sys.exit(f"{mapcycle} lists no maps")
    # redo the repack when the maps or the repacker change
    stamp = hashlib.sha256(("\n".join(maps) + open(os.path.join(HERE, "repack.py"), "rb").read().hex()).encode()).hexdigest()
    stamp_file = os.path.join(data, ".stamp")
    if os.path.exists(stamp_file) and open(stamp_file).read() == stamp and os.path.exists(os.path.join(data, SERVER_BIN)):
        print(f"game data is up to date ({', '.join(maps)})")
        return

    dl = os.path.join(data, ".download")
    os.makedirs(dl, exist_ok=True)
    zip_path = os.path.join(dl, "UrbanTerror434_full.zip")
    download(zip_path)

    work = os.path.join(data, ".work")
    shutil.rmtree(work, ignore_errors=True)
    print("unpacking", flush=True)
    z = zipfile.ZipFile(zip_path)
    z.extractall(work, [n for n in z.namelist()
                        if n.endswith(".pk3") and "/q3ut4/" in n or n.endswith("/" + SERVER_BIN)])
    src = os.path.join(work, "UrbanTerror43")

    print(f"repacking for the browser: {', '.join(maps)}", flush=True)
    out = os.path.join(work, "out")
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "repack.py"), os.path.join(src, "q3ut4"), out, *maps], check=True)

    # replace the previous packs (the gateway starts only after this container finishes)
    shutil.rmtree(os.path.join(data, "q3ut4"), ignore_errors=True)
    os.replace(os.path.join(out, "q3ut4"), os.path.join(data, "q3ut4"))
    os.replace(os.path.join(out, "manifest.json"), os.path.join(data, "manifest.json"))
    shutil.copy(os.path.join(src, SERVER_BIN), os.path.join(data, SERVER_BIN))
    os.chmod(os.path.join(data, SERVER_BIN), 0o755)
    shutil.rmtree(work)
    if os.environ.get("URT_KEEP_DOWNLOAD", "1") == "0":
        shutil.rmtree(dl)
    open(stamp_file, "w").write(stamp)
    print("game data ready")


if __name__ == "__main__":
    main()
