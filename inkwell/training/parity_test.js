// Verify the pure-JS CTC forward+decode matches PyTorch logits exactly.
const fs = require('fs');
require('../captcha-cnn.js');
const API = global.InkwellCNN;
const model = JSON.parse(fs.readFileSync(__dirname + '/../model/weights.json'));
API.setModel(model);
const par = JSON.parse(fs.readFileSync(__dirname + '/../data/parity.json'));
const AL = model.alphabet;

function decode(logits) {        // logits: T x 63
  let s = '', prev = -1;
  for (const row of logits) {
    let best = 0, bv = -1e30;
    for (let k = 0; k < row.length; k++) if (row[k] > bv) { bv = row[k]; best = k; }
    if (best !== prev && best !== 0) s += AL[best - 1];
    prev = best;
  }
  return s;
}

let ok = 0;
for (let i = 0; i < par.inputs.length; i++) {
  const rows = par.inputs[i];
  const flat = new Float32Array(40 * 140);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 140; x++) flat[y * 140 + x] = rows[y][x];
  const js = API.forward(flat).text;
  const py = decode(par.logits[i]);
  if (js === py) ok++;
  console.log(`sample ${i}: JS="${js}"  PY="${py}"  ${js === py ? 'ok' : 'MISMATCH'}`);
}
console.log(`\nmatch ${ok}/${par.inputs.length}`);
console.log(ok === par.inputs.length ? 'PARITY OK ✓' : 'PARITY MISMATCH ✗');
