"""Train the CRNN on synthetic data. This produces a working placeholder model
and the parity file; real accuracy comes from finetune.py on collected real
captchas. Run a modest number of epochs — the goal here is a correct, learning
model and parity data, not maxing synthetic accuracy."""
import sys, time, numpy as np, torch, torch.nn as nn
from crnn import CRNN, ALPHABET, BLANK, T, greedy_decode, evaluate, augment, export

DATA = "/home/user/hoth/inkwell/data"
OUT = "/home/user/hoth/inkwell/model/weights.json"
EPOCHS = int(sys.argv[1]) if len(sys.argv) > 1 else 8
torch.manual_seed(0); np.random.seed(0)


def main():
    Xtr = torch.tensor(np.load(f"{DATA}/train_X.npy")).unsqueeze(1)
    Ytr = torch.tensor(np.load(f"{DATA}/train_Y.npy"))
    Xte = torch.tensor(np.load(f"{DATA}/test_X.npy")).unsqueeze(1)
    Yte = torch.tensor(np.load(f"{DATA}/test_Y.npy"))
    print("train", Xtr.shape, "test", Xte.shape, "epochs", EPOCHS)
    net = CRNN(); opt = torch.optim.Adam(net.parameters(), lr=1e-3)
    sched = torch.optim.lr_scheduler.StepLR(opt, step_size=4, gamma=0.5)
    ctc = nn.CTCLoss(blank=BLANK, zero_infinity=True)
    bs = 256; N = Xtr.shape[0]; t0 = time.time()
    for ep in range(EPOCHS):
        net.train(); perm = torch.randperm(N); ls = 0
        for i in range(0, N, bs):
            idx = perm[i:i+bs]; xb = augment(Xtr[idx]); yb = Ytr[idx] + 1
            B = xb.shape[0]
            logp = net(xb).log_softmax(2).permute(1, 0, 2)
            il = torch.full((B,), T, dtype=torch.long)
            tl = torch.full((B,), yb.shape[1], dtype=torch.long)
            loss = ctc(logp, yb, il, tl)
            opt.zero_grad(); loss.backward(); opt.step(); ls += loss.item() * B
        sched.step()
        ca, fa = evaluate(net, Xte, Yte)
        print(f"ep {ep+1:2d}  loss {ls/N:.3f}  TEST char {ca*100:.2f}%  FULL {fa*100:.1f}%  ({time.time()-t0:.0f}s)")
    torch.save(net.state_dict(), f"{DATA}/crnn.pt")
    export(net, OUT, DATA)
    print("Done.")


if __name__ == "__main__":
    main()
