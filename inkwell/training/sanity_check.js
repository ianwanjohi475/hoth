// Sanity-check: does the trained CTC model actually LEARN? Compare its
// first-try accuracy against random chance on held-out synthetic captchas.
const fs = require('fs');
require('../captcha-cnn.js');
const API = global.InkwellCNN;
API.setModel(JSON.parse(fs.readFileSync(__dirname + '/../model/weights.json')));

const meta = JSON.parse(fs.readFileSync(__dirname + '/../data/eval.json'));
const buf = fs.readFileSync(__dirname + '/../data/eval.bin');
const { n, w, h, labels } = meta;
const stride = w * h * 4;

let full = 0, charOK = 0, charTot = 0;
for (let i = 0; i < n; i++) {
  const rgba = new Uint8ClampedArray(buf.buffer, buf.byteOffset + i * stride, stride);
  const pred = API.solveRGBA(rgba, w, h).text, truth = labels[i];
  if (pred === truth) full++;
  for (let k = 0; k < truth.length; k++) { charTot++; if (pred[k] === truth[k]) charOK++; }
}
const charAcc = charOK / charTot, fullAcc = full / n;
const charChance = 1 / 62, fullChance = Math.pow(1 / 62, 5);
console.log(`per-char: ${(100*charAcc).toFixed(1)}%  (chance ${(100*charChance).toFixed(2)}%  ->  ${(charAcc/charChance).toFixed(0)}x better)`);
console.log(`full:     ${(100*fullAcc).toFixed(1)}%  (chance ${(100*fullChance).toExponential(1)})`);
const learns = charAcc > 0.40 && fullAcc > 0.20;
console.log(learns ? 'SANITY PASS: CTC model learns decisively' : 'SANITY FAIL');
process.exit(learns ? 0 : 1);
