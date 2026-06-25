"""
Inkwell v2 training — loss-filtered clean data + bigger model.

Improvements over train_beef.py:
 1. Loss-based label cleaning: run epoch-1 model, drop top-N% highest-CTC-loss
    samples (most likely mislabeled). Retrain from scratch on clean subset.
 2. Wider CRNN: HID=256 (was 128), adds depth to catch case ambiguity.
 3. Curriculum: first 5 epochs on easy (low-loss) samples, then full set.
 4. Even stronger augmentation: noise, brightness jitter, contrast jitter.
 5. Cosine LR with warmup, AdamW, grad-clip=5.
 6. 30 epochs total.
"""
import sys, json, base64, io, time, math, numpy as np
from PIL import Image
import torch, torch.nn as nn, torch.nn.functional as F
import gen_captcha
from preprocess import preprocess
from crnn import CRNN, ALPHABET, BLANK, greedy_decode, evaluate, export

OUT = "/home/user/hoth/inkwell/model/weights.json"
DATA = "/home/user/hoth/inkwell/data"
CHAR2IDX = {c: i for i, c in enumerate(ALPHABET)}
N_CHARS = 5
SYNTH_N = 5000
REAL_REPEAT = 8
EPOCHS = 30
BS = 256
DROP_TOP_LOSS_PCT = 0.20   # drop top 20% highest-loss samples as likely mislabeled
CURRICULUM_EPOCHS = 6      # first N epochs: train only on bottom-50% loss samples


# ── wider CRNN ─────────────────────────────────────────────────────────────
HID2 = 256

class CRNNWide(nn.Module):
    """Same topology as CRNN but HID=256 and an extra conv layer."""
    def __init__(self):
        super().__init__()
        self.c1 = nn.Conv2d(1,   64,  3, padding=1); self.b1 = nn.BatchNorm2d(64)
        self.c2 = nn.Conv2d(64,  128, 3, padding=1); self.b2 = nn.BatchNorm2d(128)
        self.c3 = nn.Conv2d(128, 256, 3, padding=1); self.b3 = nn.BatchNorm2d(256)
        self.c4 = nn.Conv2d(256, 256, 3, padding=1); self.b4 = nn.BatchNorm2d(256)
        self.c5 = nn.Conv2d(256, 256, 3, padding=1); self.b5 = nn.BatchNorm2d(256)
        self.lstm = nn.LSTM(256, HID2, batch_first=True, bidirectional=True)
        self.head = nn.Linear(2 * HID2, len(ALPHABET) + 1)

    def forward(self, x):
        x = F.max_pool2d(F.relu(self.b1(self.c1(x))), (2, 2))   # 20x70
        x = F.max_pool2d(F.relu(self.b2(self.c2(x))), (2, 2))   # 10x35
        x = F.max_pool2d(F.relu(self.b3(self.c3(x))), (2, 1))   # 5x35
        # extra conv at same resolution before final pool
        x = F.relu(self.b4(self.c4(x)))                          # 5x35
        x = F.relu(self.b5(self.c5(x)))                          # 5x35
        x = F.max_pool2d(x, (5, 1))                              # 1x35
        B, C, _, T = x.shape
        x = x.squeeze(2).permute(0, 2, 1)                        # B,T,256
        x, _ = self.lstm(x)                                       # B,T,512
        return self.head(x)                                       # B,T,63

    def eval_decode(self, xb):
        logits = self.forward(xb)
        return greedy_decode(logits)


def _fold_wide(net, out_path, data_dir):
    """Export wide CRNN to JSON (adapted from crnn.export)."""
    import os
    net.eval()
    eps = 1e-5
    def a(t): return np.asarray(t.detach().cpu(), np.float32).round(6).tolist()

    def fold(conv, bn):
        w = conv.weight.detach().clone()
        b = conv.bias.detach().clone() if conv.bias is not None else torch.zeros(w.shape[0])
        sc = bn.weight.detach() / torch.sqrt(bn.running_var.detach() + eps)
        w = w * sc.view(-1, 1, 1, 1)
        b = (b - bn.running_mean.detach()) * sc + bn.bias.detach()
        return w, b

    layers = {}
    for k, bn in [("c1", net.b1), ("c2", net.b2), ("c3", net.b3),
                  ("c4", net.b4), ("c5", net.b5)]:
        w, b = fold(getattr(net, k), bn)
        layers[k] = {"w": a(w), "b": a(b)}
    layers["head"] = {"w": a(net.head.weight), "b": a(net.head.bias)}
    L = net.lstm
    lstm = {
        "wf_ih": a(L.weight_ih_l0), "wf_hh": a(L.weight_hh_l0),
        "bf_ih": a(L.bias_ih_l0),   "bf_hh": a(L.bias_hh_l0),
        "wb_ih": a(L.weight_ih_l0_reverse), "wb_hh": a(L.weight_hh_l0_reverse),
        "bb_ih": a(L.bias_ih_l0_reverse),   "bb_hh": a(L.bias_hh_l0_reverse),
    }
    blob = {"alphabet": ALPHABET, "in_h": 40, "in_w": 140, "ncls": len(ALPHABET),
            "T": 35, "hid": HID2, "ctc": True, "arch": "crnn_wide",
            "layers": layers, "lstm": lstm}
    json.dump(blob, open(out_path, "w"))
    print(f"exported {out_path} ({os.path.getsize(out_path)/1024/1024:.1f} MB)")
    Xp = torch.tensor(np.load(f"{data_dir}/test_X.npy")[:6]).unsqueeze(1)
    with torch.no_grad():
        lg = net(Xp).numpy()
    json.dump({"inputs": Xp.squeeze(1).numpy().round(4).tolist(),
               "logits": lg.round(4).tolist()},
              open(f"{data_dir}/parity.json", "w"))
    print("wrote parity.json")


