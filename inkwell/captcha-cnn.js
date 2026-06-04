/* ============================================================================
   Inkwell — pure-JS local CAPTCHA solver (no API, no quota, no limits).

   Mirrors training/segment.py (hue-cluster segmentation) and runs the CNN
   exported by training/train_cnn.py as a plain conv/relu/pool/matmul forward
   pass. Works in Node (for the parity test) and in the extension content
   script (browser).
   ============================================================================ */
(function (root) {
  'use strict';

  // ---- segmentation constants (MUST match segment.py) ----
  const SIZE = 32, TARGET_H = 26;
  const STRONG_MAX = 190, STRONG_SAT = 40;
  const HUE_CONN = 0.045, MERGE_HUE = 0.05, MERGE_GAPX = 6;
  const MIN_PIXELS = 18, MIN_W = 2, MIN_H = 7;

  let MODEL = null;           // raw JSON
  let W = null;               // typed/cached weights

  function setModel(obj) {
    MODEL = obj;
    W = {
      c1: prep(obj.layers.c1), c2: prep(obj.layers.c2), c3: prep(obj.layers.c3),
      f1: prepFC(obj.layers.f1), f2: prepFC(obj.layers.f2),
      alphabet: obj.alphabet,
    };
  }
  function prep(L) {
    // conv weight w: [out][in][3][3]; flatten to Float32 [out*in*9], keep dims
    const out = L.w.length, inC = L.w[0].length, k = L.w[0][0].length;
    const w = new Float32Array(out * inC * k * k);
    let p = 0;
    for (let o = 0; o < out; o++)
      for (let i = 0; i < inC; i++)
        for (let a = 0; a < k; a++)
          for (let b = 0; b < k; b++) w[p++] = L.w[o][i][a][b];
    return { w, b: Float32Array.from(L.b), out, inC, k };
  }
  function prepFC(L) {
    const out = L.w.length, inN = L.w[0].length;
    const w = new Float32Array(out * inN);
    let p = 0;
    for (let o = 0; o < out; o++) for (let i = 0; i < inN; i++) w[p++] = L.w[o][i];
    return { w, b: Float32Array.from(L.b), out, inN };
  }

  async function loadModel(url) {
    const res = await fetch(url);
    setModel(await res.json());
  }

  // ---- CNN ops (feature map layout: data[c*H*W + y*W + x]) ----
  function conv3x3(inp, C, H, Wd, L) {   // pad=1, stride=1
    const out = new Float32Array(L.out * H * Wd);
    const k = L.k; // 3
    for (let o = 0; o < L.out; o++) {
      const ob = L.b[o];
      const obase = o * H * Wd;
      const wo = o * L.inC * 9;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < Wd; x++) {
          let acc = ob;
          for (let i = 0; i < L.inC; i++) {
            const ibase = i * H * Wd;
            const wbase = wo + i * 9;
            for (let a = 0; a < 3; a++) {
              const yy = y + a - 1;
              if (yy < 0 || yy >= H) continue;
              const row = ibase + yy * Wd;
              const wr = wbase + a * 3;
              for (let b = 0; b < 3; b++) {
                const xx = x + b - 1;
                if (xx < 0 || xx >= Wd) continue;
                acc += inp[row + xx] * L.w[wr + b];
              }
            }
          }
          out[obase + y * Wd + x] = acc > 0 ? acc : 0;  // fused ReLU
        }
      }
    }
    return out;
  }
  function maxpool2(inp, C, H, Wd) {     // 2x2 stride2 (floor)
    const H2 = H >> 1, W2 = Wd >> 1;
    const out = new Float32Array(C * H2 * W2);
    for (let c = 0; c < C; c++) {
      const ib = c * H * Wd, ob = c * H2 * W2;
      for (let y = 0; y < H2; y++) {
        for (let x = 0; x < W2; x++) {
          const y0 = y * 2, x0 = x * 2;
          let m = inp[ib + y0 * Wd + x0];
          const a = inp[ib + y0 * Wd + x0 + 1];
          const b = inp[ib + (y0 + 1) * Wd + x0];
          const d = inp[ib + (y0 + 1) * Wd + x0 + 1];
          if (a > m) m = a; if (b > m) m = b; if (d > m) m = d;
          out[ob + y * W2 + x] = m;
        }
      }
    }
    return out;
  }
  function dense(inp, L, relu) {
    const out = new Float32Array(L.out);
    for (let o = 0; o < L.out; o++) {
      let acc = L.b[o]; const wb = o * L.inN;
      for (let i = 0; i < L.inN; i++) acc += inp[i] * L.w[wb + i];
      out[o] = relu ? (acc > 0 ? acc : 0) : acc;
    }
    return out;
  }

  // glyph32: Float32Array 32*32 (row-major). feats: [relH, aspect, fill].
  // Returns {char, conf, logits}
  function classify(glyph32, feats) {
    let m = conv3x3(glyph32, 1, 32, 32, W.c1); m = maxpool2(m, W.c1.out, 32, 32);
    m = conv3x3(m, W.c1.out, 16, 16, W.c2);    m = maxpool2(m, W.c2.out, 16, 16);
    m = conv3x3(m, W.c2.out, 8, 8, W.c3);      m = maxpool2(m, W.c3.out, 8, 8);
    // m is C3 x 4 x 4 (= 1024), layout c*16 + y*4 + x == torch flatten order.
    // Append the 3 size features to match the trained f1 input (conv + feats).
    const inp = new Float32Array(W.f1.inN);
    inp.set(m.subarray(0, W.f1.inN - 3));
    inp[W.f1.inN - 3] = feats[0];
    inp[W.f1.inN - 2] = feats[1];
    inp[W.f1.inN - 1] = feats[2];
    let v = dense(inp, W.f1, true);
    const logits = dense(v, W.f2, false);
    // softmax-ish argmax + confidence
    let best = 0, bestv = -1e9, sum = 0;
    for (let i = 0; i < logits.length; i++) if (logits[i] > bestv) { bestv = logits[i]; best = i; }
    let mx = bestv;
    for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i] - mx);
    const conf = 1 / sum; // exp(0)/sum
    return { char: W.alphabet[best], conf, logits };
  }

  // ---- segmentation (mirror of segment.py) ----
  function rgbToHue(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d === 0) return 0;
    let h;
    if (mx === r) h = (((g - b) / d) % 6 + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = h / 6; h = h - Math.floor(h);
    return h;
  }
  function circDist(a, b) { const d = Math.abs(a - b); return Math.min(d, 1 - d); }

  // rgba: Uint8(Clamped)Array length w*h*4.
  // Hue-aware connected-components flood fill (mirror of segment.py).
  function segment(rgba, w, h) {
    const N = w * h;
    const strong = new Uint8Array(N);
    const hue = new Float32Array(N);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, o = i * 4;
        const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx < STRONG_MAX && (mx - mn) > STRONG_SAT) {
          strong[i] = 1; hue[i] = rgbToHue(r, g, b);
        }
      }
    }
    const label = new Int32Array(N).fill(-1);   // -1 unvisited strong / -2 weak handled via strong[]
    const stack = new Int32Array(N);
    let blobs = [];
    for (let s = 0; s < N; s++) {
      if (!strong[s] || label[s] !== -1) continue;
      const bid = blobs.length;
      let sp = 0; stack[sp++] = s; label[s] = bid;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, cnt = 0, hsum = 0;
      const pts = [];
      while (sp > 0) {
        const idx = stack[--sp];
        const y = (idx / w) | 0, x = idx - y * w;
        cnt++; hsum += hue[idx]; pts.push(idx);
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        const hh = hue[idx];
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy; if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx; if (nx < 0 || nx >= w) continue;
            const ni = ny * w + nx;
            if (strong[ni] && label[ni] === -1 && circDist(hue[ni], hh) < HUE_CONN) {
              label[ni] = bid; stack[sp++] = ni;
            }
          }
        }
      }
      blobs.push({ x0, y0, x1, y1, n: cnt, hue: hsum / cnt, pts });
    }

    blobs = blobs.filter(b => b.n >= MIN_PIXELS &&
      (b.x1 - b.x0 + 1) >= MIN_W && (b.y1 - b.y0 + 1) >= MIN_H);
    blobs.sort((a, b) => (a.x0 + a.x1) - (b.x0 + b.x1));

    // merge same-hue blobs separated by a small x-gap (glyph cut by a line)
    const merged = [];
    for (const b of blobs) {
      if (merged.length) {
        const m = merged[merged.length - 1];
        if ((b.x0 - m.x1) <= MERGE_GAPX && circDist(b.hue, m.hue) < MERGE_HUE) {
          m.x0 = Math.min(m.x0, b.x0); m.x1 = Math.max(m.x1, b.x1);
          m.y0 = Math.min(m.y0, b.y0); m.y1 = Math.max(m.y1, b.y1);
          m.n += b.n; m.pts = m.pts.concat(b.pts); m.hue = (m.hue + b.hue) / 2;
          continue;
        }
      }
      merged.push({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, n: b.n, hue: b.hue, pts: b.pts });
    }
    for (const m of merged) m.cx = (m.x0 + m.x1) / 2;
    if (!merged.length) return { chars: [], scale: 1, w };
    let maxH = 0;
    for (const c of merged) maxH = Math.max(maxH, c.y1 - c.y0 + 1);
    return { chars: merged, scale: TARGET_H / maxH, w };
  }

  // build the 32x32 normalized glyph from a char blob (mirror normalize())
  function normalize(ch, scale, w) {
    const bw = ch.x1 - ch.x0 + 1, bh = ch.y1 - ch.y0 + 1;
    const sub = new Uint8Array(bw * bh);
    for (const idx of ch.pts) {
      const y = (idx / w) | 0, x = idx - y * w;
      sub[(y - ch.y0) * bw + (x - ch.x0)] = 1;
    }
    let nh = Math.max(1, Math.round(bh * scale));
    let nw = Math.max(1, Math.round(bw * scale));
    if (nw > SIZE) nw = SIZE;
    if (nh > SIZE) nh = SIZE;
    const out = new Float32Array(SIZE * SIZE);
    const ox = (SIZE - nw) >> 1, oy = (SIZE - nh) >> 1;
    for (let y = 0; y < nh; y++) {
      let sy = Math.floor(y / scale); if (sy >= bh) sy = bh - 1;
      for (let x = 0; x < nw; x++) {
        let sx = Math.floor(x / scale); if (sx >= bw) sx = bw - 1;
        out[(oy + y) * SIZE + (ox + x)] = sub[sy * bw + sx];
      }
    }
    return out;
  }

  // size/shape features for a char box (mirror of segment.features)
  function charFeatures(ch, maxH) {
    const bw = ch.x1 - ch.x0 + 1, bh = ch.y1 - ch.y0 + 1;
    const relH = maxH ? bh / maxH : 1.0;
    const aspect = bh ? Math.min(bw / bh, 2.0) : 1.0;
    const fill = ch.n / (bw * bh);
    return [relH, aspect, fill];
  }

  // Full solve from RGBA pixels. Returns { text, conf, n }.
  function solveRGBA(rgba, w, h) {
    const seg = segment(rgba, w, h);
    if (!seg.chars.length) return { text: '', conf: 0, n: 0 };
    let maxH = 0;
    for (const ch of seg.chars) maxH = Math.max(maxH, ch.y1 - ch.y0 + 1);
    let text = '', minConf = 1;
    for (const ch of seg.chars) {
      const g = normalize(ch, seg.scale, seg.w);
      const r = classify(g, charFeatures(ch, maxH));
      text += r.char;
      if (r.conf < minConf) minConf = r.conf;
    }
    return { text, conf: minConf, n: seg.chars.length };
  }

  // Solve from an <img> element (browser only).
  function solveImage(imgEl) {
    const w = imgEl.naturalWidth || imgEl.width;
    const h = imgEl.naturalHeight || imgEl.height;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(imgEl, 0, 0);
    const id = ctx.getImageData(0, 0, w, h);
    return solveRGBA(id.data, w, h);
  }

  root.InkwellCNN = {
    loadModel, setModel, classify, segment, normalize, solveRGBA, solveImage,
    get ready() { return !!W; },
  };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : global));
