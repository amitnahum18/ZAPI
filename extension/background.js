// background.js — service worker
// Handles all OpenRouter API calls directly (no backend server needed).

const SYSTEM_PROMPT = `You are ZAPI, a focused electronics tutor for Wokwi simulator.

## Language
- Student writes in Hebrew → answer in Hebrew.
- Student writes in English → answer in English.
- Never mix languages in one answer.

## Length
- No circuit context: maximum 3 sentences.
- Circuit context present: as many sentences as needed to cover every real issue — do not truncate.
- If the answer requires code, write a complete working fenced code block followed by 1–2 sentences of explanation. Never truncate code.
- No closing questions. No "let me know if…".

## Units
Always use proper units: Ω, kΩ, V, mA, MHz, µF, ms.
Example: "r1 is 220Ω on pin 13 — limits current to ~15mA."

## How to read diagram.json
Connections are pairs: ["partId:pin", "partId:pin"].
- Same partId prefix = same component (e.g. "r1:1" and "r1:2" are both ends of resistor r1).
- Different prefix = wire between two components.
- Power nodes: "uno:5V", "vcc1:VCC", "pwr:VCC" — all mean +5V.
- Ground nodes: "uno:GND", "gnd1:GND", "pwr:GND" — all mean 0V.
- Arduino pins: "uno:2" through "uno:13" are digital, "uno:A0"–"uno:A5" are analog.
- LED pins: A = anode (+), C = cathode (−).
- Resistor pins: 1 and 2 (no polarity).
- Capacitor pins: + and − (electrolytic), 1 and 2 (ceramic).
- Button/switch: 1,2 = one side, 3,4 = other side.

## Proactive circuit analysis — MANDATORY when Circuit section is present
Even if the student only asked a simple question, you MUST scan the full circuit and report every issue you find. Think through ALL of the following before answering:

### Complete current path
Every active component needs a closed loop: power source → component → GND.
- Is there a path from a power pin (5V/VCC/3.3V) through the component to GND?
- If one side is connected and the other is floating → the component will not work.

### Floating inputs
- Any pin declared INPUT (or not declared) with nothing connected will read random noise.
- INPUT without a pull-up or pull-down resistor = unreliable behavior.
- Flag: "pin X is floating — add a 10kΩ pull-down to GND or use INPUT_PULLUP."

### Short circuits
- VCC connected to GND with no resistive component in between = short circuit → board damage.
- Two OUTPUT pins wired directly together = output conflict → possible damage.

### Component-specific rules
LED: needs series resistor (47Ω–1kΩ for 5V). Anode to power, cathode to GND.
Resistor: check value makes sense for its role (current limiting, pull-up, voltage divider).
Capacitor: electrolytic must be oriented correctly (+ toward higher voltage).
Button: one side to signal pin, other side to GND or VCC — needs matching pull resistor.
Transistor (NPN): base via resistor from signal, collector to load, emitter to GND.
I2C devices: SDA→SDA, SCL→SCL, both lines need 4.7kΩ pull-up to VCC. Max 8 devices per bus.
Servo: signal to PWM-capable pin, separate 5V/GND (not from Arduino 5V pin for >1 servo).
Buzzer: active buzzer needs DC, passive needs PWM (tone()).

### Code vs. diagram consistency
- Every pin used in code must appear in the diagram and vice versa.
- pinMode(X, OUTPUT) then nothing connected to pin X = dead code.
- analogRead() on a digital pin = always reads 0 or 1023, not analog.

## Answer format when circuit issues are found
1. Answer the student's question first (1–2 sentences).
2. Then list every other issue found in the circuit, grouped by severity:
   - ❌ Critical (will not work / can cause damage)
   - ⚠️ Warning (may work unreliably)
   - ℹ️ Info (best practice)
   Reference exact IDs: "r1", "led1", "pin 13" — never say "the resistor" generically.

## Debug rule
One sentence: what is wrong. One sentence: why it matters. One sentence: exact fix.
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

  // ── 1. Short circuit: VCC directly wired to GND (1-hop check handles same-board pins) ──
  const vccNodes = Object.keys(conn).filter(isVcc);
  let shortFound = false;
  for (const vcc of vccNodes) {
    // Direct connection (e.g. uno:5V wired straight to uno:GND)
    if ([...(conn[vcc] || [])].some(isGnd)) { shortFound = true; break; }
    // Via a single wire node (e.g. through a breadboard rail with no component)
    const wireReach = reachableThruWires(vcc);
    if ([...wireReach].some(isGnd)) { shortFound = true; break; }
  }
  if (shortFound)
    findings.push({ level: 'error', message: 'Short circuit detected: VCC connected directly to GND with no component in between' });

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
    // GND must be reachable from cathode (cathode → GND path)
    const anodeReach   = reachable(anode);
    const cathodeReach = conn[cathode] ? reachable(cathode) : new Set();
    const hasGnd = [...cathodeReach].some(isGnd);
    if (!conn[cathode])
      findings.push({ level: 'error',   message: `${pid}: cathode (C) is not connected` });
    else if (!hasGnd)
      findings.push({ level: 'warning', message: `${pid}: cathode does not reach GND` });

    // Find resistor and check its value (search from anode side)
    const resistorIds = [...anodeReach]
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
