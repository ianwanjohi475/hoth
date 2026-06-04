"""
Inkwell — whole-captcha preprocessing (mirrored in captcha-cnn.js).

No segmentation. We binarise the captcha to a glyph mask (drops the light
background and pale decoration lines), crop to the content, and resize to a
fixed IN_H x IN_W grayscale image that the multi-head CNN reads in one shot.

Binary input makes synthetic and real look the same (colour/luminance are
normalised away), so the model transfers.
"""
import numpy as np

IN_H, IN_W = 40, 140
STRONG_MAX = 195
STRONG_SAT = 35
COL_THR = 1          # min strong px in a column/row to count as content


def strong_mask(img):
    img = np.asarray(img)[:, :, :3]
    mx = img.max(axis=2); mn = img.min(axis=2)
    return ((mx < STRONG_MAX) & ((mx.astype(np.int32) - mn) > STRONG_SAT))


def _content_box(sm):
    cols = sm.sum(axis=0); rows = sm.sum(axis=1)
    xs = np.where(cols >= COL_THR)[0]
    ys = np.where(rows >= COL_THR)[0]
    if len(xs) == 0 or len(ys) == 0:
        return None
    return int(xs[0]), int(ys[0]), int(xs[-1]), int(ys[-1])


def _pool_matrix(n_in, n_out):
    """Row/col box-average pooling matrix using integer bin edges
    a=o*n_in//n_out .. b — identical boundaries to the JS loop version."""
    M = np.zeros((n_out, n_in), dtype=np.float32)
    for o in range(n_out):
        a = o * n_in // n_out
        b = max(a + 1, (o + 1) * n_in // n_out)
        M[o, a:b] = 1.0 / (b - a)
    return M


def _resize_box(mask, out_h, out_w):
    """Area-average resize of a binary mask -> float [0,1]. Vectorised; gives
    the same values as the per-pixel box average mirrored in JS."""
    h, w = mask.shape
    Rh = _pool_matrix(h, out_h)     # out_h x h
    Cw = _pool_matrix(w, out_w)     # out_w x w
    return (Rh @ mask.astype(np.float32) @ Cw.T).astype(np.float32)


def preprocess(img):
    """RGB image -> (IN_H, IN_W) float32 in [0,1]. Returns None if blank."""
    sm = strong_mask(img)
    box = _content_box(sm)
    if box is None:
        return None
    x0, y0, x1, y1 = box
    crop = sm[y0:y1 + 1, x0:x1 + 1]
    # pad to keep a little margin (helps edge glyphs)
    crop = np.pad(crop, ((2, 2), (3, 3)), mode="constant")
    return _resize_box(crop, IN_H, IN_W)
