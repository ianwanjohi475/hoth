// ============================================================================
//  Quillforge — Background Service Worker
//  Handles alarms, debugger lifecycle, CAPTCHA solving, email notifications,
//  and message routing between content scripts and the side panel.
// ============================================================================

// ---------- Constants (carried over from the original suite) ----------------
const DEFAULT_GROQ_KEY  = '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';
const GROQ_MODEL        = 'llama-3.1-8b-instant';
const RIDGE_DEFAULT_KEY = '4qNzAeraznT1SvoUvF2gPC9J0L6G1J0O';
const MISTRAL_MODEL     = 'pixtral-12b-2409';
const SECURITY_CODE     = '4759';

const EMAILJS = {
  endpoint:    'https://api.emailjs.com/api/v1.0/email/send',
  service_id:  'service_yvjhr9k',
  template_id: 'template_tieclh9',
  user_id:     'jDHvUYssXkcBo-_Q3',
};

// ---------- Side panel: open on action click ---------------------------------
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(err => console.warn('[Quillforge] sidePanel behavior:', err));

// ---------- First-install defaults ------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
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

  chrome.storage.local.get(
    ['ridgeApiKey', 'captchaSelector', 'inputSelector', 'submitSelector', 'delay'],
    (existing) => {
      const defaults = {};
      if (!existing.ridgeApiKey)      defaults.ridgeApiKey     = RIDGE_DEFAULT_KEY;
      if (!existing.captchaSelector)  defaults.captchaSelector = '#writercaptcha > div:nth-child(2) > img:nth-child(1)';
      if (!existing.inputSelector)    defaults.inputSelector   = 'input[required]';
      if (!existing.submitSelector)   defaults.submitSelector  = 'input[type="submit"].btn.btn-success.btn-large';
      if (existing.delay === undefined) defaults.delay         = 3;
      if (Object.keys(defaults).length) chrome.storage.local.set(defaults);
    }
  );

  console.log('[Quillforge] Installed — defaults applied.');
});

// ============================================================================
//  Audio alarm — injected <audio> playing beep.wav
// ============================================================================
function injectAlarm(tabId, durationSeconds) {
  const beepUrl = chrome.runtime.getURL('beep.wav');
  chrome.scripting.executeScript({
    target: { tabId },
    args:   [durationSeconds, beepUrl],
    func:   (durationSeconds, beepUrl) => {
      if (window.__qfAlarmPlaying) return;
      window.__qfAlarmPlaying = true;

      const audio = new Audio(beepUrl);
      audio.loop   = true;
      audio.volume = 1.0;
      audio.play().catch(() => {});

      const stop = () => {
        audio.pause();
        audio.currentTime = 0;
        audio.loop = false;
        window.__qfAlarmPlaying = false;
      };
      window.__qfStopAlarm = stop;
      window.__qfAlarmTimer = setTimeout(stop, durationSeconds * 1000);
    },
  }).catch(err => console.warn('[Quillforge] Alarm inject failed:', err));
}

function stopAlarmInTab(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (typeof window.__qfStopAlarm === 'function') window.__qfStopAlarm();
      if (window.__qfAlarmTimer) clearTimeout(window.__qfAlarmTimer);
    },
  }).catch(() => {});
}

