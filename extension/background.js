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
    if (diagStr) findings.push({ level: 'error', message: 'diagram.json is not valid JSON' });
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

  // Returns all nodes reachable via wires (does NOT cross through resistive components)
  function reachableThruWires(node, visited = new Set()) {
    if (visited.has(node) || visited.size > 300) return visited;
    visited.add(node);
    for (const n of (conn[node] || [])) {
      // Don't cross from one pin of a resistive part to its other pin
      const nid = n.split(':')[0];
      const sid = node.split(':')[0];
      if (nid === sid) continue; // same component — skip (would mean crossing through it)
      reachableThruWires(n, visited);
    }
    return visited;
  }

  // Returns all nodes reachable via any path (crosses through components)
  function reachable(node, visited = new Set()) {
    if (visited.has(node) || visited.size > 300) return visited;
    visited.add(node);
    for (const n of (conn[node] || [])) reachable(n, visited);
    return visited;
  }

  function isGnd(n) { return /GND|gnd/.test(n); }
  function isVcc(n) { return /VCC|5V|3\.3V|3V3/i.test(n); }

  // ── 1. Short circuit: VCC reachable to GND without crossing any component ──
  const vccNodes = Object.keys(conn).filter(isVcc);
  for (const vcc of vccNodes) {
    const wireReach = reachableThruWires(vcc);
    if ([...wireReach].some(isGnd)) {
      findings.push({ level: 'error', message: `Short circuit detected: VCC connected directly to GND with no component in between` });
      break;
    }
  }

  // ── 2. Floating components (parts with no connections at all) ─────────────
  const connectedIds = new Set(Object.keys(conn).map(n => n.split(':')[0]));
  for (const [pid, part] of Object.entries(parts)) {
    // Skip power/ground rails and boards (they may have implicit connections)
    if (/power|ground|gnd|vcc|pwr|board|nano|uno|mega|esp/i.test(part.type || '')) continue;
    if (!connectedIds.has(pid))
      findings.push({ level: 'warning', message: `${pid} (${part.type || 'unknown'}) has no connections — floating component` });
  }

  // ── 3. Pin usage in code vs diagram ───────────────────────────────────────
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
      findings.push({ level: 'error', message: `Missing wire: pin ${pin} used in code but not connected in diagram` });
  }

  // ── 4. Output-output conflict ──────────────────────────────────────────────
  const outputPinRe = /pinMode\s*\(\s*(\d+)\s*,\s*OUTPUT\s*\)/gi;
  const outputPins = new Set();
  let om;
  while ((om = outputPinRe.exec(sketch || '')) !== null) outputPins.add(parseInt(om[1]));
  if (outputPins.size >= 2) {
    const outputNodes = [...outputPins].flatMap(p => pinToNodes[p] || []);
    for (let i = 0; i < outputNodes.length; i++) {
      for (let j = i + 1; j < outputNodes.length; j++) {
        if ((conn[outputNodes[i]] || new Set()).has(outputNodes[j])) {
          findings.push({ level: 'error', message: `Output-output conflict: ${outputNodes[i]} and ${outputNodes[j]} are directly connected — this can damage the board` });
        }
      }
    }
  }

  // ── 5. LED checks ──────────────────────────────────────────────────────────
  function parseOhms(val) {
    if (!val) return null;
    const s = String(val).trim().toLowerCase();
    const km = s.match(/^([\d.]+)\s*k$/);
    if (km) return parseFloat(km[1]) * 1000;
    const num = parseFloat(s);
    return isNaN(num) ? null : num;
  }

  for (const [pid, part] of Object.entries(parts)) {
    if (!part.type?.toLowerCase().includes('led')) continue;
    const anode   = `${pid}:A`;
    const cathode = `${pid}:C`;
    const reach   = reachable(anode);
    const hasGnd  = [...reach].some(isGnd);
    if (!conn[cathode])
      findings.push({ level: 'error',   message: `${pid}: cathode (C) is not connected` });
    else if (!hasGnd)
      findings.push({ level: 'warning', message: `${pid}: cathode does not reach GND` });

    // Find resistor and check its value
    const resistorIds = [...reach]
      .map(n => n.split(':')[0])
      .filter(id => parts[id]?.type?.toLowerCase().includes('resistor'));
    if (!resistorIds.length) {
      findings.push({ level: 'error', message: `${pid}: no current-limiting resistor — LED may burn out` });
    } else {
      for (const rid of resistorIds) {
        const ohms = parseOhms(parts[rid]?.attrs?.value);
        if (ohms !== null && ohms < 47)
          findings.push({ level: 'error', message: `${rid}: resistance ${ohms}Ω is too low for ${pid} — LED may burn out (min ~47Ω at 5V)` });
        else if (ohms !== null && ohms > 10000)
          findings.push({ level: 'warning', message: `${rid}: resistance ${ohms}Ω is very high — ${pid} may be too dim or not light at all` });
      }
    }
  }

  // ── 6. delay() blocking ───────────────────────────────────────────────────
  const delays = [...(sketch || '').matchAll(/\bdelay\s*\(\s*(\d+)\s*\)/g)].map(mm => parseInt(mm[1]));
  const maxDelay = delays.length ? Math.max(...delays) : 0;
  if (maxDelay >= 5000)
    findings.push({ level: 'info', message: `delay(${maxDelay}ms) detected — parallel logic is not possible` });

  if (!findings.length)
    findings.push({ level: 'info', message: 'No obvious circuit issues found' });
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
  if (!content) throw new Error('Empty response from OpenRouter');
  return { content: content.trim(), usage: data.usage || null };
}

// ── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'ASK') return false;

  (async () => {
    const { question, circuitContext, apiKey, model } = msg;
    const parts = [question];

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
      const { content, usage } = await callOpenRouter(apiKey, model, parts.join('\n\n'));
      sendResponse({ answer: content, usage });
    } catch (e) {
      const msg = (e.name === 'TimeoutError' || e.name === 'AbortError')
        ? 'OpenRouter did not respond in time — please try again'
        : e.message;
      sendResponse({ error: msg });
    }
  })();

  return true; // keep message channel open for async response
});
