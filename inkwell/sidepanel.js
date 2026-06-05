// ─── Inkwell — Side Panel Script ─────────────────────────────────────────────

const PROTECTED_PIN  = '0000';   // Same PIN unlocks both Groq and Mistral keys
const DEFAULT_KEY    = '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';
const GROQ_MODEL     = 'llama-3.1-8b-instant';
const WRITER_URL     = 'https://www.thehoth.com/writer';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const watcherEnabledEl  = $('watcherEnabled');
const autoClickEl       = $('autoClick');
const alarmDurationEl   = $('alarmDuration');
const alarmDurationVal  = $('alarmDurationVal');
const checkIntervalEl   = $('checkInterval');
const checkIntervalVal  = $('checkIntervalVal');
const intervalDesc      = $('intervalDesc');
const spintaxEnabledEl  = $('spintaxEnabled');
const emailEnabledEl    = $('emailEnabled');
const writerEnabledEl   = $('writerEnabled');
const autoModeEl        = $('autoMode');
const autoSubmitEl      = $('autoSubmit');
const waitTimeEl        = $('waitTime');
const waitTimeVal       = $('waitTimeVal');

const watcherBadge  = $('watcherBadge');
const spintaxBadge  = $('spintaxBadge');
const writerBadge   = $('writerBadge');
const masterStatus  = $('masterStatus');

const apiKeyDisplay = $('apiKeyDisplay');
const lockStatus    = $('lockStatus');
const pinArea       = $('pinArea');
const keyEditArea   = $('keyEditArea');
const pinInput      = $('pinInput');
const keyInput      = $('keyInput');
const changeKeyBtn  = $('changeKeyBtn');
const pinCancelBtn  = $('pinCancelBtn');
const pinConfirmBtn = $('pinConfirmBtn');
const keyCancelBtn  = $('keyCancelBtn');
const keySaveBtn    = $('keySaveBtn');

const apiDot        = $('apiDot');
const apiStatusText = $('apiStatusText');

const saveBtn       = $('saveBtn');
const stopAllBtn    = $('stopAllBtn');
const checkNowBtn   = $('checkNowBtn');
const openWriterBtn = $('openWriterBtn');
const stopAlarmBtn  = $('stopAlarmBtn');
const writeNowBtn   = $('writeNowBtn');
const testApiBtn    = $('testApiBtn');

const toast         = $('toast');
const alertAudio    = $('alertAudio');

// ── Audio alert ───────────────────────────────────────────────────────────────
let audioPlaying = false;
function playAlert(duration = 1200) {
  if (audioPlaying) return;
  audioPlaying = true;
  alertAudio.currentTime = 0;
  alertAudio.volume = 0.8;
  alertAudio.play().catch(() => {});
  setTimeout(() => {
    alertAudio.pause();
    alertAudio.currentTime = 0;
    audioPlaying = false;
  }, duration);
}

// ── Toast helper ──────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = '', playSound = false, duration = 2500) {
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent  = msg;
  toast.className    = `show ${type}`;
  if (playSound) playAlert();
  toastTimer = setTimeout(() => {
    toast.className = type;
  }, duration);
}

// ── Section collapse/expand ───────────────────────────────────────────────────
document.querySelectorAll('.section-header').forEach(header => {
  header.addEventListener('click', () => {
    const targetId = header.dataset.target;
    const body     = $(targetId);
    const chevron  = header.querySelector('.chevron');
    if (!body || !chevron) return;
    const isOpen = body.classList.contains('expanded');
    body.classList.toggle('expanded',  !isOpen);
    body.classList.toggle('collapsed',  isOpen);
    chevron.classList.toggle('open', !isOpen);
  });
});

// ── Load settings ─────────────────────────────────────────────────────────────
let currentApiKey = DEFAULT_KEY;

