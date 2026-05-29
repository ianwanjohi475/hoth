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

const STRICT_FORMAT_RULES = `═══ RESPONSE FORMAT RULES — READ CAREFULLY ═══
Your ENTIRE response must be ONLY this format, nothing else:
<ans>X</ans>
(where X is your answer)

ABSOLUTELY FORBIDDEN:
✗ "Examining the captcha…"
✗ "Looking at the image…"
✗ "I see / I can see…"
✗ "The captcha contains / shows…"
✗ "The characters are…"
✗ "Analyzing…"
✗ Any explanation, reasoning, or commentary
✗ Any text before or after the <ans></ans> tags

CORRECT EXAMPLES:
✓ <ans>jJ12U</ans>
✓ <ans>aB5cD</ans>
✓ <ans>ID7uW</ans>

WRONG EXAMPLES (do NOT do these):
✗ Examining the captcha, the answer is jJ12U
✗ <ans>jJ12U</ans> — the J is uppercase
✗ The image shows jJ12U so <ans>jJ12U</ans>
✗ jJ12U

If unsure about a single character, use ? in place of it (e.g. <ans>aB?dE</ans>).
═══════════════════════════════════════════════`;

const OCR_DISAMBIGUATION = `Disambiguate carefully:
- 0 (zero) vs O (uppercase oh) vs o (lowercase oh)
- 1 (one) vs l (lowercase L) vs I (uppercase i)
- 5 vs S vs s, 9 vs g vs q, 6 vs G vs b, 2 vs Z vs z
- Same-shape pairs (C/c, K/k, M/m, P/p, S/s, U/u, V/v, W/w, X/x, Y/y, Z/z): judge by relative HEIGHT against neighbouring tall letters.`;

const COLOUR_AND_COUNT = (L) =>
  `Image content:
- The CAPTCHA has EXACTLY ${L} characters: uppercase A-Z, lowercase a-z, or digit 0-9
- Characters may be DIFFERENT COLOURS (red, green, blue, yellow, purple) — colour is DECORATION, read the character shape
- Wavy lines, strikethrough strokes, dots, squiggles = DECORATION, IGNORE them
- Thin characters (i, l, I, 1) at the start or end are easy to miss — count to ${L} carefully
- PRESERVE CASE EXACTLY: capital letters stay capital, lowercase letters stay lowercase`;

function ocrPrompts(L) {
  return [
    `${STRICT_FORMAT_RULES}

TASK: Read the ${L}-character CAPTCHA in this image.

${COLOUR_AND_COUNT(L)}

${OCR_DISAMBIGUATION}

Respond now (tags only, no other text):`,

    `${STRICT_FORMAT_RULES}

TASK: Transcribe the ${L} characters from this CAPTCHA exactly as drawn.

Step 1 (internal, do not write): Count the coloured shapes. There must be ${L}.
Step 2 (internal, do not write): Identify each character, decide case.
Step 3 (write this as your ENTIRE response): <ans>your_answer_here</ans>

${COLOUR_AND_COUNT(L)}

Respond:`,

    `${STRICT_FORMAT_RULES}

TASK: OCR this ${L}-character CAPTCHA. Case-sensitive [a-zA-Z0-9].

${OCR_DISAMBIGUATION}

Respond:`,

    `${STRICT_FORMAT_RULES}

TASK: Identify the ${L} characters in this CAPTCHA preserving exact case.

${COLOUR_AND_COUNT(L)}

${OCR_DISAMBIGUATION}

Respond (tags only):`,

    `${STRICT_FORMAT_RULES}

TASK: ${L}-character alphanumeric CAPTCHA. Each character is uppercase A-Z, lowercase a-z, or digit 0-9.

${COLOUR_AND_COUNT(L)}

${OCR_DISAMBIGUATION}

Final answer (tags only, no commentary):`,
  ];
}

