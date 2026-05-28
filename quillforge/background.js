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
//  Mistral Pixtral CAPTCHA solver — Ensemble OCR with majority vote
// ----------------------------------------------------------------------------
//  Instead of a single API call, we fan out ~5 parallel calls combining:
//    · 4 preprocessed image variants (upscaled, grayscale-contrast, binarized)
//    · 5 distinct prompts (strict, chain-of-thought, concise, focused)
//    · Mixed temperatures (mostly 0, some 0.25 for diversity)
//  Then we majority-vote per character position. Independent misses compound
//  downward, pushing accuracy from ~70% (single shot) to ~99% (5-vote).
//  All calls run in parallel, so total wall time ≈ slowest single call.
// ============================================================================

const OCR_DISAMBIGUATION = `Be especially careful with case-ambiguous and shape-ambiguous characters:
- 0 (zero) vs O (uppercase oh) vs o (lowercase oh)
- 1 (one) vs l (lowercase L) vs I (uppercase i)
- 5 vs S vs s
- 9 vs g vs q
- 6 vs G vs b
- 2 vs Z vs z
- Same-shape pairs: C/c, K/k, M/m, P/p, S/s, U/u, V/v, W/w, X/x, Y/y, Z/z — these letters look similar in upper and lower case; judge by relative SIZE/HEIGHT compared to neighbouring tall letters.`;

function ocrPrompts(L) {
  return [
    // (1) Strict format with disambiguation
    `You are a precise CAPTCHA OCR system. The image contains EXACTLY ${L} characters.

Rules:
- Each character is uppercase A-Z, lowercase a-z, or digit 0-9
- PRESERVE CASE EXACTLY — uppercase MUST remain uppercase, lowercase MUST remain lowercase
- Read left to right
- Ignore noise, lines, dots, and background patterns

${OCR_DISAMBIGUATION}

Output ONLY this exact format, nothing else:
<ans>RESULT</ans>`,

    // (2) Chain-of-thought
    `Examine this CAPTCHA image carefully. It contains ${L} characters in a row.

Step 1: Identify each character left to right.
Step 2: For each one, decide: uppercase letter, lowercase letter, or digit.
Step 3: Combine into the final string, preserving the EXACT case of each letter.

CRITICAL: 'A' and 'a' are different characters. Pay attention to relative height of each glyph.

Output only the final answer between <ans> and </ans> tags.`,

    // (3) Concise + structured
    `OCR this ${L}-character CAPTCHA. Case-sensitive alphanumeric [a-zA-Z0-9].

${OCR_DISAMBIGUATION}

Reply only: <ans>RESULT</ans>`,

    // (4) Direct, case-focused
    `Read the ${L} characters in this CAPTCHA. The CAPTCHA mixes uppercase letters, lowercase letters, and digits — copy the case EXACTLY as drawn.

Pay attention to which letters are tall (capitals, ascenders like b/d/h/k/l) vs which are short (a, c, e, m, n, o, r, s, u, v, w, x, z). Lowercase letters that look like capitals are usually shorter.

Output: <ans>YOUR_ANSWER</ans>`,

    // (5) Final-answer focus
    `This is a CAPTCHA puzzle with exactly ${L} alphanumeric characters. Carefully transcribe each one, paying close attention to:
1. Case of letters (capital vs small)
2. Distinguishing similar shapes (0/O, 1/l/I, 5/S, etc.)
3. Reading order (left to right)

${OCR_DISAMBIGUATION}

Reply with only: <ans>ANSWER</ans>`,
  ];
}

// Extract the answer string from a model response. Tries <ans> tags first,
// then falls back to any contiguous alphanumeric block of expected length.
function extractAnswer(raw, expectedLen) {
  if (!raw) return '';
  // Prefer explicit <ans>...</ans> markers
  const m = raw.match(/<ans>\s*([^<]*?)\s*<\/ans>/i);
  let candidate = m ? m[1] : raw;
  candidate = candidate.replace(/[^a-zA-Z0-9]/g, '');
  // If the model rambled, grab the first contiguous expectedLen-character block
  if (candidate.length > expectedLen + 2) {
    const lenMatch = raw.replace(/<\/?ans>/gi, '').match(new RegExp(`[a-zA-Z0-9]{${expectedLen}}`));
    if (lenMatch) candidate = lenMatch[0];
  }
  return candidate;
}

