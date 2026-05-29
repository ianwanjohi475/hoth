// ─── HOTH Suite — Background Service Worker ────────────────────────────────

const DEFAULT_GROQ_KEY  = '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';
const GROQ_MODEL        = 'llama-3.1-8b-instant';
const RIDGE_DEFAULT_KEY = '4qNzAeraznT1SvoUvF2gPC9J0L6G1J0O';
const SECURITY_CODE     = '4759';

// ── Open the side panel when the toolbar icon is clicked ─────────────────────
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(err => console.warn('[Inkwell] sidePanel behavior:', err));

// ── On Install: set all defaults ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  // HOTH sync settings
  chrome.storage.sync.set({
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
  });
  // Ridge local settings
  chrome.storage.local.get(['ridgeApiKey', 'captchaSelector', 'inputSelector', 'submitSelector', 'delay'], (result) => {
    const defaults = {};
    if (!result.ridgeApiKey)       defaults.ridgeApiKey       = RIDGE_DEFAULT_KEY;
    if (!result.captchaSelector)   defaults.captchaSelector   = '#writercaptcha > div:nth-child(2) > img:nth-child(1)';
    if (!result.inputSelector)     defaults.inputSelector     = 'input[required]';
    if (!result.submitSelector)    defaults.submitSelector    = 'input[type="submit"].btn.btn-success.btn-large';
    if (result.delay === undefined) defaults.delay            = 3;
    if (Object.keys(defaults).length) chrome.storage.local.set(defaults);
  });
  console.log('[Inkwell] Installed. Defaults set.');
});

// ─── Audio Alarm Injection ────────────────────────────────────────────────────
// Injects an <audio> element into a tab using the extension's beep.wav.
// This replaces the old WebAudio oscillator so a real audio file is always used.

function injectAlarm(tabId, durationSeconds) {
  const beepUrl = chrome.runtime.getURL('beep.wav');
  chrome.scripting.executeScript({
    target: { tabId },
    args:   [durationSeconds, beepUrl],
    func:   (durationSeconds, beepUrl) => {
      if (window.__hothAlarmPlaying) return;
      window.__hothAlarmPlaying = true;

      const audio = new Audio(beepUrl);
      audio.loop   = true;
      audio.volume = 1.0;
      audio.play().catch(() => {});

      const stop = () => {
        audio.pause();
        audio.currentTime      = 0;
        audio.loop             = false;
        window.__hothAlarmPlaying = false;
      };

      window.__hothStopAlarm = stop;

      // Auto-stop after alarmDuration
      window.__hothAlarmTimer = setTimeout(stop, durationSeconds * 1000);
    }
  }).catch(err => console.warn('[Inkwell] Could not inject alarm:', err));
}

function stopAlarmInTab(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func:   () => {
      if (typeof window.__hothStopAlarm === 'function') window.__hothStopAlarm();
      if (window.__hothAlarmTimer) clearTimeout(window.__hothAlarmTimer);
    }
  }).catch(() => {});
}

