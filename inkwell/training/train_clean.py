"""
Inkwell — clean-data training.

Uses pre-computed per-sample CTC losses (sample_losses.npy) to drop the
noisiest 25% of training samples, then retrains the standard CRNN with:
 - More synthetic data (8k)
 - Higher real-sample repeat (10x)
 - Strong augmentation (affine, dilate/erode, brightness, noise, cuts)
 - 40 epochs with cosine LR + warmup
 - Grad clipping, AdamW
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
SYNTH_N = 8000
REAL_REPEAT = 10
EPOCHS = 40
BS = 256
LOSS_KEEP_PCT = 0.75   # keep bottom 75% by CTC loss (drop noisiest 25%)


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
    B = xb.shape[0]
    out = xb.clone()
    # affine (rotation ±6°, x/y shift)
    ang = (torch.rand(B) - 0.5) * 0.21
    tx  = (torch.rand(B) - 0.5) * 0.10
    ty  = (torch.rand(B) - 0.5) * 0.06
    theta = torch.zeros(B, 2, 3)
    theta[:,0,0] = ang.cos(); theta[:,0,1] = -ang.sin(); theta[:,0,2] = tx
    theta[:,1,0] = ang.sin(); theta[:,1,1] =  ang.cos(); theta[:,1,2] = ty
    grid = F.affine_grid(theta, out.size(), align_corners=False)
    out = F.grid_sample(out, grid, align_corners=False, padding_mode="zeros")
    # dilate / erode
    r = torch.rand(B)
    dil = r < 0.25; ero = (r >= 0.25) & (r < 0.50)
    if dil.any(): out[dil] = F.max_pool2d(out[dil], 3, stride=1, padding=1)
    if ero.any(): out[ero] = -F.max_pool2d(-out[ero], 3, stride=1, padding=1)
    # brightness & contrast
    out = out + (torch.rand(B, 1, 1, 1) - 0.5) * 0.3
    out = out * (torch.rand(B, 1, 1, 1) * 0.6 + 0.7)
    # vertical cut (15% chance)
    for i in range(B):
        if torch.rand(1).item() < 0.15:
            w = int(torch.randint(3, 10, (1,)).item())
            x0 = int(torch.randint(0, 140-w, (1,)).item())
            out[i, 0, :, x0:x0+w] = 0
    # Gaussian noise
    out = out + torch.randn_like(out) * 0.03
    return out.clamp(0, 1)


def main():
    if len(sys.argv) < 2:
        print("usage: python3 train_clean.py samples.json")
        sys.exit(1)
    torch.manual_seed(42); np.random.seed(42)

    print("Loading real samples...")
    Xr, Yr, skipped = load_real(sys.argv[1])
    print(f"real samples: {len(Xr)} (skipped {skipped})")

    n_val = max(1, len(Xr) // 7)
    perm = np.random.permutation(len(Xr))
    val_idx, tr_idx = perm[:n_val], perm[n_val:]
    Xrv, Yrv = Xr[val_idx], Yr[val_idx]
    Xrt, Yrt = Xr[tr_idx], Yr[tr_idx]

    # Load pre-computed losses (from compute_losses.py or loss analysis)
    losses_path = f"{DATA}/sample_losses.npy"
    try:
        all_losses = np.load(losses_path)
        print(f"Loaded per-sample losses from {losses_path}")
        # Align losses to training split (losses were computed on full dataset order)
        # We need to re-sort: loads losses[i] corresponds to data[i] before split
        # Since perm was applied after loading, tr_idx maps to the original positions
        tr_losses = all_losses[tr_idx]
        threshold = np.percentile(tr_losses, LOSS_KEEP_PCT * 100)
        keep_mask = tr_losses <= threshold
        Xrt_clean = Xrt[keep_mask]; Yrt_clean = Yrt[keep_mask]
        n_dropped = (~keep_mask).sum()
        print(f"Loss threshold (p{int(LOSS_KEEP_PCT*100)}): {threshold:.3f}")
        print(f"Kept {keep_mask.sum()} / {len(tr_idx)} real-train samples ({keep_mask.mean()*100:.1f}%)")
        print(f"Dropped {n_dropped} high-loss samples (likely mislabeled)")
    except Exception as e:
        print(f"Warning: could not load losses ({e}), using all training samples")
        Xrt_clean, Yrt_clean = Xrt, Yrt

    print(f"\nGenerating {SYNTH_N} synthetic captchas...")
    Xs, Ys = make_synth(SYNTH_N)

    Xr_rep = np.repeat(Xrt_clean, REAL_REPEAT, axis=0)
    Yr_rep = np.repeat(Yrt_clean, REAL_REPEAT, axis=0)
    Xtr = np.concatenate([Xs, Xr_rep], 0)
    Ytr = np.concatenate([Ys, Yr_rep], 0)
    print(f"Train set: {len(Xtr)} ({len(Xs)} synth + {len(Xr_rep)} clean-real-oversampled)")

    Xtr_t = torch.tensor(Xtr).unsqueeze(1)
    Ytr_t = torch.tensor(Ytr)
    Xrv_t = torch.tensor(Xrv).unsqueeze(1)
    Yrv_t = torch.tensor(Yrv)

    net = CRNN()
    print("Training fresh CRNN (no warm-start)")

    base_lr = 1e-3
    opt = torch.optim.AdamW(net.parameters(), lr=base_lr, weight_decay=1e-4)
    ctc = nn.CTCLoss(blank=BLANK, zero_infinity=True)
    N = Xtr_t.shape[0]
    steps_per_ep = (N + BS - 1) // BS
    total_steps = steps_per_ep * EPOCHS
    t0 = time.time(); best_full = -1.0; step = 0

    for ep in range(EPOCHS):
        net.train(); pm = torch.randperm(N); ls = 0
        for i in range(0, N, BS):
            # cosine LR with linear warmup over first 500 steps
            if step < 500:
                lr = base_lr * (step + 1) / 500
            else:
                progress = (step - 500) / max(1, total_steps - 500)
                lr = base_lr * 0.5 * (1 + math.cos(math.pi * progress))
            for g in opt.param_groups: g["lr"] = lr

            idx = pm[i:i+BS]
            xb = strong_augment(Xtr_t[idx]); yb = Ytr_t[idx] + 1; B = xb.shape[0]
            logp = net(xb).log_softmax(2).permute(1, 0, 2)
            il = torch.full((B,), 35, dtype=torch.long)
            tl = torch.full((B,), yb.shape[1], dtype=torch.long)
            loss = ctc(logp, yb, il, tl)
            opt.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 5.0)
            opt.step(); ls += loss.item() * B; step += 1

        rc, rf = evaluate(net, Xrv_t, Yrv_t)
        mark = ""
        if rf > best_full:
            best_full = rf
            torch.save(net.state_dict(), f"{DATA}/crnn.pt")
            export(net, OUT, DATA)
            mark = "  *BEST -> saved"
        print(f"ep {ep+1:2d}/{EPOCHS}  loss {ls/N:.3f}  lr {lr:.2e}  "
              f"char {rc*100:.1f}%  FULL {rf*100:.1f}%  "
              f"({time.time()-t0:.0f}s){mark}", flush=True)

    print(f"\nbest held-out FULL: {best_full*100:.1f}%")


if __name__ == "__main__":
    main()