chrome.storage.sync.get({
  watcherEnabled: true,
  autoClick:      true,
  alarmDuration:  10,
  checkInterval:  10,
  spintaxEnabled: true,
  emailEnabled:   true,
  writerEnabled:  true,
  autoMode:       false,
  autoSubmit:     false,
  waitTime:       5,
  groqApiKey:     DEFAULT_KEY,
  groqModel:      GROQ_MODEL,
}, (data) => {
  watcherEnabledEl.checked = data.watcherEnabled;
  autoClickEl.checked      = data.autoClick;
  alarmDurationEl.value    = data.alarmDuration;
  alarmDurationVal.textContent = data.alarmDuration + 's';
  checkIntervalEl.value    = data.checkInterval;
  checkIntervalVal.textContent = data.checkInterval + 's';
  intervalDesc.textContent = `Scan for "Edit" button every ${data.checkInterval} second${data.checkInterval === 1 ? '' : 's'}`;

  spintaxEnabledEl.checked = data.spintaxEnabled;
  emailEnabledEl.checked   = data.emailEnabled;

  writerEnabledEl.checked  = data.writerEnabled;
  autoModeEl.checked       = data.autoMode;
  autoSubmitEl.checked     = data.autoSubmit;
  waitTimeEl.value         = data.waitTime;
  waitTimeVal.textContent  = data.waitTime + 's';

  currentApiKey = data.groqApiKey || DEFAULT_KEY;
  updateApiKeyDisplay(currentApiKey);
  updateBadges(data);
  syncPresets();
});

// ── Mask API key for display ──────────────────────────────────────────────────
function maskKey(key) {
  if (!key || key.length < 12) return 'gsk_••••••••••••••••••••••••••••••••';
  return key.slice(0, 7) + '••••••••••••••••••••' + key.slice(-4);
}

function updateApiKeyDisplay(key) {
  apiKeyDisplay.textContent = maskKey(key);
}

// ── Badge & master status updates ─────────────────────────────────────────────
function updateBadge(el, on) {
  el.textContent  = on ? 'ON' : 'OFF';
  el.className    = `section-badge ${on ? 'badge-on' : 'badge-off'}`;
}

function updateBadges(data) {
  updateBadge(watcherBadge, data.watcherEnabled);
  updateBadge(spintaxBadge, data.spintaxEnabled);
  updateBadge(writerBadge,  data.writerEnabled);
  const anyOn = data.watcherEnabled || data.spintaxEnabled || data.writerEnabled;
  masterStatus.textContent = anyOn ? 'ACTIVE' : 'PAUSED';
  masterStatus.className   = `master-status ${anyOn ? 'on' : 'off'}`;
}

// Keep badges in sync with toggle changes in real time
[watcherEnabledEl, spintaxEnabledEl, writerEnabledEl].forEach(el => {
  el.addEventListener('change', () => {
    updateBadges({
      watcherEnabled: watcherEnabledEl.checked,
      spintaxEnabled: spintaxEnabledEl.checked,
      writerEnabled:  writerEnabledEl.checked,
    });
  });
});

// ── Slider live updates ───────────────────────────────────────────────────────
alarmDurationEl.addEventListener('input', () => {
  const v = parseInt(alarmDurationEl.value);
  alarmDurationVal.textContent = v + 's';
  syncPresetsForGroup('alarm', v);
});

checkIntervalEl.addEventListener('input', () => {
  const v = parseInt(checkIntervalEl.value);
  checkIntervalVal.textContent = v + 's';
  intervalDesc.textContent = `Scan for "Edit" button every ${v} second${v === 1 ? '' : 's'}`;
  syncPresetsForGroup('interval', v);
});

waitTimeEl.addEventListener('input', () => {
  const v = parseInt(waitTimeEl.value);
  waitTimeVal.textContent = v + 's';
  syncPresetsForGroup('wait', v);
});

// ── Preset buttons ────────────────────────────────────────────────────────────
function syncPresetsForGroup(group, val) {
  document.querySelectorAll(`.preset-btn[data-group="${group}"]`).forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.val) === val);
  });
}