# ── augmentation ───────────────────────────────────────────────────────────
def strong_augment(xb):
    B = xb.shape[0]
    out = xb.clone()
    # affine
    ang = (torch.rand(B) - 0.5) * 0.21
    tx  = (torch.rand(B) - 0.5) * 0.08
    ty  = (torch.rand(B) - 0.5) * 0.05
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
    # brightness + contrast jitter
    bright = (torch.rand(B, 1, 1, 1) - 0.5) * 0.3
    contrast = torch.rand(B, 1, 1, 1) * 0.6 + 0.7  # 0.7-1.3
    out = (out + bright) * contrast
    # random vertical cut
    for i in range(B):
        if torch.rand(1).item() < 0.15:
            w = int(torch.randint(3, 8, (1,)).item())
            x0 = int(torch.randint(0, 140-w, (1,)).item())
            out[i, 0, :, x0:x0+w] = 0
    # gaussian noise
    out = out + torch.randn_like(out) * 0.03
    return out.clamp(0, 1)


# ── data loading ───────────────────────────────────────────────────────────
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


# ── per-sample loss computation ────────────────────────────────────────────
def compute_losses(net, Xt, Yt):
    """Return per-sample CTC loss array (no reduction)."""
    ctc = nn.CTCLoss(blank=BLANK, zero_infinity=True, reduction='none')
    net.eval(); losses = []
    with torch.no_grad():
        for i in range(0, Xt.shape[0], BS):
            xb = Xt[i:i+BS]; yb = Yt[i:i+BS] + 1; B = xb.shape[0]
            logp = net(xb).log_softmax(2).permute(1, 0, 2)
            il = torch.full((B,), 35, dtype=torch.long)
            tl = torch.full((B,), N_CHARS, dtype=torch.long)
            ls = ctc(logp, yb, il, tl)
            losses.extend(ls.cpu().numpy().tolist())
    return np.array(losses)


# ── training loop ──────────────────────────────────────────────────────────
def train_loop(net, Xtr_t, Ytr_t, Xrv_t, Yrv_t, save_path, out_path, data_dir,
               epochs=EPOCHS, curriculum_thresh=None):
    base_lr = 1e-3
    opt = torch.optim.AdamW(net.parameters(), lr=base_lr, weight_decay=1e-4)
    ctc = nn.CTCLoss(blank=BLANK, zero_infinity=True)
    N = Xtr_t.shape[0]
    steps_per_ep = (N + BS - 1) // BS
    total_steps = steps_per_ep * epochs
    t0 = time.time(); best_full = -1.0; step = 0

    for ep in range(epochs):
        # Curriculum: for first CURRICULUM_EPOCHS, use only easy half
        if curriculum_thresh is not None and ep < CURRICULUM_EPOCHS:
            use_mask = curriculum_thresh
            X_ep = Xtr_t[use_mask]; Y_ep = Ytr_t[use_mask]
        else:
            X_ep = Xtr_t; Y_ep = Ytr_t
        N_ep = X_ep.shape[0]

        net.train(); pm = torch.randperm(N_ep); ls = 0
        for i in range(0, N_ep, BS):
            if step < 400:
                lr = base_lr * (step+1) / 400
            else:
                progress = (step - 400) / max(1, total_steps - 400)
                lr = base_lr * 0.5 * (1 + math.cos(math.pi * progress))
            for g in opt.param_groups: g["lr"] = lr

            idx = pm[i:i+BS]
            xb = strong_augment(X_ep[idx]); yb = Y_ep[idx] + 1; B = xb.shape[0]
            logp = net(xb).log_softmax(2).permute(1, 0, 2)
            il = torch.full((B,), 35, dtype=torch.long)
            tl = torch.full((B,), N_CHARS, dtype=torch.long)
            loss = ctc(logp, yb, il, tl)
            opt.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 5.0)
            opt.step(); ls += loss.item() * B; step += 1

        rc, rf = evaluate(net, Xrv_t, Yrv_t)
        mark = ""
        if rf > best_full:
            best_full = rf
            torch.save(net.state_dict(), save_path)
            _fold_wide(net, out_path, data_dir)
            mark = "  *BEST"
        print(f"ep {ep+1:2d}  loss {ls/N_ep:.3f}  lr {lr:.2e}  "
              f"char {rc*100:.1f}%  FULL {rf*100:.1f}%  "
              f"({time.time()-t0:.0f}s){mark}", flush=True)
    return best_full


