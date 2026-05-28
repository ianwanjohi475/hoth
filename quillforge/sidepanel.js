// ============================================================================
//  Quillforge — Side Panel Controller
// ============================================================================

// ---------- Constants -------------------------------------------------------
const PROTECTED_PIN     = '4759';
const DEFAULT_GROQ_KEY  = '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';
const GROQ_MODEL        = 'llama-3.1-8b-instant';
const RIDGE_DEFAULT_KEY = '4qNzAeraznT1SvoUvF2gPC9J0L6G1J0O';
const WRITER_URL        = 'https://www.thehoth.com/writer';

// ============================================================================
//  Icon library — Lucide SVGs resolved into [data-icon] placeholders
// ============================================================================
const ICONS = {
  eye:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  alert:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  feather:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><path d="m16 8-9 9"/><path d="M12 17H7"/></svg>',
  key:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>',
  bolt:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>',
  chevron:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  search:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  external:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>',
  'volume-x':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>',
  plug:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/></svg>',
  lock:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  unlock:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>',
  check:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  x:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  save:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
  play:      '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
  stop:      '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
  refresh:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>',
  info:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
};

function renderIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.getAttribute('data-icon');
    if (ICONS[name]) el.innerHTML = ICONS[name];
  });
}
renderIcons();

// ============================================================================
//  Element refs
// ============================================================================
const $ = id => document.getElementById(id);

const watcherEnabledEl = $('watcherEnabled');
const autoClickEl      = $('autoClick');
const alarmDurationEl  = $('alarmDuration');
const alarmDurationVal = $('alarmDurationVal');
const checkIntervalEl  = $('checkInterval');
const checkIntervalVal = $('checkIntervalVal');
const intervalDesc     = $('intervalDesc');
const spintaxEnabledEl = $('spintaxEnabled');
const emailEnabledEl   = $('emailEnabled');
const writerEnabledEl  = $('writerEnabled');
const autoModeEl       = $('autoMode');
const autoSubmitEl     = $('autoSubmit');
const waitTimeEl       = $('waitTime');
const waitTimeVal      = $('waitTimeVal');

const watcherBadge   = $('watcherBadge');
const spintaxBadge   = $('spintaxBadge');
const writerBadge    = $('writerBadge');
const masterPill     = $('masterPill');
const masterPillText = $('masterPillText');

const apiKeyText     = $('apiKeyText');
const lockStatus     = $('lockStatus');
const pinArea        = $('pinArea');
const keyEditArea    = $('keyEditArea');
const pinInput       = $('pinInput');
const keyInput       = $('keyInput');
const changeKeyBtn   = $('changeKeyBtn');
const pinCancelBtn   = $('pinCancelBtn');
const pinConfirmBtn  = $('pinConfirmBtn');
const keyCancelBtn   = $('keyCancelBtn');
const keySaveBtn     = $('keySaveBtn');

const apiDot         = $('apiDot');
const apiStatusText  = $('apiStatusText');

const saveBtn        = $('saveBtn');
const stopAllBtn     = $('stopAllBtn');
const checkNowBtn    = $('checkNowBtn');
const openWriterBtn  = $('openWriterBtn');
const stopAlarmBtn   = $('stopAlarmBtn');
const writeNowBtn    = $('writeNowBtn');
const testApiBtn     = $('testApiBtn');

const toast       = $('toast');
const alertAudio  = $('alertAudio');

// ============================================================================
//  Audio cue helper
// ============================================================================
let audioPlaying = false;
function playAlert(duration = 1200) {
  if (audioPlaying) return;
  audioPlaying = true;
  alertAudio.currentTime = 0;
  alertAudio.volume = 0.7;
  alertAudio.play().catch(() => {});
  setTimeout(() => {
    alertAudio.pause();
    alertAudio.currentTime = 0;
    audioPlaying = false;
  }, duration);
}

// ============================================================================
//  Toast
// ============================================================================
let toastTimer = null;
function showToast(message, tone = 'info', { icon, sound = false, duration = 2400 } = {}) {
  if (toastTimer) clearTimeout(toastTimer);
  const ico = icon || (tone === 'ok' ? 'check' : tone === 'err' ? 'x' : tone === 'warn' ? 'alert' : 'info');
  toast.innerHTML = `${ICONS[ico] || ''}<span>${message}</span>`;
  toast.dataset.tone = tone;
  toast.classList.add('is-visible');
  if (sound) playAlert();
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), duration);
}

