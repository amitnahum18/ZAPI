// Circuit validation test suite

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

  function reachableThruWires(node, visited = new Set()) {
    if (visited.has(node) || visited.size > 300) return visited;
    visited.add(node);
    for (const n of (conn[node] || [])) {
      if (n.split(':')[0] === node.split(':')[0]) continue;
      reachableThruWires(n, visited);
    }
    return visited;
  }

  function reachable(node, visited = new Set()) {
    if (visited.has(node) || visited.size > 300) return visited;
    visited.add(node);
    for (const n of (conn[node] || [])) reachable(n, visited);
    return visited;
  }

  function isGnd(n) { return /GND|gnd/.test(n); }
  function isVcc(n) { return /VCC|5V|3\.3V|3V3/i.test(n); }

  // 1. Short circuit
  const vccNodes = Object.keys(conn).filter(isVcc);
  let shortFound = false;
  for (const vcc of vccNodes) {
    if ([...(conn[vcc] || [])].some(isGnd)) { shortFound = true; break; }
    const wireReach = reachableThruWires(vcc);
    if ([...wireReach].some(isGnd)) { shortFound = true; break; }
  }
  if (shortFound)
    findings.push({ level: 'error', message: 'Short circuit detected: VCC connected directly to GND with no component in between' });

  // 2. Floating components
  const connectedIds = new Set(Object.keys(conn).map(n => n.split(':')[0]));
  for (const [pid, part] of Object.entries(parts)) {
    if (/power|ground|gnd|vcc|pwr|board|nano|uno|mega|esp/i.test(part.type || '')) continue;
    if (!connectedIds.has(pid))
      findings.push({ level: 'warning', message: pid + ' (' + (part.type || 'unknown') + ') has no connections — floating component' });
  }

  // 3. Pin usage in code vs diagram
  const pinRe = /(?:pinMode|digitalWrite|digitalRead|analogWrite|analogRead)\s*\(\s*(\d+)/gi;
  const codePins = new Set();
  let m;
  while ((m = pinRe.exec(sketch || '')) !== null) codePins.add(parseInt(m[1]));
  const pinToNodes = {};
  for (const node of Object.keys(conn)) {
    const nm = node.match(/^(\w+):(\w+)$/);
    if (nm) { const pn = parseInt(nm[2]); if (!isNaN(pn)) (pinToNodes[pn] = pinToNodes[pn] || []).push(node); }
  }
  const connPins = new Set(Object.keys(pinToNodes).map(Number));
  for (const pin of codePins) {
    if (!connPins.has(pin))
      findings.push({ level: 'error', message: 'Missing wire: pin ' + pin + ' used in code but not connected in diagram' });
  }

  // 4. Output-output conflict
  const outputPinRe = /pinMode\s*\(\s*(\d+)\s*,\s*OUTPUT\s*\)/gi;
  const outputPins = new Set();
  let om;
  while ((om = outputPinRe.exec(sketch || '')) !== null) outputPins.add(parseInt(om[1]));
  if (outputPins.size >= 2) {
    const outputNodes = [...outputPins].flatMap(p => pinToNodes[p] || []);
    for (let i = 0; i < outputNodes.length; i++) {
      for (let j = i + 1; j < outputNodes.length; j++) {
        if ((conn[outputNodes[i]] || new Set()).has(outputNodes[j]))
          findings.push({ level: 'error', message: 'Output-output conflict: ' + outputNodes[i] + ' and ' + outputNodes[j] + ' are directly connected' });
      }
    }
  }

  // 5. LED checks
  function parseOhms(val) {
    if (!val) return null;
    const s = String(val).trim().toLowerCase();
    const km = s.match(/^([\d.]+)\s*k$/);
    if (km) return parseFloat(km[1]) * 1000;
    const num = parseFloat(s);
    return isNaN(num) ? null : num;
  }
  for (const [pid, part] of Object.entries(parts)) {
    if (!part.type || !part.type.toLowerCase().includes('led')) continue;
    const anode = pid + ':A', cathode = pid + ':C';
    const anodeReach  = reachable(anode);
    const cathodeReach = conn[cathode] ? reachable(cathode) : new Set();
    const hasGnd = [...cathodeReach].some(isGnd);
    if (!conn[cathode]) findings.push({ level: 'error', message: pid + ': cathode (C) is not connected' });
    else if (!hasGnd)   findings.push({ level: 'warning', message: pid + ': cathode does not reach GND' });
    const resistorIds = [...anodeReach].map(n => n.split(':')[0]).filter(id => parts[id] && parts[id].type && parts[id].type.toLowerCase().includes('resistor'));
    if (!resistorIds.length) {
      findings.push({ level: 'error', message: pid + ': no current-limiting resistor — LED may burn out' });
    } else {
      for (const rid of resistorIds) {
        const ohms = parseOhms(parts[rid] && parts[rid].attrs && parts[rid].attrs.value);
        if (ohms !== null && ohms < 47)
          findings.push({ level: 'error', message: rid + ': ' + ohms + ' is too low for ' + pid + ' (min ~47)' });
        else if (ohms !== null && ohms > 10000)
          findings.push({ level: 'warning', message: rid + ': ' + ohms + ' is very high — ' + pid + ' may be too dim' });
      }
    }
  }

  // 6. delay
  const delays = [...(sketch || '').matchAll(/\bdelay\s*\(\s*(\d+)\s*\)/g)].map(mm => parseInt(mm[1]));
  const maxDelay = delays.length ? Math.max(...delays) : 0;
  if (maxDelay >= 5000) findings.push({ level: 'info', message: 'delay(' + maxDelay + 'ms) detected' });

  if (!findings.length) findings.push({ level: 'info', message: 'No obvious circuit issues found' });
  return findings;
}

