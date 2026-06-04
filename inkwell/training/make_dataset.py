"""
Render synthetic captchas and crop each glyph DIRECTLY from its known ink
mask (perfect labels, no segmentation noise in training). Each crop is
turned into the exact 32x32 + 3-feature representation that the runtime
segmentation also produces, so train == inference form.
"""
import sys, time, numpy as np
import gen_captcha as G
import segment as S

ALPHABET = G.ALPHABET
IDX = {c: i for i, c in enumerate(ALPHABET)}
IMG_H, IMG_W = G.IMG_H, G.IMG_W

MATCH_TOL = 13   # px: a segmented box must be within this of its GT ink centre

def build(n_captchas, out_prefix, save_samples=False):
    X, y, F = [], [], []
    used = 0
    t0 = time.time()
    samples = []
    for n in range(n_captchas):
        img, label, gt = G.generate()
        chars, scale = S.segment(np.asarray(img))
        if len(chars) != len(gt):
            continue
        gs = sorted(gt, key=lambda c: c["cx"])
        if not all(abs(chars[i]["cx"] - gs[i]["cx"]) <= MATCH_TOL
                   for i in range(len(chars))):
            continue
        max_h = max((c["y1"] - c["y0"] + 1) for c in chars)
        used += 1
        for c, g in zip(chars, gs):
            X.append(S.normalize(c, scale))
            F.append(S.features(c, max_h))
            y.append(IDX[g["ch"]])
            if save_samples and len(samples) < 60:
                samples.append((S.normalize(c, scale), g["ch"]))
        if (n + 1) % 5000 == 0:
            print(f"  {n+1}/{n_captchas}  used {used} ({100*used/(n+1):.1f}%)  "
                  f"glyphs {len(y)}  {time.time()-t0:.0f}s")
    X = np.array(X, dtype=np.float32)
    F = np.array(F, dtype=np.float32)
    y = np.array(y, dtype=np.int64)
    np.save(f"{out_prefix}_X.npy", X)
    np.save(f"{out_prefix}_F.npy", F)
    np.save(f"{out_prefix}_y.npy", y)
    print(f"CLEAN-MATCH: {used}/{n_captchas} = {100*used/n_captchas:.1f}%")
    print(f"SAVED X{X.shape} F{F.shape} -> {out_prefix}_*.npy")

    if save_samples and samples:
        from PIL import Image
        cell = S.SIZE; cols = 10
        rows = (len(samples) + cols - 1) // cols
        sheet = Image.new("L", (cols * (cell + 2), rows * (cell + 2)), 0)
        for i, (im, lab) in enumerate(samples):
            r, c = divmod(i, cols)
            sheet.paste(Image.fromarray((im * 255).astype(np.uint8)),
                        (c * (cell + 2), r * (cell + 2)))
        sheet.save("/home/user/hoth/inkwell/data/crops_preview.png")
        print("labels:", "".join(l for _, l in samples))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "validate"
    if mode == "validate":
        build(600, "/home/user/hoth/inkwell/data/val", save_samples=True)
    elif mode == "train":
        build(int(sys.argv[2]), "/home/user/hoth/inkwell/data/train")
    elif mode == "test":
        build(int(sys.argv[2]), "/home/user/hoth/inkwell/data/test")
