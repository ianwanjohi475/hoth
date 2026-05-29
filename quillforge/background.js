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
const SECURITY_CODE     = '0000';

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

const COLOUR_AND_COUNT = (L) =>
  `IMPORTANT — colour and count discipline:
- This CAPTCHA may have characters in DIFFERENT COLOURS (red, green, blue, yellow, purple, orange, etc.) on a light background. The colour is decoration — read the CHARACTER each colour represents.
- Each coloured shape is one character.
- Count carefully. There MUST be exactly ${L} characters.
- THIN characters (lowercase i, l, I, 1, .) are easy to miss — if your count is less than ${L}, look again at the start, end, and gaps between letters for a thin/faint character you skipped.
- Do NOT skip any character even if it is faint, thin, or a colour that blends with the background.
- IGNORE noise overlays: wavy lines, strikethrough strokes, coloured streaks, dots, and squiggles that cross through or around the letters are DECORATION, not characters. Only solid, closed letter/digit shapes count.`;

function ocrPrompts(L) {
  return [
    // (1) Strict format with full disambiguation
    `You are a precise CAPTCHA OCR system. The image contains EXACTLY ${L} characters.

${COLOUR_AND_COUNT(L)}

Rules:
- Each character is uppercase A-Z, lowercase a-z, or digit 0-9
- PRESERVE CASE EXACTLY — uppercase MUST remain uppercase, lowercase MUST remain lowercase
- Read left to right
- Ignore noise, lines, dots, and background patterns

${OCR_DISAMBIGUATION}

Output ONLY this exact format, nothing else:
<ans>RESULT</ans>`,

    // (2) Chain-of-thought with explicit count step
    `Examine this CAPTCHA image carefully. It contains EXACTLY ${L} characters in a row.

Step 1: COUNT the coloured shapes left to right. There must be ${L}. If you counted fewer, look again — you missed a thin character (i, l, I, 1, .).
Step 2: Identify each character. Some may be coloured (red, green, blue, etc.) — the colour is irrelevant, only the character shape matters.
Step 3: For each one, decide: uppercase letter, lowercase letter, or digit. Compare against the heights of neighbouring letters.
Step 4: Combine into a final string of EXACTLY ${L} characters, preserving the EXACT case.

Output only the final answer between <ans> and </ans> tags. The string MUST be ${L} characters long.`,

    // (3) Concise + structured + count emphasis
    `OCR this ${L}-character multi-coloured CAPTCHA. Case-sensitive [a-zA-Z0-9].

Output exactly ${L} characters. Do NOT skip thin or faint coloured characters.

${OCR_DISAMBIGUATION}

Reply only: <ans>RESULT</ans>`,

    // (4) Direct, case + colour focus
    `Read the ${L} characters in this CAPTCHA. Each character may be a DIFFERENT COLOUR (red, green, blue, yellow, etc.) — the colours are decorative, focus on character shape.

The CAPTCHA mixes uppercase letters, lowercase letters, and digits — copy the case EXACTLY as drawn.

Pay attention to which letters are tall (capitals, ascenders like b/d/h/k/l) vs which are short (a, c, e, m, n, o, r, s, u, v, w, x, z). Lowercase letters that look like capitals are usually shorter.

There are EXACTLY ${L} characters. Do not skip thin or faint ones at the start or end.

Output: <ans>YOUR_ANSWER</ans>`,

    // (5) Final-answer focus, count-first
    `This is a multi-coloured CAPTCHA with EXACTLY ${L} alphanumeric characters.

${COLOUR_AND_COUNT(L)}

Carefully transcribe each one, paying close attention to:
1. Total count = ${L} (recount if your draft is shorter)
2. Case of letters (capital vs small)
3. Distinguishing similar shapes (0/O, 1/l/I, 5/S, etc.)
4. Reading order (left to right)

${OCR_DISAMBIGUATION}

Reply with only: <ans>ANSWER</ans>  (must be exactly ${L} characters)`,
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Groq's current multimodal model. If the user's Groq plan doesn't include
// it, the call will fail and the ensemble falls back to Mistral-only — the
// solver keeps working, just with one fewer model in the vote.
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

async function callMistralOCR(imageBase64, prompt, temperature, apiKey, attempts = 2) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
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
        const msg = err?.message || err?.error?.message || `Mistral ${res.status}`;
        // Back off on rate limit / transient server errors
        if ((res.status === 429 || res.status >= 500) && i < attempts - 1) {
          await sleep(400 + Math.random() * 400);
          lastErr = new Error(msg);
          continue;
        }
        throw new Error(msg);
      }
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() || '';
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1 && /rate|429|timeout|network|fetch/i.test(e.message || '')) {
        await sleep(400);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('Mistral call failed');
}

