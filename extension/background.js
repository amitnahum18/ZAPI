// background.js — service worker
// Handles all OpenRouter API calls directly (no backend server needed).

const SYSTEM_PROMPT = `You are ZAPI, a focused electronics tutor for Wokwi simulator.

## Language
- Student writes in Hebrew → answer in Hebrew.
- Student writes in English → answer in English.
- Never mix languages in one answer.

## Length — STRICT
- Maximum 3 sentences per answer.
- Exception: if the answer requires code, write a complete, working fenced code block followed by 1–2 sentences of explanation. Never truncate code.
- No bullet lists. No headers. No "here are some facts". No closing questions.
- One idea per answer. If you want to say more, say the most important thing only.

## Units
Always use proper units: Ω, kΩ, V, mA, MHz, µF, ms.
Example: "נגד של 220Ω על פין 13 מגביל את הזרם ל-~15mA."

## Circuit Context Rule
If the message includes a Circuit section:
- Reference exact component IDs and pin numbers (e.g. "r1 on pin 13").
- Never ask for code or circuit — you already have it.
- Never give generic textbook answers.
If the question is a greeting or unrelated to the circuit, just answer naturally in 1-2 sentences.

## Debug rule
One sentence: what is wrong. One sentence: why it matters. Done.
Example: "פין 21 לא מוגדר כ-SDA בקוד — הספרייה LiquidCrystal_I2C צריכה Wire.begin(21, 22)."
`;

// ── Circuit validation (JS port) ──────────────────────────────────────────
function slimDiagram(diagStr) {
  try {
    const d = JSON.parse(diagStr);
    return JSON.stringify({
      parts:       (d.parts || []).map(p => ({ id: p.id, type: p.type, attrs: p.attrs })),
      connections: d.connections,
    }, null, 2);
  } catch (_) { return diagStr; }
}

function validateCircuit(sketch, diagStr) {
  const findings = [];
  if (!sketch && !diagStr) return findings;
  let diagram;
  try { diagram = JSON.parse(diagStr); }
  catch (_) {
    if (diagStr) findings.push({ level: 'error', message: 'diagram.json אינו JSON תקני' });
    return findings;
  }

  const parts = {};
  for (const p of (diagram.parts || [])) parts[p.id] = p;

  const conn = {};
  for (const c of (diagram.connections || [])) {
    if (c.length < 2) continue;
    const [a, b] = c;
    (conn[a] = conn[a] || new Set()).add(b);
    (conn[b] = conn[b] || new Set()).add(a);
  }

  function reachable(node, visited = new Set()) {
    if (visited.has(node) || visited.size > 300) return visited;
    visited.add(node);
    for (const n of (conn[node] || [])) reachable(n, visited);
    return visited;
  }

  // Pin usage in code vs diagram
  const pinRe = /(?:pinMode|digitalWrite|digitalRead|analogWrite|analogRead)\s*\(\s*(\d+)/gi;
  const codePins = new Set();
  let m;
  while ((m = pinRe.exec(sketch || '')) !== null) codePins.add(parseInt(m[1]));

  const pinToNodes = {};
  for (const node of Object.keys(conn)) {
    const nm = node.match(/^(\w+):(\w+)$/);
    if (nm) {
      const pn = parseInt(nm[2]);
      if (!isNaN(pn)) (pinToNodes[pn] = pinToNodes[pn] || []).push(node);
    }
  }
  const connPins = new Set(Object.keys(pinToNodes).map(Number));
  for (const pin of codePins) {
    if (!connPins.has(pin))
      findings.push({ level: 'error', message: `חסר כבל: פין ${pin} מופיע בקוד אך אין חיבור בשרטוט` });
  }

  // LED checks
  for (const [pid, part] of Object.entries(parts)) {
    if (!part.type?.toLowerCase().includes('led')) continue;
    const anode   = `${pid}:A`;
    const cathode = `${pid}:C`;
    const reach   = reachable(anode);
    const hasGnd  = [...reach].some(n => n.includes('GND') || n.includes('gnd'));
    if (!conn[cathode])
      findings.push({ level: 'error',   message: `${pid}: קתודה (C) לא מחוברת` });
    else if (!hasGnd)
      findings.push({ level: 'warning', message: `${pid}: קתודה לא מגיעה ל-GND` });
    const hasResistor = [...reach].some(n => {
      const id = n.split(':')[0];
      return parts[id]?.type?.toLowerCase().includes('resistor');
    });
    if (!hasResistor)
      findings.push({ level: 'error', message: `${pid}: אין נגד מגביל זרם — LED עלול להישרף` });
  }

  // delay() blocking
  const delays = [...(sketch || '').matchAll(/\bdelay\s*\(\s*(\d+)\s*\)/g)].map(mm => parseInt(mm[1]));
  const maxDelay = delays.length ? Math.max(...delays) : 0;
  if (maxDelay >= 5000)
    findings.push({ level: 'info', message: `delay(${maxDelay}ms) — לוגיקה מקבילית לא אפשרית` });

  if (!findings.length)
    findings.push({ level: 'info', message: 'לא נמצאו בעיות ברורות במעגל' });
  return findings;
}

// ── OpenRouter call ────────────────────────────────────────────────────────
async function callOpenRouter(apiKey, model, userMessage) {
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
      'HTTP-Referer':  'https://wokwi.com',
      'X-Title':       'ZAPI',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userMessage   },
      ],
      max_tokens: 1500,
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${resp.status}`);
  }
  const data    = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('תגובה ריקה מ-OpenRouter');
  return content.trim();
}

// ── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'ASK') return false;

  (async () => {
    const { question, circuitContext, apiKey, model } = msg;
    const parts = [`שאלה: ${question}`];

    if (circuitContext) {
      const files = {};
      for (const block of circuitContext.split('---')) {
        const b = block.trim();
        const match = b.match(/^\[([^\]]+)\]\n([\s\S]*)/);
        if (match) files[match[1]] = match[2].trim();
      }

      const diagram    = files['diagram.json'] || '';
      const sketchName = 'sketch.ino' in files
        ? 'sketch.ino'
        : Object.keys(files).find(n => n.endsWith('.ino')) || '';
      const sketch = files[sketchName] || '';

      const ctxParts = [];
      if (diagram) ctxParts.push(`[diagram.json]\n${slimDiagram(diagram)}`);
      for (const [name, content] of Object.entries(files)) {
        if (name !== 'diagram.json') ctxParts.push(`[${name}]\n${content}`);
      }
      if (ctxParts.length)
        parts.push('=== Circuit ===\n' + ctxParts.join('\n---\n') + '\n=== End ===');

      if (sketch && diagram) {
        const findings = validateCircuit(sketch, diagram);
        const critical = findings.filter(f => f.level !== 'info');
        if (critical.length) {
          const icons = { error: '❌', warning: '⚠️' };
          parts.push(
            '=== Circuit Validation ===\n' +
            critical.map(f => `${icons[f.level]} ${f.message}`).join('\n') +
            '\n=== End Validation ==='
          );
        }
      }
    }

    try {
      const answer = await callOpenRouter(apiKey, model, parts.join('\n\n'));
      sendResponse({ answer });
    } catch (e) {
      const msg = (e.name === 'TimeoutError' || e.name === 'AbortError')
        ? 'OpenRouter לא ענה בזמן — נסה שוב'
        : e.message;
      sendResponse({ error: msg });
    }
  })();

  return true; // keep message channel open for async response
});
