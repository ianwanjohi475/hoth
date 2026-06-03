// ─── HOTH Suite — Background Service Worker ────────────────────────────────

const DEFAULT_GROQ_KEY  = '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';
const GROQ_MODEL        = 'llama-3.1-8b-instant';
// Ridge solver now uses Google Gemini for OCR (far better at reading case
// than the old Mistral Pixtral 12B). This is the baked-in default key.
const RIDGE_DEFAULT_KEY = 'AQ.Ab8RN6JAxNa4uMdd8587SJqKdqJm7cXOfdYiEnhbN5se6xKMVQ';
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

// ─── Ridge Neural Solver — Google Gemini OCR ─────────────────────────────────
// Gemini reads text-in-image (including case) far better than Mistral Pixtral.
// We probe a small list of current Gemini flash model IDs and cache whichever
// one the account/region actually serves, so the extension keeps working as
// Google rotates model names. After the first solve only ONE call is made.

const GEMINI_MODELS = [
  'gemini-3.5-flash',        // current model used throughout the official docs
  'gemini-flash-latest',     // alias that always points to the newest flash
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];
let _geminiModel = null; // cached working model id for this service-worker life

const CAPTCHA_PROMPT =
  'This image is a CAPTCHA containing exactly 5 alphanumeric characters ' +
  '(A-Z, a-z, 0-9), each drawn in a different colour on a light background. ' +
  'Return ONLY those 5 characters, nothing else. ' +
  'PRESERVE CASE EXACTLY: output uppercase letters as uppercase and lowercase letters as lowercase. ' +
  'Judge case by RELATIVE HEIGHT — capital letters are TALL (full height), ' +
  'lowercase letters are SHORT (about 60% height) unless they have an ascender (b d f h k l t) or descender (g j p q y). ' +
  'Carefully distinguish look-alikes: 0/O/o, 1/l/I, 5/S/s, 9/g/q, 6/G/b, 2/Z/z, 8/B, c/C, k/K, o/O, p/P, s/S, u/U, v/V, w/W, x/X, z/Z. ' +
  'Ignore the thin wavy decorative lines that cross through the characters. ' +
  'No spaces, no quotes, no punctuation, no explanation — output only the 5 characters.';

// Looks like a Gemini key (AQ.… new format, or AIza… classic). Anything else
// (e.g. a leftover Mistral key in storage) is ignored in favour of the default.
function looksLikeGeminiKey(k) {
  return typeof k === 'string' && (k.startsWith('AQ.') || k.startsWith('AIza'));
}

// One raw Gemini REST call. `noThink` controls whether we send
// thinkingConfig (some models reject the field) and how big the output
// budget is.
async function callGeminiModel(model, rawBase64, apiKey, noThink) {
  // Per the official docs, the API key goes in the x-goog-api-key header
  // (current standard; works with the newer AQ.* key format). Body uses the
  // documented snake_case fields inline_data / mime_type, which the v1beta
  // REST endpoint accepts.
  const generationConfig = {
    temperature: 0,
    topP: 1,
    maxOutputTokens: noThink ? 64 : 512,
  };
  // Gemini 2.5+ runs "thinking" by default, which eats the output-token
  // budget and returns empty text. thinkingBudget:0 disables it. We send it
  // first; if a model rejects the field we retry without it (see callGemini).
  if (noThink) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{
        // Docs best practice: with a single image + text, put the image part
        // FIRST and the text prompt AFTER it.
        parts: [
          { inline_data: { mime_type: 'image/png', data: rawBase64 } },
          { text: CAPTCHA_PROMPT },
        ],
      }],
      generationConfig,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `Gemini ${res.status}`;
    const e = new Error(msg);
    // Wrong/unavailable model id → try the next one in the list.
    e.modelMissing = res.status === 404 ||
      /is not found|not supported for|does not exist|do not have access|call list ?models/i.test(msg);
    // Model rejected thinkingConfig → retry same model without it.
    e.thinkingUnsupported = noThink && /thinking|thinkingconfig|thinking_config/i.test(msg);
    throw e;
  }

  const json = await res.json();
  const cand = json?.candidates?.[0];
  // Join all text parts (defensive — usually one).
  let text = (cand?.content?.parts || []).map(p => p?.text || '').join('').trim();

  if (!text) {
    // Empty output — usually thinking ate the budget. Signal a no-think retry.
    const e = new Error(`empty output (finishReason=${cand?.finishReason || '?'})`);
    e.emptyOutput = true;
    throw e;
  }

  // Gemini may wrap in quotes/backticks/tags — strip to alphanumerics, keep case.
  const tag = text.match(/<ans>\s*([^<\s]+)\s*<\/ans>/i);
  if (tag) text = tag[1];
  text = text.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5);
  if (text.length === 0) {
    const e = new Error('no alphanumeric in output');
    e.emptyOutput = true;
    throw e;
  }
  return text;
}

// Calls a model with thinking disabled; if that model rejects thinkingConfig
// or returns empty, retries the same model WITHOUT thinkingConfig and a
// larger token budget.
async function callGemini(model, rawBase64, apiKey) {
  try {
    return await callGeminiModel(model, rawBase64, apiKey, true);
  } catch (e) {
    if (e.thinkingUnsupported || e.emptyOutput) {
      return await callGeminiModel(model, rawBase64, apiKey, false);
    }
    throw e;
  }
}

async function solveCaptcha(imageBase64, apiKey) {
  const key = looksLikeGeminiKey(apiKey) ? apiKey : RIDGE_DEFAULT_KEY;
  const rawBase64 = (imageBase64 || '').replace(/^data:image\/[^;]+;base64,/i, '');

  // Use the cached working model first, if we found one already.
  if (_geminiModel) {
    return await callGemini(_geminiModel, rawBase64, key);
  }

  // First solve of this session: find a model id the account actually serves.
  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    try {
      const result = await callGemini(model, rawBase64, key);
      _geminiModel = model; // cache the winner — every later solve is 1 call
      console.log('[Inkwell] Gemini OCR using model:', model);
      return result;
    } catch (e) {
      lastErr = e;
      if (e.modelMissing) continue;   // wrong model id — try the next one
      throw e;                        // real error (auth, quota, network) — surface it
    }
  }
  throw lastErr || new Error('No working Gemini model found');
}
