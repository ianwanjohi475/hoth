"""
Inkwell — CAPTCHA segmentation (reference; mirrored in captcha-cnn.js).

Real HOTH reuses a small colour palette, so adjacent characters often share
a colour. Colour alone therefore cannot COUNT the characters. Since HOTH
always has exactly N=5, we:

  1. strong mask  : dark + saturated glyph pixels (drops bg + pale lines).
  2. hue flood    : connect 8-neighbour strong pixels within HUE_CONN
                    → cleanly splits DIFFERENT-colour neighbours.
  3. force to N   : if too few blobs (same-colour neighbours merged), split
                    the widest blob at its thinnest vertical seam; if too
                    many (a glyph split by a line), merge the closest pair.
  4. order by x; normalise each glyph to 32x32 at a COMMON scale (case kept)
     + 3 size features.
"""
import numpy as np
from collections import deque

SIZE       = 32
TARGET_H   = 26
STRONG_MAX = 190
STRONG_SAT = 40
HUE_CONN   = 0.045
MIN_PIXELS = 12
MIN_W, MIN_H = 2, 7
EXPECTED   = 5      # HOTH always has 5 characters


def _hue_img(img):
    r = img[:, :, 0].astype(np.float64); g = img[:, :, 1].astype(np.float64); b = img[:, :, 2].astype(np.float64)
    mx = np.maximum(np.maximum(r, g), b); mn = np.minimum(np.minimum(r, g), b)
    d = mx - mn; ds = np.where(d == 0, 1, d)
    h = np.zeros_like(mx)
    rm = mx == r; gm = (mx == g) & (~rm); bm = (~rm) & (~gm)
    h[rm] = ((g[rm] - b[rm]) / ds[rm]) % 6
    h[gm] = ((b[gm] - r[gm]) / ds[gm]) + 2
    h[bm] = ((r[bm] - g[bm]) / ds[bm]) + 4
    return (h / 6.0) % 1.0


def _cd(a, b):
    d = abs(a - b); return min(d, 1.0 - d)


def strong_mask(img):
    mx = img.max(axis=2); mn = img.min(axis=2)
    return (mx < STRONG_MAX) & ((mx - mn) > STRONG_SAT)


