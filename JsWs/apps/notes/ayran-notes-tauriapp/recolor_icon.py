"""
Recolors the ayran glass from white/light-gray to golden while preserving
shading, highlights, and the orange background.

Strategy:
- Convert each pixel to HSL.
- Pixels that are "glass" have very low saturation (near-grey/white) and
  relatively high lightness (>= 0.45).  The orange background has high
  saturation and hue in the red-orange range, so it is easily excluded.
- For qualifying glass pixels, replace the hue with the target golden hue,
  boost saturation to ~0.65, and keep the original lightness so that the
  existing shading/highlights remain intact.
"""

from PIL import Image
import colorsys, os, subprocess, sys

ICONS_DIR = r"f:\T\ayran\JsWs\apps\notes\ayran-notes-tauriapp\desktop\src-tauri\icons"
SRC = os.path.join(ICONS_DIR, "icon.png")
DST = os.path.join(ICONS_DIR, "icon.png")          # overwrite in-place

# Golden target hue (degrees 0-360) and saturation.
GOLD_HUE = 42 / 360.0   # ~42° — warm gold
GOLD_SAT = 0.80

def recolor(src_path, dst_path):
    img = Image.open(src_path).convert("RGBA")
    pixels = img.load()
    w, h = img.size

    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if a < 20:
                continue   # transparent — skip

            # Normalise to 0-1
            rf, gf, bf = r / 255.0, g / 255.0, b / 255.0
            # colorsys.rgb_to_hls returns (hue, LIGHTNESS, SATURATION)
            hue, lit, sat = colorsys.rgb_to_hls(rf, gf, bf)

            # Detect "glass" pixels:
            #  - low saturation  → not the vivid orange background
            #  - lightness >= 0.30 → not the very dark rim/shadow areas
            is_glass = (sat < 0.22) and (lit >= 0.30)

            if is_glass:
                # Compress the lightness range so even the brightest glass pixels
                # retain a visible golden tint.
                # Original [0.30, 1.0] → mapped [0.45, 0.78] keeps gold visible.
                mapped_lit = 0.35 + lit * 0.43
                new_r, new_g, new_b = colorsys.hls_to_rgb(GOLD_HUE, mapped_lit, GOLD_SAT)
                pixels[x, y] = (
                    int(new_r * 255),
                    int(new_g * 255),
                    int(new_b * 255),
                    a,
                )

    img.save(dst_path, "PNG")
    print(f"Saved: {dst_path}")

recolor(SRC, DST)