// ─── Badge Flash ──────────────────────────────────────────────────────────────
function flashBadge(tabId) {
  chrome.action.setBadgeText({ text: '!', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#14B8A6', tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }), 15000);
}

// ─── Debugger — Article Auto-Writer ──────────────────────────────────────────
const debuggedTabs = new Set();

async function attachDebugger(tabId) {
  if (debuggedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggedTabs.add(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    console.log('[Inkwell] Debugger attached to tab', tabId);
  } catch (e) {
    console.warn('[Inkwell] Could not attach debugger:', e.message);
  }
}

async function detachDebugger(tabId) {
  if (!debuggedTabs.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
    debuggedTabs.delete(tabId);
  } catch (e) {
    debuggedTabs.delete(tabId);
  }
}

// Auto-accept JS dialogs (for article form submit confirmation)
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method === 'Page.javascriptDialogOpening') {
    try {
      await chrome.debugger.sendCommand(
        { tabId: source.tabId },
        'Page.handleJavaScriptDialog',
        { accept: true }
      );
      console.log('[Inkwell] Dialog auto-accepted');
    } catch (e) {
      console.warn('[Inkwell] Could not accept dialog:', e.message);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => detachDebugger(tabId));
chrome.debugger.onDetach.addListener((source) => debuggedTabs.delete(source.tabId));

// ─── Message Listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Ridge: solve CAPTCHA via Mistral API ───────────────────────────────────
  if (msg.type === 'SOLVE_CAPTCHA') {
    solveCaptcha(msg.imageBase64, msg.apiKey)
      .then(result => sendResponse({ success: true, text: result }))
      .catch(err   => sendResponse({ success: false, error: err.message }));
    return true; // async
  }

  // ── Ridge: verify security PIN ─────────────────────────────────────────────
  if (msg.type === 'VERIFY_SECURITY_CODE') {
    sendResponse({ valid: msg.code === SECURITY_CODE });
    return false;
  }

  // ── Edit button found ──────────────────────────────────────────────────────
  if (msg.type === 'EDIT_FOUND') {
    const writerTabId = sender.tab.id;
    const { articleUrl, alarmDuration, autoClick } = msg;

    flashBadge(writerTabId);

    if (autoClick && articleUrl) {
      chrome.tabs.create({ url: articleUrl, active: true }, (newTab) => {
        function onUpdated(tabId, info) {
          if (tabId !== newTab.id || info.status !== 'complete') return;
          chrome.tabs.onUpdated.removeListener(onUpdated);
          injectAlarm(newTab.id, alarmDuration);
        }
        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.remove(writerTabId);
      });
    } else {
      // Auto-click off: alarm on current tab, don't close
      injectAlarm(writerTabId, alarmDuration);
    }
    sendResponse({ ok: true });
  }

  // ── Spintax error found ────────────────────────────────────────────────────
  if (msg.type === 'SPINTAX_ERROR_FOUND') {
    const articleTabId = sender.tab.id;
    console.log('[Inkwell] Spintax error — opening alert tab, closing tab', articleTabId);

    // Check if email notification is enabled before sending
    chrome.storage.sync.get({ emailEnabled: true }, ({ emailEnabled }) => {
      if (emailEnabled) {
        fetch('https://api.emailjs.com/api/v1.0/email/send', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            service_id:  'service_yvjhr9k',
            template_id: 'template_tieclh9',
            user_id:     'jDHvUYssXkcBo-_Q3',
            template_params: {
              message: 'Spintax detected on a HOTH article page!',
              time:    new Date().toLocaleString(),
            }
          })
        })
        .then(() => console.log('[Inkwell] Email notification sent.'))
        .catch(err => console.warn('[Inkwell] Email notification failed:', err));
      }
    });

    chrome.tabs.create({ url: chrome.runtime.getURL('spintax-alert.html'), active: true });
    chrome.tabs.remove(articleTabId);
    sendResponse({ ok: true });
  }

  // ── Stop alarm (from alert page or popup) ─────────────────────────────────
  if (msg.type === 'STOP_ALARM') {
    const tabId = sender.tab?.id || msg.tabId;
    if (tabId) stopAlarmInTab(tabId);
    sendResponse({ ok: true });
  }

  // ── Stop alarm in all tabs ────────────────────────────────────────────────
  if (msg.type === 'STOP_ALL_ALARMS') {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => stopAlarmInTab(tab.id));
    });
    sendResponse({ ok: true });
  }

  // ── Debugger attach/detach (article writer) ───────────────────────────────
  if (msg.type === 'ATTACH_DEBUGGER') {
    const tabId = sender.tab?.id || msg.tabId;
    attachDebugger(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'DETACH_DEBUGGER') {
    const tabId = sender.tab?.id || msg.tabId;
    detachDebugger(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── Settings broadcast (popup → content scripts) ──────────────────────────
  if (msg.type === 'BROADCAST_SETTINGS') {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          type:     'SETTINGS_UPDATED',
          settings: msg.settings,
        }).catch(() => {});
      });
    });
    sendResponse({ ok: true });
  }

});

// ─── Ridge Neural Solver — Mistral API ───────────────────────────────────────
async function solveCaptcha(imageBase64, apiKey) {
  const key = apiKey || RIDGE_DEFAULT_KEY;

  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: 'pixtral-12b-2409',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageBase64 } },
            {
              type: 'text',
              text: 'This is a CAPTCHA image. Read the characters shown and return ONLY the alphanumeric text you see, exactly 5 characters. No spaces, no punctuation, no special characters, no accents, uppercase letters only. Return nothing else but those 5 characters.'
            }
          ]
        }
      ],
      max_tokens: 20,
      temperature: 0
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || `API error ${response.status}`);
  }

  const data = await response.json();
  let text = data.choices?.[0]?.message?.content?.trim() || '';
  text = text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 5);
  if (text.length === 0) throw new Error('Could not read CAPTCHA text');
  return text;
}