function syncPresets() {
  syncPresetsForGroup('alarm',    parseInt(alarmDurationEl.value));
  syncPresetsForGroup('interval', parseInt(checkIntervalEl.value));
  syncPresetsForGroup('wait',     parseInt(waitTimeEl.value));
}

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const group = btn.dataset.group;
    const val   = parseInt(btn.dataset.val);
    if (group === 'alarm') {
      alarmDurationEl.value = val;
      alarmDurationVal.textContent = val + 's';
    } else if (group === 'interval') {
      checkIntervalEl.value = val;
      checkIntervalVal.textContent = val + 's';
      intervalDesc.textContent = `Scan for "Edit" button every ${val} second${val === 1 ? '' : 's'}`;
    } else if (group === 'wait') {
      waitTimeEl.value = val;
      waitTimeVal.textContent = val + 's';
    }
    syncPresetsForGroup(group, val);
  });
});

// ── API Key PIN protection ────────────────────────────────────────────────────
let pinAttempts = 0;

changeKeyBtn.addEventListener('click', () => {
  changeKeyBtn.style.display = 'none';
  lockStatus.style.display   = 'none';
  pinArea.classList.add('visible');
  pinInput.value = '';
  pinInput.focus();
});

pinCancelBtn.addEventListener('click', () => {
  pinArea.classList.remove('visible');
  changeKeyBtn.style.display = 'block';
  lockStatus.style.display   = 'flex';
  pinInput.value = '';
  pinAttempts    = 0;
});

pinConfirmBtn.addEventListener('click', () => confirmPin());
pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmPin(); });

function confirmPin() {
  if (pinInput.value === PROTECTED_PIN) {
    pinAttempts = 0;
    pinArea.classList.remove('visible');
    // Show key edit area
    keyEditArea.classList.add('visible');
    keyInput.value = currentApiKey;
    keyInput.focus();
    keyInput.select();
    lockStatus.style.display = 'none';
    changeKeyBtn.style.display = 'none';
    showToast('🔓 Unlocked — edit your API key', 'ok');
  } else {
    pinAttempts++;
    playAlert(800);
    if (pinAttempts >= 3) {
      showToast('❌ Too many failed attempts', 'err', false);
      pinArea.classList.remove('visible');
      changeKeyBtn.style.display = 'block';
      lockStatus.style.display   = 'flex';
      pinInput.value = '';
      pinAttempts    = 0;
    } else {
      showToast(`❌ Wrong PIN (${pinAttempts}/3 attempts)`, 'err', false);
      pinInput.value = '';
      pinInput.focus();
    }
  }
}

keyCancelBtn.addEventListener('click', () => {
  keyEditArea.classList.remove('visible');
  changeKeyBtn.style.display = 'block';
  lockStatus.style.display   = 'flex';
  keyInput.value = '';
});

keySaveBtn.addEventListener('click', () => {
  const newKey = keyInput.value.trim();
  if (!newKey.startsWith('gsk_')) {
    playAlert(600);
    showToast('❌ Key must start with gsk_', 'err');
    return;
  }
  currentApiKey = newKey;
  updateApiKeyDisplay(currentApiKey);
  keyEditArea.classList.remove('visible');
  changeKeyBtn.style.display = 'block';
  lockStatus.style.display   = 'flex';
  keyInput.value = '';
  showToast('✓ API key updated', 'ok');
});

// ── Save settings ─────────────────────────────────────────────────────────────
saveBtn.addEventListener('click', () => {
  const settings = {
    watcherEnabled: watcherEnabledEl.checked,
    autoClick:      autoClickEl.checked,
    alarmDuration:  parseInt(alarmDurationEl.value),
    checkInterval:  parseInt(checkIntervalEl.value),
    spintaxEnabled: spintaxEnabledEl.checked,
    emailEnabled:   emailEnabledEl.checked,
    writerEnabled:  writerEnabledEl.checked,
    autoMode:       autoModeEl.checked,
    autoSubmit:     autoSubmitEl.checked,
    waitTime:       parseInt(waitTimeEl.value),
    groqApiKey:     currentApiKey,
    groqModel:      GROQ_MODEL,
  };

  chrome.storage.sync.set(settings, () => {
    updateBadges(settings);
    // Broadcast to all content scripts
    chrome.runtime.sendMessage({ type: 'BROADCAST_SETTINGS', settings });
    showToast('✓ Settings saved!', 'ok');
  });
});