// ── Test runner ──────────────────────────────────────────────────────────────
const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const RESET = '\x1b[0m';
let passed = 0, failed = 0;

function test(name, sketch, diagram, expectContains) {
  const findings = validateCircuit(sketch, JSON.stringify(diagram));
  const msgs = findings.map(f => f.message);
  const missing = expectContains.filter(exp => !msgs.some(m => m.toLowerCase().includes(exp.toLowerCase())));
  if (missing.length === 0) {
    console.log(GREEN + 'PASS' + RESET + '  ' + name);
    passed++;
  } else {
    console.log(RED + 'FAIL' + RESET + '  ' + name);
    console.log('     Expected: ' + missing.join(', '));
    console.log('     Got:      ' + msgs.join(' | '));
    failed++;
  }
}

// ── Test cases ────────────────────────────────────────────────────────────────

test('LED cathode disconnected', '', {
  parts: [
    { id: 'led1', type: 'wokwi-led' },
    { id: 'r1',   type: 'wokwi-resistor', attrs: { value: '220' } },
    { id: 'uno',  type: 'wokwi-uno-r3' }
  ],
  connections: [['uno:13', 'r1:1'], ['r1:2', 'led1:A']]
}, ['cathode (C) is not connected']);

test('LED missing resistor', '', {
  parts: [
    { id: 'led1', type: 'wokwi-led' },
    { id: 'uno',  type: 'wokwi-uno-r3' }
  ],
  connections: [['uno:13', 'led1:A'], ['led1:C', 'uno:GND']]
}, ['no current-limiting resistor']);

test('Resistor 10 Ohm — too low (LED burns)', '', {
  parts: [
    { id: 'led1', type: 'wokwi-led' },
    { id: 'r1',   type: 'wokwi-resistor', attrs: { value: '10' } },
    { id: 'uno',  type: 'wokwi-uno-r3' }
  ],
  connections: [['uno:13', 'r1:1'], ['r1:2', 'led1:A'], ['led1:C', 'uno:GND']]
}, ['too low']);

test('Resistor 47k — too high (LED too dim)', '', {
  parts: [
    { id: 'led1', type: 'wokwi-led' },
    { id: 'r1',   type: 'wokwi-resistor', attrs: { value: '47k' } },
    { id: 'uno',  type: 'wokwi-uno-r3' }
  ],
  connections: [['uno:13', 'r1:1'], ['r1:2', 'led1:A'], ['led1:C', 'uno:GND']]
}, ['very high']);

test('Pin 9 used in code but no wire in diagram', 'void setup(){ pinMode(9, OUTPUT); digitalWrite(9, HIGH); }', {
  parts: [{ id: 'uno', type: 'wokwi-uno-r3' }],
  connections: []
}, ['pin 9']);

test('Short circuit: VCC wired directly to GND', '', {
  parts: [{ id: 'uno', type: 'wokwi-uno-r3' }],
  connections: [['uno:5V', 'uno:GND']]
}, ['short circuit']);

test('Floating button — no connections', '', {
  parts: [
    { id: 'btn1', type: 'wokwi-pushbutton' },
    { id: 'uno',  type: 'wokwi-uno-r3' }
  ],
  connections: []
}, ['floating']);

test('Output-output conflict: pin 5 and pin 6 shorted', 'void setup(){ pinMode(5, OUTPUT); pinMode(6, OUTPUT); }', {
  parts: [{ id: 'uno', type: 'wokwi-uno-r3' }],
  connections: [['uno:5', 'uno:6']]
}, ['output-output conflict']);

test('delay(8000ms) flagged', 'void loop(){ delay(8000); }', {
  parts: [{ id: 'uno', type: 'wokwi-uno-r3' }],
  connections: []
}, ['delay(8000ms)']);

test('Clean circuit — LED + 220 Ohm wired correctly', '', {
  parts: [
    { id: 'led1', type: 'wokwi-led' },
    { id: 'r1',   type: 'wokwi-resistor', attrs: { value: '220' } },
    { id: 'uno',  type: 'wokwi-uno-r3' }
  ],
  connections: [['uno:13', 'r1:1'], ['r1:2', 'led1:A'], ['led1:C', 'uno:GND']]
}, ['no obvious circuit issues']);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + (passed + failed) + ' tests  —  ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
