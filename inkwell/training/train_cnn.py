"""
CTC CNN: reads the whole preprocessed captcha (1 x 40 x 140) as a left-to-
right sequence and uses CTC to align it to the 5 characters. No fixed output
positions, no segmentation — handles variable character widths/positions.

  in 1x40x140
  c1 3x3 (1->32)  bn relu  pool(2,2) -> 20x70
  c2 3x3 (32->64) bn relu  pool(2,2) -> 10x35
  c3 3x3 (64->96) bn relu  pool(2,1) -> 5x35
  c4 3x3 (96->96) bn relu  pool(5,1) -> 1x35
  per-column linear 96 -> 63  (62 classes + CTC blank=0)  => T=35 timesteps
"""
import json, time, numpy as np, torch, torch.nn as nn, torch.nn.functional as F

ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
NCLS = 62
BLANK = 0                         # CTC blank token index
DATA = "/home/user/hoth/inkwell/data"
OUT = "/home/user/hoth/inkwell/model/weights.json"
torch.manual_seed(0); np.random.seed(0)


class Net(nn.Module):
    def __init__(self):
        super().__init__()
        self.c1 = nn.Conv2d(1, 32, 3, padding=1); self.b1 = nn.BatchNorm2d(32)
        self.c2 = nn.Conv2d(32, 64, 3, padding=1); self.b2 = nn.BatchNorm2d(64)
        self.c3 = nn.Conv2d(64, 96, 3, padding=1); self.b3 = nn.BatchNorm2d(96)
        self.c4 = nn.Conv2d(96, 96, 3, padding=1); self.b4 = nn.BatchNorm2d(96)
        self.head = nn.Linear(96, NCLS + 1)        # +1 blank
    def features(self, x):
        x = F.max_pool2d(F.relu(self.b1(self.c1(x))), (2, 2))   # 20x70
        x = F.max_pool2d(F.relu(self.b2(self.c2(x))), (2, 2))   # 10x35
        x = F.max_pool2d(F.relu(self.b3(self.c3(x))), (2, 1))   # 5x35
        x = F.max_pool2d(F.relu(self.b4(self.c4(x))), (5, 1))   # 1x35
        return x  # B,96,1,35
    def forward(self, x):
        f = self.features(x)                  # B,96,1,35
        B, C, _, T = f.shape
        f = f.squeeze(2).permute(0, 2, 1)     # B,T,C
        return self.head(f)                   # B,T,63


def greedy_decode(logits):
    """logits: B,T,63 -> list of decoded strings (collapse repeats, drop blank)."""
    idx = logits.argmax(2).cpu().numpy()      # B,T
    outs = []
    for row in idx:
        s = []; prev = -1
        for t in row:
            if t != prev and t != BLANK:
                s.append(ALPHABET[t - 1])
            prev = t
        outs.append("".join(s))
    return outs


def augment(xb):
    out = xb.clone(); n = xb.shape[0]; r = torch.rand(n)
    dil = r < 0.15; ero = (r >= 0.15) & (r < 0.30)
    if dil.any(): out[dil] = F.max_pool2d(out[dil], 3, stride=1, padding=1)
    if ero.any(): out[ero] = -F.max_pool2d(-out[ero], 3, stride=1, padding=1)
    return out


def evaluate(net, X, Y, bs=512):
    net.eval(); full = 0; charok = 0; chartot = 0
    with torch.no_grad():
        for i in range(0, X.shape[0], bs):
            lg = net(X[i:i+bs])
            dec = greedy_decode(lg)
            for j, s in enumerate(dec):
                truth = "".join(ALPHABET[c] for c in Y[i+j].tolist())
                if s == truth: full += 1
                for k in range(len(truth)):
                    chartot += 1
                    if k < len(s) and s[k] == truth[k]: charok += 1
    return charok / chartot, full / X.shape[0]


def main():
    Xtr = torch.tensor(np.load(f"{DATA}/train_X.npy")).unsqueeze(1)
    Ytr = torch.tensor(np.load(f"{DATA}/train_Y.npy"))
    Xte = torch.tensor(np.load(f"{DATA}/test_X.npy")).unsqueeze(1)
    Yte = torch.tensor(np.load(f"{DATA}/test_Y.npy"))
    print("train", Xtr.shape, "test", Xte.shape)
    net = Net(); opt = torch.optim.Adam(net.parameters(), lr=1e-3)
    sched = torch.optim.lr_scheduler.StepLR(opt, step_size=6, gamma=0.5)
    ctc = nn.CTCLoss(blank=BLANK, zero_infinity=True)
    bs = 256; N = Xtr.shape[0]; EPOCHS = 16; t0 = time.time()
    T = 35
    for ep in range(EPOCHS):
        net.train(); perm = torch.randperm(N); ls = 0
        for i in range(0, N, bs):
            idx = perm[i:i+bs]; xb = augment(Xtr[idx]); yb = Ytr[idx] + 1  # shift: blank=0
            B = xb.shape[0]
            logp = net(xb).log_softmax(2).permute(1, 0, 2)   # T,B,63
            in_len = torch.full((B,), T, dtype=torch.long)
            tgt_len = torch.full((B,), yb.shape[1], dtype=torch.long)
            loss = ctc(logp, yb, in_len, tgt_len)
            opt.zero_grad(); loss.backward(); opt.step(); ls += loss.item() * B
        sched.step()
        ca, fa = evaluate(net, Xte, Yte)
        print(f"ep {ep+1:2d}  loss {ls/N:.3f}  TEST char {ca*100:.2f}%  FULL {fa*100:.1f}%  ({time.time()-t0:.0f}s)")
    export(net)


def _fold(conv, bn, eps=1e-5):
    w = conv.weight.detach().clone()
    b = conv.bias.detach().clone() if conv.bias is not None else torch.zeros(w.shape[0])
    sc = bn.weight.detach() / torch.sqrt(bn.running_var.detach() + eps)
    w = w * sc.view(-1, 1, 1, 1)
    b = (b - bn.running_mean.detach()) * sc + bn.bias.detach()
    return w, b


def export(net):
    net.eval()
    def a(t): return np.asarray(t.detach().cpu(), np.float32).round(6).tolist()
    layers = {}
    for k, bn in [("c1", net.b1), ("c2", net.b2), ("c3", net.b3), ("c4", net.b4)]:
        w, b = _fold(getattr(net, k), bn)
        layers[k] = {"w": a(w), "b": a(b)}
    layers["head"] = {"w": a(net.head.weight), "b": a(net.head.bias)}
    blob = {"alphabet": ALPHABET, "in_h": 40, "in_w": 140, "ncls": NCLS, "T": 35, "ctc": True,
            "layers": layers}
    json.dump(blob, open(OUT, "w"))
    import os
    print(f"exported {OUT} ({os.path.getsize(OUT)/1024:.0f} KB)")
    Xp = torch.tensor(np.load(f"{DATA}/test_X.npy")[:6]).unsqueeze(1)
    with torch.no_grad():
        lg = net(Xp).numpy()
    json.dump({"inputs": Xp.squeeze(1).numpy().round(4).tolist(),
               "logits": lg.round(4).tolist()}, open(f"{DATA}/parity.json", "w"))
    print("wrote parity.json")


if __name__ == "__main__":
    main()
