// End-to-end JS accuracy: segmentation + CNN on fresh synthetic captchas.
const fs = require('fs');
require('../captcha-cnn.js');
const API = global.InkwellCNN;
API.setModel(JSON.parse(fs.readFileSync(__dirname + '/../model/weights.json')));

const meta = JSON.parse(fs.readFileSync(__dirname + '/../data/eval.json'));
const buf = fs.readFileSync(__dirname + '/../data/eval.bin');
const { n, w, h, labels } = meta;
const stride = w * h * 4;

let full = 0, charOK = 0, charTot = 0, lenOK = 0;
const fails = [];
for (let i = 0; i < n; i++) {
  const rgba = new Uint8ClampedArray(buf.buffer, buf.byteOffset + i * stride, stride);
  const r = API.solveRGBA(rgba, w, h);
  const pred = r.text, truth = labels[i];
  if (pred.length === truth.length) lenOK++;
  if (pred === truth) full++;
  // per-char (aligned by index up to min length)
  for (let k = 0; k < truth.length; k++) {
    charTot++;
    if (pred[k] === truth[k]) charOK++;
  }
  if (pred !== truth && fails.length < 25) fails.push(`${truth} -> ${pred}`);
}
console.log(`samples: ${n}`);
console.log(`length-correct (5 chars): ${(100*lenOK/n).toFixed(1)}%`);
console.log(`per-char accuracy:        ${(100*charOK/charTot).toFixed(2)}%`);
console.log(`FULL-captcha accuracy:    ${(100*full/n).toFixed(1)}%`);
console.log('sample failures:', fails.join('   '));
