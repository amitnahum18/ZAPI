// content-ui.js — runs in ISOLATED world (access to chrome APIs)
(function() {
  'use strict';

  if (document.getElementById('zapi-bubble')) return;

  // ── Bridge helpers ────────────────────────────────────────────────────────
  function triggerRefresh() {
    window.postMessage({ __zapi: 'refresh' }, location.origin);
  }

  function readBridge() {
    try {
      const el  = document.getElementById('__zapi_bridge__');
      const raw = el ? el.getAttribute('data-zapi') : null;
      return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
  }

  // ── Health check (circuit only) ───────────────────────────────────────────
  function runHealthCheck() {
    const data = readBridge();
    const ok = !!data._healthy;
    return ok;
  }
  setTimeout(runHealthCheck, 2000);

  // ── File selection state ──────────────────────────────────────────────────
  // Set of filenames the user has selected to include in context.
  // null = not yet initialized (include all by default).
  let selectedFiles = null;

  // ── Circuit context for /ask ──────────────────────────────────────────────
  const SKIP_FILES  = new Set(['libraries.txt', 'Library Manager']);
  const MAX_FILE_SZ = 8000;

  function extractCircuitContext() {
    const data     = readBridge();
    const files    = data.files || {};
    const mainFile = data.main_code_file;
    const parts    = [];

    function isSelected(name) {
      return !selectedFiles || selectedFiles.has(name);
    }

    for (const f of (files.diagram || [])) {
      if (isSelected(f.name)) parts.push(`[${f.name}]\n${f.content}`);
    }

    const codeFiles = [...(files.code || [])].sort((a, b) => {
      if (mainFile && a.name === mainFile.name) return -1;
      if (mainFile && b.name === mainFile.name) return  1;
      return a.name.localeCompare(b.name);
    });
    for (const f of codeFiles) {
      if (!SKIP_FILES.has(f.name) && f.content.length <= MAX_FILE_SZ && isSelected(f.name)) {
        parts.push(`[${f.name}]\n${f.content}`);
      }
    }

    return parts.length ? parts.join('\n\n---\n\n') : null;
  }



  // ── UI ────────────────────────────────────────────────────────────────────
  const bubble = document.createElement('div');
  bubble.id    = 'zapi-bubble';
  bubble.innerHTML = '&#9889;';
  bubble.title = 'ZAPI - AI Tutor';

  const panel = document.createElement('div');
  panel.id    = 'zapi-panel';
  panel.innerHTML = `
    <div id="zapi-header">
      <span id="zapi-close">&#10005;</span>
      <span>ZAPI &#9889;</span>
      <span id="zapi-token-toggle" title="Token usage log">⬡ 0</span>
    </div>
    <div id="zapi-token-log" style="display:none"></div>
    <div id="zapi-file-toggles"></div>
    <div id="zapi-messages">
      <div class="zapi-msg bot">Hi! I'm ZAPI, your electronics tutor. Ask me anything about your circuit — in English or Hebrew.</div>
    </div>
    <div id="zapi-no-key" style="display:none">
      No API key configured.<br>
      Click the ⚡ icon in the browser toolbar to set your key.
    </div>
    <div id="zapi-input-area">
      <button id="zapi-send">&#9658;</button>
      <textarea id="zapi-input" rows="1" placeholder="Ask a question..."></textarea>
    </div>
  `;

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  // ── State ─────────────────────────────────────────────────────────────────
  let isOpen = false, isLoading = false;
  let storedKey = null, storedModel = 'anthropic/claude-sonnet-4-5';

  chrome.storage.local.get(['apiKey', 'model'], (data) => {
    storedKey   = data.apiKey || null;
    storedModel = data.model  || 'anthropic/claude-sonnet-4-5';
    updateNoKeyUI();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.apiKey) storedKey   = changes.apiKey.newValue;
    if (changes.model)  storedModel = changes.model.newValue;
    updateNoKeyUI();
  });

  function updateNoKeyUI() {
    document.getElementById('zapi-no-key').style.display     = storedKey ? 'none'  : 'block';
    document.getElementById('zapi-input-area').style.display = storedKey ? 'flex'  : 'none';
  }

  // ── File toggle buttons ───────────────────────────────────────────────────
  const SKIP_NAMES = new Set(['libraries.txt', 'Library Manager', 'wokwi-project.txt']);
  let _lastFileKey = '';

  function updateFileToggles() {
    const data  = readBridge();
    const files = data.files || {};

    // Files already extracted (have content)
    const extractedDiagram = new Set((files.diagram || []).map(f => f.name));
    const extractedCode    = new Set((files.code    || []).map(f => f.name));
    const extractedAll     = new Set([...extractedDiagram, ...extractedCode]);

    // All file names known to Monaco (may include not-yet-read files)
    const knownFiles = (data.known_files || []).filter(n => !SKIP_NAMES.has(n));

    // Union: known + extracted
    const allNames = [...new Set([...knownFiles, ...extractedAll])]
      .filter(n => !SKIP_NAMES.has(n));

    // Guess type for files not yet classified
    function guessType(name) {
      if (extractedDiagram.has(name)) return 'diagram';
      if (extractedCode.has(name))    return 'code';
      if (name.endsWith('.json'))     return 'diagram';
      return 'code';
    }

    // Sort: diagram first, then code, then alpha
    allNames.sort((a, b) => {
      const ta = guessType(a), tb = guessType(b);
      if (ta !== tb) return ta === 'diagram' ? -1 : 1;
      return a.localeCompare(b);
    });

    const key = allNames.join(',');
    if (key === _lastFileKey) return;
    _lastFileKey = key;

    // Initialize selectedFiles with all extracted files on first load
    if (selectedFiles === null && extractedAll.size > 0) {
      selectedFiles = new Set([...extractedAll]);
    }

    const container = document.getElementById('zapi-file-toggles');
    if (!container) return;
    container.innerHTML = '';

    if (allNames.length === 0) {
      container.innerHTML = '<span style="color:#555;font-size:11px;padding:4px 8px">Waiting for files...</span>';
      return;
    }

    for (const name of allNames) {
      const extracted = extractedAll.has(name);
      const btn = document.createElement('button');
      btn.className      = 'zapi-file-btn';
      btn.textContent    = name;
      btn.dataset.type   = guessType(name);

      if (extracted) {
        const active = !selectedFiles || selectedFiles.has(name);
        btn.dataset.active = active ? '1' : '0';
        btn.title = active ? 'Click to remove from context' : 'Click to add to context';
        btn.addEventListener('click', () => {
          if (!selectedFiles) selectedFiles = new Set([...extractedAll]);
          if (selectedFiles.has(name)) {
            selectedFiles.delete(name);
            btn.dataset.active = '0';
            btn.title = 'Click to add to context';
          } else {
            selectedFiles.add(name);
            btn.dataset.active = '1';
            btn.title = 'Click to remove from context';
          }
        });
      } else {
        // Known from Monaco but not yet read
        btn.dataset.active = 'pending';
        btn.disabled = true;
        btn.title = 'Not yet read from editor — will auto-refresh';
      }

      container.appendChild(btn);
    }

  }

  // Auto-refresh: poll every 3s when panel is open
  setInterval(() => {
    if (!isOpen) return;
    triggerRefresh();
    setTimeout(updateFileToggles, 400);
  }, 3000);


  // ── Drag-to-resize handle — grows UPWARD ─────────────────────────────────
  const resizeHandle = document.createElement('div');
  resizeHandle.id = 'zapi-resize-handle';
  resizeHandle.style.cssText = `
    height:12px; cursor:ns-resize; display:flex; align-items:center;
    justify-content:center; background:#0d1b33; border-top:1px solid #1e2a4a;
    user-select:none; flex-shrink:0;
  `;
  resizeHandle.innerHTML = '<div style="width:40px;height:3px;background:#3a4a7a;border-radius:2px;"></div>';
  panel.appendChild(resizeHandle);

  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY    = e.clientY;
    const startH    = panel.getBoundingClientRect().height;
    const startTop  = panel.getBoundingClientRect().top;

    function onMove(e) {
      const dy   = e.clientY - startY;          // negative = dragging up
      const newH = Math.max(200, Math.min(startH - dy, window.innerHeight - 40));
      const newTop = Math.max(8, startTop + dy);
      panel.style.height    = newH  + 'px';
      panel.style.maxHeight = 'none';
      panel.style.top       = newTop + 'px';
      panel.style.bottom    = 'unset';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // ── Drag logic ────────────────────────────────────────────────────────────
  (function initDrag() {
    let startX, startY, startRight, startBottom, dragged = false;
    const BUBBLE_SIZE = 56;

    function getBubblePos() {
      const rect = bubble.getBoundingClientRect();
      return { right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.bottom };
    }

    function positionPanel() {
      const rect   = bubble.getBoundingClientRect();
      const panelW = panel.offsetWidth  || 400;
      const panelH = panel.offsetHeight || 600;
      const GAP    = 12;
      const MARGIN = 8;

      // Prefer: panel to the LEFT of bubble, bottom-aligned with bubble
      let left = rect.left - panelW - GAP;
      let top  = rect.bottom - panelH;

      // Not enough space to the left → place above bubble, centered
      if (left < MARGIN) {
        left = rect.left + BUBBLE_SIZE / 2 - panelW / 2;
        top  = rect.top - panelH - GAP;
        if (top < MARGIN) top = rect.bottom + GAP;
      }

      // Clamp to viewport
      left = Math.max(MARGIN, Math.min(left, window.innerWidth  - panelW - MARGIN));
      top  = Math.max(MARGIN, Math.min(top,  window.innerHeight - panelH - MARGIN));

      panel.style.left   = left + 'px';
      panel.style.top    = top  + 'px';
      panel.style.right  = 'unset';
      panel.style.bottom = 'unset';
    }

    bubble.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      startX = e.clientX; startY = e.clientY;
      const pos = getBubblePos();
      startRight = pos.right; startBottom = pos.bottom;
      dragged = false;

      function onMove(e) {
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (!dragged && Math.abs(dx) + Math.abs(dy) < 6) return;
        dragged = true;
        bubble.classList.add('dragging');
        const newRight  = Math.max(8, Math.min(startRight  - dx, window.innerWidth  - BUBBLE_SIZE - 8));
        const newBottom = Math.max(8, Math.min(startBottom - dy, window.innerHeight - BUBBLE_SIZE - 8));
        bubble.style.right  = newRight  + 'px';
        bubble.style.bottom = newBottom + 'px';
        bubble.style.left   = 'unset';
        bubble.style.top    = 'unset';
        // Panel follows bubble in real time
        if (isOpen) positionPanel();
      }

      function onUp() {
        if (dragged) bubble._wasDragged = true;
        bubble.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });

    // Expose positionPanel for use in toggle
    bubble._positionPanel = positionPanel;
  })();

  // ── Toggle ────────────────────────────────────────────────────────────────
  bubble.addEventListener('click', () => {
    if (bubble._wasDragged) { bubble._wasDragged = false; return; }
    isOpen = !isOpen;
    panel.classList.toggle('visible', isOpen);
    bubble.classList.toggle('open', isOpen);
    if (isOpen) {
      bubble._positionPanel();
      triggerRefresh();
      setTimeout(updateFileToggles, 400);
    }
  });
  document.getElementById('zapi-close').addEventListener('click', () => {
    isOpen = false; panel.classList.remove('visible'); bubble.classList.remove('open');
  });
  // User must open the popup by clicking the extension icon in the toolbar.

  // ── Textarea ──────────────────────────────────────────────────────────────
  const textarea = document.getElementById('zapi-input');
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px';
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // ── Long-press debug ──────────────────────────────────────────────────────
  let pressTimer;
  const sendBtn = document.getElementById('zapi-send');
  sendBtn.addEventListener('mousedown', () => {
    pressTimer = setTimeout(() => {
      const data = readBridge();
      const msg  = data._healthy
        ? `Debug ✓\ncode: ${(data.files?.code||[]).map(x=>x.name).join(', ')||'none'}\ndiagram: ${(data.files?.diagram||[]).map(x=>x.name).join(', ')||'none'}`
        : 'Debug ✗ — bridge is empty. Open a Wokwi project and try again.';
      appendMessage(msg, 'thinking');
    }, 1500);
  });
  sendBtn.addEventListener('mouseup',    () => clearTimeout(pressTimer));
  sendBtn.addEventListener('mouseleave', () => clearTimeout(pressTimer));
  sendBtn.addEventListener('click', sendMessage);

  // ── Send ──────────────────────────────────────────────────────────────────
  async function sendMessage() {
    if (isLoading) return;
    const question = textarea.value.trim();
    if (!question || !storedKey) return;

    textarea.value = '';
    textarea.style.height = 'auto';
    isLoading = true;
    sendBtn.disabled = true;

    // Bridge is kept fresh by the 3s auto-refresh — no extra refresh needed here

    appendMessage(question, 'user');
    const thinkingEl = appendMessage('Thinking...', 'thinking');

    if (!chrome?.runtime?.sendMessage) {
      thinkingEl.remove();
      appendMessage('Extension context lost — please refresh the page (F5).', 'bot');
      isLoading = false;
      sendBtn.disabled = false;
      return;
    }

    try {
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type:          'ASK',
          question,
          apiKey:        storedKey,
          model:         storedModel,
          circuitContext: extractCircuitContext(),
        }, resp => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(resp);
        });
      });

      thinkingEl.remove();
      if (result.error) {
        appendMessage('Error: ' + result.error, 'bot');
      } else {
        appendMessage(result.answer, 'bot');
        if (result.usage) appendUsage(result.usage, question);
      }
    } catch (e) {
      thinkingEl.remove();
      appendMessage('Error: ' + e.message, 'bot');
    }

    isLoading = false;
    sendBtn.disabled = false;
  }


  // ── Markdown renderer (bot messages only) ────────────────────────────────
  function renderMarkdown(raw) {
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    function inline(s) {
      return s
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g,     '<em>$1</em>')
        .replace(/`([^`\n]+)`/g,   (_, c) => `<code>${esc(c)}</code>`);
    }

    const lines = raw.split('\n');
    const out   = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      if (line.startsWith('```')) {
        const code = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) { code.push(lines[i]); i++; }
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
        i++; continue;
      }

      // Table
      if (line.trim().startsWith('|')) {
        const rows = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i]); i++; }
        const dataRows = rows.filter(l => !/^\s*\|[\s\-:|]+\|\s*$/.test(l));
        if (dataRows.length) {
          const cols = l => l.split('|').slice(1,-1).map(c => c.trim());
          const [h, ...body] = dataRows;
          const ths = cols(h).map(c => `<th>${inline(esc(c))}</th>`).join('');
          const trs = body.map(r => `<tr>${cols(r).map(c => `<td>${inline(esc(c))}</td>`).join('')}</tr>`).join('');
          out.push(`<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`);
        }
        continue;
      }

      // Heading
      const hm = line.match(/^(#{1,4})\s+(.+)/);
      if (hm) {
        const lvl = Math.min(hm[1].length + 2, 6);
        out.push(`<h${lvl}>${inline(esc(hm[2].trim()))}</h${lvl}>`);
        i++; continue;
      }

      // Unordered list
      if (/^[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          items.push(`<li>${inline(esc(lines[i].replace(/^[-*]\s+/, '')))}</li>`);
          i++;
        }
        out.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      // Skip blank line
      if (line.trim() === '') { i++; continue; }

      // Paragraph
      const para = [];
      while (i < lines.length && lines[i].trim() !== '' &&
             !lines[i].startsWith('#') && !lines[i].startsWith('```') &&
             !lines[i].trim().startsWith('|') && !/^[-*]\s+/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      if (para.length) out.push(`<p>${para.map(l => inline(esc(l))).join('<br>')}</p>`);
    }

    return out.join('');
  }

  // ── Token usage log ───────────────────────────────────────────────────────
  let _sessionTokens = 0;
  let _requestCount  = 0;
  const _tokenHistory = [];

  let _tokenLogOpen = false;
  document.getElementById('zapi-token-toggle').addEventListener('click', () => {
    _tokenLogOpen = !_tokenLogOpen;
    document.getElementById('zapi-token-log').style.display = _tokenLogOpen ? 'block' : 'none';
  });

  function updateTokenLog() {
    const toggle = document.getElementById('zapi-token-toggle');
    toggle.textContent = `⬡ ${_sessionTokens.toLocaleString()}`;

    const log = document.getElementById('zapi-token-log');
    if (!_tokenHistory.length) { log.innerHTML = '<div class="zapi-token-log-empty">No requests yet</div>'; return; }

    log.innerHTML = _tokenHistory.map((h, i) =>
      `<div class="zapi-token-row">
        <span class="zapi-token-num">#${i + 1}</span>
        <span class="zapi-token-q">${h.q}</span>
        <span class="zapi-token-val">⬡ ${h.total.toLocaleString()} <span class="zapi-token-detail">(↑${h.prompt} ↓${h.compl})</span></span>
      </div>`
    ).join('') +
    `<div class="zapi-token-total">Session total: ${_sessionTokens.toLocaleString()} tokens (${_requestCount} requests)</div>`;
  }

  function appendUsage(usage, question) {
    const total  = usage.total_tokens      || 0;
    const prompt = usage.prompt_tokens     || 0;
    const compl  = usage.completion_tokens || 0;

    _sessionTokens += total;
    _requestCount++;
    _tokenHistory.push({ q: question.length > 30 ? question.slice(0, 30) + '…' : question, total, prompt, compl });
    updateTokenLog();

    const msgs = document.getElementById('zapi-messages');
    const el   = document.createElement('div');
    el.className = 'zapi-usage';
    el.textContent = `⬡ ${total.toLocaleString()} tokens  (↑${prompt} in · ↓${compl} out)`;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
  }

  // ── Append message ────────────────────────────────────────────────────────
  function appendMessage(text, type) {
    const msgs = document.getElementById('zapi-messages');
    const el   = document.createElement('div');
    el.className = 'zapi-msg ' + type;
    if (type === 'bot') {
      el.innerHTML = renderMarkdown(text);
    } else {
      el.textContent = text;
    }
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

})();