// ============================================================================
//  Section collapse/expand
// ============================================================================
document.querySelectorAll('.section-head').forEach(head => {
  const target = head.dataset.target;
  const section = head.closest('.section');
  const toggle = () => {
    const isOpen = section.dataset.open === 'true';
    section.dataset.open = String(!isOpen);
    head.setAttribute('aria-expanded', String(!isOpen));
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
});

// ============================================================================
//  Load HOTH settings
// ============================================================================
let currentApiKey = DEFAULT_GROQ_KEY;

function maskGroqKey(key) {
  if (!key || key.length < 12) return 'gsk_••••••••••••••••••••••••••••••••';
  return key.slice(0, 7) + '••••••••••••••••••••' + key.slice(-4);
}
function maskRidgeKey(key) {
  if (!key || key.length < 8) return '••••••••••••••••••••••••••••••••';
  return key.slice(0, 4) + '••••••••••••••••••••' + key.slice(-4);
}

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
  groqApiKey:     DEFAULT_GROQ_KEY,
  groqModel:      GROQ_MODEL,
}, (data) => {
  watcherEnabledEl.checked = data.watcherEnabled;
  autoClickEl.checked      = data.autoClick;
  alarmDurationEl.value    = data.alarmDuration;
  alarmDurationVal.textContent = `${data.alarmDuration}s`;
  checkIntervalEl.value    = data.checkInterval;
  checkIntervalVal.textContent = `${data.checkInterval}s`;
  intervalDesc.textContent = `Scan for the Edit button every ${data.checkInterval} second${data.checkInterval === 1 ? '' : 's'}`;
  spintaxEnabledEl.checked = data.spintaxEnabled;
  emailEnabledEl.checked   = data.emailEnabled;
  writerEnabledEl.checked  = data.writerEnabled;
  autoModeEl.checked       = data.autoMode;
  autoSubmitEl.checked     = data.autoSubmit;
  waitTimeEl.value         = data.waitTime;
  waitTimeVal.textContent  = `${data.waitTime}s`;

  currentApiKey = data.groqApiKey || DEFAULT_GROQ_KEY;
  apiKeyText.textContent = maskGroqKey(currentApiKey);

  updateBadges(data);
  syncPresets();
});

// ============================================================================
//  Badge / master status
// ============================================================================
function updateBadge(el, on) {
  el.textContent = on ? 'On' : 'Off';
  el.dataset.state = on ? 'on' : 'off';
}
function updateBadges(data) {
  updateBadge(watcherBadge, data.watcherEnabled);
  updateBadge(spintaxBadge, data.spintaxEnabled);
  updateBadge(writerBadge,  data.writerEnabled);
  const anyOn = data.watcherEnabled || data.spintaxEnabled || data.writerEnabled;
  masterPill.dataset.state = anyOn ? 'active' : 'paused';
  masterPillText.textContent = anyOn ? 'Active' : 'Paused';
}
[watcherEnabledEl, spintaxEnabledEl, writerEnabledEl].forEach(el => {
  el.addEventListener('change', () => {
    updateBadges({
      watcherEnabled: watcherEnabledEl.checked,
      spintaxEnabled: spintaxEnabledEl.checked,
      writerEnabled:  writerEnabledEl.checked,
    });
  });
});

// ============================================================================
//  Sliders & presets
// ============================================================================
alarmDurationEl.addEventListener('input', () => {
  const v = parseInt(alarmDurationEl.value);
  alarmDurationVal.textContent = `${v}s`;
  syncPresetGroup('alarm', v);
});
checkIntervalEl.addEventListener('input', () => {
  const v = parseInt(checkIntervalEl.value);
  checkIntervalVal.textContent = `${v}s`;
  intervalDesc.textContent = `Scan for the Edit button every ${v} second${v === 1 ? '' : 's'}`;
  syncPresetGroup('interval', v);
});
waitTimeEl.addEventListener('input', () => {
  const v = parseInt(waitTimeEl.value);
  waitTimeVal.textContent = `${v}s`;
  syncPresetGroup('wait', v);
});

