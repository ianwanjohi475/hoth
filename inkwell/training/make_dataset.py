"""Whole-image dataset: each sample is the preprocessed captcha + its 5
character labels. No segmentation, so labels are always perfectly correct."""
import sys, time, numpy as np
import gen_captcha as G
import preprocess as P

ALPHABET = G.ALPHABET
IDX = {c: i for i, c in enumerate(ALPHABET)}

def build(n, out_prefix, save_preview=False):
    X = np.zeros((n, P.IN_H, P.IN_W), dtype=np.float32)
    Y = np.zeros((n, G.N_CHARS), dtype=np.int64)
    k = 0; t0 = time.time(); previews = []
    while k < n:
        img, label, gt = G.generate()
        if len(label) != G.N_CHARS:
            continue
        x = P.preprocess(img)
        if x is None:
            continue
        X[k] = x
        Y[k] = [IDX[c] for c in label]
        if save_preview and len(previews) < 18:
            previews.append((x, label))
        k += 1
        if k % 5000 == 0:
            print(f"  {k}/{n}  {time.time()-t0:.0f}s")
    np.save(f"{out_prefix}_X.npy", X)
    np.save(f"{out_prefix}_Y.npy", Y)
    print(f"SAVED X{X.shape} Y{Y.shape} -> {out_prefix}_*.npy")
    if save_preview:
        from PIL import Image
        H, W = P.IN_H, P.IN_W
        sheet = Image.new("L", (W, (H + 3) * len(previews)), 0)
        for i, (x, lab) in enumerate(previews):
            sheet.paste(Image.fromarray((x * 255).astype(np.uint8)), (0, i * (H + 3)))
        sheet.save("/home/user/hoth/inkwell/data/pre_preview.png")
        print("preview labels:", " ".join(l for _, l in previews))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "validate"
    if mode == "validate":
        build(40, "/home/user/hoth/inkwell/data/val", save_preview=True)
    elif mode == "train":
        build(int(sys.argv[2]), "/home/user/hoth/inkwell/data/train")
    elif mode == "test":
        build(int(sys.argv[2]), "/home/user/hoth/inkwell/data/test")
