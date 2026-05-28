// ============================================================================
//  Quillforge — Content Script
//  Runs on every page; self-gates to HOTH writer / job pages.
//
//  Modules:
//    A. Edit Watcher        — looks for "Edit" buttons on /writer
//    B. Spintax Scanner     — flags "requires spintax" errors
//    C. Article Auto-Writer — Groq-powered article generation
//    D. Ridge Solver        — Mistral vision CAPTCHA autosolve
// ============================================================================

(() => {

// ---------------------------------------------------------------------------
//  Shared design tokens (mirrors the side panel palette)
// ---------------------------------------------------------------------------
const QF = Object.freeze({
  bg:        '#11151D',
  surface:   '#161B25',
  surface2:  '#1C2230',
  border:    '#2E374A',
  text:      '#E8EDF5',
  muted:     '#9BA8BD',
  faint:     '#5E6A7E',
  accent:    '#4F8BFF',
  accentHi:  '#6B9EFF',
  success:   '#3FD4A8',
  warning:   '#F2B547',
  danger:    '#F25B7A',
  fontStack: '"Inter","SF Pro Text","Segoe UI",system-ui,sans-serif',
  monoStack: '"JetBrains Mono","SF Mono",Menlo,monospace',
});

// Inline Lucide SVG icons (24x24, currentColor)
const ICON = {
  feather: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><path d="m16 8-9 9"/><path d="M12 17H7"/></svg>',
  check:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  x:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  bolt:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg>',
  square:  '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
};

// ---------------------------------------------------------------------------
//  Settings (sync with chrome.storage, defaults match background)
// ---------------------------------------------------------------------------
let S = {
  watcherEnabled: true,
  autoClick:      true,
  alarmDuration:  10,
  checkInterval:  10,
  spintaxEnabled: true,
  writerEnabled:  true,
  autoMode:       false,
  autoSubmit:     false,
  waitTime:       5,
  groqApiKey:     '',
  groqModel:      'llama-3.1-8b-instant',
};

function loadSettings(cb) {
  chrome.storage.sync.get({
    watcherEnabled: true,
    autoClick:      true,
    alarmDuration:  10,
    checkInterval:  10,
    spintaxEnabled: true,
    writerEnabled:  true,
    autoMode:       false,
    autoSubmit:     false,
    waitTime:       5,
    groqApiKey:     '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',
    groqModel:      'llama-3.1-8b-instant',
  }, (data) => { S = data; if (cb) cb(); });
}

// ---------------------------------------------------------------------------
//  Page classification
// ---------------------------------------------------------------------------
const isHothWriter = () => /thehoth\.com\/writer/i.test(window.location.href);
const isJobPage    = () =>
  !!document.querySelector('div.well') ||
  document.body.innerText.includes('Client submitted the keywords') ||
  !!document.querySelector('textarea[name="body"]') ||
  !!document.querySelector('#body');

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const s = window.getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
}

// ===========================================================================
//  A. SPINTAX SCANNER
// ===========================================================================
let spintaxTriggered = false;
let spintaxInterval  = null;
const SPINTAX_RE     = /requires\s+spintax/i;

function checkForSpintax() {
  if (spintaxTriggered || !S.spintaxEnabled) return;
  for (const el of document.querySelectorAll('.alert')) {
    if (SPINTAX_RE.test(el.textContent)) { triggerSpintax('alert-div'); return; }
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    if (SPINTAX_RE.test(node.nodeValue)) { triggerSpintax('text-node'); return; }
  }
}

function triggerSpintax(source) {
  console.log('[Quillforge] Spintax detected via', source);
  spintaxTriggered = true;
  if (spintaxInterval) { clearInterval(spintaxInterval); spintaxInterval = null; }
  chrome.runtime.sendMessage({ type: 'SPINTAX_ERROR_FOUND' });
}

function startSpintaxScanner() {
  if (spintaxInterval) clearInterval(spintaxInterval);
  spintaxTriggered = false;
  checkForSpintax();
  spintaxInterval = setInterval(checkForSpintax, 1000);
}
function stopSpintaxScanner() {
  if (spintaxInterval) { clearInterval(spintaxInterval); spintaxInterval = null; }
}

// ===========================================================================
//  B. HOTH EDIT WATCHER
// ===========================================================================
let watchInterval = null;
let hasTriggered  = false;

function findClickableAncestor(node) {
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && el !== document.body) {
    const tag  = (el.tagName || '').toLowerCase();
    const role = (el.getAttribute?.('role') || '').toLowerCase();
    if (
      tag === 'a' || tag === 'button' || tag === 'input' ||
      role === 'button' || role === 'link' ||
      el.hasAttribute?.('href') || el.hasAttribute?.('onclick') ||
      el.style.cursor === 'pointer'
    ) return el;
    if ((el.textContent || '').trim().length > 20) break;
    el = el.parentElement;
  }
  return null;
}

