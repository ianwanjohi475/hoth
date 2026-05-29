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
//  Shared design tokens (mirrors the side panel palette · v2 Atelier)
// ---------------------------------------------------------------------------
const QF = Object.freeze({
  bg:        '#08090B',
  surface:   '#0E1014',
  surface1:  '#15171C',
  surface2:  '#1C1F26',
  surface3:  '#232730',
  border:    '#262A33',
  borderStr: '#353A45',
  text:      '#F5F6F8',
  muted:     '#B4B8C2',
  faint:     '#797E89',
  fainter:   '#4A4F58',
  accent:    '#8B5CF6',
  accentHi:  '#A78BFA',
  accentLo:  '#6D28D9',
  accentRing:'rgba(139,92,246,0.30)',
  accentGlow:'rgba(139,92,246,0.45)',
  success:   '#34D399',
  warning:   '#FBBF24',
  danger:    '#F87171',
  info:      '#60A5FA',
  fontStack: '-apple-system,BlinkMacSystemFont,"Inter","SF Pro Text","Segoe UI",system-ui,sans-serif',
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
      -webkit-font-smoothing: antialiased;
    }
    #qf-card *, #qf-fab * { box-sizing: border-box; margin: 0; padding: 0; }

    #qf-card {
      position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
      width: 320px; padding: 18px 18px 16px;
      background: linear-gradient(180deg, ${QF.surface1} 0%, ${QF.surface} 100%);
      border: 1px solid ${QF.border};
      border-radius: 16px;
      box-shadow:
        0 1px 0 rgba(255,255,255,0.04) inset,
        0 24px 64px rgba(0,0,0,0.55),
        0 4px 14px rgba(0,0,0,0.40);
      animation: qf-rise 280ms cubic-bezier(0.16, 1, 0.30, 1);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    #qf-card::before {
      content: ''; position: absolute; inset: 0;
      border-radius: 16px;
      background: radial-gradient(circle at 0% 0%, ${QF.accent}10, transparent 60%);
      pointer-events: none;
    }
    @keyframes qf-rise {
      from { transform: translateY(16px) scale(0.96); opacity: 0; }
      to   { transform: translateY(0)    scale(1);    opacity: 1; }
    }

    .qf-card-header {
      position: relative;
      display: flex; align-items: center; gap: 12px; margin-bottom: 14px;
    }
    .qf-card-logo {
      position: relative;
      width: 34px; height: 34px; border-radius: 11px; flex-shrink: 0;
      background: linear-gradient(135deg, ${QF.accentHi}, ${QF.accentLo});
      display: flex; align-items: center; justify-content: center; color: #fff;
      box-shadow:
        0 6px 16px ${QF.accentGlow},
        0 1px 0 rgba(255,255,255,0.18) inset;
    }
    .qf-card-logo svg { width: 17px; height: 17px; }
    .qf-card-title  { font-size: 13.5px; font-weight: 650; letter-spacing: -0.015em; }
    .qf-card-sub    { font-size: 11px; color: ${QF.faint}; font-weight: 500; margin-top: 2px; letter-spacing: 0.005em; }

    #qf-card-kw {
      position: relative;
      margin-bottom: 16px; padding: 9px 12px;
      background: ${QF.bg}; border: 1px solid ${QF.border};
      border-radius: 9px;
      font-family: ${QF.monoStack}; font-size: 11px; font-weight: 500;
      color: ${QF.accentHi};
      letter-spacing: 0.01em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    .qf-step {
      position: relative;
      display: flex; align-items: center; gap: 11px;
      padding: 6px 0;
      opacity: 0.45;
      transition: opacity 240ms cubic-bezier(0.22,0.61,0.36,1);
    }
    .qf-step.active, .qf-step.error { opacity: 1; }
    .qf-step.done { opacity: 0.85; }

    .qf-dot {
      width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0;
      background: ${QF.surface2}; border: 1.5px solid ${QF.border};
      color: ${QF.faint};
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; font-weight: 700;
      transition: all 220ms cubic-bezier(0.22,0.61,0.36,1);
    }
    .qf-dot svg { width: 12px; height: 12px; }
    .qf-step.active .qf-dot {
      border-color: ${QF.accent}; color: ${QF.accentHi};
      background: ${QF.surface};
      box-shadow: 0 0 0 0 ${QF.accentRing};
      animation: qf-pulse 1.4s ease-out infinite;
    }
    .qf-step.done  .qf-dot {
      background: ${QF.success}; border-color: ${QF.success}; color: #052E22;
      box-shadow: 0 0 12px rgba(52,211,153,0.45);
    }
    .qf-step.error .qf-dot {
      background: ${QF.danger}; border-color: ${QF.danger}; color: #fff;
      box-shadow: 0 0 12px rgba(248,113,113,0.45);
    }
    @keyframes qf-pulse {
      0%   { box-shadow: 0 0 0 0   ${QF.accentRing}; }
      70%  { box-shadow: 0 0 0 8px rgba(139,92,246,0); }
      100% { box-shadow: 0 0 0 0   rgba(139,92,246,0); }
    }

    .qf-step-label { font-size: 12px; color: ${QF.muted}; font-weight: 500; letter-spacing: -0.005em; }
    .qf-step.active .qf-step-label { color: ${QF.text}; font-weight: 600; }
    .qf-step.done   .qf-step-label { color: ${QF.success}; }
    .qf-step.error  .qf-step-label { color: ${QF.danger}; }

    .qf-progress-track {
      height: 4px; background: ${QF.surface2};
      border-radius: 4px; margin: 14px 0 10px;
      overflow: hidden;
      border: 1px solid ${QF.border};
    }
    .qf-progress-fill {
      height: 100%; width: 0;
      background: linear-gradient(90deg, ${QF.accent}, ${QF.success});
      border-radius: 4px;
      transition: width 500ms cubic-bezier(0.22, 0.61, 0.36, 1);
      box-shadow: 0 0 8px ${QF.accentGlow};
    }

    #qf-card-foot {
      font-size: 11px; color: ${QF.faint}; text-align: center;
      letter-spacing: 0.01em; font-weight: 500;
    }

    #qf-fab {
      position: fixed; bottom: 24px; right: 24px; z-index: 2147483646;
      display: inline-flex; align-items: center; gap: 8px;
      padding: 12px 20px;
      background: linear-gradient(180deg, ${QF.accentHi} 0%, ${QF.accent} 100%);
      color: #fff; border: none; border-radius: 999px;
      font-size: 13px; font-weight: 600; letter-spacing: -0.01em; cursor: pointer;
      box-shadow:
        0 1px 0 inset rgba(255,255,255,0.25),
        0 4px 14px ${QF.accentGlow},
        0 12px 36px rgba(0,0,0,0.35);
      transition: transform 150ms, box-shadow 150ms, background 200ms;
      user-select: none;
      animation: qf-rise 280ms cubic-bezier(0.16, 1, 0.30, 1);
    }
    #qf-fab:hover  {
      transform: translateY(-2px);
      background: linear-gradient(180deg, #BCA2FE 0%, ${QF.accentHi} 100%);
      box-shadow:
        0 1px 0 inset rgba(255,255,255,0.30),
        0 6px 20px ${QF.accentGlow},
        0 16px 44px rgba(0,0,0,0.40);
    }
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
  // Track which captcha image we last solved so we don't burn API calls
  // re-solving the same image while we wait for the page to refresh it.
  let lastSolvedFingerprint = null;
  let lastSubmitFingerprint = null;
  let stuckSubmitCount      = 0;

  function injectStyles() {
    if (document.getElementById('qf-ridge-style')) return;
    const style = document.createElement('style');
    style.id = 'qf-ridge-style';
    style.textContent = `
      #qf-ridge-wrap {
        position: fixed; bottom: 88px; right: 24px; z-index: 2147483646;
        display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
        font-family: ${QF?.fontStack || 'system-ui'};
        -webkit-font-smoothing: antialiased;
      }
      #qf-ridge-wrap *, #qf-ridge-wrap *::before, #qf-ridge-wrap *::after { box-sizing: border-box; }
      #qf-ridge-status {
        display: none;
        max-width: 260px;
        padding: 8px 12px;
        background: linear-gradient(180deg, ${QF?.surface1 || '#15171C'}, ${QF?.surface || '#0E1014'});
        border: 1px solid ${QF?.border || '#262A33'};
        color: ${QF?.text || '#F5F6F8'};
        border-radius: 10px;
        font-size: 11.5px; font-weight: 500;
        letter-spacing: 0.005em;
        text-align: right;
        box-shadow: 0 12px 28px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.04) inset;
        animation: qf-fade-in 220ms cubic-bezier(0.16, 1, 0.30, 1);
      }
      @keyframes qf-fade-in {
        from { transform: translateY(4px); opacity: 0; }
        to   { transform: translateY(0);   opacity: 1; }
      }
      #qf-ridge-status[data-tone="info"]  { color: ${QF?.accentHi || '#A78BFA'}; border-color: ${QF?.accentRing || 'rgba(139,92,246,0.30)'}; }
      #qf-ridge-status[data-tone="ok"]    { color: ${QF?.success  || '#34D399'}; border-color: rgba(52,211,153,0.30); }
      #qf-ridge-status[data-tone="warn"]  { color: ${QF?.warning  || '#FBBF24'}; border-color: rgba(251,191,36,0.30); }
      #qf-ridge-status[data-tone="err"]   { color: ${QF?.danger   || '#F87171'}; border-color: rgba(248,113,113,0.30); }

      #qf-ridge-btn {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 10px 18px;
        background: linear-gradient(180deg, ${QF?.surface1 || '#15171C'}, ${QF?.surface || '#0E1014'});
        color: ${QF?.success || '#34D399'};
        border: 1px solid ${QF?.border || '#262A33'};
        border-radius: 999px;
        font-family: ${QF?.fontStack || 'system-ui'};
        font-size: 12px; font-weight: 650; letter-spacing: 0.03em;
        cursor: pointer; user-select: none;
        box-shadow:
          0 1px 0 rgba(255,255,255,0.04) inset,
          0 8px 24px rgba(0,0,0,0.40),
          0 0 0 0 transparent;
        transition: all 200ms cubic-bezier(0.22, 0.61, 0.36, 1);
      }
      #qf-ridge-btn svg { width: 14px; height: 14px; }
      #qf-ridge-btn:hover {
        transform: translateY(-1px);
        border-color: ${QF?.success || '#34D399'};
        box-shadow:
          0 1px 0 rgba(255,255,255,0.06) inset,
          0 12px 28px rgba(0,0,0,0.50),
          0 0 0 4px rgba(52,211,153,0.12);
      }
      #qf-ridge-btn:active { transform: translateY(0); }
      #qf-ridge-btn[data-running="true"] {
        color: ${QF?.danger || '#F87171'};
        border-color: rgba(248,113,113,0.40);
        box-shadow:
          0 1px 0 rgba(255,255,255,0.04) inset,
          0 8px 24px rgba(0,0,0,0.40),
          0 0 0 4px rgba(248,113,113,0.12);
        animation: qf-ridge-pulse 1.4s ease-in-out infinite;
      }
      @keyframes qf-ridge-pulse {
        0%, 100% { box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.40), 0 0 0 0   rgba(248,113,113,0.30); }
        50%      { box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.40), 0 0 0 6px rgba(248,113,113,0); }
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

  // Cheap fingerprint of a captcha image — last 200 chars of the data URL.
  // Captcha images are inline data: URLs so the tail is effectively a hash.
  function fingerprintImage(imgEl) {
    return (imgEl.src || '').slice(-200);
  }

  // Best-effort refresh of the captcha. Tries the "get a new code" link
  // first (preserves any other page state), falls back to location.reload().
  function refreshCaptcha() {
    const link = document.querySelector('#writercaptcha a[href*="/writer"]')
              || document.querySelector('#writercaptcha a');
    if (link) {
      link.click();
      return true;
    }
    try { window.location.reload(); return true; } catch (_) { return false; }
  }

  async function runLoop() {
    if (!autosolveActive) return;
    try {
      const settings = await getSettings();
      const { captchaSelector, inputSelector, submitSelector, ridgeApiKey, delay, captchaLength, ocrPasses } = settings;

      const imgEl = document.querySelector(captchaSelector);
      if (!imgEl || !imgEl.src || imgEl.naturalWidth === 0) {
        setStatus('Scanning for CAPTCHA…', 'warn');
        scheduleNext(1200);
        return;
      }

      // ── New-captcha gate ──
      // Don't re-solve the same image we already attempted. The page either
      // refreshed (new fingerprint, we solve) or it didn't (same fingerprint,
      // we wait). After 5 stuck cycles we force a refresh in case the page
      // froze with a stale captcha.
      const fp = fingerprintImage(imgEl);
      if (fp === lastSubmitFingerprint) {
        stuckSubmitCount++;
        if (stuckSubmitCount >= 5) {
          setStatus('Stuck on same image · refreshing…', 'warn');
          stuckSubmitCount = 0;
          refreshCaptcha();
          scheduleNext(2500);
          return;
        }
        setStatus('Waiting for new CAPTCHA…', 'warn');
        scheduleNext(1200);
        return;
      }
      stuckSubmitCount = 0;

      setStatus('CAPTCHA found · preparing variants…', 'info');
      const variants = await preprocessVariants(imgEl);
      if (!variants.length) throw new Error('Could not extract CAPTCHA image');

      setStatus(`Solving · ${ocrPasses}-pass ensemble…`, 'info');

      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type:           'SOLVE_CAPTCHA',
            imageVariants:  variants,
            apiKey:         ridgeApiKey,
            expectedLength: captchaLength,
            passes:         ocrPasses,
          },
          (response) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!response) return reject(new Error('No response from background'));
            if (!response.success) return reject(new Error(response.error));
            resolve(response.text);
          }
        );
      });

      if (!autosolveActive) return;

      // ── Length gate ──
      // HOTH's input has minlength=5 / maxlength=5. Submitting a shorter
      // string just trips the browser's built-in validator silently — the
      // form never posts and the loop spins forever. Catch the short read
      // BEFORE clicking submit and refresh the captcha to try a new image.
      if (result.length !== captchaLength) {
        console.warn('[Quillforge Ridge] Length mismatch', { ocr: result, got: result.length, need: captchaLength });
        setStatus(`Short read · ${result.length}/${captchaLength} chars · refreshing`, 'warn');
        lastSolvedFingerprint = fp;
        // Mark this fingerprint so we don't immediately re-solve while the
        // new image loads.
        lastSubmitFingerprint = fp;
        refreshCaptcha();
        scheduleNext(2500);
        return;
      }

      // Locate the answer input
      const inputEl = document.querySelector(inputSelector);
      if (!inputEl) {
        setStatus('Answer input not found', 'err');
        scheduleNext(2000);
        return;
      }

      // ── React/Vue-safe native value setter ──
      // Mirrors the article composer's setNativeValue() pattern. Uses the
      // prototype's value descriptor so frameworks tracking the input's
      // state register the change. Falls back to direct assignment.
      const proto  = window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      inputEl.focus();
      if (setter) setter.call(inputEl, result); else inputEl.value = result;
      inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));

      // ── Read-back verification ──
      // If anything (maxlength, transform, JS handler) changed the value
      // between assignment and read, surface the drift in the status.
      const filled = inputEl.value;
      if (filled !== result) {
        console.warn('[Quillforge Ridge] Filled value differs from OCR:', { ocr: result, filled });
        setStatus(`Filled "${filled}" · OCR "${result}"`, 'warn');
      } else {
        setStatus(`Solved · ${result}`, 'ok');
      }
      inputEl.blur();

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
        // Record the fingerprint of the captcha we just submitted so the
        // next loop iteration waits for a fresh image instead of re-solving.
        lastSubmitFingerprint = fp;
        lastSolvedFingerprint = fp;
        submitEl.click();
        setStatus(`Submitted · "${result}"`, 'ok');
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
        ['ridgeApiKey', 'captchaSelector', 'inputSelector', 'submitSelector', 'delay', 'captchaLength', 'ocrPasses'],
        (result) => resolve({
          ridgeApiKey:     result.ridgeApiKey     || RIDGE_DEFAULT_KEY,
          captchaSelector: result.captchaSelector || '#writercaptcha > div:nth-child(2) > img:nth-child(1)',
          inputSelector:   result.inputSelector   || 'input[required]',
          submitSelector:  result.submitSelector  || 'input[type="submit"].btn.btn-success.btn-large',
          delay:           result.delay !== undefined ? result.delay : 3,
          captchaLength:   Number.isFinite(result.captchaLength) ? result.captchaLength : 5,
          ocrPasses:       Number.isFinite(result.ocrPasses)     ? result.ocrPasses     : 5,
        })
      );
    });
  }

  // ─── Image preprocessing for OCR ensemble ────────────────────────────────
  //
  // Generates several preprocessed variants of the CAPTCHA image. Each variant
  // emphasises a different visual property (crisp pixels vs smooth, high-
  // contrast grayscale, binarised B&W) so the vision model sees the puzzle
  // from multiple angles. The background service then runs parallel OCR
  // passes against these variants and majority-votes the answer.
  // ─────────────────────────────────────────────────────────────────────────

  function makeCanvas(imgEl, scale, smooth) {
    const w = (imgEl.naturalWidth  || imgEl.width  || 200) * scale;
    const h = (imgEl.naturalHeight || imgEl.height || 60)  * scale;
    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = smooth;
    if (smooth) ctx.imageSmoothingQuality = 'high';
    return { canvas, ctx, w, h };
  }

  // Variant A: 4× nearest-neighbour upscale (crisp colored pixels)
  // KEEPS COLOUR — best for multi-coloured captchas (HOTH-style)
  function variantColor4x(imgEl) {
    try {
      const { canvas, ctx } = makeCanvas(imgEl, 4, false);
      ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } catch (_) { return null; }
  }

  // Variant B: 3× nearest-neighbour upscale (crisp pixel edges, colour kept)
  function variantCrispUpscale(imgEl) {
    try {
      const { canvas, ctx } = makeCanvas(imgEl, 3, false);
      ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } catch (_) { return null; }
  }

  // Variant C: 2× bilinear upscale (smooth, colour kept)
  function variantSmoothUpscale(imgEl) {
    try {
      const { canvas, ctx } = makeCanvas(imgEl, 2, true);
      ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } catch (_) { return null; }
  }

  // Variant D: ANTI-WHITE BINARISATION — treat any non-white pixel as
  // foreground regardless of colour. This catches THIN coloured characters
  // (yellow, light red, etc.) that pure luminance/Otsu would lose because
  // their grey value is too close to white. The fix that recovers HOTH's
  // thin first-character problem.
  function variantAntiWhite(imgEl) {
    try {
      const { canvas, ctx } = makeCanvas(imgEl, 3, false);
      ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
      const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d  = id.data;
      for (let i = 0; i < d.length; i += 4) {
        // Min of RGB channels — small if ANY channel is dark (any colour)
        const minCh = Math.min(d[i], d[i + 1], d[i + 2]);
        const v = minCh > 215 ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(id, 0, 0);
      return canvas.toDataURL('image/png');
    } catch (_) { return null; }
  }

  // Variant E: SATURATION-AWARE binarisation. Treat highly saturated OR
  // dark pixels as foreground. Catches bright-colour characters even when
  // they have high luminance (yellow on white, light-green on white).
  function variantSaturation(imgEl) {
    try {
      const { canvas, ctx } = makeCanvas(imgEl, 3, false);
      ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
      const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d  = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max - min;
        // Foreground if: colourful (sat>35) OR dark (max<200)
        const v = (sat > 35 || max < 200) ? 0 : 255;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(id, 0, 0);
      return canvas.toDataURL('image/png');
    } catch (_) { return null; }
  }

  // Variant F: grayscale + high contrast, 3× — backup for monochrome captchas
  function variantContrast(imgEl) {
    try {
      const { canvas, ctx } = makeCanvas(imgEl, 3, true);
      ctx.filter = 'grayscale(1) contrast(1.7) brightness(1.05)';
      ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } catch (_) { return null; }
  }

  // Variant G: Otsu-binarised luminance, 3× — adaptive threshold from each
  // image's own histogram. Last-resort variant for monochrome captchas.
  function variantBinarise(imgEl) {
    try {
      const { canvas, ctx } = makeCanvas(imgEl, 3, false);
      ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
      const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d  = id.data;

      const hist = new Uint32Array(256);
      for (let i = 0; i < d.length; i += 4) {
        const y = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
        hist[y]++;
      }
      const total = canvas.width * canvas.height;
      let sum = 0;
      for (let i = 0; i < 256; i++) sum += i * hist[i];
      let sumB = 0, wB = 0, varMax = 0, threshold = 128;
      for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (!wB) continue;
        const wF = total - wB;
        if (!wF) break;
        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > varMax) { varMax = between; threshold = t; }
      }
      for (let i = 0; i < d.length; i += 4) {
        const y = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
        const v = y > threshold ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(id, 0, 0);
      return canvas.toDataURL('image/png');
    } catch (_) { return null; }
  }

  async function preprocessVariants(imgEl) {
    // ORDER MATTERS — round-robin in background uses this order. Front-
    // load the colour-aware variants, since HOTH captchas are multi-coloured.
    const direct = [
      variantColor4x(imgEl),         // colour-preserving 4× crisp
      variantAntiWhite(imgEl),       // catches thin coloured chars
      variantSaturation(imgEl),      // colour-aware threshold
      variantCrispUpscale(imgEl),    // colour 3× crisp
      variantSmoothUpscale(imgEl),   // colour 2× smooth
      variantContrast(imgEl),        // monochrome fallback
      variantBinarise(imgEl),        // Otsu monochrome fallback
    ].filter(Boolean);
    if (direct.length) return direct;

    // Cross-origin fallback path
    try {
      const cleanImg = await loadCleanImage(imgEl.src);
      return [
        variantColor4x(cleanImg),
        variantAntiWhite(cleanImg),
        variantSaturation(cleanImg),
        variantCrispUpscale(cleanImg),
        variantSmoothUpscale(cleanImg),
        variantContrast(cleanImg),
        variantBinarise(cleanImg),
      ].filter(Boolean);
    } catch (_) {
      const single = await fetchImageAsBase64(imgEl.src);
      return single ? [single] : [];
    }
  }

  function loadCleanImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed'));
      img.src = url.split('?')[0] + '?_qf=' + Date.now();
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