// ── Stop All Alarms ───────────────────────────────────────────────────────────
stopAllBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_ALL_ALARMS' });
  showToast('🔇 Stopping all alarms…', 'warn', false);
});

// ── Stop Alarm (watcher section) ──────────────────────────────────────────────
stopAlarmBtn.addEventListener('click', () => {
  chrome.tabs.query({ url: WRITER_URL + '*' }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: 'STOP_ALARM' }).catch(() => {});
    });
  });
  chrome.runtime.sendMessage({ type: 'STOP_ALL_ALARMS' });
  showToast('🔇 Alarm stopped', 'warn');
});

// ── Check Now (manual edit scan) ──────────────────────────────────────────────
checkNowBtn.addEventListener('click', () => {
  chrome.tabs.query({ url: WRITER_URL + '*' }, (tabs) => {
    if (tabs.length === 0) {
      playAlert(600);
      showToast('⚠ Writer page not open', 'warn');
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'MANUAL_CHECK' }, () => {
      showToast('🔍 Checking now…', '');
    });
  });
});

// ── Open Writer Tab ───────────────────────────────────────────────────────────
openWriterBtn.addEventListener('click', () => {
  chrome.tabs.query({ url: WRITER_URL + '*' }, (tabs) => {
    if (tabs.length > 0) chrome.tabs.update(tabs[0].id, { active: true });
    else chrome.tabs.create({ url: WRITER_URL });
  });
});

// ── Write Now (manual article trigger) ───────────────────────────────────────
writeNowBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'MANUAL_WRITE' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        playAlert(600);
        showToast('⚠ No job page detected on this tab', 'warn');
      } else {
        showToast('✍️ Article writer started!', 'ok');
      }
    });
  });
});

