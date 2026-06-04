"""
Train a compact CNN on the synthetic glyph crops and export weights as JSON
for the pure-JS forward pass in captcha-cnn.js.

Architecture (no BatchNorm — keeps the JS port a plain conv/relu/pool/matmul):
  in 1x32x32
  conv1 3x3 (1->16)  relu  maxpool2  -> 16x16x16
  conv2 3x3 (16->32) relu  maxpool2  -> 8x8x32
  conv3 3x3 (32->32) relu  maxpool2  -> 4x4x32 = 512
  fc1 512->128 relu
  fc2 128->62
"""
import json, time, numpy as np, torch, torch.nn as nn, torch.nn.functional as F

ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
DATA = "/home/user/hoth/inkwell/data"
OUT  = "/home/user/hoth/inkwell/model/weights.json"
torch.manual_seed(0); np.random.seed(0)

NFEAT = 3  # [relH, aspect, fill]

class Net(nn.Module):
    def __init__(self):
        super().__init__()
        self.c1 = nn.Conv2d(1, 32, 3, padding=1)
        self.c2 = nn.Conv2d(32, 64, 3, padding=1)
        self.c3 = nn.Conv2d(64, 64, 3, padding=1)
        self.f1 = nn.Linear(4 * 4 * 64 + NFEAT, 192)   # conv feats + size feats
        self.f2 = nn.Linear(192, 62)
    def forward(self, x, feat):
        x = F.max_pool2d(F.relu(self.c1(x)), 2)
        x = F.max_pool2d(F.relu(self.c2(x)), 2)
        x = F.max_pool2d(F.relu(self.c3(x)), 2)
        x = x.flatten(1)
        x = torch.cat([x, feat], dim=1)               # concat size features
        x = F.relu(self.f1(x))
        return self.f2(x)

def augment(xb):
    """Light, NON-destructive augmentation: occasional stroke dilation /
    erosion only (matches real-captcha stroke-width variation). No pixel
    shift — torch.roll wraps pixels around and corrupts glyphs, and the
    crops are already centred with margin."""
    out = xb.clone()
    n = xb.shape[0]
    r = torch.rand(n)
    dil = r < 0.12
    ero = (r >= 0.12) & (r < 0.24)
    if dil.any():
        out[dil] = F.max_pool2d(out[dil], 3, stride=1, padding=1)
    if ero.any():
        out[ero] = -F.max_pool2d(-out[ero], 3, stride=1, padding=1)
    return out

def main():
    Xtr = np.load(f"{DATA}/train_X.npy"); ytr = np.load(f"{DATA}/train_y.npy")
    Ftr = np.load(f"{DATA}/train_F.npy")
    Xte = np.load(f"{DATA}/test_X.npy");  yte = np.load(f"{DATA}/test_y.npy")
    Fte = np.load(f"{DATA}/test_F.npy")
    print("train", Xtr.shape, "test", Xte.shape)
    Xtr = torch.tensor(Xtr).unsqueeze(1); Ftr = torch.tensor(Ftr); ytr = torch.tensor(ytr)
    Xte = torch.tensor(Xte).unsqueeze(1); Fte = torch.tensor(Fte); yte = torch.tensor(yte)

    net = Net()
    opt = torch.optim.Adam(net.parameters(), lr=1e-3)
    sched = torch.optim.lr_scheduler.StepLR(opt, step_size=6, gamma=0.5)
    bs = 256; N = Xtr.shape[0]; EPOCHS = 20
    t0 = time.time()
    for ep in range(EPOCHS):
        net.train(); perm = torch.randperm(N); tot = 0; corr = 0; loss_sum = 0
        for i in range(0, N, bs):
            idx = perm[i:i+bs]
            xb = augment(Xtr[idx]); fb = Ftr[idx]; yb = ytr[idx]
            opt.zero_grad()
            out = net(xb, fb); loss = F.cross_entropy(out, yb)
            loss.backward(); opt.step()
            loss_sum += loss.item() * xb.shape[0]
            corr += (out.argmax(1) == yb).sum().item(); tot += xb.shape[0]
        sched.step()
        # eval
        net.eval()
        with torch.no_grad():
            te = []
            for i in range(0, Xte.shape[0], 1024):
                te.append(net(Xte[i:i+1024], Fte[i:i+1024]).argmax(1))
            te = torch.cat(te)
            char_acc = (te == yte).float().mean().item()
        print(f"ep {ep+1:2d}  train_acc {corr/tot:.3f}  loss {loss_sum/tot:.3f}  "
              f"TEST char_acc {char_acc:.4f}  ({time.time()-t0:.0f}s)")

    # 5-char captcha accuracy estimate = char_acc**5
    print(f"=> estimated full-captcha accuracy ~ {char_acc**5*100:.1f}% "
          f"(per-char {char_acc*100:.2f}%)")

    export(net)

def export(net):
    sd = net.state_dict()
    def arr(t): return np.asarray(t.detach().cpu(), dtype=np.float32)
    blob = {
        "alphabet": ALPHABET,
        "size": 32,
        "layers": {
            "c1": {"w": arr(sd["c1.weight"]).round(6).tolist(), "b": arr(sd["c1.bias"]).round(6).tolist()},
            "c2": {"w": arr(sd["c2.weight"]).round(6).tolist(), "b": arr(sd["c2.bias"]).round(6).tolist()},
            "c3": {"w": arr(sd["c3.weight"]).round(6).tolist(), "b": arr(sd["c3.bias"]).round(6).tolist()},
            "f1": {"w": arr(sd["f1.weight"]).round(6).tolist(), "b": arr(sd["f1.bias"]).round(6).tolist()},
            "f2": {"w": arr(sd["f2.weight"]).round(6).tolist(), "b": arr(sd["f2.bias"]).round(6).tolist()},
        },
    }
    with open(OUT, "w") as f:
        json.dump(blob, f)
    import os
    print(f"exported {OUT}  ({os.path.getsize(OUT)/1024:.0f} KB)")

    # test vectors for JS parity check: 6 raw inputs + features + logits
    net.eval()
    Xp = torch.tensor(np.load(f"{DATA}/test_X.npy")[:6]).unsqueeze(1)
    Fp = torch.tensor(np.load(f"{DATA}/test_F.npy")[:6])
    with torch.no_grad():
        logits = net(Xp, Fp).numpy()
    json.dump({
        "inputs": Xp.squeeze(1).numpy().round(4).tolist(),
        "feats": Fp.numpy().round(5).tolist(),
        "logits": logits.round(4).tolist(),
    }, open(f"{DATA}/parity.json", "w"))
    print("wrote parity.json")

if __name__ == "__main__":
    main()
