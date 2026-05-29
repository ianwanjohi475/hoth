// ============================================================================
//  Quillforge — Side Panel Controller (v2 "Atelier")
// ============================================================================

// ---------- Constants -------------------------------------------------------
const PROTECTED_PIN     = '0000';   // Groq API key unlock
const RIDGE_PIN         = '0000';   // Ridge / Mistral API key unlock
const DEFAULT_GROQ_KEY  = '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';
const DEFAULT_GEMINI_KEY = 'AQ.Ab8RN6L0daqPlYRJLoDPmuDb6wNm2MY6w_pr-O7dPoQ1UHtk0Q';
const GROQ_MODEL        = 'llama-3.1-8b-instant';
const RIDGE_DEFAULT_KEY = '4qNzAeraznT1SvoUvF2gPC9J0L6G1J0O';
const WRITER_URL        = 'https://www.thehoth.com/writer';

// ============================================================================
//  Icon registry — Lucide SVGs resolved into [data-icon] placeholders
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
  cpu:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>',
  crosshair: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/></svg>',
};

function renderIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.getAttribute('data-icon');
    if (ICONS[name] && !el.firstElementChild) el.innerHTML = ICONS[name];
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
const watcherSub       = $('watcherSub');

const spintaxEnabledEl = $('spintaxEnabled');
const emailEnabledEl   = $('emailEnabled');
const spintaxSub       = $('spintaxSub');

const writerEnabledEl  = $('writerEnabled');
const autoModeEl       = $('autoMode');
const autoSubmitEl     = $('autoSubmit');
const waitTimeEl       = $('waitTime');
const waitTimeVal      = $('waitTimeVal');
const writerSub        = $('writerSub');

const heroPill       = $('heroPill');
const heroPillText   = $('heroPillText');
const heroCount      = $('heroCount');

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
const reloadBtn      = $('reloadBtn');

const toast          = $('toast');
const alertAudio     = $('alertAudio');

// ============================================================================
//  Audio cue helper
// ============================================================================
let audioPlaying = false;
function playAlert(duration = 1000) {
  if (audioPlaying) return;
  audioPlaying = true;
  alertAudio.currentTime = 0;
  alertAudio.volume = 0.6;
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
function showToast(message, tone = 'info', { icon, sound = false, duration = 2500 } = {}) {
  if (toastTimer) clearTimeout(toastTimer);
  const ico = icon || (tone === 'ok' ? 'check' : tone === 'err' ? 'x' : tone === 'warn' ? 'alert' : 'info');
  toast.innerHTML = `${ICONS[ico] || ''}<span>${message}</span>`;
  toast.dataset.tone = tone;
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  if (sound) playAlert();
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), duration);
}

// ============================================================================
//  Module open / close + hero chip jump
// ============================================================================
document.querySelectorAll('[data-toggle]').forEach(head => {
  const article = head.closest('.module');
  const toggle = (e) => {
    if (e.target.closest('[data-stop]')) return; // don't toggle when clicking switch
    const open = article.dataset.open !== 'true';
    article.dataset.open = String(open);
    head.setAttribute('aria-expanded', String(open));
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); }
  });
});

document.querySelectorAll('.hero-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const targetId = chip.dataset.target;
    const article = $(targetId);
    if (!article) return;
    article.dataset.open = 'true';
    article.querySelector('.module-head').setAttribute('aria-expanded', 'true');
    article.scrollIntoView({ behavior: 'smooth', block: 'start' });
    article.animate(
      [
        { boxShadow: '0 0 0 0 rgba(139,92,246,0.0)' },
        { boxShadow: '0 0 0 4px rgba(139,92,246,0.35)' },
        { boxShadow: '0 0 0 0 rgba(139,92,246,0.0)' },
      ],
      { duration: 900, easing: 'ease-out' }
    );
  });
});

// ============================================================================
//  Range "fill" CSS variable + value text + presets + sub-summaries
// ============================================================================
function setRangeFill(el) {
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 100;
  const val = parseFloat(el.value);
  const pct = ((val - min) / (max - min)) * 100;
  el.style.setProperty('--fill', `${pct}%`);
}

function syncPresetGroup(group, val) {
  document.querySelectorAll(`.presets[data-group="${group}"] .preset`).forEach(btn => {
    btn.classList.toggle('is-active', parseFloat(btn.dataset.val) === parseFloat(val));
  });
}

document.querySelectorAll('.range').forEach(el => {
  setRangeFill(el);
  el.addEventListener('input', () => setRangeFill(el));
});