// ── Test API ──────────────────────────────────────────────────────────────────
testApiBtn.addEventListener('click', async () => {
  testApiBtn.disabled    = true;
  testApiBtn.textContent = '⏳ Testing…';
  apiStatusText.textContent = 'Testing connection…';
  apiDot.className = 'info-dot dot-orange';

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentApiKey}`
      },
      body: JSON.stringify({
        model:      GROQ_MODEL,
        max_tokens: 10,
        messages:   [{ role: 'user', content: 'Reply: CONNECTED' }]
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);

    apiDot.className      = 'info-dot dot-green';
    apiStatusText.textContent = `✅ API connected · ${GROQ_MODEL}`;
    showToast('✅ API working! Model ready.', 'ok');
  } catch (err) {
    playAlert(800);
    apiDot.className      = 'info-dot' ;
    apiDot.style.background = 'var(--red)';
    apiStatusText.textContent = `❌ ${err.message.slice(0, 50)}`;
    showToast(`❌ ${err.message.slice(0, 40)}`, 'err');
  } finally {
    testApiBtn.disabled    = false;
    testApiBtn.textContent = '🔌 Test API';
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  RIDGE NEURAL SOLVER — Popup Logic
// ═══════════════════════════════════════════════════════════════════════════════

const RIDGE_DEFAULT_KEY = 'AQ.Ab8RN6JAxNa4uMdd8587SJqKdqJm7cXOfdYiEnhbN5se6xKMVQ';

let ridgeCurrentKey        = RIDGE_DEFAULT_KEY;
let ridgeAutosolveActive   = false;
let ridgePinAttempts       = 0;

// DOM refs
const ridgeKeyDisplay    = $('ridgeKeyDisplay');
const ridgeLockStatus    = $('ridgeLockStatus');
const ridgePinArea       = $('ridgePinArea');
const ridgeKeyEditArea   = $('ridgeKeyEditArea');
const ridgePinInput      = $('ridgePinInput');
const ridgeKeyInput      = $('ridgeKeyInput');
const ridgeChangeKeyBtn  = $('ridgeChangeKeyBtn');
const ridgePinCancelBtn  = $('ridgePinCancelBtn');
const ridgePinConfirmBtn = $('ridgePinConfirmBtn');
const ridgeKeyCancelBtn  = $('ridgeKeyCancelBtn');
const ridgeKeySaveBtn    = $('ridgeKeySaveBtn');
const ridgeCaptchaSel    = $('ridgeCaptchaSel');
const ridgeInputSel      = $('ridgeInputSel');
const ridgeSubmitSel     = $('ridgeSubmitSel');
const ridgeDelayEl       = $('ridgeDelay');
const ridgeDelayVal      = $('ridgeDelayVal');
const ridgeStartBtn      = $('ridgeStartBtn');
const ridgeSaveBtn       = $('ridgeSaveBtn');
const ridgeDot           = $('ridgeDot');
const ridgeStatusText    = $('ridgeStatusText');
const exportSamplesBtn   = $('exportSamplesBtn');
const clearSamplesBtn    = $('clearSamplesBtn');
const samplesVerifiedEl  = $('samplesVerified');
const samplesTotalEl     = $('samplesTotal');
const samplesBar         = $('samplesBar');
const samplesPct         = $('samplesPct');
const samplesGallery     = $('samplesGallery');
const samplesEmpty       = $('samplesEmpty');

// ── Self-labeling collector UI (live) ──
// Samples live in chrome.storage.local under 'inkwellSamples'. We read them
// directly (works even when the sidebar isn't on a HOTH tab) and re-render
// instantly whenever storage changes — true real-time tracking.
const SAMPLES_KEY = 'inkwellSamples';
const SAMPLE_GOAL = 300;   // total collected images to aim for before sending

function renderSamples(arr) {
  arr = arr || [];
  const verified = arr.filter(s => s.verified).length;
  const total = arr.length;
  samplesVerifiedEl.textContent = verified;
  samplesTotalEl.textContent = total;
  // Progress tracks TOTAL collected images (what we send for labeling),
  // not verified — verified stays low until the model improves.
  const pct = Math.min(100, Math.round(100 * total / SAMPLE_GOAL));
  samplesBar.style.width = pct + '%';
  samplesPct.textContent = pct + '%';

  // live thumbnail feed: newest 10 captchas, most recent first
  const recent = arr.slice(-10).reverse();
  if (!recent.length) {
    if (samplesEmpty) samplesEmpty.style.display = '';
    samplesGallery.querySelectorAll('.smp-thumb').forEach(n => n.remove());
    return;
  }
  if (samplesEmpty) samplesEmpty.style.display = 'none';
  samplesGallery.querySelectorAll('.smp-thumb').forEach(n => n.remove());
  for (const s of recent) {
    const box = document.createElement('div');
    box.className = 'smp-thumb';
    box.title = (s.verified ? 'verified · ' : 'pending · ') + (s.text || '?');
    box.style.cssText =
      'border:1.5px solid ' + (s.verified ? '#2DD4BF' : '#ffaa0066') +
      ';border-radius:6px;overflow:hidden;width:64px;background:#0d1117;';
    box.innerHTML =
      `<img src="${s.png}" style="display:block;width:64px;height:auto">` +
      `<div style="font-size:9px;text-align:center;color:${s.verified ? '#2DD4BF' : '#ffaa00'};` +
      `font-family:monospace;padding:1px 0">${(s.text || '?')}</div>`;
    samplesGallery.appendChild(box);
  }
}

function refreshSamples() {
  chrome.storage.local.get([SAMPLES_KEY], (res) => renderSamples(res[SAMPLES_KEY]));
}
refreshSamples();

// Instant updates — fires the moment the content script saves a new sample.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SAMPLES_KEY]) renderSamples(changes[SAMPLES_KEY].newValue);
});