function findEditElement() {
  const EDIT_RE = /\bedit\b/i;
  const walker  = document.createTreeWalker(
    document.body, NodeFilter.SHOW_TEXT,
    {
      acceptNode(n) {
        if (!EDIT_RE.test(n.nodeValue.trim())) return NodeFilter.FILTER_SKIP;
        if (!isVisible(n.parentElement))        return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );
  let textNode;
  while ((textNode = walker.nextNode())) {
    const clickable = findClickableAncestor(textNode) || textNode.parentElement;
    if (clickable && isVisible(clickable)) return clickable;
  }
  for (const sel of ['[aria-label]', '[title]']) {
    for (const el of document.querySelectorAll(sel)) {
      const val = el.getAttribute('aria-label') || el.getAttribute('title');
      if (val && EDIT_RE.test(val) && isVisible(el)) return el;
    }
  }
  return null;
}

function extractHref(el) {
  if (el.tagName?.toLowerCase() === 'a' && el.href) return el.href;
  let p = el.parentElement;
  while (p && p !== document.body) {
    if (p.tagName?.toLowerCase() === 'a' && p.href) return p.href;
    p = p.parentElement;
  }
  return el.querySelector?.('a[href]')?.href || null;
}

function checkPage() {
  if (!S.watcherEnabled || hasTriggered) return;
  const editEl = findEditElement();
  if (!editEl) return;
  const articleUrl = extractHref(editEl);
  console.log('[Quillforge] Edit found:', articleUrl);
  hasTriggered = true;
  chrome.runtime.sendMessage({
    type:          'EDIT_FOUND',
    articleUrl,
    alarmDuration: S.alarmDuration,
    autoClick:     S.autoClick,
  });
}

function startWatching() {
  if (watchInterval) clearInterval(watchInterval);
  watchInterval = setInterval(checkPage, S.checkInterval * 1000);
  console.log(`[Quillforge] Edit watcher running every ${S.checkInterval}s`);
}
function stopWatching() {
  if (watchInterval) { clearInterval(watchInterval); watchInterval = null; }
}

// ===========================================================================
//  SPA navigation watcher
// ===========================================================================
let lastUrl = window.location.href;
function onUrlChange() {
  const newUrl = window.location.href;
  if (newUrl === lastUrl) return;
  lastUrl = newUrl;
  hasTriggered = false;
  if ((isHothWriter() || isJobPage()) && S.spintaxEnabled) startSpintaxScanner();
}
window.addEventListener('popstate', onUrlChange);
(() => {
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function (...a) { orig.apply(this, a); onUrlChange(); };
  }
})();
new MutationObserver(onUrlChange).observe(document.body, { childList: true, subtree: false });

// ===========================================================================
//  C. ARTICLE AUTO-WRITER
// ===========================================================================
let alreadyRan = false;

function attachDebugger() {
  return new Promise(r => chrome.runtime.sendMessage({ type: 'ATTACH_DEBUGGER' }, res => r(res?.ok)));
}
function detachDebugger() {
  chrome.runtime.sendMessage({ type: 'DETACH_DEBUGGER' });
}

function getKeywords() {
  const wells = document.querySelectorAll('div.well, div[class*="well"]');
  for (const well of wells) {
    for (const ul of well.querySelectorAll('ul')) {
      const texts = [...ul.querySelectorAll('li')].map(li => li.innerText.trim().toLowerCase());
      const bad   = texts.some(t =>
        t.includes('brand name') || t.includes('url') || t.includes('filler') || t.includes('click here')
      );
      if (bad) continue;
      const all = [...ul.querySelectorAll('li')].map(li => li.innerText.trim()).filter(Boolean);
      if (all.length) return all;
    }
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.textContent.includes('Client submitted the keywords')) {
      let el = node.parentElement;
      for (let i = 0; i < 10; i++) {
        el = el?.nextElementSibling;
        if (!el) break;
        if (el.tagName === 'UL') {
          const all = [...el.querySelectorAll('li')].map(li => li.innerText.trim()).filter(Boolean);
          if (all.length) return all;
        }
        const ul = el.querySelector?.('ul');
        if (ul) {
          const all = [...ul.querySelectorAll('li')].map(li => li.innerText.trim()).filter(Boolean);
          if (all.length) return all;
        }
      }
    }
  }
  return [];
}

