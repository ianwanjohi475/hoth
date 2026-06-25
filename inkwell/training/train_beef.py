"""
Inkwell — beefed-up fine-tune.

Changes vs finetune.py:
 - Stronger augmentation: affine (rotation, shift), brightness, blur, erase
 - Cosine-anneal LR schedule
 - Longer training (24 epochs)
 - Larger batch + grad clipping
 - Saves best-by-FULL after every epoch (mid-run kill keeps best)
"""
import sys, json, base64, io, time, math, numpy as np
from PIL import Image
import torch, torch.nn as nn, torch.nn.functional as F
import gen_captcha
from preprocess import preprocess
from crnn import CRNN, ALPHABET, BLANK, evaluate, export

OUT = "/home/user/hoth/inkwell/model/weights.json"
DATA = "/home/user/hoth/inkwell/data"
CHAR2IDX = {c: i for i, c in enumerate(ALPHABET)}
N_CHARS = 5
SYNTH_N = 3000
REAL_REPEAT = 4
EPOCHS = 24
BS = 256


def load_real(path):
    Xs, Ys, skipped = [], [], 0
    for s in json.load(open(path)):
        if not s.get("verified"): skipped += 1; continue
        text = (s.get("text") or "").strip()
        if len(text) != N_CHARS or any(c not in CHAR2IDX for c in text):
            skipped += 1; continue
        try:
            b = base64.b64decode(s["png"].split(",",1)[-1])
            img = Image.open(io.BytesIO(b)).convert("RGB")
        except Exception:
            skipped += 1; continue
        x = preprocess(img)
        if x is None: skipped += 1; continue
        Xs.append(x); Ys.append([CHAR2IDX[c] for c in text])
    return (np.stack(Xs).astype(np.float32),
            np.asarray(Ys, dtype=np.int64), skipped)


def make_synth(n):
    X, Y = [], []
    while len(X) < n:
        img, label, _ = gen_captcha.generate()
        x = preprocess(img)
        if x is None: continue
        X.append(x); Y.append([CHAR2IDX[c] for c in label])
    return np.stack(X).astype(np.float32), np.asarray(Y, dtype=np.int64)


def strong_augment(xb):
    """xb: B,1,40,140 in [0,1]. Returns augmented copy."""
    B = xb.shape[0]
    out = xb.clone()
    # 1) random affine (rotation ±6deg, x-shift ±4px, y-shift ±2px) via grid_sample
    theta = torch.zeros(B, 2, 3)
    ang = (torch.rand(B) - 0.5) * 0.21  # ~±6 deg in rads
    cosA = ang.cos(); sinA = ang.sin()
    tx = (torch.rand(B) - 0.5) * 0.08    # normalized x shift
    ty = (torch.rand(B) - 0.5) * 0.05
    theta[:,0,0] = cosA; theta[:,0,1] = -sinA; theta[:,0,2] = tx
    theta[:,1,0] = sinA; theta[:,1,1] =  cosA; theta[:,1,2] = ty
    grid = F.affine_grid(theta, out.size(), align_corners=False)
    out = F.grid_sample(out, grid, align_corners=False, padding_mode="zeros")
    # 2) dilate / erode (random 25% each)
    r = torch.rand(B)
    dil = r < 0.25; ero = (r >= 0.25) & (r < 0.50)
    if dil.any(): out[dil] = F.max_pool2d(out[dil], 3, stride=1, padding=1)
    if ero.any(): out[ero] = -F.max_pool2d(-out[ero], 3, stride=1, padding=1)
    # 3) random horizontal cut (mask out a vertical band — forces context use)
    for i in range(B):
        if torch.rand(1).item() < 0.15:
            w = int(torch.randint(3, 8, (1,)).item())
            x0 = int(torch.randint(0, 140-w, (1,)).item())
            out[i, 0, :, x0:x0+w] = 0
    return out.clamp(0, 1)


def main():
    if len(sys.argv) < 2:
        print("usage: python3 train_beef.py samples.json")
        sys.exit(1)
    torch.manual_seed(0); np.random.seed(0)

    Xr, Yr, skipped = load_real(sys.argv[1])
    print(f"real samples: {len(Xr)} (skipped {skipped})")
    n_val = max(1, len(Xr) // 7)
    perm = np.random.permutation(len(Xr))
    val_idx, tr_idx = perm[:n_val], perm[n_val:]
    Xrv, Yrv = Xr[val_idx], Yr[val_idx]
    Xrt, Yrt = Xr[tr_idx], Yr[tr_idx]

    print(f"generating {SYNTH_N} synthetic...")
    Xs, Ys = make_synth(SYNTH_N)
    Xr_rep = np.repeat(Xrt, REAL_REPEAT, axis=0)
    Yr_rep = np.repeat(Yrt, REAL_REPEAT, axis=0)
    Xtr = np.concatenate([Xs, Xr_rep], 0)
    Ytr = np.concatenate([Ys, Yr_rep], 0)
    print(f"train set: {len(Xtr)}")

    Xtr_t = torch.tensor(Xtr).unsqueeze(1)
    Ytr_t = torch.tensor(Ytr)
    Xrv_t = torch.tensor(Xrv).unsqueeze(1)
    Yrv_t = torch.tensor(Yrv)

    net = CRNN()
    try:
        net.load_state_dict(torch.load(f"{DATA}/crnn.pt"))
        print("warm-started from crnn.pt")
    except Exception:
        print("training fresh CRNN")

    base_lr = 1e-3
    opt = torch.optim.AdamW(net.parameters(), lr=base_lr, weight_decay=1e-4)
    ctc = nn.CTCLoss(blank=BLANK, zero_infinity=True)

    N = Xtr_t.shape[0]
    steps_per_ep = (N + BS - 1) // BS
    total_steps = steps_per_ep * EPOCHS

    t0 = time.time()
    best_full = -1.0
    step = 0
    for ep in range(EPOCHS):
        net.train(); pm = torch.randperm(N); ls = 0
        for i in range(0, N, BS):
            # Cosine LR with linear warmup over first 200 steps
            if step < 200:
                lr = base_lr * (step+1) / 200
            else:
                progress = (step - 200) / max(1, total_steps - 200)
                lr = base_lr * 0.5 * (1 + math.cos(math.pi * progress))
            for g in opt.param_groups: g["lr"] = lr

            idx = pm[i:i+BS]
            xb = strong_augment(Xtr_t[idx])
            yb = Ytr_t[idx] + 1
            B = xb.shape[0]
            logp = net(xb).log_softmax(2).permute(1, 0, 2)
            il = torch.full((B,), 35, dtype=torch.long)
            tl = torch.full((B,), yb.shape[1], dtype=torch.long)
            loss = ctc(logp, yb, il, tl)
            opt.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 5.0)
            opt.step()
            ls += loss.item() * B
            step += 1

        rc, rf = evaluate(net, Xrv_t, Yrv_t)
        mark = ""
        if rf > best_full:
            best_full = rf
            torch.save(net.state_dict(), f"{DATA}/crnn.pt")
            export(net, OUT, DATA)
            mark = "  *BEST -> saved"
        print(f"ep {ep+1:2d}  loss {ls/N:.3f}  lr {lr:.2e}  "
              f"REAL char {rc*100:.1f}%  FULL {rf*100:.1f}%  "
              f"({time.time()-t0:.0f}s){mark}", flush=True)

    print(f"\nbest held-out FULL: {best_full*100:.1f}%")


if __name__ == "__main__":
    main()