exportSamplesBtn?.addEventListener('click', () => {
  chrome.storage.local.get([SAMPLES_KEY], (res) => {
    const arr = res[SAMPLES_KEY] || [];
    if (!arr.length) {
      alert('No captchas collected yet. Run Autosolve on a HOTH writer page first — images appear in the live feed as they are collected.');
      return;
    }
    // Export ALL collected images (verified or not). Correct labels get
    // applied later during training, so every image is useful.
    const blob = new Blob([JSON.stringify(arr)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inkwell-captchas-${arr.length}-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
});

clearSamplesBtn?.addEventListener('click', () => {
  if (!confirm('Clear all collected captcha samples?')) return;
  chrome.storage.local.set({ [SAMPLES_KEY]: [] }, refreshSamples);
});

// ── Mask Ridge API key ────────────────────────────────────────────────────────
function maskRidgeKey(key) {
  if (!key || key.length < 8) return '••••••••••••••••••••••••••••••••';
  return key.slice(0, 4) + '••••••••••••••••••••' + key.slice(-4);
}

// ── Load Ridge settings ───────────────────────────────────────────────────────
chrome.storage.local.get({
  ridgeApiKey:      RIDGE_DEFAULT_KEY,
  captchaSelector:  '#writercaptcha > div:nth-child(2) > img:nth-child(1)',
  inputSelector:    'input[required]',
  submitSelector:   'input[type="submit"].btn.btn-success.btn-large',
  delay:            3,
  autosolveEnabled: false,
}, (data) => {
  // Migrate older installs: if the stored key isn't a Gemini key (e.g. the
  // old Mistral key), drop it and use the baked-in Gemini default instead.
  const stored = data.ridgeApiKey || '';
  const isGemini = stored.startsWith('AQ.') || stored.startsWith('AIza');
  ridgeCurrentKey = isGemini ? stored : RIDGE_DEFAULT_KEY;
  if (!isGemini) chrome.storage.local.set({ ridgeApiKey: RIDGE_DEFAULT_KEY });
  ridgeKeyDisplay.textContent = maskRidgeKey(ridgeCurrentKey);
  ridgeCaptchaSel.value  = data.captchaSelector;
  ridgeInputSel.value    = data.inputSelector;
  ridgeSubmitSel.value   = data.submitSelector;
  ridgeDelayEl.value     = data.delay;
  ridgeDelayVal.textContent = data.delay + 's';
  syncPresetsForGroup('ridgeDelay', parseFloat(data.delay));
  ridgeAutosolveActive = !!data.autosolveEnabled;
  updateRidgeUI();
});

// ── Ridge UI state ────────────────────────────────────────────────────────────
function updateRidgeUI() {
  if (ridgeAutosolveActive) {
    ridgeStartBtn.textContent = '■ Stop Autosolve';
    ridgeStartBtn.className   = 'btn btn-danger btn-sm';
    ridgeDot.className        = 'info-dot dot-green';
    ridgeStatusText.textContent = 'Autosolve running…';
  } else {
    ridgeStartBtn.textContent = '▶ Start Autosolve';
    ridgeStartBtn.className   = 'btn btn-green btn-sm';
    ridgeDot.className        = 'info-dot dot-grey';
    ridgeStatusText.textContent = 'Autosolve inactive';
  }
}

// ── Ridge delay slider ────────────────────────────────────────────────────────
ridgeDelayEl.addEventListener('input', () => {
  const v = parseFloat(ridgeDelayEl.value);
  ridgeDelayVal.textContent = v + 's';
  syncPresetsForGroup('ridgeDelay', v);
});

// ── Ridge PIN lock / unlock ───────────────────────────────────────────────────
ridgeChangeKeyBtn.addEventListener('click', () => {
  ridgeChangeKeyBtn.style.display = 'none';
  ridgeLockStatus.style.display   = 'none';
  ridgePinArea.classList.add('visible');
  ridgePinInput.value = '';
  ridgePinInput.focus();
});

ridgePinCancelBtn.addEventListener('click', () => {
  ridgePinArea.classList.remove('visible');
  ridgeChangeKeyBtn.style.display = 'block';
  ridgeLockStatus.style.display   = 'flex';
  ridgePinInput.value  = '';
  ridgePinAttempts = 0;
});

ridgePinConfirmBtn.addEventListener('click', confirmRidgePin);
ridgePinInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  confirmRidgePin();
  if (e.key === 'Escape') ridgePinCancelBtn.click();
});

function confirmRidgePin() {
  if (ridgePinInput.value === PROTECTED_PIN) {
    ridgePinAttempts = 0;
    ridgePinArea.classList.remove('visible');
    ridgeKeyEditArea.classList.add('visible');
    ridgeKeyInput.value = ridgeCurrentKey;
    ridgeKeyInput.focus();
    ridgeKeyInput.select();
    ridgeLockStatus.style.display   = 'none';
    ridgeChangeKeyBtn.style.display = 'none';
    showToast('🔓 Unlocked — edit Ridge API key', 'ok');
  } else {
    ridgePinAttempts++;
    playAlert(800);
    if (ridgePinAttempts >= 3) {
      showToast('❌ Too many failed attempts', 'err');
      ridgePinArea.classList.remove('visible');
      ridgeChangeKeyBtn.style.display = 'block';
      ridgeLockStatus.style.display   = 'flex';
      ridgePinInput.value = '';
      ridgePinAttempts = 0;
    } else {
      showToast(`❌ Wrong PIN (${ridgePinAttempts}/3 attempts)`, 'err');
      ridgePinInput.value = '';
      ridgePinInput.focus();
    }
  }
}

ridgeKeyCancelBtn.addEventListener('click', () => {
  ridgeKeyEditArea.classList.remove('visible');
  ridgeChangeKeyBtn.style.display = 'block';
  ridgeLockStatus.style.display   = 'flex';
  ridgeKeyInput.value = '';
});

ridgeKeySaveBtn.addEventListener('click', () => {
  const newKey = ridgeKeyInput.value.trim();
  if (!newKey) {
    playAlert(600);
    showToast('❌ API key cannot be empty', 'err');
    return;
  }
  ridgeCurrentKey = newKey;
  ridgeKeyDisplay.textContent = maskRidgeKey(ridgeCurrentKey);
  ridgeKeyEditArea.classList.remove('visible');
  ridgeChangeKeyBtn.style.display = 'block';
  ridgeLockStatus.style.display   = 'flex';
  ridgeKeyInput.value = '';
  saveRidgeSettings();
  showToast('✓ Ridge API key updated', 'ok');
});

// ── Save Ridge settings ───────────────────────────────────────────────────────
function saveRidgeSettings() {
  chrome.storage.local.set({
    ridgeApiKey:     ridgeCurrentKey,
    captchaSelector: ridgeCaptchaSel.value.trim(),
    inputSelector:   ridgeInputSel.value.trim(),
    submitSelector:  ridgeSubmitSel.value.trim(),
    delay:           parseFloat(ridgeDelayEl.value) || 0,
  });
}

ridgeSaveBtn.addEventListener('click', () => {
  saveRidgeSettings();
  showToast('✓ Solver settings saved', 'ok');
});

// ── Ridge start / stop autosolve ──────────────────────────────────────────────
ridgeStartBtn.addEventListener('click', async () => {
  saveRidgeSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (ridgeAutosolveActive) {
    chrome.tabs.sendMessage(tab.id, { type: 'STOP_AUTOSOLVE' });
    ridgeAutosolveActive = false;
  } else {
    chrome.tabs.sendMessage(tab.id, { type: 'START_AUTOSOLVE' }, (response) => {
      if (chrome.runtime.lastError) {
        // Content script not yet injected — inject it then start
        chrome.scripting.executeScript(
          { target: { tabId: tab.id }, files: ['content.js'] },
          () => setTimeout(() => chrome.tabs.sendMessage(tab.id, { type: 'START_AUTOSOLVE' }), 500)
        );
      }
    });
    ridgeAutosolveActive = true;
  }
  updateRidgeUI();
});