document.querySelectorAll('.preset').forEach(btn => {
  btn.addEventListener('click', () => {
    const group = btn.closest('.presets').dataset.group;
    const val = parseFloat(btn.dataset.val);
    if (group === 'alarm')      { alarmDurationEl.value = val; alarmDurationEl.dispatchEvent(new Event('input')); }
    else if (group === 'interval') { checkIntervalEl.value = val; checkIntervalEl.dispatchEvent(new Event('input')); }
    else if (group === 'wait')  { waitTimeEl.value = val; waitTimeEl.dispatchEvent(new Event('input')); }
    else if (group === 'ridgeDelay')    { ridgeDelayEl.value    = val; ridgeDelayEl.dispatchEvent(new Event('input')); setRangeFill(ridgeDelayEl); }
    else if (group === 'ocrPasses')     { ocrPassesEl.value     = val; ocrPassesEl.dispatchEvent(new Event('input')); setRangeFill(ocrPassesEl); }
    else if (group === 'captchaLength') { captchaLengthEl.value = val; captchaLengthEl.dispatchEvent(new Event('input')); setRangeFill(captchaLengthEl); }
    else if (group === 'minConfidence') { minConfidenceEl.value = val; minConfidenceEl.dispatchEvent(new Event('input')); setRangeFill(minConfidenceEl); }
    markDirty();
  });
});

// ============================================================================
//  Load HOTH settings
// ============================================================================
let currentApiKey = DEFAULT_GROQ_KEY;
let isDirty = false;

function maskGroqKey(key) {
  if (!key || key.length < 12) return 'gsk_••••••••••••••••••••••••••••••••';
  return key.slice(0, 7) + '••••••••••••••••••••' + key.slice(-4);
}
function maskRidgeKey(key) {
  if (!key || key.length < 8) return '••••••••••••••••••••••••••••••••';
  return key.slice(0, 4) + '••••••••••••••••••••' + key.slice(-4);
}

function loadSettings() {
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
    setRangeFill(alarmDurationEl);
    checkIntervalEl.value    = data.checkInterval;
    checkIntervalVal.textContent = `${data.checkInterval}s`;
    setRangeFill(checkIntervalEl);
    intervalDesc.textContent = `Scan for the Edit button every ${data.checkInterval} second${data.checkInterval === 1 ? '' : 's'}.`;

    spintaxEnabledEl.checked = data.spintaxEnabled;
    emailEnabledEl.checked   = data.emailEnabled;

    writerEnabledEl.checked  = data.writerEnabled;
    autoModeEl.checked       = data.autoMode;
    autoSubmitEl.checked     = data.autoSubmit;
    waitTimeEl.value         = data.waitTime;
    waitTimeVal.textContent  = `${data.waitTime}s`;
    setRangeFill(waitTimeEl);

    currentApiKey = data.groqApiKey || DEFAULT_GROQ_KEY;
    apiKeyText.textContent = maskGroqKey(currentApiKey);

    updateBadges(data);
    syncSubs();
    syncAllPresets();
    clearDirty();
  });
}
loadSettings();

function syncAllPresets() {
  syncPresetGroup('alarm',    alarmDurationEl.value);
  syncPresetGroup('interval', checkIntervalEl.value);
  syncPresetGroup('wait',     waitTimeEl.value);
  syncPresetGroup('ridgeDelay', ridgeDelayEl.value);
}

// ============================================================================
//  Hero + module state synchronisation
// ============================================================================
function updateChip(chipId, active, stateLabel) {
  const chip = document.querySelector(`.hero-chip[data-chip="${chipId}"]`);
  if (!chip) return;
  chip.dataset.active = String(active);
  const stateEl = chip.querySelector('.hero-chip-state');
  if (stateEl) stateEl.textContent = stateLabel;
}

function updateModuleActive(moduleId, active) {
  const m = $(moduleId);
  if (m) m.dataset.active = String(active);
}

function updateBadges(data) {
  // Hero modules
  updateChip('watcher', data.watcherEnabled, data.watcherEnabled ? 'Watching' : 'Off');
  updateChip('spintax', data.spintaxEnabled, data.spintaxEnabled ? 'Scanning' : 'Off');
  updateChip('writer',  data.writerEnabled,  data.writerEnabled ? (data.autoMode ? 'Auto' : 'Ready') : 'Off');

  updateModuleActive('modWatcher', data.watcherEnabled);
  updateModuleActive('modSpintax', data.spintaxEnabled);
  updateModuleActive('modWriter',  data.writerEnabled);

  // Master pill
  const flags = [data.watcherEnabled, data.spintaxEnabled, data.writerEnabled];
  const on = flags.filter(Boolean).length;
  if (on === 0) {
    heroPill.dataset.state = 'paused';
    heroPillText.textContent = 'All paused';
  } else if (on === 3) {
    heroPill.dataset.state = 'active';
    heroPillText.textContent = 'Running';
  } else {
    heroPill.dataset.state = 'active';
    heroPillText.textContent = 'Partial';
  }
  heroCount.textContent = String(on);
}

