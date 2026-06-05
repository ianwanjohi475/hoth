/* ============================================================================
   Inkwell — pure-JS whole-image CTC CAPTCHA solver (no API, no quota, no limits).

   Mirrors training/preprocess.py (binarise → content-crop → resize 40x140) and
   runs the CTC CNN exported by training/train_cnn.py (BatchNorm folded into the
   conv weights). The CNN reads the image as a left-to-right sequence of T=35
   timesteps; greedy CTC decode (collapse repeats, drop blank) yields the text.
   Works in Node (parity test) and in the extension content script.
   ============================================================================ */
(function (root) {
  'use strict';

  const IN_H = 40, IN_W = 140;
  const STRONG_MAX = 195, STRONG_SAT = 35;
  const BLANK = 0;

  let MODEL = null, W = null;

  function setModel(obj) {
    MODEL = obj;
    W = {
      c1: conv(obj.layers.c1), c2: conv(obj.layers.c2),
      c3: conv(obj.layers.c3), c4: conv(obj.layers.c4),
      head: fc(obj.layers.head), alphabet: obj.alphabet,
      T: obj.T || 35, hid: obj.hid || 128,
      arch: obj.arch || 'cnn',
    };
    if (obj.lstm) {
      W.lstm = {
        fwd: lstmDir(obj.lstm.wf_ih, obj.lstm.wf_hh, obj.lstm.bf_ih, obj.lstm.bf_hh),
        bwd: lstmDir(obj.lstm.wb_ih, obj.lstm.wb_hh, obj.lstm.bb_ih, obj.lstm.bb_hh),
      };
    }
  }
  // Flatten one LSTM direction. PyTorch stacks gates as [i,f,g,o], each H rows.
  // Pre-sum bias_ih + bias_hh into one bias (they're always added together).
  function lstmDir(w_ih, w_hh, b_ih, b_hh) {
    const fourH = w_ih.length, inC = w_ih[0].length, H = w_hh[0].length;
    const Wih = new Float32Array(fourH * inC); let p = 0;
    for (let r = 0; r < fourH; r++) for (let c = 0; c < inC; c++) Wih[p++] = w_ih[r][c];
    const Whh = new Float32Array(fourH * H); p = 0;
    for (let r = 0; r < fourH; r++) for (let c = 0; c < H; c++) Whh[p++] = w_hh[r][c];
    const b = new Float32Array(fourH);
    for (let r = 0; r < fourH; r++) b[r] = b_ih[r] + b_hh[r];
    return { Wih, Whh, b, inC, H, fourH };
  }
  function conv(L) {
    const out = L.w.length, inC = L.w[0].length, k = L.w[0][0].length;
    const w = new Float32Array(out * inC * k * k); let p = 0;
    for (let o = 0; o < out; o++) for (let i = 0; i < inC; i++)
      for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) w[p++] = L.w[o][i][a][b];
    return { w, b: Float32Array.from(L.b), out, inC };
  }
  function fc(L) {
    const out = L.w.length, inN = L.w[0].length;
    const w = new Float32Array(out * inN); let p = 0;
    for (let o = 0; o < out; o++) for (let i = 0; i < inN; i++) w[p++] = L.w[o][i];
    return { w, b: Float32Array.from(L.b), out, inN };
  }
  async function loadModel(url) { setModel(await (await fetch(url)).json()); }

  function conv3x3relu(inp, H, Wd, L) {       // pad1 stride1 + fused ReLU
    const out = new Float32Array(L.out * H * Wd);
    for (let o = 0; o < L.out; o++) {
      const ob = L.b[o], obase = o * H * Wd, wo = o * L.inC * 9;
      for (let y = 0; y < H; y++) for (let x = 0; x < Wd; x++) {
        let acc = ob;
        for (let i = 0; i < L.inC; i++) {
          const ibase = i * H * Wd, wb = wo + i * 9;
          for (let a = 0; a < 3; a++) {
            const yy = y + a - 1; if (yy < 0 || yy >= H) continue;
            const row = ibase + yy * Wd, wr = wb + a * 3;
            for (let b = 0; b < 3; b++) {
              const xx = x + b - 1; if (xx < 0 || xx >= Wd) continue;
              acc += inp[row + xx] * L.w[wr + b];
            }
          }
        }
        out[obase + y * Wd + x] = acc > 0 ? acc : 0;
      }
    }
    return out;
  }
  function maxpool(inp, C, H, Wd, kh, kw) {    // stride = kernel, floor
    const H2 = Math.floor(H / kh), W2 = Math.floor(Wd / kw);
    const out = new Float32Array(C * H2 * W2);
    for (let c = 0; c < C; c++) {
      const ib = c * H * Wd, ob = c * H2 * W2;
      for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
        let m = -1e30;
        for (let a = 0; a < kh; a++) for (let b = 0; b < kw; b++) {
          const v = inp[ib + (y * kh + a) * Wd + (x * kw + b)];
          if (v > m) m = v;
        }
        out[ob + y * W2 + x] = m;
      }
    }
    return out;
  }

  const sigmoid = (v) => 1 / (1 + Math.exp(-v));
  // One bidirectional LSTM direction. seq: Float32Array T*C (row-major t,c).
  // Returns Float32Array T*H of hidden states (in natural t order).
  function lstmRun(seq, T, C, D, reverse) {
    const H = D.H, fourH = D.fourH, Wih = D.Wih, Whh = D.Whh, b = D.b;
    const out = new Float32Array(T * H);
    const h = new Float32Array(H), c = new Float32Array(H), g = new Float32Array(fourH);
    for (let s = 0; s < T; s++) {
      const t = reverse ? (T - 1 - s) : s;
      const xb = t * C;
      for (let r = 0; r < fourH; r++) {
        let acc = b[r];
        const wi = r * C, wh = r * H;
        for (let k = 0; k < C; k++) acc += Wih[wi + k] * seq[xb + k];
        for (let k = 0; k < H; k++) acc += Whh[wh + k] * h[k];
        g[r] = acc;
      }
      // gate order [i,f,g,o] each H
      for (let j = 0; j < H; j++) {
        const ig = sigmoid(g[j]), fg = sigmoid(g[H + j]),
              cg = Math.tanh(g[2 * H + j]), og = sigmoid(g[3 * H + j]);
        const cj = fg * c[j] + ig * cg;
        c[j] = cj; h[j] = og * Math.tanh(cj);
      }
      const ob = t * H;
      for (let j = 0; j < H; j++) out[ob + j] = h[j];
    }
    return out;
  }

  // input: Float32Array IN_H*IN_W. Returns { text, conf }
  function forward(x) {
    let m = conv3x3relu(x, 40, 140, W.c1); m = maxpool(m, W.c1.out, 40, 140, 2, 2);  // 20x70
    m = conv3x3relu(m, 20, 70, W.c2);      m = maxpool(m, W.c2.out, 20, 70, 2, 2);    // 10x35
    m = conv3x3relu(m, 10, 35, W.c3);      m = maxpool(m, W.c3.out, 10, 35, 2, 1);    // 5x35
    m = conv3x3relu(m, 5, 35, W.c4);       m = maxpool(m, W.c4.out, 5, 35, 5, 1);     // 1x35
    const C = W.c4.out, T = W.T, K = W.head.out;

    // Build per-timestep feature sequence: seq[t*C + c] = m[c*T + t]
    const seq = new Float32Array(T * C);
    for (let t = 0; t < T; t++) for (let c = 0; c < C; c++) seq[t * C + c] = m[c * T + t];

    // BiLSTM (if present) -> per-timestep vector of size headIn (2*H or C)
    let feats, FC;
    if (W.lstm) {
      const H = W.lstm.fwd.H;
      const fo = lstmRun(seq, T, C, W.lstm.fwd, false);
      const bo = lstmRun(seq, T, C, W.lstm.bwd, true);
      FC = 2 * H;
      feats = new Float32Array(T * FC);
      for (let t = 0; t < T; t++) {
        for (let j = 0; j < H; j++) feats[t * FC + j] = fo[t * H + j];
        for (let j = 0; j < H; j++) feats[t * FC + H + j] = bo[t * H + j];
      }
    } else {
      feats = seq; FC = C;
    }

    let text = '', prev = -1, minConf = 1;
    const logit = new Float32Array(K);
    const allLogits = DEBUG_LOGITS ? [] : null;
    for (let t = 0; t < T; t++) {
      const fb = t * FC;
      let best = 0, bestv = -1e30;
      for (let k = 0; k < K; k++) {
        let acc = W.head.b[k]; const wb = k * FC;
        for (let c = 0; c < FC; c++) acc += feats[fb + c] * W.head.w[wb + c];
        logit[k] = acc; if (acc > bestv) { bestv = acc; best = k; }
      }
      if (allLogits) allLogits.push(Array.from(logit));
      if (best !== prev && best !== BLANK) {
        let sum = 0; for (let k = 0; k < K; k++) sum += Math.exp(logit[k] - bestv);
        const conf = 1 / sum;
        if (conf < minConf) minConf = conf;
        text += W.alphabet[best - 1];
      }
      prev = best;
    }
    return { text, conf: text ? minConf : 0, logits: allLogits };
  }
  let DEBUG_LOGITS = false;
  function setDebugLogits(v) { DEBUG_LOGITS = v; }

  // ---- preprocessing (mirror of preprocess.py) ----
  function preprocessRGBA(rgba, w, h) {
    const sm = new Uint8Array(w * h);
    const colD = new Int32Array(w), rowD = new Int32Array(h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < STRONG_MAX && (mx - mn) > STRONG_SAT) { sm[y * w + x] = 1; colD[x]++; rowD[y]++; }
    }
    let x0 = -1, x1 = -1, y0 = -1, y1 = -1;
    for (let x = 0; x < w; x++) if (colD[x] >= 1) { if (x0 < 0) x0 = x; x1 = x; }
    for (let y = 0; y < h; y++) if (rowD[y] >= 1) { if (y0 < 0) y0 = y; y1 = y; }
    if (x0 < 0) return null;
    const ch = (y1 - y0 + 1) + 4, cw = (x1 - x0 + 1) + 6;
    const crop = new Float32Array(ch * cw);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
      if (sm[y * w + x]) crop[(y - y0 + 2) * cw + (x - x0 + 3)] = 1;
    const out = new Float32Array(IN_H * IN_W);
    for (let oy = 0; oy < IN_H; oy++) {
      const sy0 = Math.floor(oy * ch / IN_H), sy1 = Math.max(sy0 + 1, Math.floor((oy + 1) * ch / IN_H));
      for (let ox = 0; ox < IN_W; ox++) {
        const sx0 = Math.floor(ox * cw / IN_W), sx1 = Math.max(sx0 + 1, Math.floor((ox + 1) * cw / IN_W));
        let s = 0;
        for (let yy = sy0; yy < sy1; yy++) { const rb = yy * cw; for (let xx = sx0; xx < sx1; xx++) s += crop[rb + xx]; }
        out[oy * IN_W + ox] = s / ((sy1 - sy0) * (sx1 - sx0));
      }
    }
    return out;
  }

  // 3x3 morphology on the 40x140 grid (matches the dilation/erosion the model
  // was trained with). dilate=thicken strokes, erode=thin them.
  function morph(x, dilate) {
    const out = new Float32Array(IN_H * IN_W);
    for (let y = 0; y < IN_H; y++) for (let x0 = 0; x0 < IN_W; x0++) {
      let v = dilate ? -1e30 : 1e30;
      for (let a = -1; a <= 1; a++) {
        const yy = y + a; if (yy < 0 || yy >= IN_H) continue;
        for (let b = -1; b <= 1; b++) {
          const xx = x0 + b; if (xx < 0 || xx >= IN_W) continue;
          const p = x[yy * IN_W + xx];
          v = dilate ? (p > v ? p : v) : (p < v ? p : v);
        }
      }
      out[y * IN_W + x0] = v;
    }
    return out;
  }

  // Test-time augmentation: solve the original + dilated + eroded image and
  // vote. Prefer 5-char reads (HOTH length); among those take the highest
  // minimum per-char confidence. A read agreed on by 2+ variants wins ties.
  function solveRGBA(rgba, w, h) {
    const x = preprocessRGBA(rgba, w, h);
    if (!x) return { text: '', conf: 0, n: 0 };
    const variants = [forward(x), forward(morph(x, true)), forward(morph(x, false))];
    const tally = new Map();
    for (const r of variants) if (r.text) {
      const e = tally.get(r.text) || { text: r.text, votes: 0, conf: 0 };
      e.votes++; if (r.conf > e.conf) e.conf = r.conf;
      tally.set(r.text, e);
    }
    const cand = [...tally.values()];
    if (!cand.length) return { text: '', conf: 0, n: 0 };
    cand.sort((a, b) => {
      const fa = a.text.length === 5, fb = b.text.length === 5;
      if (fa !== fb) return fa ? -1 : 1;          // 5-char reads first
      if (a.votes !== b.votes) return b.votes - a.votes;  // more agreement
      return b.conf - a.conf;                     // then confidence
    });
    const best = cand[0];
    return { text: best.text, conf: best.conf, n: best.text.length };
  }
  function solveImage(imgEl) {
    const w = imgEl.naturalWidth || imgEl.width, h = imgEl.naturalHeight || imgEl.height;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(imgEl, 0, 0);
    return solveRGBA(ctx.getImageData(0, 0, w, h).data, w, h);
  }

  root.InkwellCNN = {
    loadModel, setModel, forward, preprocessRGBA, solveRGBA, solveImage,
    setDebugLogits,
    get ready() { return !!W; },
  };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : global));
