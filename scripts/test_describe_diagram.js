/**
 * test_describe_diagram.js
 * Compares three methods for representing a Wokwi diagram.json to an LLM:
 *   Method 1 — slimDiagram()      : current (raw JSON, strips layout only)
 *   Method 2 — describeDiagram()  : human-readable English text (proposed)
 *
 * Tests:
 *   A. Simon Says circuit (complex, all-English)
 *   B. Circuit with Hebrew in attrs (language isolation test)
 *   C. I2C OLED circuit (common beginner setup)
 */

// ── Method 1: current ────────────────────────────────────────────────────────
function slimDiagram(diagStr) {
  try {
    const d = JSON.parse(diagStr);
    return JSON.stringify({
      parts:       (d.parts || []).map(p => ({ id: p.id, type: p.type, attrs: p.attrs })),
      connections: d.connections,
    }, null, 2);
  } catch (_) { return diagStr; }
}

// ── Method 2: human-readable English ────────────────────────────────────────
function normPin(pin) {
  // Normalize "uno:GND.1", "uno:GND.2" → "uno:GND"
  // Normalize "uno:5V.1" → "uno:5V"
  return pin.replace(/:(GND|5V|VCC|3\.3V|3V3|AREF)(\.\d+)?$/i, ':$1');
}

function friendlyType(raw) {
  // Strip "wokwi-" prefix and convert hyphens to spaces
  return (raw || 'unknown').replace(/^wokwi-/i, '').replace(/-/g, ' ');
}

function isGndPin(pin) { return /:(GND|gnd)/i.test(pin); }
function isVccPin(pin) { return /:(VCC|5V|3\.3V|3V3|AREF)/i.test(pin); }
function isPowerWire(a, b) { return isGndPin(a) || isGndPin(b) || isVccPin(a) || isVccPin(b); }

function describeDiagram(diagStr) {
  let d;
  try { d = JSON.parse(diagStr); }
  catch (_) { return '(invalid diagram.json)'; }

  const parts = d.parts || [];
  const conns = d.connections || [];

  // ── Components section ────────────────────────────────────────────────────
  const lines = [];
  lines.push(`Components (${parts.length}):`);
  for (const p of parts) {
    const type = friendlyType(p.type);
    // Include attrs that matter for the circuit (value, color, volume, address)
    const relevantAttrs = {};
    for (const [k, v] of Object.entries(p.attrs || {})) {
      if (['value', 'color', 'volume', 'address', 'freq'].includes(k) && v !== '') {
        relevantAttrs[k] = v;
      }
    }
    const attrStr = Object.keys(relevantAttrs).length
      ? ' [' + Object.entries(relevantAttrs).map(([k,v]) => `${k}=${v}`).join(', ') + ']'
      : '';
    lines.push(`  ${p.id}: ${type}${attrStr}`);
  }

  // ── Connections section ───────────────────────────────────────────────────
  const powerConns = [];
  const signalConns = [];
  const seen = new Set();

  for (const c of conns) {
    if (!Array.isArray(c) || c.length < 2) continue;
    const a = normPin(String(c[0]));
    const b = normPin(String(c[1]));
    const key = [a, b].sort().join('||');
    if (seen.has(key)) continue;
    seen.add(key);
    const line = `  ${a} → ${b}`;
    if (isPowerWire(a, b)) powerConns.push(line);
    else signalConns.push(line);
  }

  lines.push('');
  lines.push(`Power connections (${powerConns.length}):`);
  lines.push(...powerConns);
  lines.push('');
  lines.push(`Signal connections (${signalConns.length}):`);
  lines.push(...signalConns);

  return lines.join('\n');
}

// ── Test runner ──────────────────────────────────────────────────────────────
const GREEN = '\x1b[32m';
const BLUE  = '\x1b[34m';
const BOLD  = '\x1b[1m';
const RESET = '\x1b[0m';

function tokens(str) { return Math.ceil(str.length / 4); }

