# ZAPI — AI Electronics Tutor for Wokwi

ZAPI is a Chrome extension that acts as an AI tutor inside the [Wokwi](https://wokwi.com) online electronics simulator.
It reads your live circuit (code files + `diagram.json`), validates connections, and answers questions in Hebrew or English — no server, no setup, no code pasting required.

---

## How it works

```
┌─────────────────────────────────────────────┐
│             Chrome Extension                │
│                                             │
│  content-main.js  (MAIN world)              │
│    └─ Monaco getModels() — all open files   │
│    └─ hooks __next_f (RSC stream)           │
│    └─ fetch interceptor (lazy chunks)       │
│    └─ ZIP API + diagram.json API            │
│    └─ writes to DOM bridge element          │
│                                             │
│  content-ui.js    (ISOLATED world)          │
│    └─ reads DOM bridge                      │
│    └─ renders draggable bubble + panel      │
│    └─ file toggle buttons (per file)        │
│    └─ sends message to background.js        │
│                                             │
│  background.js    (Service Worker)          │
│    └─ circuit validation (JS)               │
│    └─ builds LLM context                   │
│    └─ calls OpenRouter API directly         │
│                                             │
│  popup.html / popup.js                      │
│    └─ saves OpenRouter API key + model      │
│    └─ validates key against OpenRouter      │
└─────────────────────────────────────────────┘
                    │
                    ▼
         https://openrouter.ai/api/v1/chat/completions
```

### How circuit data is extracted

Wokwi uses **Monaco Editor** and **Next.js App Router** (RSC streaming).
`content-main.js` runs at `document_start` in the **MAIN world** and extracts files from multiple sources:

| Source | What it captures |
|--------|-----------------|
| `window.monaco.editor.getModels()` | All open files with exact filenames (primary) |
| `__next_f` RSC stream hook | Files streamed before editor renders |
| `fetch` interceptor | Lazy-loaded RSC chunks after page load |
| Wokwi ZIP API | All project files for public projects |
| Wokwi diagram API | `diagram.json` for public projects |

Files are written to a hidden DOM bridge element (`#__zapi_bridge__`).
`content-ui.js` runs in the **ISOLATED world** and reads from the bridge.

```
MAIN world              │  DOM (shared)             │  ISOLATED world
────────────────────────┼───────────────────────────┼────────────────────
content-main.js         │  #__zapi_bridge__          │  content-ui.js
Monaco + RSC + API ──►  │  data-zapi="{ files: {} }" │  ◄── readBridge()
```

---

## Requirements

- **Chrome 103+** (Manifest V3)
- An **[OpenRouter](https://openrouter.ai) API key** (free tier available)
- No Python, no server, no Docker

---

## Setup

### 1. Get an OpenRouter API key

Sign up at [openrouter.ai](https://openrouter.ai) — free tier is sufficient for testing.

### 2. Load the extension in Chrome

1. Download or clone this repo
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** → select the `extension/` folder
5. Click the ⚡ icon in the Chrome toolbar
6. Paste your OpenRouter key, choose a model, click **שמור והפעל**

### 3. Open a Wokwi project

Navigate to any project on [wokwi.com](https://wokwi.com).
The ⚡ bubble appears in the bottom-right corner.
Click it to open the chat panel and start asking questions about your circuit.

---

## File Structure

```
zapi/
├── README.md
└── extension/
    ├── manifest.json         # MV3 extension manifest
    ├── content-main.js       # MAIN world: multi-source data extraction
    ├── content-ui.js         # ISOLATED world: chat bubble UI + file toggles
    ├── background.js         # Service worker: validation + OpenRouter calls
    ├── popup.html            # Settings popup
    ├── popup.js              # Settings logic + key validation
    ├── styles.css            # Chat panel styles
    └── icon*.png             # Extension icons
```

---

## Circuit Validation

Every question runs static analysis on the circuit before calling the LLM.
Findings are injected into the context so the AI can reference them directly.

| Check | Level |
|-------|-------|
| Pin used in code but missing wire in diagram | Error |
| LED cathode not connected | Error |
| LED missing current-limiting resistor | Error |
| LED cathode not reaching GND | Warning |
| `delay()` >= 5000 ms | Info |

---

## Supported Models (via OpenRouter)

| Model | ID |
|-------|----|
| Claude Sonnet 4.5 | `anthropic/claude-sonnet-4-5` |
| Claude Opus 4.5 | `anthropic/claude-opus-4-5` |
| GPT-4o | `openai/gpt-4o` |
| GPT-4o mini | `openai/gpt-4o-mini` |
| Gemini 1.5 Pro | `google/gemini-1.5-pro` |
| Gemini 2.0 Flash | `google/gemini-2.0-flash` |
| Llama 3.3 70B | `meta-llama/llama-3.3-70b-instruct` |
| Mistral Large | `mistralai/mistral-large` |

---

## Packaging for Chrome Web Store

Create a ZIP of the `extension/` folder only:

```bash
# Windows (PowerShell)
Compress-Archive -Path extension\* -DestinationPath zapi-extension.zip

# macOS / Linux
zip -r zapi-extension.zip extension/
```

Upload `zapi-extension.zip` in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

> For local testing, skip the ZIP — just use **Load unpacked** and point to the `extension/` folder directly.

---

## Development

```bash
# After editing any JS file:
# chrome://extensions/ → click the refresh icon on ZAPI
```

---

## License

MIT
