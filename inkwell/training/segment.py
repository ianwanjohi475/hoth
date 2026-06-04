"""
Inkwell — CAPTCHA segmentation (reference; mirrored in captcha-cnn.js).

Hue-aware connected components:
  1. strong mask : max(R,G,B) < STRONG_MAX AND (max-min) > STRONG_SAT
                   → dark saturated glyph strokes only (drops bg + pale lines).
  2. flood fill  : connect 8-neighbour strong pixels whose HUE differs by
                   < HUE_CONN. Same-hue glyph stays one blob; touching glyphs
                   of different hue split apart.
  3. filter tiny blobs; merge same-hue blobs separated by a small x-gap
     (a glyph cut by an overlaid line).
  4. order by x; normalise each glyph to 32x32 at a COMMON scale (case kept).

Used for BOTH training-data extraction and runtime so the crops match.
"""
import numpy as np
from collections import deque

SIZE       = 32
TARGET_H   = 26
STRONG_MAX = 190
STRONG_SAT = 40
HUE_CONN   = 0.045   # connect neighbours within this hue distance
MERGE_HUE  = 0.05    # merge blobs with hue closer than this ...
MERGE_GAPX = 6       # ... if their x-ranges are within this many px
MIN_PIXELS = 18
MIN_W, MIN_H = 2, 7


def _hue_img(img):
    r = img[:, :, 0].astype(np.float64)
    g = img[:, :, 1].astype(np.float64)
    b = img[:, :, 2].astype(np.float64)
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    d = mx - mn
    ds = np.where(d == 0, 1, d)
    h = np.zeros_like(mx)
    rm = mx == r
    gm = (mx == g) & (~rm)
    bm = (~rm) & (~gm)
    h[rm] = ((g[rm] - b[rm]) / ds[rm]) % 6
    h[gm] = ((b[gm] - r[gm]) / ds[gm]) + 2
    h[bm] = ((r[bm] - g[bm]) / ds[bm]) + 4
    return (h / 6.0) % 1.0


def _cdist(a, b):
    d = abs(a - b)
    return min(d, 1.0 - d)


def strong_mask(img):
    mx = img.max(axis=2); mn = img.min(axis=2)
    return (mx < STRONG_MAX) & ((mx - mn) > STRONG_SAT)


def segment(img):
    img = np.asarray(img)[:, :, :3].astype(np.uint8)
    H, W, _ = img.shape
    sm = strong_mask(img)
    hue = _hue_img(img)
    label = -np.ones((H, W), dtype=np.int32)
    label[~sm] = -2  # not-strong
    blobs = []
    NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    for sy in range(H):
        for sx in range(W):
            if label[sy, sx] != -1:
                continue
            # BFS flood fill from this strong pixel
            bid = len(blobs)
            q = deque([(sy, sx)])
            label[sy, sx] = bid
            xs0 = xs1 = sx; ys0 = ys1 = sy; cnt = 0; hsum = 0.0
            pts = []
            while q:
                y, x = q.popleft()
                cnt += 1; hsum += hue[y, x]; pts.append((y, x))
                if x < xs0: xs0 = x
                if x > xs1: xs1 = x
                if y < ys0: ys0 = y
                if y > ys1: ys1 = y
                hh = hue[y, x]
                for dy, dx in NB:
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < H and 0 <= nx < W and label[ny, nx] == -1:
                        if _cdist(hue[ny, nx], hh) < HUE_CONN:
                            label[ny, nx] = bid
                            q.append((ny, nx))
            blobs.append({"x0": xs0, "x1": xs1, "y0": ys0, "y1": ys1,
                          "n": cnt, "hue": hsum / cnt, "pts": pts})

    # filter tiny
    blobs = [b for b in blobs if b["n"] >= MIN_PIXELS
             and (b["x1"] - b["x0"] + 1) >= MIN_W and (b["y1"] - b["y0"] + 1) >= MIN_H]
    blobs.sort(key=lambda b: (b["x0"] + b["x1"]) / 2.0)

    # merge same-hue blobs separated by a small x gap (glyph split by a line)
    merged = []
    for b in blobs:
        if merged:
            m = merged[-1]
            gap = b["x0"] - m["x1"]
            if gap <= MERGE_GAPX and _cdist(b["hue"], m["hue"]) < MERGE_HUE:
                m["x0"] = min(m["x0"], b["x0"]); m["x1"] = max(m["x1"], b["x1"])
                m["y0"] = min(m["y0"], b["y0"]); m["y1"] = max(m["y1"], b["y1"])
                m["n"] += b["n"]; m["pts"] += b["pts"]
                m["hue"] = (m["hue"] + b["hue"]) / 2
                continue
        merged.append(dict(b))

    chars = []
    for b in merged:
        mask = np.zeros((H, W), dtype=bool)
        for (y, x) in b["pts"]:
            mask[y, x] = True
        chars.append({"x0": b["x0"], "y0": b["y0"], "x1": b["x1"], "y1": b["y1"],
                      "cx": (b["x0"] + b["x1"]) / 2.0, "mask": mask})
    if not chars:
        return [], 1.0
    max_h = max((c["y1"] - c["y0"] + 1) for c in chars)
    return chars, TARGET_H / max_h


def features(char, max_h):
    bw = char["x1"] - char["x0"] + 1
    bh = char["y1"] - char["y0"] + 1
    relH = bh / max_h if max_h else 1.0
    aspect = bw / bh if bh else 1.0
    fill = float(char["mask"][char["y0"]:char["y1"] + 1,
                              char["x0"]:char["x1"] + 1].mean())
    return [relH, min(aspect, 2.0), fill]


def normalize(char, scale):
    x0, y0, x1, y1 = char["x0"], char["y0"], char["x1"], char["y1"]
    sub = char["mask"][y0:y1 + 1, x0:x1 + 1].astype(np.float32)
    h, w = sub.shape
    nh = max(1, int(round(h * scale)))
    nw = max(1, int(round(w * scale)))
    yi = (np.arange(nh) / scale).astype(np.int32).clip(0, h - 1)
    xi = (np.arange(nw) / scale).astype(np.int32).clip(0, w - 1)
    rs = sub[yi][:, xi]
    if nw > SIZE: rs = rs[:, :SIZE]; nw = SIZE
    if nh > SIZE: rs = rs[:SIZE, :]; nh = SIZE
    out = np.zeros((SIZE, SIZE), dtype=np.float32)
    ox = (SIZE - nw) // 2; oy = (SIZE - nh) // 2
    out[oy:oy + nh, ox:ox + nw] = rs
    return out