def _bbox(pts):
    xs = [p[1] for p in pts]; ys = [p[0] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def _coldens(pts, x0, x1):
    w = x1 - x0 + 1
    col = np.zeros(w, dtype=np.float64)
    for (y, x) in pts:
        col[x - x0] += 1
    if w >= 5:                      # light smoothing
        col = np.convolve(np.pad(col, 2, mode="edge"), np.ones(5) / 5, mode="valid")
    return col


def _split_blob(b, k):
    """Split one blob into k pieces at k-1 density valleys near even positions."""
    if k <= 1:
        return [b]
    x0, x1, pts = b["x0"], b["x1"], b["pts"]
    w = x1 - x0 + 1
    col = _coldens(pts, x0, x1)
    cuts = []
    for j in range(1, k):
        e = w * j / k
        w0 = max(1, int(e - w * 0.16)); w1 = min(w - 1, int(e + w * 0.16))
        if w1 <= w0:
            cuts.append(x0 + int(round(e)))
        else:
            cuts.append(x0 + w0 + int(np.argmin(col[w0:w1 + 1])))
    cuts = sorted(set(cuts))
    bounds = [x0 - 1] + cuts + [x1]
    pieces = []
    for i in range(len(bounds) - 1):
        xa, xb = bounds[i] + 1, bounds[i + 1]
        sub = [p for p in pts if xa <= p[1] <= xb]
        if len(sub) >= MIN_PIXELS:
            sx0, sy0, sx1, sy1 = _bbox(sub)
            pieces.append({"x0": sx0, "y0": sy0, "x1": sx1, "y1": sy1, "pts": sub})
    return pieces if pieces else [b]


def _merge_closest(blobs):
    gi = min(range(len(blobs) - 1), key=lambda i: blobs[i + 1]["x0"] - blobs[i]["x1"])
    a, b = blobs[gi], blobs[gi + 1]
    pts = a["pts"] + b["pts"]; x0, y0, x1, y1 = _bbox(pts)
    blobs[gi] = {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "pts": pts}
    del blobs[gi + 1]


def _merge_xoverlap(blobs):
    """Merge blobs whose x-ranges strongly overlap — these are parts of the
    SAME character (an i/j dot above its stem, or a glyph cut by a line)."""
    changed = True
    while changed:
        changed = False
        for i in range(len(blobs)):
            for j in range(i + 1, len(blobs)):
                a, b = blobs[i], blobs[j]
                ov = min(a["x1"], b["x1"]) - max(a["x0"], b["x0"]) + 1
                minw = min(a["x1"] - a["x0"] + 1, b["x1"] - b["x0"] + 1)
                if ov >= 0.55 * minw:
                    pts = a["pts"] + b["pts"]; x0, y0, x1, y1 = _bbox(pts)
                    blobs[i] = {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "pts": pts}
                    del blobs[j]
                    changed = True
                    break
            if changed:
                break
    return blobs


def segment(img, expected=EXPECTED):
    """Hue-aware connected components, then distribute `expected` characters
    across the blobs by width (a double-wide blob = two merged same-colour
    glyphs → split it at the density valley)."""
    img = np.asarray(img)[:, :, :3].astype(np.uint8)
    H, W, _ = img.shape
    sm = strong_mask(img); hue = _hue_img(img)
    label = -np.ones((H, W), dtype=np.int32); label[~sm] = -2
    NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    blobs = []
    for sy in range(H):
        for sx in range(W):
            if label[sy, sx] != -1:
                continue
            bid = len(blobs); q = deque([(sy, sx)]); label[sy, sx] = bid; pts = []
            while q:
                y, x = q.popleft(); pts.append((y, x)); hh = hue[y, x]
                for dy, dx in NB:
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < H and 0 <= nx < W and label[ny, nx] == -1 and _cd(hue[ny, nx], hh) < HUE_CONN:
                        label[ny, nx] = bid; q.append((ny, nx))
            x0, y0, x1, y1 = _bbox(pts)
            blobs.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "pts": pts})

    # keep blobs with enough pixels (a glyph dot can be small but real, so
    # only drop truly tiny specks here; the width/height filter comes after
    # x-overlap merging so dots aren't discarded for being short).
    blobs = [b for b in blobs if len(b["pts"]) >= 6]
    blobs.sort(key=lambda b: (b["x0"] + b["x1"]) / 2.0)
    if not blobs:
        return [], 1.0

    blobs = _merge_xoverlap(blobs)
    blobs = [b for b in blobs if len(b["pts"]) >= MIN_PIXELS
             and (b["x1"] - b["x0"] + 1) >= MIN_W and (b["y1"] - b["y0"] + 1) >= MIN_H]
    blobs.sort(key=lambda b: (b["x0"] + b["x1"]) / 2.0)
    if not blobs:
        return [], 1.0

    if expected:
        while len(blobs) > expected:
            _merge_closest(blobs)
        if len(blobs) < expected:
            # distribute the extra splits to the widest-per-current-count blobs
            kk = [1] * len(blobs)
            widths = [b["x1"] - b["x0"] + 1 for b in blobs]
            for _ in range(expected - len(blobs)):
                j = max(range(len(blobs)), key=lambda i: widths[i] / kk[i])
                kk[j] += 1
            new = []
            for b, k in zip(blobs, kk):
                new.extend(_split_blob(b, k))
            blobs = new
            blobs.sort(key=lambda b: (b["x0"] + b["x1"]) / 2.0)

    chars = []
    for b in blobs:
        mask = np.zeros((H, W), dtype=bool)
        for (y, x) in b["pts"]:
            mask[y, x] = True
        chars.append({"x0": b["x0"], "y0": b["y0"], "x1": b["x1"], "y1": b["y1"],
                      "cx": (b["x0"] + b["x1"]) / 2.0, "mask": mask})
    max_h = max((c["y1"] - c["y0"] + 1) for c in chars)
    return chars, TARGET_H / max_h


def features(char, max_h):
    bw = char["x1"] - char["x0"] + 1; bh = char["y1"] - char["y0"] + 1
    relH = bh / max_h if max_h else 1.0
    aspect = bw / bh if bh else 1.0
    fill = float(char["mask"][char["y0"]:char["y1"] + 1, char["x0"]:char["x1"] + 1].mean())
    return [relH, min(aspect, 2.0), fill]


def normalize(char, scale):
    x0, y0, x1, y1 = char["x0"], char["y0"], char["x1"], char["y1"]
    sub = char["mask"][y0:y1 + 1, x0:x1 + 1].astype(np.float32)
    h, w = sub.shape
    nh = max(1, int(round(h * scale))); nw = max(1, int(round(w * scale)))
    yi = (np.arange(nh) / scale).astype(np.int32).clip(0, h - 1)
    xi = (np.arange(nw) / scale).astype(np.int32).clip(0, w - 1)
    rs = sub[yi][:, xi]
    if nw > SIZE: rs = rs[:, :SIZE]; nw = SIZE
    if nh > SIZE: rs = rs[:SIZE, :]; nh = SIZE
    out = np.zeros((SIZE, SIZE), dtype=np.float32)
    ox = (SIZE - nw) // 2; oy = (SIZE - nh) // 2
    out[oy:oy + nh, ox:ox + nw] = rs
    return out
