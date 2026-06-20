"""
Inkwell — pseudo-label expansion.

After training a seed CRNN on hand-labeled real captchas, run it on all
remaining unlabeled unique images. Keep only predictions where the model's
minimum per-character confidence is very high (default 0.92) — those are
correct with high probability and become additional training labels.

Output: big_pseudo.json — hand labels + accepted pseudo-labels, all stamped
as verified so finetune.py uses them.
"""
import sys, json, base64, io, hashlib, numpy as np
from PIL import Image
import torch
import math

from crnn import CRNN, ALPHABET, BLANK, T
from preprocess import preprocess

CONF_THR = float(sys.argv[1]) if len(sys.argv) > 1 else 0.92
CHAR2IDX = {c: i for i, c in enumerate(ALPHABET)}


def softmax_min_conf_decode(logits_TK):
    """Greedy CTC decode + return min per-emitted-char softmax probability."""
    # logits_TK: numpy T,K
    lg = logits_TK
    # softmax row-wise (stable)
    m = lg.max(1, keepdims=True)
    e = np.exp(lg - m); p = e / e.sum(1, keepdims=True)
    idx = lg.argmax(1)
    s = []; prev = -1; min_conf = 1.0
    for t in range(len(idx)):
        b = int(idx[t])
        if b != prev and b != BLANK:
            s.append(ALPHABET[b - 1])
            if p[t, b] < min_conf: min_conf = float(p[t, b])
        prev = b
    return "".join(s), min_conf


def main():
    # Load CRNN
    net = CRNN()
    net.load_state_dict(torch.load("/home/user/hoth/inkwell/data/crnn.pt"))
    net.eval()

    # Load hand-labeled set first (these are kept as-is, gold standard).
    hand = json.load(open("/home/user/hoth/inkwell/data/big_labeled.json"))
    hand_hashes = set()
    for s in hand:
        b = base64.b64decode(s["png"].split(",",1)[-1])
        hand_hashes.add(hashlib.sha1(b).hexdigest())
    print(f"hand-labeled gold set: {len(hand)} samples ({len(hand_hashes)} unique images)")

    # Load full collection, dedup by image hash, skip ones we already labeled.
    raw = json.load(open("/home/user/hoth/inkwell/data/big_raw.json"))
    by_hash = {}
    for s in raw:
        h = hashlib.sha1(base64.b64decode(s["png"].split(",",1)[-1])).hexdigest()
        by_hash.setdefault(h, []).append(s)
    to_pseudo = []
    for h, samples in by_hash.items():
        if h in hand_hashes: continue
        # skip the 440x ambiguous image (it's the only outlier in the histogram)
        if len(samples) > 50: continue
        to_pseudo.append((h, samples))
    print(f"images to pseudo-label: {len(to_pseudo)}")

    # Batch inference
    batch = 256
    accepted = 0; rejected = 0; bad_len = 0
    pseudo = []
    cur_x = []; cur_meta = []
    def flush():
        nonlocal accepted, rejected, bad_len
        if not cur_x: return
        X = torch.tensor(np.stack(cur_x)).unsqueeze(1)
        with torch.no_grad():
            lg = net(X).numpy()  # B,T,63
        for j, (h, samples) in enumerate(cur_meta):
            text, conf = softmax_min_conf_decode(lg[j])
            if len(text) != 5:
                bad_len += 1; continue
            if any(c not in CHAR2IDX for c in text):
                rejected += 1; continue
            if conf < CONF_THR:
                rejected += 1; continue
            # accept — expand back to ALL raw samples sharing this image
            for s in samples:
                pseudo.append({"png": s["png"], "text": text, "verified": True,
                               "id": s.get("id"), "ts": s.get("ts",0),
                               "conf": round(conf, 4)})
            accepted += 1

    for i, (h, samples) in enumerate(to_pseudo):
        b = base64.b64decode(samples[0]["png"].split(",",1)[-1])
        img = Image.open(io.BytesIO(b)).convert("RGB")
        x = preprocess(img)
        if x is None: continue
        cur_x.append(x.astype(np.float32))
        cur_meta.append((h, samples))
        if len(cur_x) >= batch:
            flush(); cur_x.clear(); cur_meta.clear()
        if (i+1) % 1000 == 0:
            print(f"  ...processed {i+1}/{len(to_pseudo)}, accepted={accepted}")
    flush()

    print(f"\nresults @ conf>={CONF_THR}:")
    print(f"  accepted images:  {accepted}")
    print(f"  rejected (low):   {rejected}")
    print(f"  rejected (len!=5): {bad_len}")
    print(f"  accepted samples (with duplicate expansion): {len(pseudo)}")

    combined = hand + pseudo
    out = "/home/user/hoth/inkwell/data/big_pseudo.json"
    json.dump(combined, open(out,"w"))
    print(f"wrote {out}  total samples: {len(combined)}  (hand {len(hand)} + pseudo {len(pseudo)})")


if __name__ == "__main__":
    main()
