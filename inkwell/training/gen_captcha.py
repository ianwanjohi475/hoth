"""
Inkwell — synthetic HOTH-style CAPTCHA generator.

Produces 5-character captchas that mimic thehoth.com/writer:
  - light-gray background
  - each character a distinct vivid (saturated, fairly dark) colour
  - serif font, bold-ish, slight per-character rotation + vertical jitter
  - characters sized by case (capitals tall, lowercase short)
  - thin pastel wavy decoration lines crossing the whole image

The point of matching the real style closely is that a model trained on
these generalises to the real captchas (path A — synthetic only).
"""
import random, math
from PIL import Image, ImageDraw, ImageFont

# Character set: digits + upper + lower = 62 classes
ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSerif.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSerifBold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
]

IMG_W, IMG_H = 230, 70
BG = (237, 237, 237)
N_CHARS = 5

# HOTH-like palette: dark, saturated colours that repeat across characters.
PALETTE = [
    (40, 40, 130),    # navy
    (30, 90, 40),     # dark green
    (110, 100, 25),   # olive
    (120, 30, 35),    # maroon
    (95, 35, 110),    # purple
    (25, 95, 100),    # teal
    (110, 60, 25),    # brown
    (60, 60, 60),     # near-black grey
    (150, 35, 80),    # magenta-ish
]

def _vivid_color():
    """A saturated, DARK colour like HOTH's character colours.
    Kept dark (low value) so a simple brightness threshold cleanly
    separates glyph strokes from the pale decoration lines."""
    h = random.random()
    s = random.uniform(0.55, 1.0)
    v = random.uniform(0.40, 0.68)          # dark → max channel <= ~173
    return _hsv_to_rgb(h, s, v)

def _pastel_color():
    """A LIGHT decoration-line colour, brighter than any glyph so the
    brightness threshold drops it."""
    h = random.random()
    s = random.uniform(0.20, 0.55)
    v = random.uniform(0.80, 0.96)          # light → max channel >= ~204
    return _hsv_to_rgb(h, s, v)

def _hsv_to_rgb(h, s, v):
    i = int(h * 6); f = h * 6 - i
    p = v * (1 - s); q = v * (1 - f * s); t = v * (1 - (1 - f) * s)
    i %= 6
    r, g, b = [(v,t,p),(q,v,p),(p,v,t),(p,q,v),(t,p,v),(v,p,q)][i]
    return (int(r*255), int(g*255), int(b*255))

def _draw_wavy_line(draw, color):
    """A thin wavy line across the width, like HOTH decoration. Colour is
    chosen by the caller; some are dark enough to survive binarisation so
    the model learns to ignore thin line strokes."""
    y0 = random.uniform(10, IMG_H - 10)
    amp = random.uniform(3, 9)
    period = random.uniform(40, 110)
    phase = random.uniform(0, 6.28)
    pts = []
    x = 0
    while x <= IMG_W:
        y = y0 + amp * math.sin((x / period) * 6.28 + phase)
        pts.append((x, y))
        x += 3
    draw.line(pts, fill=color, width=random.choice([1, 1, 2]))

def _line_color():
    # 70% pale (removed by binarisation), 30% darker/saturated (survives)
    return _pastel_color() if random.random() < 0.7 else random.choice(PALETTE)

def generate():
    """Return (PIL.Image RGB, label string of length N_CHARS)."""
    img = Image.new("RGB", (IMG_W, IMG_H), BG)

    chars = [random.choice(ALPHABET) for _ in range(N_CHARS)]
    gt = []   # ground-truth [{ch, cx}] for clean label assignment downstream

    # decoration lines UNDER the characters
    d = ImageDraw.Draw(img)
    for _ in range(random.randint(1, 3)):
        _draw_wavy_line(d, _line_color())

    # place characters left to right with slight overlap + jitter
    x = random.uniform(8, 16)
    base_size = random.randint(38, 46)
    for ci, ch in enumerate(chars):
        font = ImageFont.truetype(random.choice(FONTS), base_size)
        # render glyph on its own transparent layer so we can rotate it
        tmp = Image.new("RGBA", (base_size * 2, base_size * 2), (0, 0, 0, 0))
        td = ImageDraw.Draw(tmp)
        # HOTH reuses a small palette — colours REPEAT and adjacent letters
        # often share one. Pick each char's colour independently from the
        # palette so the model/segmenter learn to handle same-colour neighbours.
        col = random.choice(PALETTE)
        td.text((base_size * 0.5, base_size * 0.3), ch, font=font, fill=col + (255,))
        bbox = tmp.getbbox()
        if bbox is None:
            continue
        glyph = tmp.crop(bbox)
        # modest scale jitter (keep case size cue intact)
        sf = random.uniform(0.92, 1.10)
        glyph = glyph.resize((max(1, int(glyph.width * sf)),
                              max(1, int(glyph.height * sf))), Image.LANCZOS)
        # rotation
        ang = random.uniform(-16, 16)
        glyph = glyph.rotate(ang, expand=True, resample=Image.BICUBIC)
        # vertical position with jitter
        iy = int(random.uniform(6, IMG_H - glyph.height - 6))
        px = int(x)
        img.paste(glyph, (px, iy), glyph)
        # record the glyph's exact ink mask + bbox in full-image coords, so
        # training can crop perfectly-labelled glyphs without segmenting.
        gb = glyph.getbbox()
        if gb:
            alpha = glyph.split()[-1]
            import numpy as _np
            am = (_np.asarray(alpha) > 128)
            gx0, gy0, gx1, gy1 = gb[0], gb[1], gb[2] - 1, gb[3] - 1
            local = am[gy0:gy1 + 1, gx0:gx1 + 1]
            gt.append({"ch": ch,
                       "x0": px + gx0, "y0": iy + gy0,
                       "x1": px + gx1, "y1": iy + gy1,
                       "cx": px + (gx0 + gx1) / 2.0,
                       "local": local})
        # advance x — like HOTH: mostly small GAPS between letters, only
        # occasionally just touching. Less overlap => fewer same-colour
        # merges => cleaner segmentation.
        x += glyph.width * random.uniform(0.99, 1.18)

    # a decoration line OVER the characters sometimes
    if random.random() < 0.6:
        d = ImageDraw.Draw(img)
        _draw_wavy_line(d, _line_color())

    label = "".join(c["ch"] for c in gt)
    return img, label, gt


if __name__ == "__main__":
    import os
    os.makedirs("/home/user/hoth/inkwell/data/samples", exist_ok=True)
    for i in range(12):
        im, lab, _ = generate()
        im.save(f"/home/user/hoth/inkwell/data/samples/{i:02d}_{lab}.png")
    # also a contact sheet
    sheet = Image.new("RGB", (IMG_W, IMG_H * 12 + 11), (255, 255, 255))
    for i in range(12):
        im, lab, _ = generate()
        sheet.paste(im, (0, i * (IMG_H + 1)))
    sheet.save("/home/user/hoth/inkwell/data/sample_sheet.png")
    print("wrote samples to data/samples and data/sample_sheet.png")
