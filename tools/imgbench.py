#!/usr/bin/env python3
"""Compare texture encodings on a sample of UrT .tga textures: total size and SSIM.

usage: imgbench.py SRC_Q3UT4_DIR [sample_size]
"""
import io
import random
import sys
import zipfile
import glob
import os

import numpy as np
from PIL import Image


def ssim(a, b):
    """Mean SSIM over 8x8 blocks of the luminance (and alpha, if any)."""
    def lum(im):
        x = np.asarray(im.convert("RGBA"), dtype=np.float64)
        # weight colour by alpha: colour under fully transparent pixels is invisible
        y = (0.299 * x[..., 0] + 0.587 * x[..., 1] + 0.114 * x[..., 2]) * (x[..., 3] / 255.0)
        return [y, x[..., 3]]
    scores = []
    for x, y in zip(lum(a), lum(b)):
        h, w = (x.shape[0] // 8) * 8, (x.shape[1] // 8) * 8
        if h == 0 or w == 0:
            return 1.0
        x = x[:h, :w].reshape(h // 8, 8, w // 8, 8).swapaxes(1, 2).reshape(-1, 64)
        y = y[:h, :w].reshape(h // 8, 8, w // 8, 8).swapaxes(1, 2).reshape(-1, 64)
        mx, my = x.mean(1), y.mean(1)
        vx, vy = x.var(1), y.var(1)
        cov = ((x - mx[:, None]) * (y - my[:, None])).mean(1)
        c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
        s = ((2 * mx * my + c1) * (2 * cov + c2)) / ((mx ** 2 + my ** 2 + c1) * (vx + vy + c2))
        scores.append(s.mean())
    return float(min(scores))


def enc(im, fmt, **kw):
    buf = io.BytesIO()
    im.save(buf, fmt, **kw)
    data = buf.getvalue()
    return len(data), Image.open(io.BytesIO(data)).convert("RGBA")


def main():
    src = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 300
    files = {}
    for pk3 in sorted(glob.glob(os.path.join(src, "*.pk3")), key=str.lower):
        z = zipfile.ZipFile(pk3)
        for name in z.namelist():
            if name.lower().endswith(".tga"):
                files[name.lower()] = (pk3, name)
    random.seed(1)
    keys = random.sample(sorted(files), min(n, len(files)))

    opaque = {}
    alpha = {}
    for k in keys:
        pk3, name = files[k]
        try:
            im = Image.open(io.BytesIO(zipfile.ZipFile(pk3).read(name)))
            im.load()
        except Exception:
            continue
        a = im.mode in ("RGBA", "LA") and im.getchannel("A").getextrema()[0] < 255
        (alpha if a else opaque)[k] = im.convert("RGBA" if a else "RGB")

    def run(group, variants):
        print(flush=True)
        print(f"{len(group)} textures, {sum(i.width * i.height for i in group.values()) / 1e6:.1f} Mpx")
        for label, fn in variants:
            total, worst, scores = 0, 1.0, []
            for im in group.values():
                size, out = fn(im)
                s = ssim(im, out)
                total += size
                scores.append(s)
                worst = min(worst, s)
            print(f"  {label:28} {total / 1e6:7.2f} MB   mean SSIM {np.mean(scores):.4f}  worst {worst:.4f}", flush=True)

    which = sys.argv[3] if len(sys.argv) > 3 else "both"
    if which in ("both", "opaque"):
        run(opaque, [
            ("jpg q88 (current)", lambda im: enc(im, "JPEG", quality=88, optimize=True)),
            ("webp q85", lambda im: enc(im, "WEBP", quality=85, method=6)),
            ("webp q90", lambda im: enc(im, "WEBP", quality=90, method=6)),
            ("avif q60", lambda im: enc(im, "AVIF", quality=60, speed=6)),
            ("avif q70", lambda im: enc(im, "AVIF", quality=70, speed=6)),
        ])
    if which in ("both", "alpha"):
        run(alpha, [
            ("png palette (current)", lambda im: enc(im.quantize(256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE), "PNG", optimize=True)),
            ("png lossless", lambda im: enc(im, "PNG", optimize=True)),
            ("webp lossless", lambda im: enc(im, "WEBP", lossless=True, method=6)),
            ("webp q85 + alpha", lambda im: enc(im, "WEBP", quality=85, method=6)),
            ("webp q90 + alpha", lambda im: enc(im, "WEBP", quality=90, method=6)),
            ("webp q90 + alpha exact", lambda im: enc(im, "WEBP", quality=90, method=6, exact=True)),
            ("avif q70 + alpha", lambda im: enc(im, "AVIF", quality=70, speed=6)),
        ])


def half(im, fmt, **kw):
    small = im.resize((max(1, im.width // 2), max(1, im.height // 2)), Image.Resampling.LANCZOS)
    size, out = enc(small, fmt, **kw)
    return size, out.resize(im.size, Image.Resampling.BILINEAR)


if __name__ == "__main__":
    main()