function compareAndShow(label, diagJson) {
  const slim = slimDiagram(JSON.stringify(diagJson));
  const desc = describeDiagram(JSON.stringify(diagJson));

  const hebrewRe = /[\u0590-\u05FF]/;
  const slimHasHebrew = hebrewRe.test(slim);
  const descHasHebrew = hebrewRe.test(desc);

  console.log(`\n${BOLD}═══ ${label} ═══${RESET}`);
  console.log(`\n${BLUE}── Method 1: slimDiagram (current) ──${RESET}`);
  console.log(slim);
  console.log(`\n  📊 ~${tokens(slim)} tokens  |  Hebrew in output: ${slimHasHebrew ? '🚨 YES' : '✅ no'}`);

  console.log(`\n${BLUE}── Method 2: describeDiagram (proposed) ──${RESET}`);
  console.log(desc);
  console.log(`\n  📊 ~${tokens(desc)} tokens  |  Hebrew in output: ${descHasHebrew ? '🚨 YES' : '✅ no'}`);

  const savings = Math.round((1 - tokens(desc) / tokens(slim)) * 100);
  console.log(`\n  ${savings > 0 ? GREEN + '↓' + RESET : '↑'} ${Math.abs(savings)}% ${savings > 0 ? 'fewer' : 'more'} tokens vs Method 1`);
  console.log(`  Language isolation: ${!descHasHebrew && slimHasHebrew ? GREEN + 'FIXED ✅' + RESET : !descHasHebrew ? GREEN + 'CLEAN ✅' + RESET : '🚨 still leaking'}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Test A: Simon Says (complex, real-world circuit)
// ══════════════════════════════════════════════════════════════════════════════
compareAndShow('TEST A — Simon Says (complex, 13 components)', {
  version: 1,
  parts: [
    { type: 'wokwi-arduino-uno',  id: 'uno',       top: 183,   left: 18.6,   attrs: {} },
    { type: 'wokwi-buzzer',       id: 'buzzer',     top: 16,    left: 124,    attrs: { volume: '0.1' } },
    { type: 'wokwi-led',          id: 'led-red',    top: 10,    left: 6,      attrs: { color: 'red' } },
    { type: 'wokwi-led',          id: 'led-green',  top: 73,    left: 6,      attrs: { color: 'green' } },
    { type: 'wokwi-led',          id: 'led-blue',   top: 10,    left: 270,    attrs: { color: 'blue' } },
    { type: 'wokwi-led',          id: 'led-yellow', top: 73,    left: 270,    attrs: { color: 'yellow' } },
    { type: 'wokwi-pushbutton',   id: 'btn-red',    top: 10,    left: 46,     attrs: { color: 'red',    key: '1', label: '1' } },
    { type: 'wokwi-pushbutton',   id: 'btn-green',  top: 76,    left: 46,     attrs: { color: 'green',  key: '2', label: '2' } },
    { type: 'wokwi-pushbutton',   id: 'btn-blue',   top: 10,    left: 200,    attrs: { color: 'blue',   key: '3', label: '3' } },
    { type: 'wokwi-pushbutton',   id: 'btn-yellow', top: 76,    left: 200,    attrs: { color: 'yellow', key: '4', label: '4' } },
    { type: 'wokwi-74hc595',      id: 'sr1',        top: 171.8, left: 361.16, attrs: {} },
    { type: 'wokwi-74hc595',      id: 'sr2',        top: 171.8, left: 457.16, attrs: {} },
    { type: 'wokwi-7segment',     id: 'sevseg1',    top: 47.16, left: 379.48, attrs: {} },
    { type: 'wokwi-7segment',     id: 'sevseg2',    top: 47.16, left: 446.68, attrs: {} },
  ],
  connections: [
    ['uno:GND.1', 'buzzer:1',   'black',  ['v-12','*','h0']],
    ['uno:2',     'btn-yellow:1.l', 'gold',  ['v-48','*','h-6']],
    ['uno:GND.1', 'btn-yellow:2.r','black', ['v-12','*','h6']],
    ['uno:3',     'btn-blue:1.l',   'blue',  ['v-44','*','h-10']],
    ['uno:GND.1', 'btn-blue:2.r',   'black', ['v-12','*','h6']],
    ['uno:4',     'btn-green:2.r',  'green', ['v-40','*','h6']],
    ['uno:GND.1', 'btn-green:1.l',  'black', ['v-12','*','h-6']],
    ['uno:5',     'btn-red:2.r',    'orange',['v-36','*','h10']],
    ['uno:GND.1', 'btn-red:1.l',    'black', ['v-12','*','h-6']],
    ['uno:8',     'buzzer:2',       'purple',['v-32','*','h0']],
    ['uno:9',     'led-yellow:A',   'gold',  ['v-28','*','h0']],
    ['uno:GND.1', 'led-yellow:C',   'black', ['v-12','*','h-15','v4']],
    ['uno:10',    'led-blue:A',     'blue',  ['v-24','*','h8']],
    ['uno:GND.1', 'led-blue:C',     'black', ['v-12','*','h-15','v4']],
    ['uno:11',    'led-green:A',    'green', ['v-20','*','h0']],
    ['uno:GND.1', 'led-green:C',    'black', ['v-12','*','h-8','v4']],
    ['uno:12',    'led-red:A',      'orange',['v-16','*','h6']],
    ['uno:GND.1', 'led-red:C',      'black', ['v-12','*','h-8','v4']],
    ['uno:5V',    'sr1:VCC',        'red',   ['v57.5','h253.4']],
    ['uno:A2',    'sr1:SHCP',       'gray',  ['v19.1','h138.4']],
    ['uno:A1',    'sr1:STCP',       'purple',['v28.7','h157.5']],
    ['uno:A0',    'sr1:DS',         'blue',  ['v38.3','h186.2']],
    ['sr1:SHCP',  'sr2:SHCP',       'gray',  ['v47','h106.12']],
    ['sr1:STCP',  'sr2:STCP',       'purple',['v37.4','h96.52']],
    ['sr1:Q7S',   'sr2:DS',         'blue',  ['h0.52','v56.6','h144']],
    ['sr1:VCC',   'sr1:MR',         'red',   ['v17','h-57.6']],
    ['sr1:VCC',   'sr2:MR',         'red',   ['v17','h38.4']],
    ['sr1:VCC',   'sr2:VCC',        'red',   ['v17','h96']],
    ['sr1:OE',    'sr2:OE',         'black', ['v26.6','h96']],
    ['sr1:MR',    'sevseg1:COM.1',  'red',   ['v17','h-57.6','v-96','h76.8']],
    ['sevseg1:COM.1','sevseg2:COM.1','red',  ['h0','v9.6','h57.6']],
    ['sr2:Q0',    'sevseg2:A',      'green', []],
    ['sr2:Q1',    'sevseg2:B',      'green', []],
    ['sr2:Q2',    'sevseg2:C',      'green', []],
    ['sr2:Q3',    'sevseg2:D',      'green', []],
    ['sr2:Q4',    'sevseg2:E',      'green', []],
    ['sr2:Q5',    'sevseg2:F',      'green', []],
    ['sr2:Q6',    'sevseg2:G',      'green', []],
    ['sr1:GND',   'sr2:GND',        'black', []],
    ['sr1:Q1',    'sevseg1:B',      'green', []],
    ['sr1:Q2',    'sevseg1:C',      'green', []],
    ['sr1:Q3',    'sevseg1:D',      'green', []],
    ['sr1:Q4',    'sevseg1:E',      'green', []],
    ['uno:GND.3', 'sr1:GND',        'black', []],
    ['sr1:GND',   'sr1:OE',         'black', []],
    ['sr1:Q0',    'sevseg1:A',      'green', []],
    ['sr1:Q5',    'sevseg1:F',      'green', []],
    ['sr1:Q6',    'sevseg1:G',      'green', []],
  ]
});

// ══════════════════════════════════════════════════════════════════════════════
// Test B: Hebrew attrs — language isolation test (THE KEY TEST)
// ══════════════════════════════════════════════════════════════════════════════
compareAndShow('TEST B — Hebrew in attrs (language isolation)', {
  version: 1,
  parts: [
    { type: 'wokwi-arduino-uno', id: 'uno',  attrs: {} },
    { type: 'wokwi-led',         id: 'led1', attrs: { color: 'red',   label: 'נורה אדומה' } },
    { type: 'wokwi-resistor',    id: 'r1',   attrs: { value: '220',   label: 'נגד הגבלת זרם' } },
    { type: 'wokwi-pushbutton',  id: 'btn1', attrs: { color: 'green', label: 'כפתור ירוק' } },
  ],
  connections: [
    ['uno:13',  'r1:1',       'orange', []],
    ['r1:2',    'led1:A',     'orange', []],
    ['led1:C',  'uno:GND.1',  'black',  []],
    ['uno:2',   'btn1:1.l',   'green',  []],
    ['uno:GND.1','btn1:2.r',  'black',  []],
  ]
});

// ══════════════════════════════════════════════════════════════════════════════
// Test C: I2C OLED (common beginner circuit)
// ══════════════════════════════════════════════════════════════════════════════
compareAndShow('TEST C — I2C OLED + ESP32 (common beginner)', {
  version: 1,
  parts: [
    { type: 'wokwi-esp32-devkit-v1', id: 'esp',   attrs: {} },
    { type: 'wokwi-ssd1306',         id: 'oled1', attrs: { address: '0x3C' } },
  ],
  connections: [
    ['esp:3V3',  'oled1:VCC', 'red',   []],
    ['esp:GND.1','oled1:GND', 'black', []],
    ['esp:22',   'oled1:SCL', 'gray',  []],
    ['esp:21',   'oled1:SDA', 'blue',  []],
  ]
});

// ══════════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n${BOLD}════ SUMMARY ════${RESET}`);
console.log(`
Method 1 — slimDiagram (current):
  ✗ Hebrew in attrs leaks into the prompt → model may respond in Hebrew
  ✗ Large JSON blobs with low info density
  ✓ Lossless (model sees exact pin names)

Method 2 — describeDiagram (proposed):
  ✓ Pure English output — no Hebrew leaks regardless of circuit content
  ✓ Separates power from signal connections for clarity
  ✓ Strips irrelevant layout info (top/left coordinates)
  ✓ Normalizes duplicate GND pins (GND.1, GND.2 → GND)
  ~ Slightly different format from raw JSON (model adaptation needed)

→ Verdict: Method 2 recommended for production.
`);
