// Find the confidence threshold where SUBMITTED answers are ~100% correct.
// Everything below threshold is refreshed for free, so precision is what
// matters for "accuracy when solving".
const fs = require('fs');
require('../captcha-cnn.js');
const API = global.InkwellCNN;
API.setModel(JSON.parse(fs.readFileSync(__dirname + '/../model/weights.json')));
const meta = JSON.parse(fs.readFileSync(__dirname + '/../data/eval.json'));
const buf = fs.readFileSync(__dirname + '/../data/eval.bin');
const { n, w, h, labels } = meta, stride = w * h * 4;

const rows = [];
for (let i = 0; i < n; i++) {
  const rgba = new Uint8ClampedArray(buf.buffer, buf.byteOffset + i * stride, stride);
  const r = API.solveRGBA(rgba, w, h);
  rows.push({ conf: r.conf, len5: r.text.length === 5, correct: r.text === labels[i] });
}
console.log('thr  | submit% | precision(correct|submitted) | first-try-overall');
for (const thr of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99]) {
  // "submit" = 5 chars AND conf>=thr
  const sub = rows.filter(r => r.len5 && r.conf >= thr);
  const corr = sub.filter(r => r.correct).length;
  const prec = sub.length ? (100 * corr / sub.length) : 0;
  const cover = 100 * sub.length / n;
  console.log(`${thr.toFixed(2)} | ${cover.toFixed(1).padStart(6)}% | ${prec.toFixed(1).padStart(6)}% (${corr}/${sub.length}) | ${(100*corr/n).toFixed(1)}%`);
}
