"""Dump N fresh synthetic captchas as raw RGBA + labels for the Node
end-to-end accuracy test (tests JS segmentation + CNN together)."""
import json, numpy as np, gen_captcha as G
N = 400
W, H = G.IMG_W, G.IMG_H
labels = []
buf = bytearray()
for i in range(N):
    img, label, gt = G.generate()
    rgba = np.asarray(img.convert("RGBA"), dtype=np.uint8)  # H,W,4
    buf += rgba.tobytes()
    labels.append(label)
open("/home/user/hoth/inkwell/data/eval.bin", "wb").write(buf)
json.dump({"n": N, "w": W, "h": H, "labels": labels},
          open("/home/user/hoth/inkwell/data/eval.json", "w"))
print(f"dumped {N} captchas {W}x{H} -> data/eval.bin ({len(buf)} bytes)")