// STRICT extraction: only accept responses with explicit <ans>…</ans> tags.
//
// The previous loose version had a greedy fallback ("if no tags, take the
// first 5 alphanumeric chars") which produced 'Exami' out of 'Examining
// the captcha…' whenever the model added commentary instead of just the
// answer. Rejecting un-tagged responses costs us those samples but keeps
// the vote clean — better to vote on fewer good samples than a mix of
// good samples and parser garbage.
function extractAnswer(raw, expectedLen) {
  if (!raw) return '';
  const m = raw.match(/<ans>\s*([^<]*?)\s*<\/ans>/i);
  if (!m) {
    console.warn('[Quillforge OCR] response missing <ans> tags:', raw.slice(0, 100));
    return '';
  }
  // Keep '?' as a valid sentinel — model uses it for "unsure on this position"
  const cleaned = m[1].replace(/[^a-zA-Z0-9?]/g, '');
  // Sanity bounds: empty, all-unsure, or wildly long → reject the sample
  if (!cleaned.length || cleaned.length > expectedLen + 4) return '';
  if (/^\?+$/.test(cleaned)) return '';
  return cleaned;
}

function withTimeout(promise, ms, label = 'OCR call') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ]);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callMistralOCR(imageBase64, prompt, temperature, apiKey, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      // CRITICAL: Mistral rejects top_p≠1 when temperature=0 ("greedy
      // sampling"). Send top_p only when we're actually doing stochastic
      // sampling (temperature > 0); omit it on greedy calls.
      const body = {
        model:       MISTRAL_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        }],
        max_tokens:  120,
        temperature: temperature,
      };
      if (temperature > 0) body.top_p = 0.1;

      const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err?.message || err?.error?.message || `Mistral ${res.status}`;
        // Real backoff on rate-limit / server errors. Free tier is ~1 req/s
        // so 3-5s with jitter is required, not the 400ms I had before.
        if ((res.status === 429 || res.status >= 500) && i < attempts - 1) {
          const wait = 3000 + Math.random() * 2000 + i * 1500;
          await sleep(wait);
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
        await sleep(3000 + Math.random() * 2000);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('Mistral call failed');
}

// Single-character OCR prompt — used on individual segments cropped from
// the captcha. Same model (Mistral Pixtral), much smaller problem space:
// no counting, no spatial multi-attention, just "what is this glyph?".
function singleCharPrompt() {
  return `═══ RESPONSE FORMAT — READ CAREFULLY ═══
Your ENTIRE response must be ONLY: <ans>X</ans>
(where X is exactly one character)

ABSOLUTELY FORBIDDEN:
✗ "Examining the character…"
✗ "Looking at the image…"
✗ "I see / I can see…"
✗ "The character appears to be…"
✗ "It looks like…"
✗ Any explanation or commentary
✗ Any text before or after the <ans></ans> tags

CORRECT EXAMPLES:
✓ <ans>A</ans>
✓ <ans>g</ans>
✓ <ans>7</ans>
✓ <ans>?</ans>     (only if you are unsure)

WRONG EXAMPLES (do NOT do these):
✗ Examining the character, it appears to be <ans>A</ans>
✗ The character is A
✗ <ans>A</ans> (lowercase)
═══════════════════════════════════════════════

TASK: This image is ONE character cropped from a CAPTCHA. Identify the MAIN character in the CENTRE.

- Character is uppercase A-Z, lowercase a-z, or digit 0-9
- PRESERVE CASE EXACTLY (capital stays capital, lowercase stays lowercase)
- Slivers of neighbouring characters may appear at the edges — IGNORE them, focus on the centre
- Wavy lines, strikethrough strokes, dots, coloured streaks = DECORATION, IGNORE them
- Distinguish carefully: 0/O/o, 1/l/I, 5/S/s, 9/g/q, 6/G/b, 2/Z/z (compare relative height — capitals are tall, lowercase are short)

If you cannot identify the character with confidence, respond with: <ans>?</ans>

Respond now (tags only):`;
}