function syncSubs() {
  watcherSub.textContent = `Every ${checkIntervalEl.value}s · ${alarmDurationEl.value}s alarm`;
  spintaxSub.textContent = emailEnabledEl.checked ? 'Email alerts on detection' : 'Detection only';
  writerSub.textContent  = `${autoModeEl.checked ? 'Auto' : 'Manual'}${autoSubmitEl.checked ? ' submit' : ''} · ${waitTimeEl.value}s wait`;
}

// Real-time updates as the user interacts
[watcherEnabledEl, spintaxEnabledEl, writerEnabledEl, autoClickEl, autoModeEl, autoSubmitEl, emailEnabledEl]
  .forEach(el => el.addEventListener('change', () => {
    markDirty();
    updateBadges({
      watcherEnabled: watcherEnabledEl.checked,
      spintaxEnabled: spintaxEnabledEl.checked,
      writerEnabled:  writerEnabledEl.checked,
      autoMode:       autoModeEl.checked,
    });
    syncSubs();
  }));

alarmDurationEl.addEventListener('input', () => {
  alarmDurationVal.textContent = `${alarmDurationEl.value}s`;
  syncPresetGroup('alarm', alarmDurationEl.value);
  syncSubs();
  markDirty();
});
checkIntervalEl.addEventListener('input', () => {
  checkIntervalVal.textContent = `${checkIntervalEl.value}s`;
  intervalDesc.textContent = `Scan for the Edit button every ${checkIntervalEl.value} second${checkIntervalEl.value === '1' ? '' : 's'}.`;
  syncPresetGroup('interval', checkIntervalEl.value);
  syncSubs();
  markDirty();
});
waitTimeEl.addEventListener('input', () => {
  waitTimeVal.textContent = `${waitTimeEl.value}s`;
  syncPresetGroup('wait', waitTimeEl.value);
  syncSubs();
  markDirty();
});

// ============================================================================
//  Dirty-state save button
// ============================================================================
function markDirty() {
  if (isDirty) return;
  isDirty = true;
  saveBtn.classList.add('is-dirty');
}
function clearDirty() {
  isDirty = false;
  saveBtn.classList.remove('is-dirty');
}

// ============================================================================
//  Groq API key PIN flow
// ============================================================================
let pinAttempts = 0;

changeKeyBtn.addEventListener('click', () => {
  changeKeyBtn.classList.add('hidden');
  lockStatus.classList.add('hidden');
  pinArea.classList.add('is-open');
  pinInput.value = '';
  pinInput.focus();
});
pinCancelBtn.addEventListener('click', closePin);
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
    playAlert(600);
    if (pinAttempts >= 3) {
      showToast('Too many failed attempts', 'err');
      closePin();
    } else {
      showToast(`Wrong PIN · ${pinAttempts}/3`, 'err');
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
    playAlert(500);
    showToast('Key must start with gsk_', 'err');
    return;
  }
  currentApiKey = newKey;
  apiKeyText.textContent = maskGroqKey(currentApiKey);
  keyEditArea.classList.remove('is-open');
  changeKeyBtn.classList.remove('hidden');
  lockStatus.classList.remove('hidden');
  keyInput.value = '';
  markDirty();
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
    clearDirty();
    showToast('Settings saved', 'ok');
  });
});

reloadBtn.addEventListener('click', () => {
  loadSettings();
  showToast('Settings reloaded', 'info');
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
    if (!tabs.length) { playAlert(400); showToast('Writer page not open', 'warn'); return; }
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
        playAlert(400);
        showToast('No job page detected on this tab', 'warn');
      } else {
        showToast('Composer started', 'ok');
      }
    });
  });
});

