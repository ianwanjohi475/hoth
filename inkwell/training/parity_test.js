// Verify the pure-JS CNN forward pass matches PyTorch exactly.
const fs = require('fs');
const cnn = require('../captcha-cnn.js');   // attaches to global
const API = global.InkwellCNN;

const model = JSON.parse(fs.readFileSync(__dirname + '/../model/weights.json'));
API.setModel(model);
const par = JSON.parse(fs.readFileSync(__dirname + '/../data/parity.json'));

let maxLogitErr = 0, agree = 0;
for (let i = 0; i < par.inputs.length; i++) {
  const flat = new Float32Array(32 * 32);
  const rows = par.inputs[i];
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) flat[y * 32 + x] = rows[y][x];
  const r = API.classify(flat, par.feats[i]);
  // compare logits
  let err = 0, jsBest = 0, jsBestV = -1e9, pyBest = 0, pyBestV = -1e9;
  for (let k = 0; k < 62; k++) {
    err = Math.max(err, Math.abs(r.logits[k] - par.logits[i][k]));
    if (r.logits[k] > jsBestV) { jsBestV = r.logits[k]; jsBest = k; }
    if (par.logits[i][k] > pyBestV) { pyBestV = par.logits[i][k]; pyBest = k; }
  }
  maxLogitErr = Math.max(maxLogitErr, err);
  if (jsBest === pyBest) agree++;
  console.log(`sample ${i}: argmax JS=${model.alphabet[jsBest]} PY=${model.alphabet[pyBest]} maxLogitErr=${err.toFixed(4)}`);
}
console.log(`\nMAX logit error across samples: ${maxLogitErr.toFixed(5)}`);
console.log(`argmax agreement: ${agree}/${par.inputs.length}`);
console.log(maxLogitErr < 0.02 && agree === par.inputs.length
  ? 'PARITY OK ✓ (JS == PyTorch)'
  : 'PARITY MISMATCH ✗');