// STRICT: only accept <ans>X</ans> where X is one alphanumeric character
// (or '?' for "unsure"). No greedy fallback — a response of
// "Examining the character, it appears to be A" would otherwise yield 'E'.
function extractSingleChar(raw) {
  if (!raw) return '';
  const m = raw.match(/<ans>\s*([a-zA-Z0-9?])\s*<\/ans>/);
  if (!m) {
    console.warn('[Quillforge OCR] per-char response missing <ans> tag:', raw.slice(0, 60));
    return '';
  }
  if (m[1] === '?') return '';   // model said unsure → no vote
  return m[1];
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

async function solveCaptchaEnsemble({ imageVariants, segmentedChars, cvHint, apiKey, expectedLength = 5, passes = 5 }) {
  const mistralKey = apiKey || RIDGE_DEFAULT_KEY;
  const variants   = Array.isArray(imageVariants)  ? imageVariants.filter(Boolean)  : [];
  const segments   = Array.isArray(segmentedChars) ? segmentedChars.filter(Boolean) : [];
  // cvHint is the answer from the pure-JS local OCR solver. Treated as one
  // additional sample in the per-position vote alongside the API samples.
  // Independent of Mistral's failure modes, which makes it real signal.
  const cvSamples = (typeof cvHint === 'string' && cvHint.length >= Math.max(1, expectedLength - 2))
    ? [{ kind: 'cv', text: cvHint, raw: cvHint }]
    : [];
  if (!variants.length) throw new Error('No image variants provided');

  const prompts = ocrPrompts(expectedLength);
  const charPrompt = singleCharPrompt();

  // ── Full-image tasks ──
  // The existing N-pass Mistral ensemble. Each pass sees a different
  // (image variant × prompt) combo. Mostly temperature 0 with a couple
  // of 0.25 calls for diversity.
  const fullTasks = [];
  for (let i = 0; i < passes; i++) {
    fullTasks.push({
      kind:        'full',
      image:       variants[i % variants.length],
      prompt:      prompts[i % prompts.length],
      temperature: i < Math.ceil(passes * 0.6) ? 0 : 0.25,
    });
  }

  // ── Per-character tasks ──
  // One Mistral call per character segment. Each segment is a single-
  // character image (slightly padded so the model sees the full glyph
  // even if segmentation lands slightly off). Single-char OCR is far
  // more reliable than full-string OCR — the model only has to identify
  // ONE glyph in isolation, no counting, sharper attention.
  const charTasks = segments.slice(0, expectedLength).map((seg, idx) => ({
    kind:        'char',
    position:    idx,
    image:       seg,
    prompt:      charPrompt,
    temperature: 0,
  }));

  // ── Run everything in parallel with stagger ──
  // Mistral free tier is ~1 req/s. 1100ms between calls (just over 1s)
  // keeps us comfortably under the limit instead of bursting and getting
  // every call rejected with 429.
  const allTasks = [...fullTasks, ...charTasks];
  const settled = await Promise.allSettled(
    allTasks.map((t, idx) => {
      const fn = async () => {
        if (idx > 0) await sleep(idx * 1100);
        const raw = await callMistralOCR(t.image, t.prompt, t.temperature, mistralKey);
        if (t.kind === 'full') {
          return { ...t, raw, text: extractAnswer(raw, expectedLength) };
        } else {
          return { ...t, raw, text: extractSingleChar(raw) };
        }
      };
      return withTimeout(fn(), 15000, `${t.kind} pass ${idx + 1}`);
    })
  );

  const fulfilled = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  const rejected  = settled.filter(r => r.status === 'rejected').map(r => r.reason?.message || String(r.reason));

  const fullSamples = fulfilled.filter(s => s.kind === 'full'
    && s.text && s.text.length >= Math.max(1, expectedLength - 2));
  const charSamples = fulfilled.filter(s => s.kind === 'char' && /^[a-zA-Z0-9]$/.test(s.text));

  if (!fullSamples.length && !charSamples.length) {
    console.warn('[Quillforge OCR] All passes failed:', { rejected });
    throw new Error(rejected[0] || 'All OCR attempts failed');
  }

  // ── Combined per-position vote ──
  // For each character position, gather votes from:
  //   1. Every full-image sample's character at that position
  //   2. The per-character segment OCR for that position
  // '?' chars (model said "unsure") are filtered out of votes — they're
  // explicit non-votes.
  let voted = '';
  const breakdown = [];
  // Confidence per position = (votes for winner) / (total valid votes).
  // Overall confidence = MIN across positions (weakest link sets the
  // chain). Drives the "refuse to submit unless certain" gate downstream.
  const positionConfidences = [];
  for (let i = 0; i < expectedLength; i++) {
    const fromFull = fullSamples
      .map(s => (s.text.length === expectedLength ? s.text[i] : null))
      .filter(c => c && c !== '?' && /[a-zA-Z0-9]/.test(c));
    const fromChar = charSamples
      .filter(s => s.position === i)
      .map(s => s.text)
      .filter(c => c && c !== '?' && /[a-zA-Z0-9]/.test(c));
    const fromCv = cvSamples
      .map(s => (s.text.length > i ? s.text[i] : null))
      .filter(c => c && c !== '?' && /[a-zA-Z0-9]/.test(c));

    const allVotes = [...fromFull, ...fromChar, ...fromCv];
    if (!allVotes.length) {
      // No vote for this position — try loose full-image positions (even
      // for length-mismatched samples), else mark '?'.
      const loose = fullSamples
        .map(s => s.text[i])
        .filter(c => c && c !== '?' && /[a-zA-Z0-9]/.test(c));
      voted += loose.length ? mostFrequent(loose) : '?';
      positionConfidences.push(0);
      breakdown.push({ pos: i, full: fromFull, char: fromChar, cv: fromCv, picked: voted[i], note: 'fallback', conf: 0 });
      continue;
    }
    const pick = mostFrequent(allVotes);
    const winnerCount = allVotes.filter(c => c === pick).length;
    const conf = winnerCount / allVotes.length;
    voted += pick;
    positionConfidences.push(conf);
    breakdown.push({ pos: i, full: fromFull, char: fromChar, cv: fromCv, picked: pick, conf });
  }
  const overallConfidence = positionConfidences.length
    ? Math.min(...positionConfidences)
    : 0;

  // ── Diagnostic log ──
  try {
    console.groupCollapsed(`[Quillforge OCR] full ${fullSamples.length}·char ${charSamples.length}·cv ${cvSamples.length} · "${voted}" · conf ${(overallConfidence * 100).toFixed(0)}%`);
    fullSamples.forEach((s, i) => console.log(`  full ${i + 1}: "${s.text}"`));
    charSamples.forEach((s)    => console.log(`  char [${s.position}]: "${s.text}"`));
    cvSamples.forEach((s)      => console.log(`  cv  hint: "${s.text}"  (pure-JS local solver)`));
    breakdown.forEach(b => console.log(`  pos ${b.pos}: full=${JSON.stringify(b.full)} char=${JSON.stringify(b.char)} cv=${JSON.stringify(b.cv || [])} → "${b.picked}" (${(b.conf * 100).toFixed(0)}%)`));
    if (rejected.length) console.log('  rejected:', rejected);
    console.groupEnd();
  } catch (_) {}

  // Remove trailing '?' fallbacks (length-tolerant downstream check)
  voted = voted.replace(/\?+$/, '');
  if (!voted) throw new Error('Vote produced empty result');
  return { text: voted, confidence: overallConfidence };
}

function mostFrequent(arr) {
  const counts = {};
  let best = arr[0], bestN = 0;
  for (const x of arr) {
    counts[x] = (counts[x] || 0) + 1;
    if (counts[x] > bestN) { best = x; bestN = counts[x]; }
  }
  return best;
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
      const segmentedChars = Array.isArray(msg.segmentedChars) ? msg.segmentedChars : [];
      const cvHint         = typeof msg.cvHint === 'string' ? msg.cvHint : null;
      const expectedLength = Number.isFinite(msg.expectedLength) ? msg.expectedLength : 5;
      const passes         = Number.isFinite(msg.passes) ? msg.passes : 5;

      solveCaptchaEnsemble({
        imageVariants:  variants,
        segmentedChars,
        cvHint,
        apiKey:         msg.apiKey,
        expectedLength,
        passes,
      })
        .then(({ text, confidence }) => sendResponse({ success: true, text, confidence }))
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
