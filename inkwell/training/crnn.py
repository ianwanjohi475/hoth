"""
Inkwell CRNN — bigger model: deeper/wider CNN backbone + bidirectional LSTM
+ CTC head. This replaces the tiny 4-conv CNN. The LSTM gives the model
character-context (it reads the sequence left-to-right and right-to-left),
which is what lifts the accuracy ceiling from ~88% toward ~95% given enough
real data.

Shared by train_crnn.py and finetune.py so the architecture is defined once.

Backbone (input 1 x 40 x 140):
  c1 3x3 1->64    bn relu  pool(2,2) -> 20x70
  c2 3x3 64->128  bn relu  pool(2,2) -> 10x35
  c3 3x3 128->256 bn relu  pool(2,1) -> 5x35
  c4 3x3 256->256 bn relu  pool(5,1) -> 1x35     => 256 channels, T=35
  BiLSTM(256 -> 2x128)  per timestep
  Linear(256 -> 63)     (62 classes + CTC blank=0)
"""
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F

ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
NCLS = 62
BLANK = 0
HID = 128
T = 35


class CRNN(nn.Module):
    def __init__(self):
        super().__init__()
        self.c1 = nn.Conv2d(1, 64, 3, padding=1);   self.b1 = nn.BatchNorm2d(64)
        self.c2 = nn.Conv2d(64, 128, 3, padding=1); self.b2 = nn.BatchNorm2d(128)
        self.c3 = nn.Conv2d(128, 256, 3, padding=1); self.b3 = nn.BatchNorm2d(256)
        self.c4 = nn.Conv2d(256, 256, 3, padding=1); self.b4 = nn.BatchNorm2d(256)
        self.lstm = nn.LSTM(256, HID, batch_first=True, bidirectional=True)
        self.head = nn.Linear(2 * HID, NCLS + 1)

    def features(self, x):
        x = F.max_pool2d(F.relu(self.b1(self.c1(x))), (2, 2))   # 20x70
        x = F.max_pool2d(F.relu(self.b2(self.c2(x))), (2, 2))   # 10x35
        x = F.max_pool2d(F.relu(self.b3(self.c3(x))), (2, 1))   # 5x35
        x = F.max_pool2d(F.relu(self.b4(self.c4(x))), (5, 1))   # 1x35
        return x  # B,256,1,35

    def forward(self, x):
        f = self.features(x)               # B,256,1,35
        B, C, _, Tt = f.shape
        f = f.squeeze(2).permute(0, 2, 1)  # B,T,256
        f, _ = self.lstm(f)                # B,T,256
        return self.head(f)                # B,T,63


def greedy_decode(logits):
    """logits: B,T,63 -> list of strings (collapse repeats, drop blank)."""
    idx = logits.argmax(2).cpu().numpy()
    outs = []
    for row in idx:
        s = []; prev = -1
        for t in row:
            if t != prev and t != BLANK:
                s.append(ALPHABET[t - 1])
            prev = t
        outs.append("".join(s))
    return outs


def evaluate(net, X, Y, bs=256):
    net.eval(); full = 0; charok = 0; chartot = 0
    with torch.no_grad():
        for i in range(0, X.shape[0], bs):
            dec = greedy_decode(net(X[i:i+bs]))
            for j, s in enumerate(dec):
                truth = "".join(ALPHABET[c] for c in Y[i+j].tolist())
                if s == truth: full += 1
                for k in range(len(truth)):
                    chartot += 1
                    if k < len(s) and s[k] == truth[k]: charok += 1
    return charok / chartot, full / X.shape[0]


def augment(xb):
    out = xb.clone(); n = xb.shape[0]; r = torch.rand(n)
    dil = r < 0.15; ero = (r >= 0.15) & (r < 0.30)
    if dil.any(): out[dil] = F.max_pool2d(out[dil], 3, stride=1, padding=1)
    if ero.any(): out[ero] = -F.max_pool2d(-out[ero], 3, stride=1, padding=1)
    return out


def _fold(conv, bn, eps=1e-5):
    w = conv.weight.detach().clone()
    b = conv.bias.detach().clone() if conv.bias is not None else torch.zeros(w.shape[0])
    sc = bn.weight.detach() / torch.sqrt(bn.running_var.detach() + eps)
    w = w * sc.view(-1, 1, 1, 1)
    b = (b - bn.running_mean.detach()) * sc + bn.bias.detach()
    return w, b


def export(net, out_path, data_dir):
    """Export folded conv + LSTM + head weights to JSON, plus a parity file."""
    import json, os
    net.eval()
    def a(t): return np.asarray(t.detach().cpu(), np.float32).round(6).tolist()
    layers = {}
    for k, bn in [("c1", net.b1), ("c2", net.b2), ("c3", net.b3), ("c4", net.b4)]:
        w, b = _fold(getattr(net, k), bn)
        layers[k] = {"w": a(w), "b": a(b)}
    layers["head"] = {"w": a(net.head.weight), "b": a(net.head.bias)}
    # LSTM params (PyTorch names). l0 = forward, l0_reverse = backward.
    L = net.lstm
    lstm = {
        "wf_ih": a(L.weight_ih_l0), "wf_hh": a(L.weight_hh_l0),
        "bf_ih": a(L.bias_ih_l0),   "bf_hh": a(L.bias_hh_l0),
        "wb_ih": a(L.weight_ih_l0_reverse), "wb_hh": a(L.weight_hh_l0_reverse),
        "bb_ih": a(L.bias_ih_l0_reverse),   "bb_hh": a(L.bias_hh_l0_reverse),
    }
    blob = {"alphabet": ALPHABET, "in_h": 40, "in_w": 140, "ncls": NCLS,
            "T": T, "hid": HID, "ctc": True, "arch": "crnn",
            "layers": layers, "lstm": lstm}
    json.dump(blob, open(out_path, "w"))
    print(f"exported {out_path} ({os.path.getsize(out_path)/1024/1024:.1f} MB)")
    # parity sample
    Xp = torch.tensor(np.load(f"{data_dir}/test_X.npy")[:6]).unsqueeze(1)
    with torch.no_grad():
        lg = net(Xp).numpy()
    json.dump({"inputs": Xp.squeeze(1).numpy().round(4).tolist(),
               "logits": lg.round(4).tolist()},
              open(f"{data_dir}/parity.json", "w"))
    print("wrote parity.json")
