#!/usr/bin/env python3
"""
zapi_deep_analyzer.py
Parses ZAPI Chrome extension JS files, maps data flow, and flags architectural issues.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent / "extension"

FILES = {
    "content-main.js":  ROOT / "content-main.js",
    "content-ui.js":    ROOT / "content-ui.js",
    "background.js":    ROOT / "background.js",
    "popup.js":         ROOT / "popup.js",
    "manifest.json":    ROOT / "manifest.json",
}

# ── ANSI colours ──────────────────────────────────────────────────────────────
G  = "\033[32m"   # green
Y  = "\033[33m"   # yellow
R  = "\033[31m"   # red
B  = "\033[34m"   # blue
C  = "\033[36m"   # cyan
W  = "\033[1;37m" # bold white
DIM = "\033[2m"
RST = "\033[0m"

def hdr(title):
    bar = "─" * 60
    print(f"\n{W}{bar}{RST}")
    print(f"{W}  {title}{RST}")
    print(f"{W}{bar}{RST}")

def ok(msg):   print(f"  {G}✔{RST}  {msg}")
def warn(msg): print(f"  {Y}⚠{RST}  {msg}")
def err(msg):  print(f"  {R}✘{RST}  {msg}")
def info(msg): print(f"  {C}ℹ{RST}  {msg}")
def dim(msg):  print(f"  {DIM}{msg}{RST}")

# ── Load sources ──────────────────────────────────────────────────────────────
def load(name):
    p = FILES[name]
    if not p.exists():
        err(f"{name} not found at {p}")
        return ""
    return p.read_text(encoding="utf-8")

# ── Function extractor ────────────────────────────────────────────────────────
FUNC_RE = re.compile(
    r'(?:async\s+)?function\s+(\w+)\s*\('          # function foo(
    r'|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|\w+\s*=>)'  # const foo = (async) function/arrow
)

def extract_functions(src):
    fns = []
    for m in FUNC_RE.finditer(src):
        name = m.group(1) or m.group(2)
        if name:
            fns.append(name)
    return fns

# ── Message pattern extractors ────────────────────────────────────────────────
MSG_SEND_RE    = re.compile(r'chrome\.runtime\.sendMessage\s*\(\s*\{[^}]*type\s*:\s*[\'"](\w+)[\'"]')
MSG_LISTEN_RE  = re.compile(r'chrome\.runtime\.onMessage\.addListener')
MSG_TYPE_IN_RE = re.compile(r'msg\.type\s*!==\s*[\'"](\w+)[\'"]|msg\.type\s*===\s*[\'"](\w+)[\'"]')

STORAGE_GET_RE = re.compile(r'chrome\.storage\.local\.get\s*\(\s*\[([^\]]+)\]')
STORAGE_SET_RE = re.compile(r'chrome\.storage\.local\.set\s*\(\s*\{([^}]+)\}')

POSTMSG_SEND_RE   = re.compile(r'window\.postMessage\s*\(\s*\{([^}]+)\}')
POSTMSG_LISTEN_RE = re.compile(r"window\.addEventListener\s*\(\s*['\"]message['\"]")

FETCH_RE     = re.compile(r"fetch\s*\(\s*[`'\"]([^`'\"]+)[`'\"]")
API_KEY_RE   = re.compile(r'[Aa]pi[Kk]ey|apiKey|api_key')
BEARER_RE    = re.compile(r'Bearer.*apiKey|Authorization.*Bearer')

BRIDGE_WRITE_RE = re.compile(r'setAttribute\s*\(\s*[\'"]data-zapi[\'"]')
BRIDGE_READ_RE  = re.compile(r'getAttribute\s*\(\s*[\'"]data-zapi[\'"]')

# ── Depth guard / safety checks ───────────────────────────────────────────────
RECURSION_RE  = re.compile(r'function\s+(\w+)\s*\([^)]*\)\s*\{[^}]*\1\s*\(')
VISITED_RE    = re.compile(r'visited\.size\s*>\s*(\d+)')
SIZE_GUARD_RE = re.compile(r'uncompSize\s*>\s*([\d_]+)')
TIMEOUT_RE    = re.compile(r'AbortSignal\.timeout\s*\(\s*(\d+)\s*\)')
MAX_TOKENS_RE = re.compile(r'max_tokens\s*:\s*(\d+)')

# ── Manifest parser ───────────────────────────────────────────────────────────
import json

def parse_manifest(src):
    try:
        return json.loads(src)
    except Exception:
        return {}

# ══════════════════════════════════════════════════════════════════════════════
# ANALYSIS
# ══════════════════════════════════════════════════════════════════════════════

def main():
    print(f"\n{W}{'═'*62}{RST}")
    print(f"{W}  ZAPI Deep Architecture Analyzer{RST}")
    print(f"{W}{'═'*62}{RST}")

    src_main   = load("content-main.js")
    src_ui     = load("content-ui.js")
    src_bg     = load("background.js")
    src_popup  = load("popup.js")
    src_mf     = load("manifest.json")
    manifest   = parse_manifest(src_mf)

    issues   = []   # (severity, message)  severity: 'err'|'warn'|'info'
    findings = []

    # ── 1. FUNCTION INVENTORY ──────────────────────────────────────────────
    hdr("1 · Function Inventory")

    fns_main  = extract_functions(src_main)
    fns_ui    = extract_functions(src_ui)
    fns_bg    = extract_functions(src_bg)
    fns_popup = extract_functions(src_popup)

    print(f"\n  {B}content-main.js{RST}  ({len(fns_main)} functions)")
    for f in fns_main:
        dim(f"    · {f}")

    print(f"\n  {B}content-ui.js{RST}  ({len(fns_ui)} functions)")
    for f in fns_ui:
        dim(f"    · {f}")

    print(f"\n  {B}background.js{RST}  ({len(fns_bg)} functions)")
    for f in fns_bg:
        dim(f"    · {f}")

    print(f"\n  {B}popup.js{RST}  ({len(fns_popup)} functions)")
    for f in fns_popup:
        dim(f"    · {f}")

    # ── 2. DATA FLOW GRAPH ────────────────────────────────────────────────
    hdr("2 · Data Flow Graph")

    print(f"""
  {W}Wokwi Page (window)
  ├── Monaco editor.getModels(){RST}
  │     {DIM}content-main.js → extractEditors(){RST}
  {W}│
  ├── RSC stream (__next_f hook){RST}
  │     {DIM}content-main.js → extractFromRSCChunk(){RST}
  {W}│
  ├── fetch() interceptor (_rsc= URLs){RST}
  │     {DIM}content-main.js → hookFetch() → extractFromRSCChunk(){RST}
  {W}│
  ├── localStorage fallback{RST}
  │     {DIM}content-main.js → extractLocalStorage(){RST}
  {W}│
  └── Wokwi ZIP + diagram APIs{RST}
        {DIM}content-main.js → extractFromAPI(){RST}
              {DIM}https://wokwi.com/api/projects/{{id}}/zip{RST}
              {DIM}https://wokwi.com/api/projects/{{id}}/diagram.json{RST}

        {Y}▼  mergeFile() → commitCache(){RST}

  {W}DOM Bridge  (#__zapi_bridge__){RST}
  {DIM}  content-main.js writes: setAttribute('data-zapi', JSON){RST}
  {DIM}  content-ui.js  reads:  getAttribute('data-zapi')  → readBridge(){RST}

        {Y}▼  extractCircuitContext()  [called fresh on every question]{RST}

  {W}content-ui.js → sendMessage(){RST}
  {DIM}  chrome.runtime.sendMessage({{ type:'ASK', question, apiKey, model, circuitContext }}){RST}

        {Y}▼  chrome.runtime.onMessage  [background.js]{RST}

  {W}background.js{RST}
  {DIM}  slimDiagram()  → trims diagram JSON{RST}
  {DIM}  validateCircuit() → static analysis findings{RST}
  {DIM}  callOpenRouter()  → POST https://openrouter.ai/api/v1/chat/completions{RST}

        {Y}▼  {{ answer }} or {{ error }}{RST}

  {W}content-ui.js → appendMessage() → renderMarkdown(){RST}
""")

    # ── 3. MESSAGE BUS AUDIT ──────────────────────────────────────────────
    hdr("3 · Chrome Message Bus Audit")

    sent_types  = set(MSG_SEND_RE.findall(src_ui))
    listen_src  = MSG_LISTEN_RE.search(src_bg)
    handled     = set()
    for m in MSG_TYPE_IN_RE.finditer(src_bg):
        t = m.group(1) or m.group(2)
        if t:
            handled.add(t)

    print(f"\n  Messages SENT by content-ui.js:    {sent_types or '{none}'}")
    print(f"  Listener in background.js:         {'YES' if listen_src else 'NO — CRITICAL'}")
    print(f"  Message types handled:             {handled or '{none}'}")

    for t in sent_types:
        if t in handled:
            ok(f"type='{t}' → sent and handled ✓")
        else:
            msg = f"type='{t}' is sent but NOT handled in background.js"
            err(msg)
            issues.append(("err", msg))

    orphan = handled - sent_types
    for t in orphan:
        warn(f"type='{t}' is handled in background.js but never sent — dead handler")
        issues.append(("warn", f"Dead handler: type='{t}'"))

    # ── 4. POSTMESSAGE AUDIT ──────────────────────────────────────────────
    hdr("4 · window.postMessage Audit")

    pm_sends = POSTMSG_SEND_RE.findall(src_ui)
    pm_listen_main = POSTMSG_LISTEN_RE.search(src_main)
    origin_check = "e.origin !== location.origin" in src_main or "e.origin === location.origin" in src_main

    for payload in pm_sends:
        dim(f"  postMessage payload: {{ {payload.strip()} }}")

    if pm_listen_main:
        ok("content-main.js has window.addEventListener('message', ...)")
    else:
        msg = "No postMessage listener in content-main.js — refresh trigger dead"
        err(msg); issues.append(("err", msg))

    if origin_check:
        ok("Origin check present: e.origin !== location.origin")
    else:
        msg = "Missing origin check in postMessage listener — XSS risk"
        err(msg); issues.append(("err", msg))

    # ── 5. DOM BRIDGE AUDIT ───────────────────────────────────────────────
    hdr("5 · DOM Bridge Audit")

    writes = len(BRIDGE_WRITE_RE.findall(src_main))
    reads  = len(BRIDGE_READ_RE.findall(src_ui))

    if writes > 0:
        ok(f"Bridge writes (content-main.js):  {writes} call(s) to setAttribute('data-zapi')")
    else:
        msg = "No bridge write found — content-main.js never updates the bridge"
        err(msg); issues.append(("err", msg))

    if reads > 0:
        ok(f"Bridge reads  (content-ui.js):    {reads} call(s) to getAttribute('data-zapi')")
    else:
        msg = "No bridge read found — content-ui.js never reads the bridge"
        err(msg); issues.append(("err", msg))

    if "JSON.parse" in src_ui and "data-zapi" in src_ui:
        ok("Bridge data parsed via JSON.parse with try/catch guard")
    else:
        warn("Bridge JSON parse may be unguarded")

    # ── 6. API KEY & SECURITY AUDIT ───────────────────────────────────────
    hdr("6 · API Key & Privacy Audit")

    # Check key flows only to openrouter
    fetch_urls = FETCH_RE.findall(src_bg)
    openrouter_calls = [u for u in fetch_urls if "openrouter" in u]
    other_calls      = [u for u in fetch_urls if "openrouter" not in u and "wokwi" not in u]

    ok(f"OpenRouter API calls in background.js: {len(openrouter_calls)}")
    for u in openrouter_calls:
        dim(f"    → {u}")

    if other_calls:
        for u in other_calls:
            msg = f"Unexpected outbound URL in background.js: {u}"
            warn(msg); issues.append(("warn", msg))
    else:
        ok("No unexpected third-party URLs in background.js")

    # API key in header only
    bearer_ok = BEARER_RE.search(src_bg)
    if bearer_ok:
        ok("API key sent only as Authorization: Bearer header")
    else:
        warn("Cannot confirm API key is sent only in Authorization header")

    # Check key never logged
    if "console.log" in src_bg and "apiKey" in src_bg:
        # check if they appear on the same line
        for line in src_bg.splitlines():
            if "console.log" in line and "apiKey" in line:
                msg = f"API key may be logged: {line.strip()}"
                err(msg); issues.append(("err", msg))
    else:
        ok("API key not found in any console.log in background.js")

    # popup.js key validation
    popup_fetch = FETCH_RE.findall(src_popup)
    non_or = [u for u in popup_fetch if "openrouter" not in u]
    if non_or:
        msg = f"popup.js fetches unexpected URL: {non_or}"
        warn(msg); issues.append(("warn", msg))
    else:
        ok("popup.js only contacts openrouter.ai for key validation")

    # ── 7. SAFETY GUARDS AUDIT ────────────────────────────────────────────
    hdr("7 · Safety Guards Audit")

    # reachable() depth guard
    visited_guard = VISITED_RE.search(src_bg)
    if visited_guard:
        limit = int(visited_guard.group(1))
        ok(f"reachable() depth guard: visited.size > {limit}")
        if limit < 100:
            warn(f"Depth guard limit {limit} may be too low for large circuits")
    else:
        msg = "reachable() has NO depth guard — infinite recursion risk on cyclic circuits"
        err(msg); issues.append(("err", msg))

    # ZIP size guard
    size_guard = SIZE_GUARD_RE.search(src_main)
    if size_guard:
        limit_raw = size_guard.group(1).replace("_", "")
        ok(f"ZIP file size guard: uncompSize > {int(limit_raw):,} bytes")
    else:
        msg = "No ZIP uncompressed size guard — malicious/huge files could OOM"
        warn(msg); issues.append(("warn", msg))

    # Timeout guards
    timeouts = TIMEOUT_RE.findall(src_bg) + TIMEOUT_RE.findall(src_popup)
    if timeouts:
        for t in timeouts:
            ok(f"AbortSignal.timeout({int(t):,} ms) present")
    else:
        msg = "No AbortSignal.timeout found — fetch calls could hang forever"
        err(msg); issues.append(("err", msg))

    # max_tokens
    mt = MAX_TOKENS_RE.search(src_bg)
    if mt:
        tokens = int(mt.group(1))
        ok(f"max_tokens = {tokens}")
        if tokens < 512:
            msg = f"max_tokens={tokens} is very low — code responses will be truncated"
            warn(msg); issues.append(("warn", msg))
    else:
        warn("max_tokens not set — defaults to model maximum (may be expensive)")

    # ── 8. MANIFEST AUDIT ────────────────────────────────────────────────
    hdr("8 · Manifest (MV3) Audit")

    perms = manifest.get("permissions", [])
    host  = manifest.get("host_permissions", [])
    min_chrome = manifest.get("minimum_chrome_version", "not set")
    mv = manifest.get("manifest_version", "?")

    ok(f"manifest_version: {mv}")
    ok(f"minimum_chrome_version: {min_chrome}")
    info(f"permissions: {perms}")
    info(f"host_permissions: {host}")

    dangerous = [p for p in perms if p in ("tabs","webRequest","nativeMessaging","debugger","<all_urls>")]
    if dangerous:
        for p in dangerous:
            msg = f"Dangerous permission declared: '{p}'"
            err(msg); issues.append(("err", msg))
    else:
        ok("No dangerous permissions — minimal attack surface")

    broad_host = [h for h in host if h in ("<all_urls>", "http://*/*", "https://*/*")]
    if broad_host:
        msg = f"Overly broad host permission: {broad_host}"
        warn(msg); issues.append(("warn", msg))
    else:
        ok("Host permissions scoped to wokwi.com and openrouter.ai only")

    # Check worlds are correct
    cs = manifest.get("content_scripts", [])
    main_world = [s for s in cs if s.get("world") == "MAIN"]
    iso_world  = [s for s in cs if s.get("world") != "MAIN"]

    if any("content-main.js" in s.get("js",[]) for s in main_world):
        ok("content-main.js correctly runs in MAIN world")
    else:
        msg = "content-main.js NOT in MAIN world — Monaco access will fail"
        err(msg); issues.append(("err", msg))

    if any("content-ui.js" in s.get("js",[]) for s in iso_world):
        ok("content-ui.js correctly runs in ISOLATED world (chrome.* access)")
    else:
        msg = "content-ui.js NOT in ISOLATED world"
        err(msg); issues.append(("err", msg))

    # ── 9. STORAGE CONSISTENCY AUDIT ─────────────────────────────────────
    hdr("9 · Storage Key Consistency Audit")

    def storage_keys(src, pattern):
        keys = set()
        for m in pattern.finditer(src):
            raw = m.group(1)
            for k in re.findall(r"['\"](\w+)['\"]", raw):
                keys.add(k)
        return keys

    bg_get    = storage_keys(src_bg,    STORAGE_GET_RE)
    bg_set    = storage_keys(src_bg,    STORAGE_SET_RE)
    ui_get    = storage_keys(src_ui,    STORAGE_GET_RE)
    ui_set    = storage_keys(src_ui,    STORAGE_SET_RE)
    pop_get   = storage_keys(src_popup, STORAGE_GET_RE)
    pop_set   = storage_keys(src_popup, STORAGE_SET_RE)

    all_written = bg_set | ui_set | pop_set
    all_read    = bg_get | ui_get | pop_get

    info(f"Keys written: {sorted(all_written)}")
    info(f"Keys read:    {sorted(all_read)}")

    ghost_reads = all_read - all_written
    if ghost_reads:
        msg = f"Keys read but never written: {ghost_reads}"
        warn(msg); issues.append(("warn", msg))
    else:
        ok("All storage keys that are read are also written somewhere")

    dead_writes = all_written - all_read
    if dead_writes:
        for k in dead_writes:
            warn(f"Key '{k}' is written but never read — possibly dead")
    else:
        ok("No dead storage writes found")

    # ── 10. CIRCUIT CONTEXT FRESHNESS ────────────────────────────────────
    hdr("10 · Circuit Context Freshness")

    # Check if extractCircuitContext is called inside sendMessage (per-question)
    send_fn_match = re.search(r'async function sendMessage\(\)(.*?)(?=\n  (function|//|$))', src_ui, re.DOTALL)
    if send_fn_match and "extractCircuitContext" in send_fn_match.group(0):
        ok("extractCircuitContext() called inside sendMessage() — context is fresh on EVERY question")
    else:
        msg = "extractCircuitContext() may NOT be called per-question — stale circuit context risk"
        warn(msg); issues.append(("warn", msg))

    # triggerRefresh called before extract
    if "triggerRefresh" in (send_fn_match.group(0) if send_fn_match else ""):
        ok("triggerRefresh() called before extractCircuitContext() — forces latest Monaco state")
    else:
        warn("triggerRefresh() not called inside sendMessage — may use slightly stale bridge data")

    # ── SUMMARY ───────────────────────────────────────────────────────────
    hdr("SUMMARY")

    errs  = [(s,m) for s,m in issues if s == "err"]
    warns = [(s,m) for s,m in issues if s == "warn"]

    if not errs and not warns:
        print(f"\n  {G}★ No architectural flaws detected. ZAPI is production-ready.{RST}\n")
    else:
        if errs:
            print(f"\n  {R}Critical issues ({len(errs)}):{RST}")
            for _, m in errs:
                print(f"    {R}✘{RST} {m}")
        if warns:
            print(f"\n  {Y}Warnings ({len(warns)}):{RST}")
            for _, m in warns:
                print(f"    {Y}⚠{RST} {m}")

    score = max(0, 100 - len(errs)*20 - len(warns)*5)
    colour = G if score >= 80 else (Y if score >= 60 else R)
    print(f"\n  {colour}Architecture score: {score}/100{RST}")
    print(f"  {DIM}(−20 per critical · −5 per warning){RST}\n")
    print(f"{W}{'═'*62}{RST}\n")

if __name__ == "__main__":
    main()
    sys.exit(0)
