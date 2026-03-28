const MODELS = [
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-opus-4-5',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'google/gemini-1.5-pro',
  'google/gemini-2.0-flash',
  'meta-llama/llama-3.3-70b-instruct',
  'mistralai/mistral-large',
];

function populateModels(selected) {
  const sel = document.getElementById('model');
  sel.innerHTML = '';
  MODELS.forEach(m => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = m;
    if (m === selected) opt.selected = true;
    sel.appendChild(opt);
  });
}

function showStatus(msg, type) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + type;
}

function setLoading(on) {
  const btn = document.getElementById('save-btn');
  btn.disabled = on;
  btn.textContent = on ? 'בודק מפתח...' : 'שמור והפעל';
}

// Init
chrome.storage.local.get(['apiKey', 'model'], (data) => {
  populateModels(data.model || MODELS[0]);
  if (data.apiKey) {
    document.getElementById('api-key').value = data.apiKey;
    showStatus('מפתח שמור — ZAPI פעיל', 'success');
  }
});

document.getElementById('toggle-key').addEventListener('click', () => {
  const input = document.getElementById('api-key');
  input.type = input.type === 'password' ? 'text' : 'password';
});

document.getElementById('save-btn').addEventListener('click', async () => {
  const apiKey = document.getElementById('api-key').value.trim();
  const model  = document.getElementById('model').value;

  if (!apiKey) { showStatus('נא להזין מפתח API', 'error'); return; }

  chrome.storage.local.set({ apiKey, model });

  setLoading(true);
  showStatus('בודק מפתח...', 'checking');

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      showStatus('✓ מפתח תקין ונשמר — ZAPI פעיל', 'success');
    } else {
      showStatus('המפתח נשמר אך לא תקין (בדוק ב-openrouter.ai)', 'error');
    }
  } catch (_) {
    showStatus('✓ מפתח נשמר (לא ניתן לאמת כרגע)', 'checking');
  }

  setLoading(false);
});
