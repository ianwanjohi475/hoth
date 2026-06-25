"""
Length-constrained CTC beam search.

Standard greedy CTC gets 35% FULL because ~35% of outputs have the wrong
number of characters. Since we KNOW the output must be exactly 5 chars,
we can constrain the decoder.

This module also exports a JS-ready version for captcha-cnn.js.
"""
import numpy as np
import torch
from crnn import ALPHABET, BLANK, CRNN

NCLS = len(ALPHABET)
NEG_INF = float('-inf')


def ctc_decode_length_constrained(log_probs, target_len=5):
    """
    CTC beam search constrained to exactly target_len non-blank characters.

    log_probs: (T, C+1) log-softmax output. Class 0 = blank.
    Returns: best string of exactly target_len chars.

    Beam state: (prefix_str, last_nonblank_idx, last_was_blank)
    Score: log-probability of the best path leading to this state.
    """
    T = log_probs.shape[0]
    BEAM = 20

    # State: (prefix, last_char_idx, last_token_was_blank)
    # Use dict for O(1) lookup; key = (prefix, last_char_idx, last_blank_flag)
    # Store: log-prob (sum over all paths leading to this state)
    # We keep TWO beam dicts: blank-ending and non-blank-ending paths

    # beams_b[prefix] = log_prob of best path ending with blank
    # beams_nb[(prefix, last_c)] = log_prob of best path ending with char c
    beams_b = {"": 0.0}
    beams_nb = {}  # empty at start

    for t in range(T):
        lp = log_probs[t]  # shape (NCLS+1,)
        new_b = {}
        new_nb = {}

        # Helper to update a dict with log-sum-exp
        def update(d, key, score):
            if key not in d:
                d[key] = score
            else:
                # log-sum-exp
                a, b = d[key], score
                m = max(a, b)
                d[key] = m + np.log1p(np.exp(min(a, b) - m))

        # Process blank (class 0)
        blank_score = lp[0]
        for prefix, score in beams_b.items():
            update(new_b, prefix, score + blank_score)
        for (prefix, last_c), score in beams_nb.items():
            update(new_b, prefix, score + blank_score)

        # Process non-blank classes
        for c in range(1, NCLS + 1):
            char_score = lp[c]
            char = ALPHABET[c - 1]
            # Only extend if adding this char doesn't exceed target_len
            for prefix, score in beams_b.items():
                if len(prefix) >= target_len:
                    continue
                new_prefix = prefix + char
                update(new_nb, (new_prefix, c), score + char_score)
            for (prefix, last_c), score in beams_nb.items():
                if len(prefix) >= target_len:
                    continue
                if c == last_c:
                    # Same char as last: only allowed if last token was blank
                    # but we're in nb, so last was non-blank → skip (CTC rule)
                    continue
                new_prefix = prefix + char
                update(new_nb, (new_prefix, c), score + char_score)
            # Same-char extension where last-in-nb is same char:
            # allowed only if we're "continuing" a run — but CTC collapse
            # means we can't emit same char twice in a row without blank
            # Already handled above (skip if c == last_c in nb).

        # Prune to BEAM size — only keep if len(prefix) <= target_len
        def top_k(d, k):
            return dict(sorted(d.items(), key=lambda x: -x[1])[:k])
        beams_b = top_k(new_b, BEAM)
        beams_nb = top_k(new_nb, BEAM)

    # Collect all complete (len == target_len) prefixes with their total score
    results = {}
    for prefix, score in beams_b.items():
        if len(prefix) == target_len:
            if prefix not in results or results[prefix] < score:
                results[prefix] = score
    for (prefix, last_c), score in beams_nb.items():
        if len(prefix) == target_len:
            if prefix not in results or results[prefix] < score:
                results[prefix] = score

    if not results:
        # Fallback: return longest < target_len or shortest > target_len
        all_prefs = {}
        for prefix, score in beams_b.items():
            if prefix not in all_prefs or all_prefs[prefix] < score:
                all_prefs[prefix] = score
        for (prefix, last_c), score in beams_nb.items():
            if prefix not in all_prefs or all_prefs[prefix] < score:
                all_prefs[prefix] = score
        if all_prefs:
            return max(all_prefs.items(), key=lambda x: x[1])[0]
        return ""

    return max(results.items(), key=lambda x: x[1])[0]


def greedy_decode_one(log_probs):
    """Standard greedy CTC for comparison."""
    idx = log_probs.argmax(1)
    s = []; prev = -1
    for t in idx:
        t = int(t)
        if t != prev and t != BLANK:
            s.append(ALPHABET[t - 1])
        prev = t
    return "".join(s)


def evaluate_both(net, X, Y, bs=128):
    """Compare greedy vs length-constrained on a dataset."""
    from crnn import greedy_decode
    net.eval()
    greedy_full = 0; beam_full = 0; n = 0
    greedy_len_ok = 0; beam_len_ok = 0
    wrong_len_fixed = 0

    with torch.no_grad():
        for i in range(0, X.shape[0], bs):
            xb = X[i:i+bs]
            logits = net(xb)           # B, T, NCLS+1
            B = xb.shape[0]
            log_probs = logits.log_softmax(2)  # B, T, NCLS+1

            greedy_preds = greedy_decode(logits)
            for j in range(B):
                truth = "".join(ALPHABET[c] for c in Y[i+j].tolist())
                lp = log_probs[j].cpu().numpy()  # T, NCLS+1
                beam_pred = ctc_decode_length_constrained(lp, target_len=len(truth))

                g = greedy_preds[j]
                if g == truth: greedy_full += 1
                if beam_pred == truth: beam_full += 1
                if len(g) == len(truth): greedy_len_ok += 1
                if len(beam_pred) == len(truth): beam_len_ok += 1
                if len(g) != len(truth) and len(beam_pred) == len(truth):
                    wrong_len_fixed += 1
                n += 1

    print(f"N={n}")
    print(f"Greedy: FULL {greedy_full/n*100:.1f}%  len_ok {greedy_len_ok/n*100:.1f}%")
    print(f"Beam5:  FULL {beam_full/n*100:.1f}%  len_ok {beam_len_ok/n*100:.1f}%  (fixed {wrong_len_fixed} length errors)")
    return greedy_full/n, beam_full/n


if __name__ == "__main__":
    import json, base64, io
    from PIL import Image
    from preprocess import preprocess
    import sys
    sys.path.insert(0, ".")

    print("Loading model...")
    net = CRNN()
    net.load_state_dict(torch.load("/home/user/hoth/inkwell/data/crnn.pt"))
    net.eval()

    print("Loading samples...")
    data = json.load(open("/home/user/hoth/inkwell/data/big_labeled_v5.json"))
    CHAR2IDX = {c: i for i, c in enumerate(ALPHABET)}

    Xs, Ys = [], []
    for s in data[:3000]:
        text = s.get("text", "").strip()
        if len(text) != 5 or any(c not in CHAR2IDX for c in text): continue
        try:
            b = base64.b64decode(s["png"].split(",", 1)[-1])
            img = Image.open(io.BytesIO(b)).convert("RGB")
            x = preprocess(img)
            if x is None: continue
            Xs.append(x); Ys.append([CHAR2IDX[c] for c in text])
        except: continue

    Xt = torch.tensor(np.stack(Xs).astype(np.float32)).unsqueeze(1)
    Yt = torch.tensor(Ys, dtype=torch.long)

    print(f"Evaluating on {len(Xs)} samples...")
    evaluate_both(net, Xt, Yt, bs=64)
