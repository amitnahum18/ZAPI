// content-main.js — runs in MAIN world (access to CM6, localStorage, window)
(function() {
  'use strict';

  const bridge = document.createElement('div');
  bridge.id = '__zapi_bridge__';
  bridge.style.display = 'none';
  document.documentElement.appendChild(bridge);

  // ── Internal store ────────────────────────────────────────────────────────
  const store = {
    byName:     {},   // { name: { content, type, confidence, ts } }
    rscRefs:    {},   // { hexId: resolvedContent }
    rscPending: {}    // { hexId: [name, ...] }
  };
  const cache = {};

  // ── File classification ───────────────────────────────────────────────────
  const CODE_SIGNALS = ['void setup(', 'void loop(', '#include', 'import '];
  const CODE_EXTS    = ['.ino', '.cpp', '.c', '.h', '.py', '.js', '.ts'];

  function classifyFile(name, content) {
    // 1. Diagram by content — strongest signal
    if (content.trimStart().startsWith('{')) {
      try {
        const j = JSON.parse(content);
        if (j.parts && j.connections) return { type: 'diagram', confidence: 1.0 };
      } catch (_) {}
    }
    // 2. Code by content heuristics
    const hits = CODE_SIGNALS.filter(s => content.includes(s)).length;
    if (hits > 0) return { type: 'code', confidence: Math.min(1.0, hits * 0.4) };
    // 3. Extension fallback
    if (CODE_EXTS.some(e => name.endsWith(e))) return { type: 'code',    confidence: 0.5 };
    if (name.endsWith('.json'))                return { type: 'diagram', confidence: 0.3 };
    return { type: 'other', confidence: 1.0 };
  }

  // ── Merge: keep longer (fresher) content, never overwrite with empty ──────
  function mergeFile(name, content) {
    if (!content || content.length < 10) return false;
    const existing = store.byName[name];
    if (existing && existing.content === content) return false;
    const { type, confidence } = classifyFile(name, content);
    store.byName[name] = { content, type, confidence, ts: Date.now() };
    return true;
  }

  // ── Select entry-point code file (prefers setup/loop) ────────────────────
  function selectMainCodeFile(codeFiles) {
    return codeFiles.find(f =>
      f.content.includes('void setup(') || f.content.includes('void loop(')
    ) || codeFiles[0] || null;
  }

  // ── Active tab ────────────────────────────────────────────────────────────
  function getActiveTabName() {
    const el = document.querySelector('[class*="tabs_active__"]');
    return el ? el.textContent.trim() : null;
  }

  // ── Commit: rebuild structured bridge output from store ───────────────────
  function commitCache() {
    const files = { code: [], diagram: [], other: [] };
    for (const [name, { content, type }] of Object.entries(store.byName)) {
      files[type].push({ name, content });
    }
    const main = selectMainCodeFile(files.code);

    // All file names known to Monaco (even if not yet read into store)
    let knownFiles = [];
    if (window.monaco && window.monaco.editor) {
      knownFiles = window.monaco.editor.getModels()
        .map(m => m.uri.toString().replace(/^[a-z][a-z0-9+.-]*:\/*?/i, ''))
        .filter(n => n && n.length > 1 && !n.includes('/'));
    }

    cache._ts            = Date.now();
    cache._healthy       = files.code.length > 0 || files.diagram.length > 0;
    cache.files          = files;
    cache.active_file    = getActiveTabName();
    cache.main_code_file = main;
    cache.known_files    = knownFiles;
    bridge.setAttribute('data-zapi', JSON.stringify(cache));
  }

  // ── RSC reference resolution ──────────────────────────────────────────────
  function resolveRef(id) {
    if (!store.rscRefs[id] || !store.rscPending[id]) return;
    let changed = false;
    store.rscPending[id].forEach(name => {
      if (mergeFile(name, store.rscRefs[id])) changed = true;
    });
    delete store.rscPending[id];
    if (changed) commitCache();
  }

  // ── Source 1: RSC stream hook (__next_f) ──────────────────────────────────
  function extractFromRSCChunk(text) {
    if (!text || typeof text !== 'string') return;

    // A: collect named row values — hex/decimal id + JSON string
    // Matches:  2f:"escaped content"
    const rowRe = /^([0-9a-f]+):"((?:[^"\\]|\\.)*)"\s*$/gmi;
    let rm;
    while ((rm = rowRe.exec(text)) !== null) {
      try {
        const id      = rm[1];
        const content = JSON.parse('"' + rm[2] + '"');
        if (content.length > 0) {
          store.rscRefs[id] = content;
          resolveRef(id);
        }
      } catch (_) {}
    }

    // B: find file objects — both field orderings supported
    const patterns = [
      /"name":"([^"\\]+)","content":"((?:[^"\\]|\\.)*)"/g,
      /"content":"((?:[^"\\]|\\.)*)","name":"([^"\\]+)"/g,
    ];

    let found = false;
    for (const re of patterns) {
      let fm;
      while ((fm = re.exec(text)) !== null) {
        try {
          const isNameFirst = re.source.startsWith('"name"');
          const name = isNameFirst ? fm[1] : fm[2];
          const raw  = isNameFirst ? fm[2] : fm[1];

          if (/^\$[0-9a-f]+$/i.test(raw)) {
            // RSC reference — resolve now or queue for later
            const id = raw.slice(1).toLowerCase();
            if (store.rscRefs[id]) {
              if (mergeFile(name, store.rscRefs[id])) found = true;
            } else {
              (store.rscPending[id] = store.rscPending[id] || []).push(name);
            }
          } else {
            const content = JSON.parse('"' + raw + '"');
            if (mergeFile(name, content)) found = true;
          }
        } catch (_) {}
      }
    }
    if (found) commitCache();
  }

  // ── Source 5: fetch interceptor — catches lazy RSC chunks ────────────────
  // Wokwi sometimes loads code files in a separate RSC fetch after page load.
  // We intercept responses with _rsc= in the URL or text/x-component content type.
  (function hookFetch() {
    const _fetch = window.fetch;
    window.fetch = function(...args) {
      return _fetch.apply(this, args).then(function(res) {
        try {
          const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url) || '';
          const ct  = res.headers.get('content-type') || '';
          // Catch RSC chunks and any other text response that may contain file data
        const isRSC  = url.includes('_rsc=') || ct.includes('text/x-component');
        const isText = ct.includes('text/') || ct.includes('application/json');
        if (isRSC || isText) {
          res.clone().text().then(extractFromRSCChunk).catch(() => {});
        }
        } catch (_) {}
        return res;
      });
    };
  })();

  // Hook __next_f — modify the existing array in place so Next.js references
  // (which may already hold a pointer to the array) continue to work.
  const nextFQueue = window.__next_f = window.__next_f || [];
  nextFQueue.forEach(item => {
    if (Array.isArray(item) && item[0] === 1) extractFromRSCChunk(item[1]);
  });
  const _origPush = nextFQueue.push.bind(nextFQueue);
  nextFQueue.push = function(...args) {
    args.forEach(item => {
      if (Array.isArray(item) && item[0] === 1) extractFromRSCChunk(item[1]);
    });
    return _origPush(...args);
  };

  // ── Source 2: Monaco editor — all open models ────────────────────────────
  // Wokwi uses Monaco (not CM6). monaco.editor.getModels() returns every
  // open file with its exact URI (vfs:filename.ino) and full content,
  // regardless of which tab is currently visible.
  function extractEditors() {
    // Monaco path (primary)
    if (window.monaco && window.monaco.editor) {
      const models = window.monaco.editor.getModels();
      let changed = false;
      for (const model of models) {
        const uriStr = model.uri.toString(); // e.g. "vfs:ServoOverdone.ino"
        const name   = uriStr.replace(/^[a-z][a-z0-9+.-]*:\/*?/i, ''); // strip scheme
        if (!name || name.length < 2) continue;
        const text = model.getValue();
        if (mergeFile(name, text)) changed = true;
      }
      if (changed) commitCache();
      return;
    }

    // Fallback: CM6 active editor only
    const activeTab = getActiveTabName();
    if (!activeTab) return;
    const editors = document.querySelectorAll('.cm-editor');
    let found = false;
    for (const el of editors) {
      if (el.closest('[hidden]') || el.closest('[style*="display: none"]')) continue;
      const key = Object.keys(el).find(k => k.startsWith('__cm'));
      if (!key) continue;
      const view = el[key];
      if (!view || !view.state || !view.state.doc) continue;
      const text = view.state.doc.toString();
      if (!text || text.length < 10) continue;
      const { type } = classifyFile(activeTab, text);
      const name = (type === 'diagram' && !activeTab.endsWith('.json'))
        ? 'diagram.json' : activeTab;
      if (mergeFile(name, text)) found = true;
      break;
    }
    if (found) commitCache();
  }

  // ── Source 3: localStorage fallback ──────────────────────────────────────
  // Only used when RSC + CM6 produced no diagram.
  // Skipped on non-project pages to avoid stale data from previous sessions.
  function extractLocalStorage() {
    const hasDiagram = Object.values(store.byName).some(e => e.type === 'diagram');
    if (hasDiagram) return;
    if (!location.pathname.includes('/projects/')) return; // project pages only
    try {
      for (const k of Object.keys(localStorage)) {
        const v = localStorage.getItem(k);
        if (v && v.includes('"parts"') && v.includes('"connections"')) {
          if (mergeFile('diagram.json', v)) commitCache();
          break;
        }
      }
    } catch (_) {}
  }

  // ── Source 4: Wokwi ZIP API — all project files, no dependencies ──────────
  async function extractFromAPI() {
    const m = location.pathname.match(/\/projects\/(\d+)/);
    if (!m) return;

    // Always try diagram.json first — fast, reliable
    const hasDiagram = Object.values(store.byName).some(e => e.type === 'diagram');
    // Only use API as fallback when Monaco hasn't provided a diagram yet.
    // The API returns the saved version — it will overwrite unsaved editor changes.
    if (!hasDiagram) {
      fetch(`https://wokwi.com/api/projects/${m[1]}/diagram.json`, { credentials: 'include' })
        .then(r => r.ok ? r.text() : null)
        .then(text => { if (text && mergeFile('diagram.json', text)) commitCache(); })
        .catch(() => {});
    }

    const hasCode = Object.values(store.byName).some(e => e.type === 'code');
    if (hasCode) return;

    try {
      const res = await fetch(`https://wokwi.com/api/projects/${m[1]}/zip`,
                              { credentials: 'include' });
      if (!res.ok) return;

      const buf   = await res.arrayBuffer();
      const view  = new DataView(buf);
      const bytes = new Uint8Array(buf);
      const dec   = new TextDecoder();

      let i = 0, changed = false;
      while (i < bytes.length - 30) {
        // Local file header signature: PK\x03\x04
        if (view.getUint32(i, true) !== 0x04034B50) { i++; continue; }

        const compression = view.getUint16(i + 8,  true);
        const compSize    = view.getUint32(i + 18, true);
        const uncompSize  = view.getUint32(i + 22, true);
        const nameLen     = view.getUint16(i + 26, true);
        const extraLen    = view.getUint16(i + 28, true);
        const name        = dec.decode(bytes.slice(i + 30, i + 30 + nameLen));
        const dataStart   = i + 30 + nameLen + extraLen;
        const data        = bytes.slice(dataStart, dataStart + compSize);
        i = dataStart + compSize;

        if (name === 'wokwi-project.txt') continue;
        if (uncompSize > 500_000) continue;

        let content;
        if (compression === 0) {
          // STORED — no compression
          content = dec.decode(data);
        } else if (compression === 8) {
          // DEFLATE — use browser-native DecompressionStream
          try {
            const ds     = new DecompressionStream('deflate-raw');
            const writer = ds.writable.getWriter();
            const reader = ds.readable.getReader();
            writer.write(data);
            writer.close();
            const chunks = [];
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            const out = new Uint8Array(uncompSize);
            let off = 0;
            for (const c of chunks) { out.set(c, off); off += c.length; }
            content = dec.decode(out);
          } catch (_) {}
        }

        if (content && mergeFile(name, content)) changed = true;
      }
      if (changed) commitCache();
    } catch (_) {}
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  extractEditors();
  extractLocalStorage();
  extractFromAPI();

  setTimeout(extractEditors, 500);
  setTimeout(() => { extractEditors(); extractFromAPI(); }, 2000);

  // Capture code files from each tab the user visits
  document.addEventListener('click', function(e) {
    if (e.target.closest('[class*="tabs_"]')) setTimeout(extractEditors, 150);
  }, true);

  function attachObserver() {
    new MutationObserver(function() {
      const hasCode = Object.values(store.byName).some(e => e.type === 'code');
      if (!cache._healthy || !hasCode) extractEditors();
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) {
    attachObserver();
  } else {
    document.addEventListener('DOMContentLoaded', attachObserver);
  }

  function clearStore() {
    store.byName     = {};
    store.rscRefs    = {};
    store.rscPending = {};
  }

  window.addEventListener('popstate', () => {
    clearStore();
    extractEditors();
    extractLocalStorage();
    extractFromAPI();
  });
  window.addEventListener('hashchange', () => {
    clearStore();
    extractEditors();
    extractLocalStorage();
    extractFromAPI();
  });
  window.addEventListener('message', function(e) {
    if (e.origin !== location.origin) return;
    if (e.data && e.data.__zapi === 'refresh') {
      extractEditors();
      extractLocalStorage();
      extractFromAPI();
    }
  });

})();
