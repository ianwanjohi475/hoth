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
  // Per-image failure counter. If the same captcha image throws errors
  // twice in a row, we refresh to a new one instead of looping forever.
  let lastSeenFingerprint = null;
  let failsOnSameImage    = 0;

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
    // Capture these in the outer scope so the catch block can use them even
    // if the failure happened before destructuring settings.
    let currentFp = null;
    let captchaSelForCatch = '#writercaptcha img';

    try {
      const settings = await getSettings();
      captchaSelForCatch = settings.captchaSelector;
      const { captchaSelector, inputSelector, submitSelector, ridgeApiKey, delay, captchaLength, ocrPasses, minConfidence, usePerCharMistral } = settings;

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
      currentFp = fp;
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

      // Reset the per-image failure counter when we see a brand-new image.
      if (fp !== lastSeenFingerprint) {
        lastSeenFingerprint = fp;
        failsOnSameImage = 0;
      }

      setStatus('CAPTCHA found · preparing variants…', 'info');
      const variants = await preprocessVariants(imgEl);
      if (!variants.length) throw new Error('Could not extract CAPTCHA image');

      // Per-character Mistral segments — disabled by default because each
      // segment is one extra API call (×5 for HOTH) and was the main cause
      // of rate-limit cascades. Opt in via usePerCharMistral setting.
      const segments = usePerCharMistral ? segmentCharacters(imgEl, captchaLength) : [];

      // Pure-JS local OCR — runs in ~30-80 ms, no API. Returns a complete
      // candidate answer based on color segmentation + template matching.
      // The background worker treats it as one additional sample in the
      // per-position ensemble vote.
      const cvHint = pureCVSolve(imgEl, captchaLength);

      const statusBits = [`${ocrPasses} full`];
      if (segments.length) statusBits.push(`${segments.length} per-char`);
      statusBits.push('1 local');
      setStatus(`Solving · ${statusBits.join(' + ')}…`, 'info');

      const { text: result, confidence } = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type:           'SOLVE_CAPTCHA',
            imageVariants:  variants,
            segmentedChars: segments,
            cvHint:         cvHint || null,
            apiKey:         ridgeApiKey,
            expectedLength: captchaLength,
            passes:         ocrPasses,
          },
          (response) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!response) return reject(new Error('No response from background'));
            if (!response.success) return reject(new Error(response.error));
            resolve({ text: response.text, confidence: response.confidence ?? 1 });
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
        lastSubmitFingerprint = fp;
        refreshCaptcha();
        scheduleNext(2500);
        return;
      }

      // ── Suspicious-answer gate ──
      // Defence-in-depth against the parser-bug residue: if the voted
      // answer starts with an English-prefix word (Exami, Looki, Analy,
      // Captc, etc.), it's almost certainly leakage from model commentary
      // rather than a real captcha read. Refresh instead of submitting.
      if (isSuspiciousAnswer(result)) {
        console.warn('[Quillforge Ridge] Suspicious answer rejected:', result);
        setStatus(`Rejected "${result}" · refreshing`, 'warn');
        lastSubmitFingerprint = fp;
        refreshCaptcha();
        scheduleNext(2500);
        return;
      }

      // ── Confidence gate ──
      // The vision model has a hard ceiling on hard captchas. Instead of
      // accepting whatever it produces, REFUSE to submit unless the vote
      // shows strong cross-pass agreement at every position. HOTH lets us
      // click "get a new code" indefinitely for free, so we trade quantity
      // of attempts for quality of submissions — the answers that DO go
      // through are answers we're highly confident in. minConfidence is
      // tunable via storage (chrome.storage.local: minConfidence ∈ [0,1])
      // and is the lever between "refresh anything sketchy" (high value)
      // and "submit even if guessing" (low value).
      if (confidence < minConfidence) {
        const pct = (confidence * 100).toFixed(0);
        const need = (minConfidence * 100).toFixed(0);
        console.warn(`[Quillforge Ridge] Confidence ${pct}% < ${need}% threshold for "${result}" — refreshing`);
        setStatus(`Low confidence ${pct}% · refreshing`, 'warn');
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
        failsOnSameImage = 0;        // reset on a clean submit
        submitEl.click();
        setStatus(`Submitted · "${result}"`, 'ok');
      } else {
        setStatus('Submit button not found', 'err');
      }
      scheduleNext(2000);

    } catch (err) {
      // Count failures against this specific captcha image. After 2 in a
      // row on the same image, refresh to a new one — never loop forever.
      failsOnSameImage++;
      const reason = (err && err.message ? err.message : 'unknown error').slice(0, 60);
      console.warn(`[Quillforge Ridge] solve failed (${failsOnSameImage}/2): ${err?.message || err}`);

      if (failsOnSameImage >= 2) {
        setStatus(`Hard captcha · refreshing (${reason})`, 'warn');
        failsOnSameImage = 0;
        // Mark the current fingerprint as "submitted" so the next loop
        // iteration waits for a new image rather than re-solving this one.
        if (!currentFp) {
          const errImg = document.querySelector(captchaSelForCatch);
          if (errImg) currentFp = fingerprintImage(errImg);
        }
        if (currentFp) lastSubmitFingerprint = currentFp;
        refreshCaptcha();
        scheduleNext(2500);
      } else {
        setStatus(`Retry · ${reason}`, 'warn');
        scheduleNext(2500);
      }
    }
  }

  function scheduleNext(ms) {
    if (!autosolveActive) return;
    solveLoop = setTimeout(runLoop, ms);
  }

  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        ['ridgeApiKey', 'captchaSelector', 'inputSelector', 'submitSelector', 'delay', 'captchaLength', 'ocrPasses', 'minConfidence', 'usePerCharMistral'],
        (result) => resolve({
          ridgeApiKey:     result.ridgeApiKey     || RIDGE_DEFAULT_KEY,
          captchaSelector: result.captchaSelector || '#writercaptcha > div:nth-child(2) > img:nth-child(1)',
          inputSelector:   result.inputSelector   || 'input[required]',
          submitSelector:  result.submitSelector  || 'input[type="submit"].btn.btn-success.btn-large',
          delay:           result.delay !== undefined ? result.delay : 3,
          captchaLength:   Number.isFinite(result.captchaLength) ? result.captchaLength : 5,
          // Rate-limit reality: free tier ≈ 1 req/s. 2 full-image passes ≈ 2.5s.
          // Defaulting to 2 keeps us out of 429 hell — bump in the slider if you
          // want more samples and don't mind slower solves.
          ocrPasses:       Number.isFinite(result.ocrPasses)     ? result.ocrPasses     : 2,
          // OFF by default. User asked for "no low/high confidence" — system
          // always submits its best guess and lets HOTH reject if wrong.
          minConfidence:   Number.isFinite(result.minConfidence) ? result.minConfidence : 0,
          // Per-character Mistral calls add captchaLength extra API calls and
          // are what was busting the rate limit. OFF by default — pure-JS
          // solver provides per-character votes for free.
          usePerCharMistral: result.usePerCharMistral === true,
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

  // ─── Per-character segmentation ──────────────────────────────────────────
  //
  // Crops the captcha image into N character-shaped slices. Equal-width
  // splits with ~20% overlap padding on each side so the model sees the
  // full glyph even if our cut lands slightly off-centre. Each segment
  // is upscaled 5× crisp so the single character fills the frame.
  //
  // Why this helps so much: single-character OCR is a fundamentally easier
  // problem than full-string OCR. The model doesn't have to count, doesn't
  // have to spatially attend to N glyphs at once, and the attention budget
  // per character is much larger. Per-char passes break ties whenever the
  // full-image vote can't decide.
  // ─────────────────────────────────────────────────────────────────────────

  // Find the horizontal range that actually contains character pixels.
  // HOTH captchas have white margins on each side — slicing the FULL image
  // width into N pieces puts the cuts off-centre. We detect the leftmost
  // and rightmost column with enough non-white content to qualify as a
  // glyph (filtering out the thin wavy decorative lines), then slice
  // within that span instead. Significantly improves per-character OCR.
  function findContentSpan(imgEl) {
    try {
      const w = imgEl.naturalWidth  || imgEl.width  || 200;
      const h = imgEl.naturalHeight || imgEl.height || 60;
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(imgEl, 0, 0);
      const id = ctx.getImageData(0, 0, w, h);
      const d  = id.data;

      const density = new Int32Array(w);
      for (let x = 0; x < w; x++) {
        let count = 0;
        for (let y = 0; y < h; y++) {
          const i = (y * w + x) * 4;
          // Treat anything noticeably non-white as content
          const minCh = Math.min(d[i], d[i + 1], d[i + 2]);
          if (minCh < 200) count++;
        }
        density[x] = count;
      }
      // Threshold: a column must have ≥10% of its height as content. Filters
      // out thin wavy lines that have only a few pixels per column.
      const threshold = Math.max(2, Math.floor(h * 0.10));
      let left = 0, right = w - 1;
      while (left < w && density[left] < threshold) left++;
      while (right >= 0 && density[right] < threshold) right--;

      // Safety: if span looks wrong (too narrow, inverted) fall back to full width
      if (right - left < w * 0.30) return { left: 0, right: w - 1 };
      return { left, right };
    } catch (_) {
      return { left: 0, right: (imgEl.naturalWidth || imgEl.width || 200) - 1 };
    }
  }

  function segmentCharacters(imgEl, count, upscale = 5, overlap = 0.22) {
    try {
      const fullW = imgEl.naturalWidth  || imgEl.width  || 200;
      const h     = imgEl.naturalHeight || imgEl.height || 60;
      // Slice within the actual content span — skips the white margins
      // so each slice lands centred on its character.
      const { left, right } = findContentSpan(imgEl);
      const spanW   = (right - left + 1);
      const charW   = spanW / count;
      const padding = charW * overlap;

      const segments = [];
      for (let i = 0; i < count; i++) {
        const x0 = Math.max(0,     left + i * charW - padding);
        const x1 = Math.min(fullW, left + (i + 1) * charW + padding);
        const segW = x1 - x0;
        if (segW <= 0) { segments.push(null); continue; }

        const canvas = document.createElement('canvas');
        canvas.width  = Math.round(segW * upscale);
        canvas.height = Math.round(h    * upscale);
        const ctx = canvas.getContext('2d', { willReadFrequently: false });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(imgEl, x0, 0, segW, h, 0, 0, canvas.width, canvas.height);
        segments.push(canvas.toDataURL('image/png'));
      }
      return segments.filter(Boolean);
    } catch (e) {
      console.warn('[Quillforge Ridge] segmentation failed:', e.message);
      return [];
    }
  }

  // Safety net: catches parser-bug residue like "Exami" from "Examining…"
  // or "Looki" from "Looking at the captcha…". With strict extraction in
  // background.js these should never reach here, but this is a belt-and-
  // braces guard so the script will REFRESH instead of submitting any
  // English-prefix word that slipped through.
  const SUSPICIOUS_ANSWER_PATTERNS = [
    /^Exami/i, /^Examp/i, /^Looki/i, /^Analy/i, /^Check/i,
    /^Image/i, /^Captc/i, /^Chara/i, /^Reads/i, /^Texto/i,
    /^Numbe/i, /^Lette/i, /^Visib/i, /^Trans/i, /^Ident/i,
    /^Recog/i, /^Apper/i, /^Appea/i, /^Begin/i, /^First/i,
    /^After/i, /^Here/i,  /^Note/i,
  ];
  function isSuspiciousAnswer(text) {
    if (!text) return false;
    return SUSPICIOUS_ANSWER_PATTERNS.some(re => re.test(text));
  }

  // ═══════════════════════════════════════════════════════════════════════
  //   PURE-JS LOCAL OCR SOLVER
  //
  //   No API calls. No external dependencies. Runs entirely in the browser
  //   in ~30-80 ms. Uses HOTH-specific structure: each character is painted
  //   in a distinct vivid colour on near-white background with thin pastel
  //   decoration lines.
  //
  //   Pipeline:
  //     1. Histogram-cluster pixel colours, find N character colours
  //     2. For each colour, build a binary mask of matching pixels
  //     3. Morphological opening drops the thin pastel decoration lines
  //     4. Bounding box → crop to character region
  //     5. Aspect-preserving normalize to a fixed template size
  //     6. Match against rendered-font templates (Jaccard similarity)
  //     7. Sort by x-position → left-to-right answer string
  //
  //   The whole answer is sent to the background worker as cvHint and
  //   counted as one additional sample in the per-position ensemble vote.
  //   It's an independent signal — when the API drifts, the local solver
  //   doesn't drift the same way, and vice versa.
  // ═══════════════════════════════════════════════════════════════════════

  const PCV_SIZE = 40;
  const PCV_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const PCV_FONT_SPECS = [
    '900 32px Arial, sans-serif',
    'bold 32px Arial, sans-serif',
    '900 32px Tahoma, sans-serif',
    '900 32px Verdana, sans-serif',
    'bold 32px "Trebuchet MS", sans-serif',
    'bold 32px "Comic Sans MS", sans-serif',
  ];
  // HOTH paints each character at a small random rotation. Flat templates
  // miss them. Generating rotated variants at ±12°, ±6°, 0° gives every
  // character ~6 fonts × 5 rotations = 30 templates to match against, which
  // covers the realistic distortion range without ballooning compare time.
  const PCV_ROTATIONS = [-12, -6, 0, 6, 12];
  let _pcvTemplatesCache = null;

  function pcvImageToMask(id, threshold = 128) {
    const mask = new Uint8Array(id.width * id.height);
    for (let i = 0; i < mask.length; i++) {
      const pi = i * 4;
      const lum = 0.299 * id.data[pi] + 0.587 * id.data[pi + 1] + 0.114 * id.data[pi + 2];
      mask[i] = lum < threshold ? 1 : 0;
    }
    return mask;
  }

  function pcvBBox(mask, w, h) {
    let left = w, right = -1, top = h, bottom = -1, count = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (mask[row + x]) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
          count++;
        }
      }
    }
    return count > 0 ? { left, right, top, bottom, count } : null;
  }

  function pcvCrop(mask, w, box) {
    const cw = box.right - box.left + 1;
    const ch = box.bottom - box.top + 1;
    const out = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      const src = (box.top + y) * w + box.left;
      const dst = y * cw;
      for (let x = 0; x < cw; x++) out[dst + x] = mask[src + x];
    }
    return { mask: out, w: cw, h: ch };
  }

  function pcvResize(mask, srcW, srcH, dstW, dstH) {
    const result = new Uint8Array(dstW * dstH);
    for (let y = 0; y < dstH; y++) {
      const sy = Math.min(srcH - 1, Math.floor(y * srcH / dstH));
      const srcRow = sy * srcW;
      const dstRow = y * dstW;
      for (let x = 0; x < dstW; x++) {
        const sx = Math.min(srcW - 1, Math.floor(x * srcW / dstW));
        result[dstRow + x] = mask[srcRow + sx];
      }
    }
    return result;
  }

  // Trim to bounding box, pad to a square (preserves aspect), then resize
  // to the standard template size. This way a thin '1' and a wide 'W' both
  // end up centred and scaled to fill the same canvas.
  function pcvTrimAndNormalize(mask, w, h) {
    const box = pcvBBox(mask, w, h);
    if (!box || box.count < 4) return null;
    const cropped = pcvCrop(mask, w, box);
    const sq = Math.max(cropped.w, cropped.h);
    const square = new Uint8Array(sq * sq);
    const offX = Math.floor((sq - cropped.w) / 2);
    const offY = Math.floor((sq - cropped.h) / 2);
    for (let y = 0; y < cropped.h; y++) {
      const src = y * cropped.w;
      const dst = (y + offY) * sq + offX;
      for (let x = 0; x < cropped.w; x++) {
        square[dst + x] = cropped.mask[src + x];
      }
    }
    return pcvResize(square, sq, sq, PCV_SIZE, PCV_SIZE);
  }

  function pcvErode(mask, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      const up = row - w, dn = row + w;
      for (let x = 1; x < w - 1; x++) {
        if (mask[row + x] && mask[up + x] && mask[dn + x] &&
            mask[row + x - 1] && mask[row + x + 1]) {
          out[row + x] = 1;
        }
      }
    }
    return out;
  }

  function pcvDilate(mask, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const up = (y > 0) ? row - w : row;
      const dn = (y < h - 1) ? row + w : row;
      for (let x = 0; x < w; x++) {
        if (mask[row + x] ||
            mask[up + x] || mask[dn + x] ||
            (x > 0 && mask[row + x - 1]) ||
            (x < w - 1 && mask[row + x + 1])) {
          out[row + x] = 1;
        }
      }
    }
    return out;
  }

  // Jaccard similarity = |A ∩ B| / |A ∪ B|. Range [0,1], 1 = identical.
  // More forgiving than Hamming distance when characters are shifted or
  // slightly differently sized.
  function pcvJaccard(a, b) {
    let inter = 0, union = 0;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i], bi = b[i];
      if (ai && bi) inter++;
      if (ai || bi) union++;
    }
    return union ? inter / union : 0;
  }

  // Render a character to a canvas at the given font, optionally rotated
  // around the canvas centre. Returns a binary mask the size of the padded
  // canvas (large enough to hold the rotation without clipping corners).
  function pcvRenderChar(ch, fontSpec, rotationDeg) {
    const PAD = PCV_SIZE * 2;
    const cv = document.createElement('canvas');
    cv.width = PAD;
    cv.height = PAD;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, PAD, PAD);
    ctx.save();
    ctx.translate(PAD / 2, PAD / 2);
    if (rotationDeg) ctx.rotate(rotationDeg * Math.PI / 180);
    ctx.fillStyle = 'black';
    ctx.font = fontSpec;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    return pcvImageToMask(ctx.getImageData(0, 0, PAD, PAD));
  }

  function pcvGetTemplates() {
    if (_pcvTemplatesCache) return _pcvTemplatesCache;
    const templates = new Map();
    const PAD = PCV_SIZE * 2;
    for (const fontSpec of PCV_FONT_SPECS) {
      for (const ch of PCV_CHARS) {
        for (const rot of PCV_ROTATIONS) {
          const mask = pcvRenderChar(ch, fontSpec, rot);
          const trimmed = pcvTrimAndNormalize(mask, PAD, PAD);
          if (!trimmed) continue;
          if (!templates.has(ch)) templates.set(ch, []);
          templates.get(ch).push(trimmed);
        }
      }
    }
    _pcvTemplatesCache = templates;
    const totalTpls = [...templates.values()].reduce((a, v) => a + v.length, 0);
    console.log(`[Quillforge PureCV] templates ready (${templates.size} chars · ${totalTpls} total templates)`);
    return templates;
  }

  // Confusable-pair refinement: when the best match and second-best are very
  // close AND fall into a known visual-twin pair (0/O/o, l/I/1, S/s/5,
  // M/m, P/p, etc.), prefer the one whose aspect ratio better matches the
  // segment. Capitals are tall; lowercase letters are shorter. Digits live
  // somewhere in between.
  function pcvDisambiguate(bestChar, second, segH, segW) {
    const pair = (a, b) => (bestChar === a && second === b) || (bestChar === b && second === a);
    const aspectRatio = segW / Math.max(1, segH);
    if (pair('0', 'O') || pair('O', 'o')) {
      // Lowercase 'o' is shorter / wider; pick by aspect ratio
      return aspectRatio > 0.85 ? 'o' : (bestChar === '0' || second === '0' ? '0' : 'O');
    }
    if (pair('1', 'l') || pair('1', 'I') || pair('l', 'I')) {
      // 1 has a flag/serif → wider; l is straight tall; I is short straight
      // Heuristic: if very narrow, more likely l or I
      return bestChar;
    }
    return bestChar;
  }

  function pcvClassify(mask, w, h) {
    const templates = pcvGetTemplates();
    const normalized = pcvTrimAndNormalize(mask, w, h);
    if (!normalized) return { char: '?', score: 0 };

    let bestChar = '?', bestScore = 0;
    let secondChar = '?', secondScore = 0;

    for (const [ch, variants] of templates) {
      for (const tpl of variants) {
        const score = pcvJaccard(normalized, tpl);
        if (score > bestScore) {
          secondChar = bestChar; secondScore = bestScore;
          bestChar = ch; bestScore = score;
        } else if (score > secondScore && ch !== bestChar) {
          secondChar = ch; secondScore = score;
        }
      }
    }
    const disambiguated = pcvDisambiguate(bestChar, secondChar, h, w);
    return { char: disambiguated, score: bestScore, runnerUp: secondChar, runnerUpScore: secondScore };
  }

  // Find the N most distinctive non-background colours in the image.
  // Bins the colour space, sorts by frequency, then merges similar
  // colours (within a Euclidean distance threshold) so a slightly anti-
  // aliased 'red' character doesn't get split into red-100 and red-110.
  function pcvFindColors(id, count) {
    const histogram = new Map();
    const BIN = 32;
    for (let i = 0; i < id.data.length; i += 4) {
      const r = id.data[i], g = id.data[i + 1], b = id.data[i + 2];
      const min = Math.min(r, g, b);
      const max = Math.max(r, g, b);
      if (min > 220) continue;                     // near-white background
      const sat = max - min;
      if (min > 140 && sat < 60) continue;         // light pastel decoration
      const key = (Math.floor(r / BIN) * BIN) * 65536 +
                  (Math.floor(g / BIN) * BIN) * 256 +
                   Math.floor(b / BIN) * BIN;
      histogram.set(key, (histogram.get(key) || 0) + 1);
    }
    const sorted = [...histogram.entries()].sort((a, b) => b[1] - a[1]);

    const merged = [];
    const MERGE_DIST = 70;
    for (const [key, n] of sorted.slice(0, count * 5)) {
      const r = (key >> 16) & 0xff;
      const g = (key >> 8) & 0xff;
      const b =  key        & 0xff;
      let absorbed = false;
      for (const m of merged) {
        const d = Math.hypot(r - m.color[0], g - m.color[1], b - m.color[2]);
        if (d < MERGE_DIST) { m.count += n; absorbed = true; break; }
      }
      if (!absorbed) merged.push({ color: [r, g, b], count: n });
      if (merged.length >= count * 2) break;
    }
    return merged.slice(0, count).map(c => c.color);
  }

  function pcvExtractByColor(id, color, tolerance = 95) {
    const w = id.width, h = id.height;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) {
      const pi = i * 4;
      const r = id.data[pi], g = id.data[pi + 1], b = id.data[pi + 2];
      const d = Math.hypot(r - color[0], g - color[1], b - color[2]);
      mask[i] = d < tolerance ? 1 : 0;
    }
    return mask;
  }

  function pureCVSolve(imgEl, expectedLength) {
    try {
      const w = imgEl.naturalWidth  || imgEl.width  || 0;
      const h = imgEl.naturalHeight || imgEl.height || 0;
      if (!w || !h) return '';

      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(imgEl, 0, 0);
      const id = ctx.getImageData(0, 0, w, h);

      const colors = pcvFindColors(id, expectedLength);
      if (!colors.length) return '';

      const chars = [];
      for (const color of colors) {
        let mask = pcvExtractByColor(id, color);
        // Open (erode → dilate) to drop thin decoration lines that
        // happen to share approximately this colour.
        mask = pcvDilate(pcvErode(mask, w, h), w, h);

        const box = pcvBBox(mask, w, h);
        if (!box || box.count < 30) continue;
        const bw = box.right - box.left + 1;
        const bh = box.bottom - box.top + 1;
        if (bw < 6 || bh < 8) continue;  // too thin to be a glyph

        const cropped = pcvCrop(mask, w, box);
        const result = pcvClassify(cropped.mask, cropped.w, cropped.h);
        chars.push({
          char: result.char,
          x: (box.left + box.right) / 2,
          score: result.score,
          runnerUp: result.runnerUp,
          runnerUpScore: result.runnerUpScore,
        });
      }

      chars.sort((a, b) => a.x - b.x);

      const answer = chars.map(c => c.char).join('');
      if (answer) {
        console.log('[Quillforge PureCV] solve:', JSON.stringify({
          answer,
          detail: chars.map(c => ({
            ch: c.char,
            score: +(c.score * 100).toFixed(0),
            runnerUp: c.runnerUp,
            runnerUpScore: +(c.runnerUpScore * 100).toFixed(0),
          })),
        }));
      }
      return answer;
    } catch (e) {
      console.warn('[Quillforge PureCV] solve failed:', e.message);
      return '';
    }
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