function syncPresetGroup(group, val) {
  document.querySelectorAll(`.presets[data-group="${group}"] .preset`).forEach(btn => {
    btn.classList.toggle('is-active', parseFloat(btn.dataset.val) === parseFloat(val));
  });
}
function syncPresets() {
  syncPresetGroup('alarm',    parseInt(alarmDurationEl.value));
  syncPresetGroup('interval', parseInt(checkIntervalEl.value));
  syncPresetGroup('wait',     parseInt(waitTimeEl.value));
}
document.querySelectorAll('.preset').forEach(btn => {
  btn.addEventListener('click', () => {
    const group = btn.closest('.presets').dataset.group;
    const val   = parseFloat(btn.dataset.val);
    if (group === 'alarm') {
      alarmDurationEl.value = val;
      alarmDurationVal.textContent = `${val}s`;
    } else if (group === 'interval') {
      checkIntervalEl.value = val;
      checkIntervalVal.textContent = `${val}s`;
      intervalDesc.textContent = `Scan for the Edit button every ${val} second${val === 1 ? '' : 's'}`;
    } else if (group === 'wait') {
      waitTimeEl.value = val;
      waitTimeVal.textContent = `${val}s`;
    } else if (group === 'ridgeDelay') {
      ridgeDelayEl.value = val;
      ridgeDelayVal.textContent = `${val}s`;
    }
    syncPresetGroup(group, val);
  });
});

// ============================================================================
//  API key PIN protection (Groq)
// ============================================================================
let pinAttempts = 0;

changeKeyBtn.addEventListener('click', () => {
  changeKeyBtn.classList.add('hidden');
  lockStatus.classList.add('hidden');
  pinArea.classList.add('is-open');
  pinInput.value = '';
  pinInput.focus();
});
pinCancelBtn.addEventListener('click', () => closePin());
function closePin() {
  pinArea.classList.remove('is-open');
  changeKeyBtn.classList.remove('hidden');
  lockStatus.classList.remove('hidden');
  pinInput.value = '';
  pinAttempts = 0;
}
pinConfirmBtn.addEventListener('click', confirmPin);
pinInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  confirmPin();
  if (e.key === 'Escape') closePin();
});

function confirmPin() {
  if (pinInput.value === PROTECTED_PIN) {
    pinAttempts = 0;
    pinArea.classList.remove('is-open');
    keyEditArea.classList.add('is-open');
    keyInput.value = currentApiKey;
    keyInput.focus();
    keyInput.select();
    lockStatus.classList.add('hidden');
    changeKeyBtn.classList.add('hidden');
    showToast('Unlocked — edit your API key', 'ok', { icon: 'unlock' });
  } else {
    pinAttempts++;
    playAlert(700);
    if (pinAttempts >= 3) {
      showToast('Too many failed attempts', 'err');
      closePin();
    } else {
      showToast(`Wrong PIN (${pinAttempts}/3 attempts)`, 'err');
      pinInput.value = '';
      pinInput.focus();
    }
  }
}

keyCancelBtn.addEventListener('click', () => {
  keyEditArea.classList.remove('is-open');
  changeKeyBtn.classList.remove('hidden');
  lockStatus.classList.remove('hidden');
  keyInput.value = '';
});

keySaveBtn.addEventListener('click', () => {
  const newKey = keyInput.value.trim();
  if (!newKey.startsWith('gsk_')) {
    playAlert(600);
    showToast('Key must start with gsk_', 'err');
    return;
  }
  currentApiKey = newKey;
  apiKeyText.textContent = maskGroqKey(currentApiKey);
  keyEditArea.classList.remove('is-open');
  changeKeyBtn.classList.remove('hidden');
  lockStatus.classList.remove('hidden');
  keyInput.value = '';
  showToast('API key updated', 'ok');
});

// ============================================================================
//  Save settings
// ============================================================================
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
    chrome.runtime.sendMessage({ type: 'BROADCAST_SETTINGS', settings });
    showToast('Settings saved', 'ok');
  });
});

// ============================================================================
//  Quick actions
// ============================================================================
stopAllBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_ALL_ALARMS' });
  showToast('Stopping all alarms…', 'warn');
});

stopAlarmBtn.addEventListener('click', () => {
  chrome.tabs.query({ url: `${WRITER_URL}*` }, (tabs) => {
    tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, { type: 'STOP_ALARM' }).catch(() => {}));
  });
  chrome.runtime.sendMessage({ type: 'STOP_ALL_ALARMS' });
  showToast('Alarm stopped', 'warn');
});

checkNowBtn.addEventListener('click', () => {
  chrome.tabs.query({ url: `${WRITER_URL}*` }, (tabs) => {
    if (!tabs.length) { playAlert(500); showToast('Writer page not open', 'warn'); return; }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'MANUAL_CHECK' }, () => {
      showToast('Checking now…', 'info');
    });
  });
});