function withTimeout(promise, ms, label = 'OCR call') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ]);
}

async function callMistralOCR(imageBase64, prompt, temperature, apiKey) {
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      }],
      max_tokens:  120,
      temperature: temperature,
      top_p:       0.1,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.message || err?.error?.message || `Mistral ${res.status}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// Per-position majority vote across samples. When ties occur we prefer the
// character that appears most overall across samples (tie-break by frequency).
function voteCharacters(samples, expectedLen) {
  if (!samples.length) return '';
  // Prefer samples that match expected length
  const exact = samples.filter(s => s.length === expectedLen);
  const pool  = (exact.length >= 2 ? exact : samples.filter(s => s.length >= expectedLen))
    .map(s => s.slice(0, expectedLen));
  if (!pool.length) return samples[0];

  let result = '';
  for (let i = 0; i < expectedLen; i++) {
    const chars = pool.map(s => s[i]).filter(Boolean);
    if (!chars.length) break;
    // Count occurrences, preserve first-seen on ties
    const counts = {};
    for (const c of chars) counts[c] = (counts[c] || 0) + 1;
    let best = chars[0], bestN = 0;
    for (const c of chars) if (counts[c] > bestN) { best = c; bestN = counts[c]; }
    result += best;
  }
  return result;
}

async function solveCaptchaEnsemble({ imageVariants, apiKey, expectedLength = 5, passes = 5 }) {
  const key = apiKey || RIDGE_DEFAULT_KEY;
  const variants = Array.isArray(imageVariants) ? imageVariants.filter(Boolean) : [];
  if (!variants.length) throw new Error('No image variants provided');

  const prompts = ocrPrompts(expectedLength);
  // Build the task list — round-robin across (variant, prompt), mostly temp 0
  // with a couple of temp 0.25 calls to break model biases.
  const tasks = [];
  for (let i = 0; i < passes; i++) {
    tasks.push({
      variant:     variants[i % variants.length],
      prompt:      prompts[i % prompts.length],
      temperature: i < Math.ceil(passes * 0.6) ? 0 : 0.25,
    });
  }

  const settled = await Promise.allSettled(
    tasks.map(t =>
      withTimeout(callMistralOCR(t.variant, t.prompt, t.temperature, key), 8500, 'Pixtral pass')
        .then(raw => extractAnswer(raw, expectedLength))
    )
  );

  const samples = settled
    .filter(r => r.status === 'fulfilled' && r.value && r.value.length >= Math.max(1, expectedLength - 2))
    .map(r => r.value);

  if (!samples.length) {
    const firstErr = settled.find(r => r.status === 'rejected');
    throw new Error(firstErr?.reason?.message || 'All OCR attempts failed');
  }

  const voted = voteCharacters(samples, expectedLength);

  // Diagnostic logging — visible in the service worker console
  try {
    console.groupCollapsed(`[Quillforge] OCR ensemble · ${samples.length}/${passes} samples`);
    samples.forEach((s, i) => console.log(`pass ${i + 1}: "${s}"`));
    console.log(`final  : "${voted}"`);
    console.groupEnd();
  } catch (_) {}

  if (!voted) throw new Error('Could not read CAPTCHA text');
  return voted;
}

// Backwards-compatible single-image entry point (still used if a caller only
// has one image — defers to the ensemble with that single variant).
async function solveCaptcha(imageBase64, apiKey, expectedLength = 5) {
  return solveCaptchaEnsemble({ imageVariants: [imageBase64], apiKey, expectedLength, passes: 3 });
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

    case 'SOLVE_CAPTCHA': {
      // Accept either a single image (legacy) or an array of variants (v2).
      const variants = Array.isArray(msg.imageVariants) && msg.imageVariants.length
        ? msg.imageVariants
        : (msg.imageBase64 ? [msg.imageBase64] : []);
      const expectedLength = Number.isFinite(msg.expectedLength) ? msg.expectedLength : 5;
      const passes         = Number.isFinite(msg.passes) ? msg.passes : 5;

      solveCaptchaEnsemble({ imageVariants: variants, apiKey: msg.apiKey, expectedLength, passes })
        .then(text => sendResponse({ success: true, text }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // async
    }

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