async function callGroqVisionOCR(imageBase64, prompt, temperature, apiKey, attempts = 2) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: GROQ_VISION_MODEL,
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
        const msg = err?.error?.message || `Groq ${res.status}`;
        if ((res.status === 429 || res.status >= 500) && i < attempts - 1) {
          await sleep(400 + Math.random() * 400);
          lastErr = new Error(msg);
          continue;
        }
        throw new Error(msg);
      }
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() || '';
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1 && /rate|429|timeout|network|fetch/i.test(e.message || '')) {
        await sleep(400);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('Groq call failed');
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
  const mistralKey = apiKey || RIDGE_DEFAULT_KEY;

  // Cross-model OCR uses the Groq key the user already configured for the
  // article writer. Falls back to the default Groq key if none is set yet.
  const groqKey = await new Promise((resolve) => {
    chrome.storage.sync.get(['groqApiKey'], d => resolve(d.groqApiKey || DEFAULT_GROQ_KEY));
  });

  const variants = Array.isArray(imageVariants) ? imageVariants.filter(Boolean) : [];
  if (!variants.length) throw new Error('No image variants provided');

  const prompts = ocrPrompts(expectedLength);

  // Build the task list — round-robin across (variant, prompt).
  // Provider split: ~75 % Mistral Pixtral (proven), ~25 % Groq Llama-4 Scout
  // (cross-model diversity). Same-model errors correlate; different-model
  // errors don't, which is what actually makes the vote effective.
  const groqPasses = groqKey ? (passes >= 6 ? 2 : 1) : 0;
  const tasks = [];
  for (let i = 0; i < passes; i++) {
    const useGroq = groqPasses > 0 && i >= (passes - groqPasses);
    tasks.push({
      variant:     variants[i % variants.length],
      prompt:      prompts[i % prompts.length],
      temperature: i < Math.ceil(passes * 0.6) ? 0 : 0.25,
      provider:    useGroq ? 'groq' : 'mistral',
    });
  }

  // Stagger requests by 80 ms each so we don't burst the rate limiter
  const settled = await Promise.allSettled(
    tasks.map((t, idx) => {
      const fn = async () => {
        if (idx > 0) await sleep(idx * 80);
        const raw = t.provider === 'groq'
          ? await callGroqVisionOCR(t.variant, t.prompt, t.temperature, groqKey)
          : await callMistralOCR(t.variant, t.prompt, t.temperature, mistralKey);
        return { provider: t.provider, raw, text: extractAnswer(raw, expectedLength) };
      };
      return withTimeout(fn(), 12000, `${t.provider} pass ${idx + 1}`);
    })
  );

  const fulfilled = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  const rejected  = settled.filter(r => r.status === 'rejected').map(r => r.reason?.message || String(r.reason));

  const samples = fulfilled.filter(s =>
    s.text && s.text.length >= Math.max(1, expectedLength - 2)
  );

  if (!samples.length) {
    // Surface the real cause rather than a generic "Retrying…"
    console.warn('[Quillforge OCR] All passes failed:', { rejected, raw: fulfilled.map(s => s.raw) });
    const msg = rejected[0] || 'All OCR attempts failed';
    throw new Error(msg);
  }

  const voted = voteCharacters(samples.map(s => s.text), expectedLength);

  // Diagnostic log — see the per-provider breakdown in the SW console
  try {
    console.groupCollapsed(`[Quillforge OCR] ${samples.length}/${passes} samples · voted "${voted}"`);
    samples.forEach((s, i) => console.log(`  ${s.provider.padEnd(8)} → "${s.text}"`));
    if (rejected.length) console.log('  rejected:', rejected);
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