openWriterBtn.addEventListener('click', () => {
  chrome.tabs.query({ url: `${WRITER_URL}*` }, (tabs) => {
    if (tabs.length) chrome.tabs.update(tabs[0].id, { active: true });
    else chrome.tabs.create({ url: WRITER_URL });
  });
});

writeNowBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'MANUAL_WRITE' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        playAlert(500);
        showToast('No job page detected on this tab', 'warn');
      } else {
        showToast('Article composer started', 'ok');
      }
    });
  });
});

// ============================================================================
//  Test Groq API
// ============================================================================
testApiBtn.addEventListener('click', async () => {
  testApiBtn.disabled = true;
  const original = testApiBtn.innerHTML;
  testApiBtn.innerHTML = `${ICONS.refresh.replace('<svg', '<svg class="spin"')}<span>Testing…</span>`;
  apiStatusText.textContent = 'Testing connection…';
  apiDot.dataset.tone = 'warn';

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${currentApiKey}`,
      },
      body: JSON.stringify({
        model:      GROQ_MODEL,
        max_tokens: 10,
        messages:   [{ role: 'user', content: 'Reply: CONNECTED' }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    apiDot.dataset.tone = 'ok';
    apiStatusText.textContent = `API connected · ${GROQ_MODEL}`;
    showToast('API working — model ready', 'ok');
  } catch (err) {
    playAlert(700);
    apiDot.dataset.tone = 'err';
    apiStatusText.textContent = err.message.slice(0, 60);
    showToast(err.message.slice(0, 40), 'err');
  } finally {
    testApiBtn.disabled = false;
    testApiBtn.innerHTML = original;
  }
});

// ============================================================================
//  RIDGE NEURAL SOLVER (popup-side controller)
// ============================================================================
let ridgeCurrentKey      = RIDGE_DEFAULT_KEY;
let ridgeAutosolveActive = false;
let ridgePinAttempts     = 0;

const ridgeKeyText        = $('ridgeKeyText');
const ridgeLockStatus     = $('ridgeLockStatus');
const ridgePinArea        = $('ridgePinArea');
const ridgeKeyEditArea    = $('ridgeKeyEditArea');
const ridgePinInput       = $('ridgePinInput');
const ridgeKeyInput       = $('ridgeKeyInput');
const ridgeChangeKeyBtn   = $('ridgeChangeKeyBtn');
const ridgePinCancelBtn   = $('ridgePinCancelBtn');
const ridgePinConfirmBtn  = $('ridgePinConfirmBtn');
const ridgeKeyCancelBtn   = $('ridgeKeyCancelBtn');
const ridgeKeySaveBtn     = $('ridgeKeySaveBtn');
const ridgeCaptchaSel     = $('ridgeCaptchaSel');
const ridgeInputSel       = $('ridgeInputSel');
const ridgeSubmitSel      = $('ridgeSubmitSel');
const ridgeDelayEl        = $('ridgeDelay');
const ridgeDelayVal       = $('ridgeDelayVal');
const ridgeStartBtn       = $('ridgeStartBtn');
const ridgeSaveBtn        = $('ridgeSaveBtn');
const ridgeDot            = $('ridgeDot');
const ridgeStatusText     = $('ridgeStatusText');

chrome.storage.local.get({
  ridgeApiKey:      RIDGE_DEFAULT_KEY,
  captchaSelector:  '#writercaptcha > div:nth-child(2) > img:nth-child(1)',
  inputSelector:    'input[required]',
  submitSelector:   'input[type="submit"].btn.btn-success.btn-large',
  delay:            3,
  autosolveEnabled: false,
}, (data) => {
  ridgeCurrentKey = data.ridgeApiKey || RIDGE_DEFAULT_KEY;
  ridgeKeyText.textContent = maskRidgeKey(ridgeCurrentKey);
  ridgeCaptchaSel.value = data.captchaSelector;
  ridgeInputSel.value   = data.inputSelector;
  ridgeSubmitSel.value  = data.submitSelector;
  ridgeDelayEl.value    = data.delay;
  ridgeDelayVal.textContent = `${data.delay}s`;
  syncPresetGroup('ridgeDelay', parseFloat(data.delay));
  ridgeAutosolveActive = !!data.autosolveEnabled;
  updateRidgeUI();
});

function updateRidgeUI() {
  if (ridgeAutosolveActive) {
    ridgeStartBtn.className = 'btn btn-danger btn-sm';
    ridgeStartBtn.innerHTML = `${ICONS.stop}<span>Stop autosolve</span>`;
    ridgeDot.dataset.tone = 'ok';
    ridgeStatusText.textContent = 'Autosolve running';
  } else {
    ridgeStartBtn.className = 'btn btn-success btn-sm';
    ridgeStartBtn.innerHTML = `${ICONS.play}<span>Start autosolve</span>`;
    ridgeDot.dataset.tone = '';
    ridgeStatusText.textContent = 'Autosolve inactive';
  }
}

ridgeDelayEl.addEventListener('input', () => {
  const v = parseFloat(ridgeDelayEl.value);
  ridgeDelayVal.textContent = `${v}s`;
  syncPresetGroup('ridgeDelay', v);
});

ridgeChangeKeyBtn.addEventListener('click', () => {
  ridgeChangeKeyBtn.classList.add('hidden');
  ridgeLockStatus.classList.add('hidden');
  ridgePinArea.classList.add('is-open');
  ridgePinInput.value = '';
  ridgePinInput.focus();
});
ridgePinCancelBtn.addEventListener('click', closeRidgePin);
function closeRidgePin() {
  ridgePinArea.classList.remove('is-open');
  ridgeChangeKeyBtn.classList.remove('hidden');
  ridgeLockStatus.classList.remove('hidden');
  ridgePinInput.value = '';
  ridgePinAttempts = 0;
}
ridgePinConfirmBtn.addEventListener('click', confirmRidgePin);
ridgePinInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  confirmRidgePin();
  if (e.key === 'Escape') closeRidgePin();
});
function confirmRidgePin() {
  if (ridgePinInput.value === PROTECTED_PIN) {
    ridgePinAttempts = 0;
    ridgePinArea.classList.remove('is-open');
    ridgeKeyEditArea.classList.add('is-open');
    ridgeKeyInput.value = ridgeCurrentKey;
    ridgeKeyInput.focus();
    ridgeKeyInput.select();
    ridgeLockStatus.classList.add('hidden');
    ridgeChangeKeyBtn.classList.add('hidden');
    showToast('Unlocked — edit Ridge key', 'ok', { icon: 'unlock' });
  } else {
    ridgePinAttempts++;
    playAlert(700);
    if (ridgePinAttempts >= 3) {
      showToast('Too many failed attempts', 'err');
      closeRidgePin();
    } else {
      showToast(`Wrong PIN (${ridgePinAttempts}/3 attempts)`, 'err');
      ridgePinInput.value = '';
      ridgePinInput.focus();
    }
  }
}

ridgeKeyCancelBtn.addEventListener('click', () => {
  ridgeKeyEditArea.classList.remove('is-open');
  ridgeChangeKeyBtn.classList.remove('hidden');
  ridgeLockStatus.classList.remove('hidden');
  ridgeKeyInput.value = '';
});

ridgeKeySaveBtn.addEventListener('click', () => {
  const newKey = ridgeKeyInput.value.trim();
  if (!newKey) {
    playAlert(500);
    showToast('API key cannot be empty', 'err');
    return;
  }
  ridgeCurrentKey = newKey;
  ridgeKeyText.textContent = maskRidgeKey(ridgeCurrentKey);
  ridgeKeyEditArea.classList.remove('is-open');
  ridgeChangeKeyBtn.classList.remove('hidden');
  ridgeLockStatus.classList.remove('hidden');
  ridgeKeyInput.value = '';
  saveRidgeSettings();
  showToast('Ridge API key updated', 'ok');
});

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
  showToast('Solver settings saved', 'ok');
});

ridgeStartBtn.addEventListener('click', async () => {
  saveRidgeSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (ridgeAutosolveActive) {
    chrome.tabs.sendMessage(tab.id, { type: 'STOP_AUTOSOLVE' }).catch(() => {});
    ridgeAutosolveActive = false;
  } else {
    chrome.tabs.sendMessage(tab.id, { type: 'START_AUTOSOLVE' }, () => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript(
          { target: { tabId: tab.id }, files: ['content.js'] },
          () => setTimeout(() => chrome.tabs.sendMessage(tab.id, { type: 'START_AUTOSOLVE' }).catch(() => {}), 500)
        );
      }
    });
    ridgeAutosolveActive = true;
  }
  updateRidgeUI();
});
