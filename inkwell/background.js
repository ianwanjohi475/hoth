// ─── HOTH Suite — Background Service Worker ────────────────────────────────

const DEFAULT_GROQ_KEY  = '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';
const GROQ_MODEL        = 'llama-3.1-8b-instant';
const RIDGE_DEFAULT_KEY = '4qNzAeraznT1SvoUvF2gPC9J0L6G1J0O';
const SECURITY_CODE     = '0000';

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

// ─── Ridge Neural Solver — Mistral primary, Gemini fallback on 429 ─────────
// The default Mistral key is shared across every installation of this
// extension, so its rate-limit ceiling gets hit constantly. When that
// happens, we silently fall back to Gemini 2.0 Flash — generous 15 RPM
// free tier, completely independent of Mistral's quotas. The user sees
// no difference at the UI level: same status messages, same answer.

const GEMINI_FALLBACK_KEY = 'AQ.Ab8RN6L0daqPlYRJLoDPmuDb6wNm2MY6w_pr-O7dPoQ1UHtk0Q';

const CAPTCHA_PROMPT_TEXT =
  'This is a CAPTCHA image with exactly 5 alphanumeric characters. ' +
  'Read the characters shown and return ONLY those 5 characters. ' +
  'PRESERVE CASE EXACTLY — if a letter is uppercase output it uppercase, if it is lowercase output it lowercase. ' +
  'Compare relative HEIGHT against neighbouring letters to judge case (capitals are tall, lowercase letters are short). ' +
  'Distinguish carefully: 0/O/o, 1/l/I, 5/S/s, 9/g/q, 6/G/b. ' +
  'Ignore wavy decorative lines that cross through the letters. ' +
  'No spaces, no punctuation, no other text — only the 5 characters.';

function isRateLimitError(e) {
  const m = (e && e.message || '').toLowerCase();
  return m.includes('429') || m.includes('rate') || m.includes('limit') || m.includes('quota');
}

async function solveCaptcha(imageBase64, apiKey) {
  const key = apiKey || RIDGE_DEFAULT_KEY;

  // ONE Mistral attempt (same as the user's original extension). No retry
  // on 429 — retrying just adds load to the already-rate-limited shared
  // key, which is what was making things worse. If Mistral comes back 429,
  // fall straight through to Gemini.
  try {
    return await callMistral(imageBase64, key);
  } catch (mistralErr) {
    if (!isRateLimitError(mistralErr)) throw mistralErr;

    console.log('[Inkwell] Mistral 429 — falling back to Gemini');
    try {
      return await callGemini(imageBase64);
    } catch (geminiErr) {
      console.warn('[Inkwell] Gemini fallback failed:', geminiErr.message);
      throw new Error(`Rate limited (Mistral) + Gemini: ${geminiErr.message}`);
    }
  }
}

async function callMistral(imageBase64, apiKey) {
  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'pixtral-12b-2409',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageBase64 } },
          { type: 'text', text: CAPTCHA_PROMPT_TEXT },
        ],
      }],
      max_tokens: 20,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const msg = err.message || err?.error?.message || '';
    if (response.status === 429) throw new Error(`429: ${msg || 'Rate limit exceeded'}`);
    throw new Error(msg || `Mistral ${response.status}`);
  }

  const data = await response.json();
  let text = data.choices?.[0]?.message?.content?.trim() || '';
  text = text.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5);
  if (!text.length) throw new Error('Mistral returned empty');
  return text;
}

async function callGemini(imageBase64) {
  // Strip the data:image/...;base64, prefix — Gemini's inline_data wants raw base64.
  const raw = imageBase64.replace(/^data:image\/[^;]+;base64,/i, '');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(GEMINI_FALLBACK_KEY)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: CAPTCHA_PROMPT_TEXT },
          { inline_data: { mime_type: 'image/png', data: raw } },
        ],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 50 },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini ${res.status}`);
  }
  const json = await res.json();
  let text = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  // Strip <ans> tags if present (Gemini sometimes wraps), then non-alphanumeric, then 5 chars.
  const tag = text.match(/<ans>\s*([^<\s]+)\s*<\/ans>/i);
  if (tag) text = tag[1];
  text = text.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5);
  if (!text.length) throw new Error('Gemini returned empty');
  return text;
}