function setNativeValue(el, value) {
  const proto  = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function toTitleCase(str) {
  const minors = ['a','an','the','and','but','or','for','nor','on','at','to','by','in','of','up','as','is'];
  return str.toLowerCase().split(' ').map((w, i) =>
    i === 0 || !minors.includes(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w
  ).join(' ');
}

function stripMarkdown(text) {
  return text
    .replace(/^#{1,6}\s*(.+)/gm, (_, h) => toTitleCase(h))
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g,     '$1')
    .replace(/^[-*]\s+/gm,     '')
    .replace(/`{1,3}/g,        '')
    .trim();
}

function clickSubmitButton() {
  const btn =
    document.querySelector('input[name="submit"]') ||
    document.querySelector('input[value="Submit For Review"]') ||
    document.querySelector('input[type="submit"]') ||
    document.querySelector('button[type="submit"]') ||
    [...document.querySelectorAll('button,input[type="button"]')]
      .find(el => el.value?.toLowerCase().includes('submit') || el.innerText?.toLowerCase().includes('submit'));
  if (!btn) return false;
  btn.click();
  return true;
}

// ---------- Progress card UI (in-page) -------------------------------------
function injectWriterStyles() {
  if (document.getElementById('qf-writer-style')) return;
  const style = document.createElement('style');
  style.id = 'qf-writer-style';
  style.textContent = `
    #qf-card, #qf-fab {
      font-family: ${QF.fontStack};
      color: ${QF.text};
      box-sizing: border-box;
    }
    #qf-card *, #qf-fab * { box-sizing: border-box; }

    #qf-card {
      position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
      width: 304px; padding: 16px 18px 14px;
      background: ${QF.surface}; border: 1px solid ${QF.border};
      border-radius: 14px;
      box-shadow: 0 18px 48px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.35);
      animation: qf-rise 220ms cubic-bezier(.2,.8,.2,1);
    }
    @keyframes qf-rise {
      from { transform: translateY(12px); opacity: 0; }
      to   { transform: translateY(0);    opacity: 1; }
    }

    .qf-card-header {
      display: flex; align-items: center; gap: 10px; margin-bottom: 4px;
    }
    .qf-card-logo {
      width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0;
      background: linear-gradient(135deg, ${QF.accent}, #2B5BD7);
      display: flex; align-items: center; justify-content: center; color: #fff;
    }
    .qf-card-logo svg { width: 16px; height: 16px; }
    .qf-card-title { font-size: 13px; font-weight: 600; letter-spacing: -0.01em; }
    .qf-card-sub   { font-size: 11px; color: ${QF.muted}; margin-top: 1px; }

    #qf-card-kw {
      margin: 12px 0 14px; padding: 8px 10px;
      background: ${QF.bg}; border: 1px solid ${QF.border};
      border-radius: 8px;
      font-family: ${QF.monoStack}; font-size: 11px; color: ${QF.accent};
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    .qf-step { display: flex; align-items: center; gap: 10px; padding: 4px 0; opacity: 0.45; transition: opacity 200ms; }
    .qf-step.active, .qf-step.error { opacity: 1; }
    .qf-step.done { opacity: 0.85; }

    .qf-dot {
      width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0;
      background: transparent; border: 1.5px solid ${QF.border};
      color: ${QF.faint};
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 700;
      transition: all 200ms;
    }
    .qf-dot svg { width: 11px; height: 11px; }
    .qf-step.active .qf-dot {
      border-color: ${QF.accent}; color: ${QF.accent};
      box-shadow: 0 0 0 0 ${QF.accent}33;
      animation: qf-pulse 1.2s infinite;
    }
    .qf-step.done  .qf-dot { background: ${QF.success}; border-color: ${QF.success}; color: #0B0E14; }
    .qf-step.error .qf-dot { background: ${QF.danger};  border-color: ${QF.danger};  color: #FFFFFF; }
    @keyframes qf-pulse {
      0%   { box-shadow: 0 0 0 0   ${QF.accent}55; }
      70%  { box-shadow: 0 0 0 6px ${QF.accent}00; }
      100% { box-shadow: 0 0 0 0   ${QF.accent}00; }
    }

    .qf-step-label { font-size: 12px; color: ${QF.muted}; font-weight: 500; }
    .qf-step.active .qf-step-label { color: ${QF.text}; font-weight: 600; }
    .qf-step.done   .qf-step-label { color: ${QF.success}; }
    .qf-step.error  .qf-step-label { color: ${QF.danger}; }

    .qf-progress-track { height: 3px; background: ${QF.bg}; border-radius: 3px; margin: 12px 0 8px; overflow: hidden; }
    .qf-progress-fill  { height: 100%; width: 0; background: linear-gradient(90deg, ${QF.accent}, ${QF.success}); transition: width 500ms ease; }

    #qf-card-foot { font-size: 10.5px; color: ${QF.faint}; text-align: center; letter-spacing: 0.02em; }

    #qf-fab {
      position: fixed; bottom: 24px; right: 24px; z-index: 2147483646;
      display: inline-flex; align-items: center; gap: 8px;
      padding: 11px 18px;
      background: linear-gradient(135deg, ${QF.accent} 0%, #2B5BD7 100%);
      color: #fff; border: none; border-radius: 999px;
      font-size: 13px; font-weight: 600; letter-spacing: -0.01em; cursor: pointer;
      box-shadow: 0 8px 24px rgba(79,139,255,0.35), 0 2px 6px rgba(0,0,0,0.25);
      transition: transform 150ms, box-shadow 150ms;
      user-select: none;
    }
    #qf-fab:hover  { transform: translateY(-1px); box-shadow: 0 10px 28px rgba(79,139,255,0.45), 0 2px 6px rgba(0,0,0,0.3); }
    #qf-fab:active { transform: translateY(0); }
    #qf-fab svg { width: 14px; height: 14px; }
  `;
  document.head.appendChild(style);
}

function createCard() {
  if (document.getElementById('qf-card')) return;
  injectWriterStyles();
  const card = document.createElement('div');
  card.id = 'qf-card';
  card.innerHTML = `
    <div class="qf-card-header">
      <div class="qf-card-logo">${ICON.feather}</div>
      <div>
        <div class="qf-card-title">Article Composer</div>
        <div class="qf-card-sub">Quillforge · Groq Llama 3.1</div>
      </div>
    </div>
    <div id="qf-card-kw">Detecting keyword…</div>
    <div class="qf-step" id="qf-step-1"><div class="qf-dot">1</div><span class="qf-step-label">Detect keyword</span></div>
    <div class="qf-step" id="qf-step-2"><div class="qf-dot">2</div><span class="qf-step-label">Generate article</span></div>
    <div class="qf-step" id="qf-step-3"><div class="qf-dot">3</div><span class="qf-step-label">Fill form fields</span></div>
    <div class="qf-step" id="qf-step-4"><div class="qf-dot">4</div><span class="qf-step-label">Submit assignment</span></div>
    <div class="qf-progress-track"><div class="qf-progress-fill" id="qf-progress-fill"></div></div>
    <div id="qf-card-foot">Starting…</div>
  `;
  document.body.appendChild(card);
}

function updateStep(n, state, label) {
  const step = document.getElementById(`qf-step-${n}`);
  if (!step) return;
  step.className = `qf-step ${state}`;
  const dot = step.querySelector('.qf-dot');
  const lbl = step.querySelector('.qf-step-label');
  if (label) lbl.textContent = label;
  if (state === 'done')  dot.innerHTML = ICON.check;
  else if (state === 'error') dot.innerHTML = ICON.x;
  else dot.textContent = String(n);
  const pct = { 1: 15, 2: 45, 3: 75, 4: 100 };
  if (state === 'done') {
    const fill = document.getElementById('qf-progress-fill');
    if (fill) fill.style.width = pct[n] + '%';
  }
}

function setFoot(t) { const f = document.getElementById('qf-card-foot'); if (f) f.textContent = t; }
function setKw(t)   { const e = document.getElementById('qf-card-kw');   if (e) e.textContent = t; }
function removeCard() {
  document.getElementById('qf-card')?.remove();
}

function countdown(secs) {
  return new Promise(res => {
    let rem = secs;
    setFoot(`Submitting in ${rem}s…`);
    const iv = setInterval(() => {
      rem--;
      if (rem <= 0) { clearInterval(iv); res(); }
      else setFoot(`Submitting in ${rem}s…`);
    }, 1000);
  });
}

// ---------- Groq call ------------------------------------------------------
async function callGroq(keyword, extraKeywords = []) {
  const secNote = extraKeywords.length
    ? '\n- Naturally incorporate these related keywords: ' + extraKeywords.map(k => `"${k}"`).join(', ')
    : '';

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${S.groqApiKey}` },
    body:    JSON.stringify({
      model:       S.groqModel || 'llama-3.1-8b-instant',
      max_tokens:  1200,
      temperature: 0.7,
      messages: [
        {
          role:    'system',
          content: 'You are a professional blog writer. Write clean plain text articles with no markdown formatting whatsoever.',
        },
        {
          role:    'user',
          content: `Write a 700-word informative blog article about: "${keyword}".

Requirements:
- Start with a compelling title of AT LEAST 5 words on its own line (do NOT use # symbols)
- Use 3-4 subheadings in Title Case on their own lines (do NOT use ## symbols or any markdown)
- Leave a blank line between each section
- Use second person (you/your), never first person (I/we)
- Do not mention any brand names
- Active voice only
- No markdown symbols anywhere: no #, ##, **, *, backticks, or dashes for bullets
- Be practical and informative` + secNote,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ---------- Main writer process -------------------------------------------
async function runWriterProcess() {
  if (alreadyRan) return;
  alreadyRan = true;

  createCard();

  // Step 1
  updateStep(1, 'active');
  setFoot('Scanning page…');
  const allKws   = getKeywords();
  const keyword  = allKws[0] || null;
  const extraKws = allKws.slice(1);

  if (!keyword) {
    updateStep(1, 'error', 'No keyword found');
    setFoot('Could not detect keyword.');
    setTimeout(removeCard, 5000);
    return;
  }
  setKw(`"${keyword}"${extraKws.length ? ` · +${extraKws.length} related` : ''}`);
  updateStep(1, 'done', `Keyword${extraKws.length ? 's' : ''} detected`);

  // Step 2
  updateStep(2, 'active', 'Generating article…');
  setFoot(`Using ${S.groqModel}`);
  let article;
  try {
    article = await callGroq(keyword, extraKws);
    updateStep(2, 'done', 'Article generated');
  } catch (err) {
    updateStep(2, 'error', err.message.slice(0, 38));
    setFoot('API error — check your key.');
    setTimeout(removeCard, 6000);
    return;
  }

  const clean = stripMarkdown(article);

  // Step 3
  updateStep(3, 'active', 'Filling form…');
  setFoot('Pasting content…');

  const subjectInput =
    document.querySelector('input[name="subject"]') ||
    document.querySelector('#subject') ||
    [...document.querySelectorAll('input[type="text"]')].find(el =>
      (el.closest('tr,div,label')?.textContent || '').toLowerCase().includes('subject')
    );
  if (subjectInput) setNativeValue(subjectInput, keyword);

  const bodyArea =
    document.querySelector('textarea[name="body"]') ||
    document.querySelector('#body') ||
    document.querySelector('textarea');

  if (!bodyArea) {
    updateStep(3, 'error', 'Body field not found');
    setFoot('Could not find article body field.');
    setTimeout(removeCard, 5000);
    return;
  }
  setNativeValue(bodyArea, clean);
  updateStep(3, 'done', 'Fields filled');

  // Step 4
  if (!S.autoSubmit) {
    updateStep(4, 'done', 'Submit manually');
    setFoot('Done — submit when ready.');
    setTimeout(removeCard, 6000);
    return;
  }

  updateStep(4, 'active', 'Submitting…');
  if (S.waitTime > 0) await countdown(S.waitTime);

  setFoot('Attaching dialog handler…');
  const attached = await attachDebugger();
  if (!attached) {
    setFoot('Could not attach debugger — submit manually.');
    updateStep(4, 'error', 'Debugger failed');
    setTimeout(removeCard, 6000);
    return;
  }

  setFoot('Submitting…');
  const ok = clickSubmitButton();
  if (ok) {
    updateStep(4, 'done', 'Submitted');
    setFoot('Assignment submitted.');
    setTimeout(detachDebugger, 6000);
  } else {
    updateStep(4, 'error', 'Submit button not found');
    setFoot('Submit manually.');
    detachDebugger();
  }
  setTimeout(removeCard, 4000);
}

// ---------- Floating FAB ---------------------------------------------------
function injectFAB() {
  if (document.getElementById('qf-fab')) return;
  injectWriterStyles();
  const btn = document.createElement('button');
  btn.id = 'qf-fab';
  btn.type = 'button';
  btn.innerHTML = `${ICON.feather}<span>Compose Article</span>`;
  btn.addEventListener('click', () => {
    if (!S.groqApiKey) {
      setFoot?.('Set API key in side panel first.');
      return;
    }
    btn.remove();
    alreadyRan = false;
    runWriterProcess();
  });
  document.body.appendChild(btn);
}

function initArticleWriter() {
  if (!S.writerEnabled || !isJobPage()) return;
  if (!S.groqApiKey) { injectFAB(); return; }
  if (S.autoMode)    runWriterProcess();
  else               injectFAB();
}

// ===========================================================================
//  Message handlers (popup/sidepanel → content)
// ===========================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'SETTINGS_UPDATED') {
    const prevInterval = S.checkInterval;
    const prevWatcher  = S.watcherEnabled;
    const prevSpintax  = S.spintaxEnabled;
    S = { ...S, ...msg.settings };

    if (isHothWriter() || isJobPage()) {
      if (S.spintaxEnabled && !prevSpintax) startSpintaxScanner();
      else if (!S.spintaxEnabled && prevSpintax) stopSpintaxScanner();

      if (!prevWatcher && S.watcherEnabled) {
        hasTriggered = false; startWatching();
      } else if (prevWatcher && !S.watcherEnabled) {
        stopWatching();
      } else if (S.watcherEnabled && prevInterval !== S.checkInterval) {
        hasTriggered = false; startWatching();
      }
    }
    sendResponse({ ok: true });
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({
      isWatching:     S.watcherEnabled,
      spintaxEnabled: S.spintaxEnabled,
      writerEnabled:  S.writerEnabled,
      hasTriggered,
      spintaxTriggered,
      alarmDuration:  S.alarmDuration,
      checkInterval:  S.checkInterval,
    });
  }

  if (msg.type === 'MANUAL_CHECK') {
    hasTriggered = false;
    checkPage();
    sendResponse({ ok: true });
  }

  if (msg.type === 'MANUAL_WRITE') {
    alreadyRan = false;
    initArticleWriter();
    sendResponse({ ok: true });
  }
});

// ===========================================================================
//  Init
// ===========================================================================
loadSettings(() => {
  if (isHothWriter()) {
    if (S.spintaxEnabled) startSpintaxScanner();
    if (S.watcherEnabled) startWatching();
  } else if (isJobPage() && S.spintaxEnabled) {
    startSpintaxScanner();
  }
  initArticleWriter();
});

// Re-init writer when DOM changes significantly (SPA)
new MutationObserver(() => {
  if (
    S.writerEnabled && isJobPage() &&
    !document.getElementById('qf-fab') &&
    !document.getElementById('qf-card')
  ) {
    alreadyRan = false;
    initArticleWriter();
  }
}).observe(document.body, { childList: true, subtree: true });

// Export icon/colour tokens so the Ridge IIFE below can share them
window.__qfTokens = { QF, ICON };

})();

// ============================================================================
//  D. RIDGE NEURAL SOLVER — CAPTCHA autosolver
// ============================================================================
(function () {
  'use strict';

  const RIDGE_DEFAULT_KEY = '4qNzAeraznT1SvoUvF2gPC9J0L6G1J0O';
  const { QF, ICON } = window.__qfTokens || {};

  let autosolveActive = false;
  let solveLoop       = null;
  let overlayBtn      = null;
  let statusEl        = null;

  function injectStyles() {
    if (document.getElementById('qf-ridge-style')) return;
    const style = document.createElement('style');
    style.id = 'qf-ridge-style';
    style.textContent = `
      #qf-ridge-wrap {
        position: fixed; bottom: 90px; right: 24px; z-index: 2147483646;
        display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
        font-family: ${QF?.fontStack || 'system-ui'};
      }
      #qf-ridge-status {
        background: ${QF?.surface || '#161B25'};
        border: 1px solid ${QF?.border || '#2E374A'};
        color: ${QF?.text || '#E8EDF5'};
        font-size: 11px; font-weight: 500;
        padding: 6px 10px; border-radius: 8px;
        max-width: 240px; text-align: right; display: none;
        box-shadow: 0 8px 20px rgba(0,0,0,0.35);
      }
      #qf-ridge-status[data-tone="info"]    { color: ${QF?.accent  || '#4F8BFF'}; }
      #qf-ridge-status[data-tone="ok"]      { color: ${QF?.success || '#3FD4A8'}; }
      #qf-ridge-status[data-tone="warn"]    { color: ${QF?.warning || '#F2B547'}; }
      #qf-ridge-status[data-tone="err"]     { color: ${QF?.danger  || '#F25B7A'}; }

      #qf-ridge-btn {
        display: inline-flex; align-items: center; gap: 8px;
        background: ${QF?.surface || '#161B25'};
        color: ${QF?.success || '#3FD4A8'};
        border: 1px solid ${QF?.border || '#2E374A'};
        border-radius: 999px; padding: 9px 16px;
        font-family: ${QF?.fontStack || 'system-ui'};
        font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
        cursor: pointer; user-select: none;
        box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        transition: all 180ms ease;
        text-transform: uppercase;
      }
      #qf-ridge-btn svg { width: 14px; height: 14px; }
      #qf-ridge-btn:hover { transform: translateY(-1px); border-color: ${QF?.success || '#3FD4A8'}; }
      #qf-ridge-btn[data-running="true"] {
        color: ${QF?.danger || '#F25B7A'};
        border-color: ${QF?.danger || '#F25B7A'};
        box-shadow: 0 8px 24px rgba(242,91,122,0.25);
      }
    `;
    document.head.appendChild(style);
  }

  function injectOverlay() {
    if (document.getElementById('qf-ridge-wrap')) return;
    injectStyles();

    const wrap = document.createElement('div');
    wrap.id = 'qf-ridge-wrap';

    statusEl = document.createElement('div');
    statusEl.id = 'qf-ridge-status';

    overlayBtn = document.createElement('button');
    overlayBtn.id = 'qf-ridge-btn';
    overlayBtn.type = 'button';
    setBtnIdle();
    overlayBtn.addEventListener('click', toggleAutosolve);

    wrap.appendChild(statusEl);
    wrap.appendChild(overlayBtn);
    document.body.appendChild(wrap);

    chrome.storage.local.get(['autosolveEnabled'], (res) => {
      if (res.autosolveEnabled) startAutosolve(true);
    });
  }

  function setBtnIdle() {
    if (!overlayBtn) return;
    overlayBtn.dataset.running = 'false';
    overlayBtn.innerHTML = `${ICON?.bolt || ''}<span>Autosolve</span>`;
  }
  function setBtnRunning() {
    if (!overlayBtn) return;
    overlayBtn.dataset.running = 'true';
    overlayBtn.innerHTML = `${ICON?.square || ''}<span>Stop</span>`;
  }

  function setStatus(msg, tone) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.dataset.tone = tone || 'info';
    statusEl.style.display = msg ? 'block' : 'none';
  }

  function toggleAutosolve() {
    if (autosolveActive) stopAutosolve(); else startAutosolve(false);
  }

  function startAutosolve(silent) {
    if (autosolveActive) return;
    autosolveActive = true;
    chrome.storage.local.set({ autosolveEnabled: true });
    setBtnRunning();
    if (!silent) setStatus('Scanning for CAPTCHA…', 'info');
    runLoop();
  }
  function stopAutosolve() {
    autosolveActive = false;
    if (solveLoop) { clearTimeout(solveLoop); solveLoop = null; }
    chrome.storage.local.set({ autosolveEnabled: false });
    setBtnIdle();
    setStatus('', '');
  }

  async function runLoop() {
    if (!autosolveActive) return;
    try {
      const settings = await getSettings();
      const { captchaSelector, inputSelector, submitSelector, ridgeApiKey, delay } = settings;

      const imgEl = document.querySelector(captchaSelector);
      if (!imgEl || !imgEl.src || imgEl.naturalWidth === 0) {
        setStatus('Scanning for CAPTCHA…', 'warn');
        scheduleNext(1200);
        return;
      }

      setStatus('CAPTCHA found · reading…', 'info');
      const base64 = await imageToBase64(imgEl);
      setStatus('Solving…', 'info');

      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'SOLVE_CAPTCHA', imageBase64: base64, apiKey: ridgeApiKey },
          (response) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!response) return reject(new Error('No response from background'));
            if (!response.success) return reject(new Error(response.error));
            resolve(response.text);
          }
        );
      });

      if (!autosolveActive) return;
      setStatus(`Solved · ${result}`, 'ok');

      const inputEl = document.querySelector(inputSelector);
      if (inputEl) {
        inputEl.focus();
        inputEl.value = result;
        inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        inputEl.blur();
      }

      const delayMs = (parseFloat(delay) || 0) * 1000;
      if (delayMs > 0) {
        let remaining = parseFloat(delay);
        const countdownId = setInterval(() => {
          if (!autosolveActive) return;
          setStatus(`Submitting in ${remaining.toFixed(1)}s…`, 'warn');
          remaining -= 0.1;
        }, 100);
        await sleep(delayMs);
        clearInterval(countdownId);
      }
      if (!autosolveActive) return;

      const submitEl =
        document.querySelector(submitSelector) ||
        document.querySelector('input[type="submit"].btn-success') ||
        document.querySelector('input[type="submit"]');
      if (submitEl) {
        submitEl.click();
        setStatus('Submitted · waiting…', 'ok');
      } else {
        setStatus('Submit button not found', 'err');
      }
      scheduleNext(2000);

    } catch (err) {
      setStatus('Retrying…', 'warn');
      scheduleNext(2000);
    }
  }

  function scheduleNext(ms) {
    if (!autosolveActive) return;
    solveLoop = setTimeout(runLoop, ms);
  }

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        ['ridgeApiKey', 'captchaSelector', 'inputSelector', 'submitSelector', 'delay'],
        (result) => resolve({
          ridgeApiKey:     result.ridgeApiKey     || RIDGE_DEFAULT_KEY,
          captchaSelector: result.captchaSelector || '#writercaptcha > div:nth-child(2) > img:nth-child(1)',
          inputSelector:   result.inputSelector   || 'input[required]',
          submitSelector:  result.submitSelector  || 'input[type="submit"].btn.btn-success.btn-large',
          delay:           result.delay !== undefined ? result.delay : 3,
        })
      );
    });
  }

  function imageToBase64(imgEl) {
    return new Promise((resolve, reject) => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width  = imgEl.naturalWidth  || imgEl.width  || 200;
        canvas.height = imgEl.naturalHeight || imgEl.height || 60;
        canvas.getContext('2d').drawImage(imgEl, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        if (dataUrl && dataUrl.length > 200) resolve(dataUrl);
        else fetchImageAsBase64(imgEl.src).then(resolve).catch(reject);
      } catch (_) {
        fetchImageAsBase64(imgEl.src).then(resolve).catch(reject);
      }
    });
  }

  function fetchImageAsBase64(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Cannot load image'));
      img.src = url.split('?')[0] + '?_qf=' + Date.now();
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'START_AUTOSOLVE') startAutosolve(false);
    if (msg.type === 'STOP_AUTOSOLVE')  stopAutosolve();
  });

  if (document.body) injectOverlay();
  else document.addEventListener('DOMContentLoaded', injectOverlay);

})();
