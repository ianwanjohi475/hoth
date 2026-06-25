// ─── HOTH Suite — Content Script ────────────────────────────────────────────
// Runs on all pages. HOTH watcher logic gates itself to thehoth.com/writer.
// Article writer logic gates itself to recognized job pages.

(() => {

  // ── Shared settings ──────────────────────────────────────────────────────
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

  const isHothWriter  = () => /thehoth\.com\/writer/i.test(window.location.href);
  const isJobPage     = () =>
    !!document.querySelector('div.well') ||
    document.body.innerText.includes('Client submitted the keywords') ||
    !!document.querySelector('textarea[name="body"]') ||
    !!document.querySelector('#body');

  // ── Visibility helper ────────────────────────────────────────────────────
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SPINTAX SCANNER
  // ═══════════════════════════════════════════════════════════════════════════
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
    console.log('[Inkwell] Spintax found via', source);
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  HOTH EDIT WATCHER
  // ═══════════════════════════════════════════════════════════════════════════
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
      { acceptNode(n) {
        if (!EDIT_RE.test(n.nodeValue.trim())) return NodeFilter.FILTER_SKIP;
        if (!isVisible(n.parentElement))        return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }}
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
    console.log('[Inkwell] Edit found. URL:', articleUrl, 'el:', editEl);
    hasTriggered = true;
    chrome.runtime.sendMessage({
      type: 'EDIT_FOUND',
      articleUrl,
      alarmDuration: S.alarmDuration,
      autoClick:     S.autoClick,
    });
  }

  function startWatching() {
    if (watchInterval) clearInterval(watchInterval);
    watchInterval = setInterval(checkPage, S.checkInterval * 1000);
    console.log(`[Inkwell] Edit watcher started — every ${S.checkInterval}s`);
  }

  function stopWatching() {
    if (watchInterval) { clearInterval(watchInterval); watchInterval = null; }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SPA NAVIGATION WATCHER
  // ═══════════════════════════════════════════════════════════════════════════
  let lastUrl = window.location.href;

  function onUrlChange() {
    const newUrl = window.location.href;
    if (newUrl === lastUrl) return;
    lastUrl = newUrl;
    console.log('[Inkwell] SPA navigation →', newUrl);
    hasTriggered = false;
    if ((isHothWriter() || isJobPage()) && S.spintaxEnabled) startSpintaxScanner();
  }

  window.addEventListener('popstate', onUrlChange);
  (function patchHistory() {
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      history[m] = function (...args) { orig.apply(this, args); onUrlChange(); };
    }
  })();
  new MutationObserver(onUrlChange).observe(document.body, { childList: true, subtree: false });

  // ═══════════════════════════════════════════════════════════════════════════
  //  ARTICLE AUTO-WRITER
  // ═══════════════════════════════════════════════════════════════════════════
  let alreadyRan = false;

  // ── Debugger helpers ──────────────────────────────────────────────────────
  function attachDebugger() {
    return new Promise(r => chrome.runtime.sendMessage({ type: 'ATTACH_DEBUGGER' }, res => r(res?.ok)));
  }
  function detachDebugger() {
    chrome.runtime.sendMessage({ type: 'DETACH_DEBUGGER' });
  }

  // ── Keyword extraction ────────────────────────────────────────────────────
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

  // ── Native value setter (React-friendly) ──────────────────────────────────
  function setNativeValue(el, value) {
    const proto  = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── Markdown stripper ─────────────────────────────────────────────────────
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

  // ── Submit button ─────────────────────────────────────────────────────────
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

  // ── Progress card UI ──────────────────────────────────────────────────────
  function createCard() {
    if (document.getElementById('hs-card')) return;
    const style  = document.createElement('style');
    style.id     = 'hs-style';
    style.textContent = `
      #hs-card {
        position:fixed;bottom:24px;right:24px;z-index:2147483647;
        width:260px;background:#0d1117;border:1px solid #21262d;
        border-radius:14px;padding:14px 16px;
        font-family:'Segoe UI',sans-serif;
        box-shadow:0 8px 32px rgba(0,0,0,0.6);
        animation:hs-slide 0.2s ease;
      }
      @keyframes hs-slide{from{transform:translateY(12px);opacity:0}to{transform:translateY(0);opacity:1}}
      #hs-hdr{display:flex;align-items:center;gap:8px;margin-bottom:10px}
      #hs-title{font-size:12px;font-weight:700;color:#f0f6fc}
      #hs-kw{font-size:10px;color:#14B8A6;font-weight:600;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .hs-row{display:flex;align-items:center;gap:8px;margin-bottom:7px;opacity:0.3;transition:opacity 0.3s}
      .hs-row.active{opacity:1}.hs-row.done{opacity:0.65}.hs-row.error{opacity:1}
      .hs-dot{width:18px;height:18px;border-radius:50%;flex-shrink:0;background:#161b22;border:1.5px solid #30363d;display:flex;align-items:center;justify-content:center;font-size:9px;color:#484f58;transition:all 0.3s}
      .hs-dot.active{border-color:#14B8A6;color:#14B8A6;animation:hs-pulse 1s infinite}
      .hs-dot.done{background:#14B8A6;border-color:#14B8A6;color:#fff}
      .hs-dot.error{background:#f85149;border-color:#f85149;color:#fff}
      @keyframes hs-pulse{0%,100%{box-shadow:0 0 0 0 rgba(20,184,166,0.4)}50%{box-shadow:0 0 0 4px rgba(20,184,166,0)}}
      .hs-lbl{font-size:11px;color:#8b949e}
      .hs-lbl.active{color:#f0f6fc;font-weight:600}
      .hs-lbl.done{color:#2DD4BF}
      .hs-lbl.error{color:#f85149}
      #hs-bar-wrap{height:3px;background:#161b22;border-radius:3px;margin:10px 0 8px;overflow:hidden}
      #hs-bar{height:100%;width:0%;background:linear-gradient(90deg,#14B8A6,#2DD4BF);border-radius:3px;transition:width 0.5s ease}
      #hs-foot{font-size:10px;color:#484f58;text-align:center}
    `;
    document.head.appendChild(style);

    const card   = document.createElement('div');
    card.id      = 'hs-card';
    card.innerHTML = `
      <div id="hs-hdr"><span style="display:inline-flex;color:#2DD4BF"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><path d="m16 8-9 9"/></svg></span><span id="hs-title">Inkwell · Article Writer</span></div>
      <div id="hs-kw">Detecting keyword…</div>
      <div class="hs-row" id="hs-row-1"><div class="hs-dot" id="hs-dot-1">1</div><span class="hs-lbl" id="hs-lbl-1">Detect keyword</span></div>
      <div class="hs-row" id="hs-row-2"><div class="hs-dot" id="hs-dot-2">2</div><span class="hs-lbl" id="hs-lbl-2">Generate article</span></div>
      <div class="hs-row" id="hs-row-3"><div class="hs-dot" id="hs-dot-3">3</div><span class="hs-lbl" id="hs-lbl-3">Fill form fields</span></div>
      <div class="hs-row" id="hs-row-4"><div class="hs-dot" id="hs-dot-4">4</div><span class="hs-lbl" id="hs-lbl-4">Submit assignment</span></div>
      <div id="hs-bar-wrap"><div id="hs-bar"></div></div>
      <div id="hs-foot">Starting…</div>
    `;
    document.body.appendChild(card);
  }

  function updateStep(n, state, label) {
    const row = document.getElementById(`hs-row-${n}`);
    const dot = document.getElementById(`hs-dot-${n}`);
    const lbl = document.getElementById(`hs-lbl-${n}`);
    if (!row) return;
    row.className = `hs-row ${state}`;
    dot.className = `hs-dot ${state}`;
    lbl.className = `hs-lbl ${state}`;
    if (label) lbl.textContent = label;
    if (state === 'done')  dot.textContent = '✓';
    if (state === 'error') dot.textContent = '✕';
    const pct = { 1: 15, 2: 45, 3: 75, 4: 100 };
    if (state === 'done') document.getElementById('hs-bar').style.width = pct[n] + '%';
  }

  function setFoot(t) { const f = document.getElementById('hs-foot'); if (f) f.textContent = t; }
  function setKw(t)   { const e = document.getElementById('hs-kw');   if (e) e.textContent = t; }
  function removeCard() {
    document.getElementById('hs-card')?.remove();
    document.getElementById('hs-style')?.remove();
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

  // ── Groq API ──────────────────────────────────────────────────────────────
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
            content: 'You are a professional blog writer. Write clean plain text articles with no markdown formatting whatsoever.'
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
- Be practical and informative` + secNote
          }
        ]
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  }

  // ── Main writer process ───────────────────────────────────────────────────
  async function runWriterProcess() {
    if (alreadyRan) return;
    alreadyRan = true;

    createCard();

    // Step 1 — detect keyword
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
    setKw(`"${keyword}"${extraKws.length ? ` + ${extraKws.length} more` : ''}`);
    updateStep(1, 'done', `Keyword${extraKws.length ? 's' : ''} detected`);

    // Step 2 — generate article
    updateStep(2, 'active', 'Generating article…');
    setFoot(`Using ${S.groqModel}…`);

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

    // Step 3 — fill form
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

    // Step 4 — submit
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
      setFoot('⚠️ Could not attach debugger — submit manually.');
      updateStep(4, 'error', 'Debugger failed');
      setTimeout(removeCard, 6000);
      return;
    }

    setFoot('Submitting…');
    const ok = clickSubmitButton();

    if (ok) {
      updateStep(4, 'done', 'Submitted!');
      setFoot('Assignment submitted ✓');
      setTimeout(detachDebugger, 6000);
    } else {
      updateStep(4, 'error', 'Submit button not found');
      setFoot('Submit manually.');
      detachDebugger();
    }
    setTimeout(removeCard, 4000);
  }

  // ── FAB button ────────────────────────────────────────────────────────────
  function injectFAB() {
    if (document.getElementById('hs-fab')) return;
    const btn    = document.createElement('button');
    btn.id       = 'hs-fab';
    btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><path d="m16 8-9 9"/></svg>Write Article';
    Object.assign(btn.style, {
      position:'fixed', bottom:'24px', right:'24px', zIndex:'2147483646',
      padding:'12px 20px', background:'linear-gradient(135deg,#14B8A6,#2DD4BF)',
      color:'#fff', border:'none', borderRadius:'50px', fontSize:'13px',
      fontWeight:'700', fontFamily:'Segoe UI, sans-serif', cursor:'pointer',
      boxShadow:'0 6px 24px rgba(20,184,166,0.4)', transition:'transform 0.15s',
      userSelect:'none',
    });
    btn.onmouseenter = () => btn.style.transform = 'scale(1.05)';
    btn.onmouseleave = () => btn.style.transform = 'scale(1)';
    btn.onclick = async () => {
      if (!S.groqApiKey) {
        chrome.runtime.sendMessage({ type: 'PLAY_ALERT_SOUND' });
        setFoot?.('Set API key in extension popup first.');
        return;
      }
      btn.remove();
      alreadyRan = false;
      runWriterProcess();
    };
    document.body.appendChild(btn);
  }

  function initArticleWriter() {
    if (!S.writerEnabled || !isJobPage()) return;
    if (!S.groqApiKey) { injectFAB(); return; }
    if (S.autoMode)    runWriterProcess();
    else               injectFAB();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  MESSAGES FROM POPUP / BACKGROUND
  // ═══════════════════════════════════════════════════════════════════════════
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.type === 'SETTINGS_UPDATED') {
      const prevInterval = S.checkInterval;
      const prevWatcher  = S.watcherEnabled;
      const prevSpintax  = S.spintaxEnabled;
      S = { ...S, ...msg.settings };

      if (isHothWriter() || isJobPage()) {
        // Spintax scanner
        if (S.spintaxEnabled && !prevSpintax) startSpintaxScanner();
        else if (!S.spintaxEnabled && prevSpintax) stopSpintaxScanner();

        // Edit watcher
        if (!prevWatcher && S.watcherEnabled) {
          hasTriggered = false; startWatching();
        } else if (prevWatcher && !S.watcherEnabled) {
          stopWatching();
        } else if (S.watcherEnabled && prevInterval !== S.checkInterval) {
          // Interval changed — restart with new interval
          hasTriggered = false; startWatching();
        }
      }
      sendResponse({ ok: true });
    }

    if (msg.type === 'GET_STATUS') {
      sendResponse({
        isWatching:      S.watcherEnabled,
        spintaxEnabled:  S.spintaxEnabled,
        writerEnabled:   S.writerEnabled,
        hasTriggered,
        spintaxTriggered,
        alarmDuration:   S.alarmDuration,
        checkInterval:   S.checkInterval,
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════════════════════════════════════
  loadSettings(() => {
    if (isHothWriter()) {
      if (S.spintaxEnabled) startSpintaxScanner();
      if (S.watcherEnabled) startWatching();
    } else if (isJobPage() && S.spintaxEnabled) {
      startSpintaxScanner();
    }
    initArticleWriter();
  });

  // Re-init article writer when DOM changes significantly (SPA)
  new MutationObserver(() => {
    if (
      S.writerEnabled && isJobPage() &&
      !document.getElementById('hs-fab') &&
      !document.getElementById('hs-card')
    ) {
      alreadyRan = false;
      initArticleWriter();
    }
  }).observe(document.body, { childList: true, subtree: true });

})();

// ═══════════════════════════════════════════════════════════════════════════════
//  RIDGE NEURAL SOLVER — Content Script (merged)
// ═══════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const RIDGE_DEFAULT_KEY = '4qNzAeraznT1SvoUvF2gPC9J0L6G1J0O';

  let autosolveActive = false;
  let solveLoop       = null;
  let overlayBtn      = null;
  let statusEl        = null;

  // ── Self-labeling collector ──
  // Every captcha we submit is stored in chrome.storage.local with its image
  // (base64 PNG) and the text we entered. After submit, we watch for HOTH's
  // "You must enter the captcha" error: if it does NOT appear within 4s, the
  // submission was accepted -> the pair is real-world ground truth and gets
  // flagged 'verified'. Verified pairs are the training data needed to fine-
  // tune the model on real HOTH captchas (the only path to true ~100%).
  const SAMPLES_KEY = 'inkwellSamples';
  let lastSample = null;        // { id, text } awaiting verification
  let verifyTimer = null;

  // Click "get a new code" to fetch a fresh captcha (free on HOTH). Falls
  // back to nothing if the link isn't found.
  function refreshCaptcha() {
    const link = document.querySelector('#writercaptcha a[href*="writer"]')
              || document.querySelector('#writercaptcha a')
              || [...document.querySelectorAll('a')].find(a => /get a new code/i.test(a.textContent || ''));
    if (link) { try { link.click(); } catch (_) {} }
  }

  // ── Local CNN model loader (one-time, from the bundled weights) ──
  let _cnnLoading = null;
  async function ensureCNN() {
    if (!window.InkwellCNN) return;             // script not present
    if (window.InkwellCNN.ready) return;
    if (_cnnLoading) return _cnnLoading;
    const url = chrome.runtime.getURL('model/weights.json');
    console.log('[Inkwell] loading CNN model from', url);
    _cnnLoading = window.InkwellCNN.loadModel(url)
      .then(() => console.log('[Inkwell] CNN model loaded ✓'))
      .catch(e => console.warn('[Inkwell] CNN model load FAILED:', e));
    return _cnnLoading;
  }

  // ─── Inject overlay button ─────────────────────────────────────────────────
  function injectOverlay() {
    if (document.getElementById('rns-overlay')) return;

    const wrap = document.createElement('div');
    wrap.id = 'rns-overlay';
    wrap.style.cssText = `
      position: fixed; bottom: 90px; right: 24px; z-index: 2147483646;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      font-family: 'Courier New', monospace;
    `;

    statusEl = document.createElement('div');
    statusEl.id = 'rns-status';
    statusEl.style.cssText = `
      background: rgba(10,10,15,0.92); color: #2DD4BF; font-size: 11px;
      padding: 5px 10px; border-radius: 6px; border: 1px solid #2DD4BF40;
      max-width: 220px; text-align: right; display: none; letter-spacing: 0.5px;
    `;

    overlayBtn = document.createElement('button');
    overlayBtn.id = 'rns-toggle-btn';
    overlayBtn.textContent = '⚡ AUTOSOLVE';
    overlayBtn.style.cssText = `
      background: linear-gradient(135deg, #0a0a0f 0%, #111120 100%);
      color: #2DD4BF; border: 1.5px solid #2DD4BF60; border-radius: 10px;
      padding: 10px 18px; font-family: 'Courier New', monospace; font-size: 12px;
      font-weight: bold; letter-spacing: 1.5px; cursor: pointer;
      box-shadow: 0 0 18px #2DD4BF30, 0 4px 20px rgba(0,0,0,0.6);
      transition: all 0.2s ease; outline: none; text-transform: uppercase;
    `;

    overlayBtn.addEventListener('mouseenter', () => {
      overlayBtn.style.boxShadow = '0 0 28px #2DD4BF60, 0 4px 24px rgba(0,0,0,0.7)';
      overlayBtn.style.borderColor = '#2DD4BF';
    });
    overlayBtn.addEventListener('mouseleave', () => {
      if (autosolveActive) return;
      overlayBtn.style.boxShadow = '0 0 18px #2DD4BF30, 0 4px 20px rgba(0,0,0,0.6)';
      overlayBtn.style.borderColor = '#2DD4BF60';
    });
    overlayBtn.addEventListener('click', toggleAutosolve);

    wrap.appendChild(statusEl);
    wrap.appendChild(overlayBtn);
    document.body.appendChild(wrap);

    chrome.storage.local.get(['autosolveEnabled'], (res) => {
      if (res.autosolveEnabled) startAutosolve(true);
    });
  }

  function setStatus(msg, color) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = color || '#2DD4BF';
    statusEl.style.display = msg ? 'block' : 'none';
  }

  function toggleAutosolve() {
    if (autosolveActive) stopAutosolve(); else startAutosolve(false);
  }

  function startAutosolve(silent) {
    if (autosolveActive) return;
    autosolveActive = true;
    lastSample = null;
    if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
    chrome.storage.local.set({ autosolveEnabled: true });
    setOverlayStopMode();
    if (!silent) setStatus('Scanning for CAPTCHA...', '#2DD4BF');
    runLoop();
  }

  function stopAutosolve() {
    autosolveActive = false;
    if (solveLoop) { clearTimeout(solveLoop); solveLoop = null; }
    chrome.storage.local.set({ autosolveEnabled: false });
    setOverlayStartMode();
    setStatus('', '');
  }

  function setOverlayStopMode() {
    if (!overlayBtn) return;
    overlayBtn.textContent = '■ STOP';
    overlayBtn.style.color = '#FB7185';
    overlayBtn.style.borderColor = '#FB718560';
    overlayBtn.style.boxShadow = '0 0 18px #FB718530, 0 4px 20px rgba(0,0,0,0.6)';
  }

  function setOverlayStartMode() {
    if (!overlayBtn) return;
    overlayBtn.textContent = '⚡ AUTOSOLVE';
    overlayBtn.style.color = '#2DD4BF';
    overlayBtn.style.borderColor = '#2DD4BF60';
    overlayBtn.style.boxShadow = '0 0 18px #2DD4BF30, 0 4px 20px rgba(0,0,0,0.6)';
  }

  // Snapshot the captcha image as a small base64 PNG. Bounded by the natural
  // size of HOTH's image (~230x70), so each sample is well under 30 KB.
  function snapshotImage(imgEl) {
    try {
      const w = imgEl.naturalWidth || imgEl.width;
      const h = imgEl.naturalHeight || imgEl.height;
      if (!w || !h) return null;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d', { willReadFrequently: true }).drawImage(imgEl, 0, 0);
      return cv.toDataURL('image/png');
    } catch (_) { return null; }
  }

  // Save (image, text) as a pending sample. Capped at 500 entries so storage
  // can't grow unbounded; oldest unverified samples drop out first.
  function captureSample(imgEl, text, conf) {
    const png = snapshotImage(imgEl);
    if (!png) return;
    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    chrome.storage.local.get([SAMPLES_KEY], (res) => {
      const arr = res[SAMPLES_KEY] || [];
      arr.push({ id, png, text, conf, verified: false, ts: Date.now() });
      while (arr.length > 15000) {
        // drop oldest unverified first; if all verified, drop oldest overall
        const idx = arr.findIndex(s => !s.verified);
        arr.splice(idx >= 0 ? idx : 0, 1);
      }
      chrome.storage.local.set({ [SAMPLES_KEY]: arr });
    });
    lastSample = { id, text };
    if (verifyTimer) clearTimeout(verifyTimer);
    // Fallback: clear pending status after 8s if neither success nor failure
    // signal was seen (e.g. navigation, tab switch). Sample stays unverified.
    verifyTimer = setTimeout(() => { lastSample = null; verifyTimer = null; }, 8000);
  }

  function verifySample(id, ok) {
    if (!id) return;
    chrome.storage.local.get([SAMPLES_KEY], (res) => {
      const arr = res[SAMPLES_KEY] || [];
      const s = arr.find(x => x.id === id);
      if (!s) return;
      // ok=true: HOTH accepted (success message) -> verified ground truth
      // ok=false: HOTH rejected (error message) -> flag as known-wrong
      s.verified = !!ok;
      s.rejected = !ok;
      chrome.storage.local.set({ [SAMPLES_KEY]: arr });
    });
  }

  // Watch for HOTH's response messages. TWO distinct signals from the user:
  //  - "There are no articles to assign!" => captcha was CORRECT (verified)
  //  - "You must enter the captcha to take a new assignment" => WRONG (rejected)
  // Either signal resolves the pending verification for the last submission.
  // Exact phrasing only — looser patterns matched menu text on other pages.
  const SUCCESS_RE = /there are no articles to assign/i;
  const FAILURE_RE = /must enter the captcha to take a new assignment/i;
  new MutationObserver(() => {
    if (!lastSample) return;
    // scan likely message containers + bare text nodes
    const nodes = document.querySelectorAll('.alert, .alert-danger, .alert-info, .alert-warning, .alert-success, .error, .message, .flash, .notice, .invalid-feedback, p, div');
    for (const el of nodes) {
      const t = (el.textContent || '').slice(0, 300);
      if (!t) continue;
      if (SUCCESS_RE.test(t)) {
        if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
        const id = lastSample.id; lastSample = null;
        verifySample(id, true);
        console.log('[Inkwell] HOTH accepted ✓ -> sample verified');
        return;
      }
      if (FAILURE_RE.test(t)) {
        if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
        const id = lastSample.id; lastSample = null;
        verifySample(id, false);
        console.log('[Inkwell] HOTH rejected ✗ -> sample marked wrong');
        return;
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // ─── Main solve loop ───────────────────────────────────────────────────────
  async function runLoop() {
    if (!autosolveActive) return;
    try {
      const settings = await getSettings();
      const { captchaSelector, inputSelector, submitSelector, ridgeApiKey, delay } = settings;

      const imgEl = document.querySelector(captchaSelector);
      if (!imgEl || !imgEl.src || imgEl.naturalWidth === 0) {
        setStatus('Scanning for CAPTCHA...', '#ffaa00');
        scheduleNext(600);   // tight poll while image is loading
        return;
      }

      setStatus('CAPTCHA found! Reading...', '#00ccff');

      // ── Local CNN solve (no API, no quota, no limits) ──
      await ensureCNN();
      if (!window.InkwellCNN || !window.InkwellCNN.ready) {
        setStatus('Model not loaded ✗', '#ff4466');
        console.warn('[Inkwell] model not ready when solving');
        scheduleNext(1500);
        return;
      }
      let sol;
      try {
        sol = window.InkwellCNN.solveImage(imgEl);
      } catch (e) {
        setStatus('Solve error: ' + (e.message || e).slice(0, 30), '#ff4466');
        console.warn('[Inkwell] solveImage error:', e);
        scheduleNext(1500);
        return;
      }
      const result = sol.text;
      console.log(`[Inkwell] solve: chars=${sol.n} text="${result}" conf=${(sol.conf*100|0)}%`);

      if (!autosolveActive) return;

      // ALWAYS submit. The user wants every captcha autofilled — no skipping,
      // no waiting for high confidence. If the read isn't 5 chars we still
      // submit what we have (HOTH will reject it, fresh code appears, and the
      // loop tries again automatically). Every accepted solve gets saved as
      // a verified-correct training pair (see captureSample).
      const corrected = result || '';
      captureSample(imgEl, corrected, sol.conf);

      setStatus(`Autofill: ${corrected || '?'}  (${Math.round(sol.conf * 100)}%)`, '#2DD4BF');

      const inputEl = document.querySelector(inputSelector);
      if (inputEl) {
        inputEl.focus();
        inputEl.value = corrected;
        inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        inputEl.blur();
      }

      const delayMs = (parseFloat(delay) || 0) * 1000;
      if (delayMs > 0) {
        let remaining = parseFloat(delay);
        // Show the actual text we're about to autofill, not just the time.
        const countdownId = setInterval(() => {
          if (!autosolveActive) return;
          setStatus(`Submitting "${corrected}" in ${remaining.toFixed(1)}s...`, '#ffaa00');
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
        setStatus(`Submitted "${corrected}"`, '#2DD4BF');
      } else {
        setStatus('Submit btn not found — retrying...', '#FB7185');
      }
      // Snappy resume — HOTH's "You must enter the captcha" message
      // appears with a fresh captcha image immediately, so 500 ms is plenty
      // to let the page settle and the new image render.
      scheduleNext(500);

    } catch (err) {
      // Show the real reason so failures are diagnosable instead of a blind
      // "Retrying...". Full detail is also in the service-worker console.
      const reason = (err && err.message ? err.message : 'unknown').slice(0, 60);
      console.warn('[Inkwell] solve failed:', err && err.message);
      setStatus('Retry · ' + reason, '#ffaa00');
      scheduleNext(1500);
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
          ridgeApiKey:      result.ridgeApiKey      || RIDGE_DEFAULT_KEY,
          captchaSelector:  result.captchaSelector  || '#writercaptcha > div:nth-child(2) > img:nth-child(1)',
          inputSelector:    result.inputSelector    || 'input[required]',
          submitSelector:   result.submitSelector   || 'input[type="submit"].btn.btn-success.btn-large',
          delay:            result.delay !== undefined ? result.delay : 3,
        })
      );
    });
  }

  // Upscale 3× before sending to the OCR model. A larger, crisp image is
  // significantly easier for the vision model to read accurately — the glyph
  // edges and relative letter heights (which decide case) become clearer.
  const OCR_UPSCALE = 3;

  function imageToBase64(imgEl) {
    return new Promise((resolve, reject) => {
      try {
        const w = imgEl.naturalWidth  || imgEl.width  || 200;
        const h = imgEl.naturalHeight || imgEl.height || 60;
        const canvas = document.createElement('canvas');
        canvas.width  = w * OCR_UPSCALE;
        canvas.height = h * OCR_UPSCALE;
        const ctx = canvas.getContext('2d');
        // High-quality smoothing so the upscaled glyphs stay clean, not blocky.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/png');
        if (dataUrl && dataUrl.length > 200) resolve(dataUrl);
        else fetchImageAsBase64(imgEl.src).then(resolve).catch(reject);
      } catch (e) {
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
      img.src = url.split('?')[0] + '?_rns=' + Date.now();
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ═══════════════════════════════════════════════════════════════════════
  //  GEOMETRIC CASE CORRECTOR
  //
  //  For HOTH-style multi-coloured captchas where each character is its
  //  own colour: model OCR is usually correct on the SHAPE of every
  //  character, but case-ambiguous letters (c/C, o/O, s/S, u/U, v/V,
  //  w/W, x/X, z/Z, m/M, n/N, k/K, p/P) are hit-or-miss because the only
  //  difference between cases is RELATIVE HEIGHT. We can measure that
  //  height directly from the source image, so we do.
  //
  //  Algorithm:
  //   1. Find the content span in the image (skip left/right margins).
  //   2. Divide the span into N equal slices (one per character).
  //   3. For each slice, measure the height of dark/coloured pixels.
  //   4. Build a reference height from characters in the answer whose
  //      case is unambiguous (digits, distinctly-capital letters like
  //      B/D/E/F/H/L/Q/R/T/Y, and lowercase ascenders b/d/f/h/l/t).
  //   5. For each AMBIGUOUS letter, compare its height to the reference:
  //        ratio >= 0.85 → force uppercase
  //        ratio <= 0.72 → force lowercase
  //        between      → trust the model
  // ═══════════════════════════════════════════════════════════════════════

  // Letters whose case is ambiguous from shape alone — same glyph, only
  // size differs between upper and lower case.
  const _CASE_AMBIGUOUS = new Set([
    'c','C','k','K','m','M','o','O','p','P',
    's','S','u','U','v','V','w','W','x','X','z','Z',
  ]);

  // Characters that read as "tall" in this captcha — used as height
  // reference. Capitals that don't have a same-shape lowercase, plus
  // lowercase ascenders, plus digits.
  const _TALL_REFERENCE = /[ABDEFGHLQRTY0-9bdfhlt]/;

  function caseCorrect(answer, imgEl) {
    try {
      if (!answer || !imgEl || answer.length === 0) return answer;
      const heights = _measureCharHeights(imgEl, answer.length);
      if (!heights || heights.length !== answer.length) return answer;

      // Build the tall reference from characters whose case the model
      // surely got right.
      const tallHeights = [];
      for (let i = 0; i < answer.length; i++) {
        if (_TALL_REFERENCE.test(answer[i]) && heights[i] > 0) {
          tallHeights.push(heights[i]);
        }
      }
      if (tallHeights.length === 0) return answer; // no reference -> bail

      tallHeights.sort((a, b) => a - b);
      const refTall = tallHeights[Math.floor(tallHeights.length / 2)];
      if (refTall <= 0) return answer;

      let out = '';
      for (let i = 0; i < answer.length; i++) {
        const ch = answer[i];
        if (!_CASE_AMBIGUOUS.has(ch) || heights[i] <= 0) {
          out += ch;
          continue;
        }
        const ratio = heights[i] / refTall;
        if      (ratio >= 0.85) out += ch.toUpperCase();
        else if (ratio <= 0.72) out += ch.toLowerCase();
        else                    out += ch;  // borderline — trust the model
      }
      return out;
    } catch (e) {
      console.warn('[Inkwell] caseCorrect failed:', e.message);
      return answer;
    }
  }

  function _measureCharHeights(imgEl, charCount) {
    const w = imgEl.naturalWidth  || imgEl.width  || 0;
    const h = imgEl.naturalHeight || imgEl.height || 0;
    if (!w || !h || charCount <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(imgEl, 0, 0);
    let id;
    try { id = ctx.getImageData(0, 0, w, h); }
    catch (_) { return null; } // tainted canvas (shouldn't happen for HOTH)
    const d = id.data;

    // 1. Find content span (leftmost/rightmost columns with significant
    //    non-white content). Threshold filters out the thin decoration lines.
    const density = new Int32Array(w);
    for (let x = 0; x < w; x++) {
      let count = 0;
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        const minCh = Math.min(d[i], d[i + 1], d[i + 2]);
        if (minCh < 200) count++;
      }
      density[x] = count;
    }
    const colThreshold = Math.max(2, Math.floor(h * 0.10));
    let left = 0, right = w - 1;
    while (left < w && density[left] < colThreshold) left++;
    while (right >= 0 && density[right] < colThreshold) right--;
    if (right - left < w * 0.30) { left = 0; right = w - 1; }

    // 2. Equal-width slices, measure top/bottom of dark pixels in each.
    const spanW = (right - left + 1);
    const charW = spanW / charCount;
    const heights = new Array(charCount).fill(0);
    for (let i = 0; i < charCount; i++) {
      const x0 = Math.floor(left + i * charW);
      const x1 = Math.floor(left + (i + 1) * charW);
      let top = h, bottom = -1;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let found = false;
        for (let x = x0; x < x1; x++) {
          const idx = (row + x) * 4;
          // Stricter threshold here (180 vs 200) so thin pastel decoration
          // lines don't get counted as character pixels and inflate height.
          const minCh = Math.min(d[idx], d[idx + 1], d[idx + 2]);
          if (minCh < 180) { found = true; break; }
        }
        if (found) {
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
      heights[i] = bottom >= top ? bottom - top + 1 : 0;
    }
    return heights;
  }

  // ─── Listen for messages from popup ───────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_AUTOSOLVE') startAutosolve(false);
    if (msg.type === 'STOP_AUTOSOLVE')  stopAutosolve();
    if (msg.type === 'EXPORT_SAMPLES') {
      chrome.storage.local.get([SAMPLES_KEY], (res) => {
        const arr = res[SAMPLES_KEY] || [];
        const verified = arr.filter(s => s.verified);
        sendResponse({ total: arr.length, verified: verified.length, samples: verified });
      });
      return true;  // async response
    }
    if (msg.type === 'CLEAR_SAMPLES') {
      chrome.storage.local.set({ [SAMPLES_KEY]: [] }, () => sendResponse({ ok: true }));
      return true;
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────────────
  if (document.body) injectOverlay();
  else document.addEventListener('DOMContentLoaded', injectOverlay);

})();