// ============================================================================
//  Badge flash on Edit detection
// ============================================================================
function flashBadge(tabId) {
  chrome.action.setBadgeText({ text: '!', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#3FD4A8', tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }), 15000);
}

// ============================================================================
//  Debugger — needed to auto-accept the submit-confirm JS dialog
// ============================================================================
const debuggedTabs = new Set();

async function attachDebugger(tabId) {
  if (debuggedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggedTabs.add(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  } catch (e) {
    console.warn('[Quillforge] Debugger attach failed:', e.message);
    throw e;
  }
}

async function detachDebugger(tabId) {
  if (!debuggedTabs.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_) { /* ignore */ }
  debuggedTabs.delete(tabId);
}

chrome.debugger.onEvent.addListener(async (source, method) => {
  if (method !== 'Page.javascriptDialogOpening') return;
  try {
    await chrome.debugger.sendCommand(
      { tabId: source.tabId },
      'Page.handleJavaScriptDialog',
      { accept: true }
    );
  } catch (e) {
    console.warn('[Quillforge] Could not accept dialog:', e.message);
  }
});

chrome.tabs.onRemoved.addListener(tabId => detachDebugger(tabId));
chrome.debugger.onDetach.addListener(source => debuggedTabs.delete(source.tabId));

// ============================================================================
//  Mistral Pixtral CAPTCHA solver
// ============================================================================
async function solveCaptcha(imageBase64, apiKey) {
  const key = apiKey || RIDGE_DEFAULT_KEY;
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageBase64 } },
          {
            type: 'text',
            text: 'This is a CAPTCHA image. Read the characters shown and return ONLY the alphanumeric text you see, exactly 5 characters. No spaces, no punctuation, no special characters, no accents, uppercase letters only. Return nothing else but those 5 characters.',
          },
        ],
      }],
      max_tokens:  20,
      temperature: 0,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `API error ${res.status}`);
  }

  const data = await res.json();
  let text = data.choices?.[0]?.message?.content?.trim() || '';
  text = text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 5);
  if (!text.length) throw new Error('Could not read CAPTCHA text');
  return text;
}

// ============================================================================
//  EmailJS spintax notification
// ============================================================================
async function sendSpintaxEmail() {
  try {
    await fetch(EMAILJS.endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        service_id:  EMAILJS.service_id,
        template_id: EMAILJS.template_id,
        user_id:     EMAILJS.user_id,
        template_params: {
          message: 'Spintax detected on a HOTH article page!',
          time:    new Date().toLocaleString(),
        },
      }),
    });
    console.log('[Quillforge] Spintax email sent.');
  } catch (err) {
    console.warn('[Quillforge] Spintax email failed:', err);
  }
}

// ============================================================================
//  Message router
// ============================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'SOLVE_CAPTCHA':
      solveCaptcha(msg.imageBase64, msg.apiKey)
        .then(text => sendResponse({ success: true, text }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // async

    case 'VERIFY_SECURITY_CODE':
      sendResponse({ valid: msg.code === SECURITY_CODE });
      return false;

    case 'EDIT_FOUND': {
      const writerTabId = sender.tab.id;
      const { articleUrl, alarmDuration, autoClick } = msg;
      flashBadge(writerTabId);

      if (autoClick && articleUrl) {
        chrome.tabs.create({ url: articleUrl, active: true }, (newTab) => {
          const onUpdated = (tabId, info) => {
            if (tabId !== newTab.id || info.status !== 'complete') return;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            injectAlarm(newTab.id, alarmDuration);
          };
          chrome.tabs.onUpdated.addListener(onUpdated);
          chrome.tabs.remove(writerTabId);
        });
      } else {
        injectAlarm(writerTabId, alarmDuration);
      }
      sendResponse({ ok: true });
      return false;
    }

    case 'SPINTAX_ERROR_FOUND': {
      const articleTabId = sender.tab.id;
      chrome.storage.sync.get({ emailEnabled: true }, ({ emailEnabled }) => {
        if (emailEnabled) sendSpintaxEmail();
      });
      chrome.tabs.create({ url: chrome.runtime.getURL('spintax-alert.html'), active: true });
      chrome.tabs.remove(articleTabId);
      sendResponse({ ok: true });
      return false;
    }

    case 'STOP_ALARM': {
      const tabId = sender.tab?.id || msg.tabId;
      if (tabId) stopAlarmInTab(tabId);
      sendResponse({ ok: true });
      return false;
    }

    case 'STOP_ALL_ALARMS':
      chrome.tabs.query({}, tabs => tabs.forEach(t => stopAlarmInTab(t.id)));
      sendResponse({ ok: true });
      return false;

    case 'ATTACH_DEBUGGER': {
      const tabId = sender.tab?.id || msg.tabId;
      attachDebugger(tabId)
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    case 'DETACH_DEBUGGER': {
      const tabId = sender.tab?.id || msg.tabId;
      detachDebugger(tabId)
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    case 'BROADCAST_SETTINGS':
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            type:     'SETTINGS_UPDATED',
            settings: msg.settings,
          }).catch(() => {});
        });
      });
      sendResponse({ ok: true });
      return false;
  }
});
