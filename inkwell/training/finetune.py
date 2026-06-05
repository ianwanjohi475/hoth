"""
Inkwell — fine-tune the CTC model on REAL HOTH captchas.

This is the path to ~95-100% accuracy on the actual captchas (path C). It
takes the verified samples exported from the extension sidebar
(inkwell-samples-*.json) and retrains the model on a mix of:

  - the REAL captchas you collected (heavily oversampled), and
  - fresh SYNTHETIC captchas (so the model keeps its general shape knowledge
    and doesn't overfit to a few hundred real images).

Usage:
  python3 finetune.py path/to/inkwell-samples.json [more.json ...]

Each exported sample is { png: dataURL, text: "AbC12", verified: true, ... }.
Only verified samples (HOTH accepted them -> known-correct labels) are used.
The retrained model is written straight to ../model/weights.json, so you just
reload the extension afterward.
"""
import sys, json, base64, io, time, numpy as np
from PIL import Image

import torch, torch.nn as nn
import gen_captcha
from preprocess import preprocess, IN_H, IN_W
from crnn import (CRNN, ALPHABET, BLANK, greedy_decode, evaluate,
                  augment, export)

OUT = "/home/user/hoth/inkwell/model/weights.json"
DATA = "/home/user/hoth/inkwell/data"
CHAR2IDX = {c: i for i, c in enumerate(ALPHABET)}
N_CHARS = 5
SYNTH_N = 12000          # fewer synthetic so real dominates
REAL_REPEAT = 80         # heavy real weighting for small batches
EPOCHS = 18


def load_real(paths):
    """Decode exported JSON -> (X, Y) of verified real captchas."""
    Xs, Ys, skipped = [], [], 0
    for p in paths:
        samples = json.load(open(p))
        for s in samples:
            if not s.get("verified"):
                skipped += 1; continue
            text = (s.get("text") or "").strip()
            if len(text) != N_CHARS or any(c not in CHAR2IDX for c in text):
                skipped += 1; continue
            try:
                b64 = s["png"].split(",", 1)[-1]
                img = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
            except Exception:
                skipped += 1; continue
            x = preprocess(img)
            if x is None:
                skipped += 1; continue
            Xs.append(x)
            Ys.append([CHAR2IDX[c] for c in text])
    if not Xs:
        return None, None, skipped
    return (np.stack(Xs).astype(np.float32),
            np.asarray(Ys, dtype=np.int64), skipped)


def make_synth(n):
    """Fresh synthetic captchas, preprocessed the same way as real ones."""
    X, Y = [], []
    while len(X) < n:
        img, label, _gt = gen_captcha.generate()
        x = preprocess(img)
        if x is None:
            continue
        X.append(x); Y.append([CHAR2IDX[c] for c in label])
    return np.stack(X).astype(np.float32), np.asarray(Y, dtype=np.int64)


def main():
    if len(sys.argv) < 2:
        print("usage: python3 finetune.py samples1.json [samples2.json ...]")
        sys.exit(1)

    torch.manual_seed(0); np.random.seed(0)
    Xr, Yr, skipped = load_real(sys.argv[1:])
    if Xr is None:
        print(f"No usable verified samples found (skipped {skipped}). "
              f"Collect more by running autosolve on HOTH, then export again.")
        sys.exit(1)
    print(f"real samples: {len(Xr)} usable (skipped {skipped})")

    # Hold out 15% of real for an honest real-accuracy readout.
    n_val = max(1, len(Xr) // 7)
    perm = np.random.permutation(len(Xr))
    val_idx, tr_idx = perm[:n_val], perm[n_val:]
    Xrv, Yrv = Xr[val_idx], Yr[val_idx]
    Xrt, Yrt = Xr[tr_idx], Yr[tr_idx]

    print(f"generating {SYNTH_N} synthetic...")
    Xs, Ys = make_synth(SYNTH_N)

    # Oversample real so it isn't drowned by synthetic.
    Xr_rep = np.repeat(Xrt, REAL_REPEAT, axis=0)
    Yr_rep = np.repeat(Yrt, REAL_REPEAT, axis=0)
    Xtr = np.concatenate([Xs, Xr_rep], 0)
    Ytr = np.concatenate([Ys, Yr_rep], 0)
    print(f"train set: {len(Xtr)} ({len(Xs)} synth + {len(Xr_rep)} real-oversampled)")

    Xtr_t = torch.tensor(Xtr).unsqueeze(1)
    Ytr_t = torch.tensor(Ytr)
    Xrv_t = torch.tensor(Xrv).unsqueeze(1)
    Yrv_t = torch.tensor(Yrv)

    net = CRNN()
    # Warm-start from a prior CRNN checkpoint if compatible (optional).
    try:
        net.load_state_dict(torch.load(f"{DATA}/crnn.pt"))
        print("warm-started from data/crnn.pt")
    except Exception:
        print("training CRNN from scratch")

    opt = torch.optim.Adam(net.parameters(), lr=1e-3)
    sched = torch.optim.lr_scheduler.StepLR(opt, step_size=5, gamma=0.5)
    ctc = nn.CTCLoss(blank=BLANK, zero_infinity=True)
    bs, T, N = 256, 35, Xtr_t.shape[0]
    t0 = time.time()
    for ep in range(EPOCHS):
        net.train(); pm = torch.randperm(N); ls = 0
        for i in range(0, N, bs):
            idx = pm[i:i+bs]; xb = augment(Xtr_t[idx]); yb = Ytr_t[idx] + 1
            B = xb.shape[0]
            logp = net(xb).log_softmax(2).permute(1, 0, 2)
            il = torch.full((B,), T, dtype=torch.long)
            tl = torch.full((B,), yb.shape[1], dtype=torch.long)
            loss = ctc(logp, yb, il, tl)
            opt.zero_grad(); loss.backward(); opt.step(); ls += loss.item() * B
        sched.step()
        rc, rf = evaluate(net, Xrv_t, Yrv_t)
        print(f"ep {ep+1:2d}  loss {ls/N:.3f}  REAL-val char {rc*100:.1f}%  "
              f"FULL {rf*100:.1f}%  ({time.time()-t0:.0f}s)")

    torch.save(net.state_dict(), f"{DATA}/crnn.pt")  # for future warm-starts
    export(net, OUT, DATA)
    print("Done. Reload the extension to use the retrained model.")


if __name__ == "__main__":
    main()