def main():
    if len(sys.argv) < 2:
        print("usage: python3 train_v2.py samples.json")
        sys.exit(1)
    torch.manual_seed(42); np.random.seed(42)

    Xr, Yr, skipped = load_real(sys.argv[1])
    print(f"real samples: {len(Xr)} (skipped {skipped})")
    n_val = max(1, len(Xr) // 7)
    perm = np.random.permutation(len(Xr))
    val_idx, tr_idx = perm[:n_val], perm[n_val:]
    Xrv, Yrv = Xr[val_idx], Yr[val_idx]
    Xrt, Yrt = Xr[tr_idx], Yr[tr_idx]

    # ── Phase 0: compute per-sample losses with the EXISTING checkpoint ──
    print(f"\n=== Phase 0: loss-based label cleaning ===")
    scout = CRNN()
    try:
        scout.load_state_dict(torch.load(f"{DATA}/crnn.pt"))
        print("loaded existing checkpoint for loss computation")
    except Exception:
        print("no checkpoint found — skipping loss filter (will train on all data)")
        scout = None

    Xrt_t = torch.tensor(Xrt).unsqueeze(1)
    Yrt_t = torch.tensor(Yrt)

    if scout is not None:
        raw_losses = compute_losses(scout, Xrt_t, Yrt_t)
        threshold = np.percentile(raw_losses, (1 - DROP_TOP_LOSS_PCT) * 100)
        clean_mask = raw_losses < threshold
        n_clean = clean_mask.sum()
        print(f"loss threshold (p{int((1-DROP_TOP_LOSS_PCT)*100)}): {threshold:.3f}")
        print(f"keeping {n_clean}/{len(Xrt)} real-train samples ({n_clean/len(Xrt)*100:.1f}%)")
        Xrt_clean = Xrt[clean_mask]; Yrt_clean = Yrt[clean_mask]
        # curriculum mask: bottom 50% loss = easiest
        easy_thresh = np.percentile(raw_losses[clean_mask], 50)
        easy_mask_idx = np.where(clean_mask)[0][raw_losses[clean_mask] < easy_thresh]
        # convert to boolean mask over Xrt_clean indices
        curriculum_bool = raw_losses[clean_mask] < easy_thresh
    else:
        Xrt_clean = Xrt; Yrt_clean = Yrt; curriculum_bool = None

    # ── Phase 1: train wide CRNN from scratch on cleaned data ──
    print(f"\n=== Phase 1: generating {SYNTH_N} synthetic ===")
    Xs, Ys = make_synth(SYNTH_N)
    Xr_rep = np.repeat(Xrt_clean, REAL_REPEAT, axis=0)
    Yr_rep = np.repeat(Yrt_clean, REAL_REPEAT, axis=0)
    Xtr = np.concatenate([Xs, Xr_rep], 0)
    Ytr = np.concatenate([Ys, Yr_rep], 0)
    print(f"train set: {len(Xtr)} ({len(Xs)} synth + {len(Xr_rep)} clean-real)")

    Xtr_t = torch.tensor(Xtr).unsqueeze(1)
    Ytr_t = torch.tensor(Ytr)
    Xrv_t = torch.tensor(Xrv).unsqueeze(1)
    Yrv_t = torch.tensor(Yrv)

    # Build curriculum mask on the full training tensor
    # synth samples are always "easy" for curriculum phase
    n_synth = len(Xs); n_rep = len(Xr_rep)
    if curriculum_bool is not None:
        cur_real = np.repeat(curriculum_bool, REAL_REPEAT, axis=0)
        cur_mask = np.concatenate([np.ones(n_synth, dtype=bool), cur_real], 0)
        cur_mask_t = torch.tensor(cur_mask)
    else:
        cur_mask_t = None

    print(f"\n=== Phase 1: training wide CRNN ({EPOCHS} epochs) ===")
    net = CRNNWide()
    best = train_loop(net, Xtr_t, Ytr_t, Xrv_t, Yrv_t,
                      f"{DATA}/crnn_wide.pt", OUT, DATA,
                      epochs=EPOCHS, curriculum_thresh=cur_mask_t)
    print(f"\nbest held-out FULL: {best*100:.1f}%")


if __name__ == "__main__":
    main()