// ============================================================================
//  Test Groq API
// ============================================================================
testApiBtn.addEventListener('click', async () => {
  testApiBtn.disabled = true;
  const orig = testApiBtn.innerHTML;
  testApiBtn.innerHTML = `<span class="spin" style="display:inline-flex">${ICONS.refresh}</span><span>Testing…</span>`;
  apiStatusText.textContent = 'Testing connection…';
  apiDot.dataset.tone = 'warn';

  const start = performance.now();
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${currentApiKey}` },
      body: JSON.stringify({
        model:      GROQ_MODEL,
        max_tokens: 10,
        messages:   [{ role: 'user', content: 'Reply: CONNECTED' }],
      }),
    });
    const ms = Math.round(performance.now() - start);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    apiDot.dataset.tone = 'ok';
    apiStatusText.textContent = `Connected · ${GROQ_MODEL} · ${ms}ms`;
    showToast('API connected', 'ok');
  } catch (err) {
    playAlert(600);
    apiDot.dataset.tone = 'err';
    apiStatusText.textContent = err.message.slice(0, 60);
    showToast(err.message.slice(0, 40), 'err');
  } finally {
    testApiBtn.disabled = false;
    testApiBtn.innerHTML = orig;
  }
});

// ============================================================================
//  RIDGE NEURAL SOLVER
// ============================================================================
let ridgeCurrentKey      = RIDGE_DEFAULT_KEY;
let ridgeAutosolveActive = false;
let ridgePinAttempts     = 0;
let geminiCurrentKey     = '';
let geminiPinAttempts    = 0;

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
const ocrPassesEl         = $('ocrPasses');
const ocrPassesVal        = $('ocrPassesVal');
const captchaLengthEl     = $('captchaLength');
const captchaLengthVal    = $('captchaLengthVal');
const minConfidenceEl     = $('minConfidence');
const minConfidenceVal    = $('minConfidenceVal');
const ridgeStartBtn       = $('ridgeStartBtn');
const ridgeSaveBtn        = $('ridgeSaveBtn');
const ridgeDot            = $('ridgeDot');
const ridgeStatusText     = $('ridgeStatusText');

const geminiKeyText        = $('geminiKeyText');
const geminiLockStatus     = $('geminiLockStatus');
const geminiPinArea        = $('geminiPinArea');
const geminiKeyEditArea    = $('geminiKeyEditArea');
const geminiPinInput       = $('geminiPinInput');
const geminiKeyInput       = $('geminiKeyInput');
const geminiChangeKeyBtn   = $('geminiChangeKeyBtn');
const geminiPinCancelBtn   = $('geminiPinCancelBtn');
const geminiPinConfirmBtn  = $('geminiPinConfirmBtn');
const geminiKeyCancelBtn   = $('geminiKeyCancelBtn');
const geminiKeySaveBtn     = $('geminiKeySaveBtn');

function maskGeminiKey(key) {
  if (!key) return 'Not set — get a free key at aistudio.google.com';
  if (key.length < 12) return key;
  return key.slice(0, 6) + '••••••••••••••••••••' + key.slice(-4);
}

// Load Gemini key from sync storage. Falls back to the bundled default so
// the cascade has a working key out of the box on first install.
chrome.storage.sync.get(['geminiApiKey'], (data) => {
  geminiCurrentKey = data.geminiApiKey || DEFAULT_GEMINI_KEY;
  // Persist the default if storage was empty (first install before the
  // service worker's onInstalled wrote anything).
  if (!data.geminiApiKey) chrome.storage.sync.set({ geminiApiKey: DEFAULT_GEMINI_KEY });
  geminiKeyText.textContent = maskGeminiKey(geminiCurrentKey);
});

geminiChangeKeyBtn.addEventListener('click', () => {
  geminiChangeKeyBtn.classList.add('hidden');
  geminiLockStatus.classList.add('hidden');
  geminiPinArea.classList.add('is-open');
  geminiPinInput.value = '';
  geminiPinInput.focus();
});
geminiPinCancelBtn.addEventListener('click', closeGeminiPin);
function closeGeminiPin() {
  geminiPinArea.classList.remove('is-open');
  geminiChangeKeyBtn.classList.remove('hidden');
  geminiLockStatus.classList.remove('hidden');
  geminiPinInput.value = '';
  geminiPinAttempts = 0;
}
geminiPinConfirmBtn.addEventListener('click', confirmGeminiPin);
geminiPinInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  confirmGeminiPin();
  if (e.key === 'Escape') closeGeminiPin();
});
function confirmGeminiPin() {
  if (geminiPinInput.value === RIDGE_PIN) {
    geminiPinAttempts = 0;
    geminiPinArea.classList.remove('is-open');
    geminiKeyEditArea.classList.add('is-open');
    geminiKeyInput.value = geminiCurrentKey;
    geminiKeyInput.focus();
    geminiKeyInput.select();
    geminiLockStatus.classList.add('hidden');
    geminiChangeKeyBtn.classList.add('hidden');
    showToast('Unlocked — paste your Gemini key', 'ok', { icon: 'unlock' });
  } else {
    geminiPinAttempts++;
    playAlert(700);
    if (geminiPinAttempts >= 3) {
      showToast('Too many failed attempts', 'err');
      closeGeminiPin();
    } else {
      showToast(`Wrong PIN · ${geminiPinAttempts}/3`, 'err');
      geminiPinInput.value = '';
      geminiPinInput.focus();
    }
  }
}
geminiKeyCancelBtn.addEventListener('click', () => {
  geminiKeyEditArea.classList.remove('is-open');
  geminiChangeKeyBtn.classList.remove('hidden');
  geminiLockStatus.classList.remove('hidden');
  geminiKeyInput.value = '';
});
geminiKeySaveBtn.addEventListener('click', () => {
  const newKey = geminiKeyInput.value.trim();
  geminiCurrentKey = newKey;
  chrome.storage.sync.set({ geminiApiKey: newKey });
  geminiKeyText.textContent = maskGeminiKey(geminiCurrentKey);
  geminiKeyEditArea.classList.remove('is-open');
  geminiChangeKeyBtn.classList.remove('hidden');
  geminiLockStatus.classList.remove('hidden');
  geminiKeyInput.value = '';
  showToast(newKey ? 'Gemini key saved' : 'Gemini key cleared', 'ok');
});


chrome.storage.local.get({
  ridgeApiKey:      RIDGE_DEFAULT_KEY,
  captchaSelector:  '#writercaptcha > div:nth-child(2) > img:nth-child(1)',
  inputSelector:    'input[required]',
  submitSelector:   'input[type="submit"].btn.btn-success.btn-large',
  delay:            3,
  autosolveEnabled: false,
  ocrPasses:        2,
  captchaLength:    5,
  minConfidence:    0,
}, (data) => {
  ridgeCurrentKey = data.ridgeApiKey || RIDGE_DEFAULT_KEY;
  ridgeKeyText.textContent = maskRidgeKey(ridgeCurrentKey);
  ridgeCaptchaSel.value = data.captchaSelector;
  ridgeInputSel.value   = data.inputSelector;
  ridgeSubmitSel.value  = data.submitSelector;
  ridgeDelayEl.value    = data.delay;
  ridgeDelayVal.textContent = `${data.delay}s`;
  setRangeFill(ridgeDelayEl);
  syncPresetGroup('ridgeDelay', parseFloat(data.delay));

  ocrPassesEl.value = data.ocrPasses;
  ocrPassesVal.textContent = `${data.ocrPasses} pass${data.ocrPasses === 1 ? '' : 'es'}`;
  setRangeFill(ocrPassesEl);
  syncPresetGroup('ocrPasses', data.ocrPasses);

  captchaLengthEl.value = data.captchaLength;
  captchaLengthVal.textContent = `${data.captchaLength} chars`;
  setRangeFill(captchaLengthEl);
  syncPresetGroup('captchaLength', data.captchaLength);

  const confPct = Math.round((data.minConfidence ?? 0) * 100);
  minConfidenceEl.value = confPct;
  minConfidenceVal.textContent = confPct === 0 ? 'Off' : `${confPct}%`;
  setRangeFill(minConfidenceEl);
  syncPresetGroup('minConfidence', confPct);

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
  ridgeDelayVal.textContent = `${ridgeDelayEl.value}s`;
  syncPresetGroup('ridgeDelay', ridgeDelayEl.value);
});

ocrPassesEl.addEventListener('input', () => {
  const v = parseInt(ocrPassesEl.value);
  ocrPassesVal.textContent = `${v} pass${v === 1 ? '' : 'es'}`;
  syncPresetGroup('ocrPasses', v);
});

captchaLengthEl.addEventListener('input', () => {
  const v = parseInt(captchaLengthEl.value);
  captchaLengthVal.textContent = `${v} chars`;
  syncPresetGroup('captchaLength', v);
});

minConfidenceEl.addEventListener('input', () => {
  const v = parseInt(minConfidenceEl.value);
  minConfidenceVal.textContent = v === 0 ? 'Off' : `${v}%`;
  syncPresetGroup('minConfidence', v);
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
  if (ridgePinInput.value === RIDGE_PIN) {
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
    playAlert(600);
    if (ridgePinAttempts >= 3) {
      showToast('Too many failed attempts', 'err');
      closeRidgePin();
    } else {
      showToast(`Wrong PIN · ${ridgePinAttempts}/3`, 'err');
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
    playAlert(400);
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
    ocrPasses:       parseInt(ocrPassesEl.value)    || 5,
    captchaLength:   parseInt(captchaLengthEl.value) || 5,
    minConfidence:   (parseInt(minConfidenceEl.value) || 65) / 100,
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
