/* ─────────────────────────────────────────────────────────────────
   Jev Router Playground · app.js
   Vanilla JS, no build step. State + render + API calls.
   ───────────────────────────────────────────────────────────────── */

(() => {
  'use strict';

  // ─── Defaults ─────────────────────────────────────────────────────
  const DEFAULT_POOL = [
    {
      id: 'google/gemini-2.5-flash-lite',
      name: 'Gemini 2.5 Flash Lite',
      description: 'Fast, efficient model for everyday questions, summaries, and simple analysis. Good balance of quality and speed.',
      pricing: { prompt: '0.07', completion: '0.28' },
      context_length: 1000000,
      tier: 'very-low',
    },
    {
      id: 'deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      description: 'Strong general reasoning and analysis. Good for explanations, research and structured writing.',
      pricing: { prompt: '0.14', completion: '0.55' },
      context_length: 1000000,
      tier: 'low',
    },
    {
      id: 'qwen/qwen3-coder-next',
      name: 'Qwen3 Coder Next',
      description: 'Excellent at coding, debugging and technical problem solving. Good at explaining code and suggesting solutions.',
      pricing: { prompt: '0.18', completion: '0.72' },
      context_length: 1000000,
      tier: 'low',
    },
    {
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      description: 'Careful, high-quality reasoning and writing. Great for complex analysis, planning and nuanced answers.',
      pricing: { prompt: '3.00', completion: '15.00' },
      context_length: 200000,
      tier: 'premium',
    },
  ];

  const DEFAULT_ENDPOINTS = {
    // Jev default: go through the CORS proxy. TypeSafe's API does not return
    // CORS headers on 401/4xx responses, which makes every browser call fail
    // with a generic "Failed to fetch". The proxy adds the right headers.
    // Users can switch back to the direct URL in Settings → Advanced if they
    // prefer (e.g. running their own proxy or self-hosting TypeSafe).
    jev: 'https://jev-router-proxy.xperiment.workers.dev/jev',
    openrouter: 'https://openrouter.ai/api/v1',
  };

  // Direct (non-proxied) Jev endpoint — exposed for reference / manual override.
  const JEV_DIRECT_URL = 'https://api.typesafe.ai/v1/systemone';

  // ─── Storage keys ─────────────────────────────────────────────────
  const KEY_POOL = 'jev-router.playground.pool.v1';
  const KEY_SETTINGS = 'jev-router.playground.settings.v1'; // non-secret only
  const SECRET_KEYS = { jev: 'jev-router.playground.jevKey', openrouter: 'jev-router.playground.openrouterKey' };

  // ─── State ────────────────────────────────────────────────────────
  const state = {
    pool: loadPool(),
    settings: loadSettings(),
    catalog: null,
    catalogLoading: false,
    lastResult: null,    // { routing, answers, task, startedAt }
    pendingRemove: null,
    busy: false,
  };

  function loadPool() {
    try {
      const raw = localStorage.getItem(KEY_POOL);
      if (!raw) return DEFAULT_POOL.slice();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return DEFAULT_POOL.slice();
      return parsed.filter(m => m && typeof m.id === 'string' && m.id);
    } catch { return DEFAULT_POOL.slice(); }
  }
  function savePool() {
    try { localStorage.setItem(KEY_POOL, JSON.stringify(state.pool)); } catch {}
  }
  function loadSettings() {
    const defaults = { jevUrl: DEFAULT_ENDPOINTS.jev, openrouterUrl: DEFAULT_ENDPOINTS.openrouter };
    try {
      const raw = localStorage.getItem(KEY_SETTINGS);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      const merged = { ...defaults, ...parsed };
      // Self-heal at load time: a saved direct-TypeSafe URL fails with CORS
      // in every browser. Migrate immediately so the very first Jev call
      // works, instead of waiting for the user to open Settings.
      if (merged.jevUrl === JEV_DIRECT_URL) {
        merged.jevUrl = DEFAULT_ENDPOINTS.jev;
        try { localStorage.setItem(KEY_SETTINGS, JSON.stringify(merged)); } catch {}
      }
      return merged;
    } catch { return defaults; }
  }
  function saveSettings() {
    try { localStorage.setItem(KEY_SETTINGS, JSON.stringify(state.settings)); } catch {}
  }
  function loadSecret(which) {
    try { return sessionStorage.getItem(SECRET_KEYS[which]) || ''; } catch { return ''; }
  }
  function saveSecret(which, value) {
    try {
      if (value) sessionStorage.setItem(SECRET_KEYS[which], value);
      else sessionStorage.removeItem(SECRET_KEYS[which]);
    } catch {}
  }

  // ─── DOM helpers ──────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtUsd = (n) => n < 0.01 && n > 0 ? '<$' + (n * 100).toFixed(2) + '¢' : '$' + n.toFixed(2);
  const fmtMs = (ms) => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  const fmtCtx = (n) => n >= 1_000_000 ? (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : String(n);

  // ─── Status pill ──────────────────────────────────────────────────
  function setStatus(status, label) {
    const pill = $('#status-pill');
    pill.dataset.status = status;
    pill.querySelector('.status-pill__label').textContent = label;
  }

  // ─── Toast ────────────────────────────────────────────────────────
  function toast(message, kind = 'info', ms = 3500) {
    const stack = $('#toast-stack');
    const el = document.createElement('div');
    el.className = `toast toast--${kind}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; el.style.transition = 'opacity .2s, transform .2s'; }, ms - 200);
    setTimeout(() => { el.remove(); }, ms);
  }

  // ─── Cost tier ────────────────────────────────────────────────────
  function tierFor(model) {
    const input = parseFloat(model.pricing?.prompt);
    const output = parseFloat(model.pricing?.completion);
    if (Number.isFinite(input) && Number.isFinite(output)) {
      const avg = (input + output) / 2;
      if (avg < 0.5) return 'very-low';
      if (avg < 2) return 'low';
      if (avg < 8) return 'mid';
      return 'high';
    }
    return 'mid';
  }
  const TIER_LABELS = { 'very-low': 'Very low cost', 'low': 'Low cost', 'mid': 'Mid cost', 'high': 'Premium' };

  // ─── Render: model pool ───────────────────────────────────────────
  function renderPool() {
    const root = $('#model-pool');
    root.innerHTML = '';
    if (!state.pool.length) {
      $('#pool-empty').hidden = false;
    } else {
      $('#pool-empty').hidden = true;
    }
    state.pool.forEach((m, i) => {
      const tier = m.tier || tierFor(m);
      const input = parseFloat(m.pricing?.prompt);
      const output = parseFloat(m.pricing?.completion);
      const ctx = m.context_length;
      const isSelected = state.lastResult?.answers?.pickId === m.id;
      const card = document.createElement('div');
      card.className = 'model-card' + (isSelected ? ' model-card--selected' : '');
      card.dataset.id = m.id;
      card.innerHTML = `
        <div class="model-card__head">
          <span class="model-card__num">${i + 1}</span>
          <span class="model-card__name" title="${escHtml(m.name || m.id)}">${escHtml(m.name || m.id)}</span>
          <span class="cost-badge cost-badge--${tier}">${TIER_LABELS[tier] || 'Cost unknown'}</span>
          <button class="model-card__remove" type="button" data-action="remove" aria-label="Remove ${escHtml(m.name || m.id)}">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M5 7h14M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M7 7l1 13a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
        <div class="model-card__id">${escHtml(m.id)}</div>
        <div class="model-card__field">
          <label class="model-card__label" for="desc-${escHtml(m.id)}">What is this model good at?</label>
          <textarea class="model-card__textarea" id="desc-${escHtml(m.id)}" rows="3" data-action="desc">${escHtml(m.description || '')}</textarea>
        </div>
        <div class="model-card__meta">
          <span><strong>${Number.isFinite(input) ? '$' + input.toFixed(2) : '—'}</strong> / 1M input</span>
          <span><strong>${Number.isFinite(output) ? '$' + output.toFixed(2) : '—'}</strong> / 1M output</span>
          <span><strong>${fmtCtx(ctx)}</strong> context</span>
        </div>
      `;
      root.appendChild(card);
    });
    updateActivity();
  }

  // ─── Activity gates (buttons enabled?) ──────────────────────────
  function updateActivity() {
    const hasPool = state.pool.length >= 2;
    const hasTask = $('#task-prompt').value.trim().length > 0;
    const hasJevKey = !!loadSecret('jev');
    const hasORKey = !!loadSecret('openrouter');
    $('#ask-jev').disabled = state.busy || !hasPool || !hasTask || !hasJevKey;
    $('#run-every').disabled = state.busy || !hasPool || !hasTask || !hasORKey;
    $('#export-result').disabled = !state.lastResult;

    const task = $('#task-prompt').value.trim();
    let helper = 'Add candidates and paste a task to begin.';
    if (!hasPool) helper = `Add at least 2 candidates to route between (currently ${state.pool.length}).`;
    else if (!hasTask) helper = 'Paste the task you want answered.';
    else if (!hasJevKey && !hasORKey) helper = 'Open Settings and add your TypeSafe and OpenRouter keys.';
    else if (!hasJevKey) helper = 'Add your TypeSafe key in Settings to ask Jev to choose.';
    else if (!hasORKey) helper = 'Add your OpenRouter key in Settings to run every model.';
    else if (state.busy) helper = 'Working…';
    else helper = `${state.pool.length} candidates ready.`;
    $('#task-helper').textContent = helper;
    $('#task-sub').textContent = hasJevKey
      ? 'Jev reads the task and the model profiles, then picks the best fit.'
      : 'Add your TypeSafe key in Settings to unlock routing.';
  }

  // ─── Add / remove / update model ────────────────────────────────
  function addModel(partial) {
    const m = {
      id: partial.id,
      name: partial.name || partial.id.split('/').pop() || partial.id,
      description: partial.description || '',
      pricing: { prompt: partial.pricing?.prompt ?? '', completion: partial.pricing?.completion ?? '' },
      context_length: partial.context_length ?? null,
      tier: partial.tier,
    };
    m.tier = m.tier || tierFor(m);
    if (state.pool.some(x => x.id === m.id)) {
      toast(`${m.name} is already in the pool.`, 'info');
      return;
    }
    state.pool.push(m);
    savePool();
    renderPool();
    toast(`Added ${m.name} to the pool.`, 'ok');
  }
  function removeModel(id) {
    const i = state.pool.findIndex(m => m.id === id);
    if (i < 0) return;
    const [removed] = state.pool.splice(i, 1);
    savePool();
    renderPool();
    toast(`Removed ${removed.name || removed.id}.`, 'info');
  }
  function updateDescription(id, description) {
    const m = state.pool.find(x => x.id === id);
    if (!m) return;
    m.description = description;
    savePool();
  }

  // ─── Pool event delegation ───────────────────────────────────────
  $('#model-pool').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="remove"]');
    if (!btn) return;
    const card = btn.closest('.model-card');
    if (!card) return;
    const id = card.dataset.id;
    const m = state.pool.find(x => x.id === id);
    state.pendingRemove = id;
    $('#confirm-body').textContent = `${m?.name || id} will be removed from the pool for this session.`;
    openModal('confirm');
  });
  $('#model-pool').addEventListener('input', (e) => {
    const ta = e.target.closest('[data-action="desc"]');
    if (!ta) return;
    const card = ta.closest('.model-card');
    if (!card) return;
    updateDescription(card.dataset.id, ta.value);
  });

  // ─── Confirm modal ──────────────────────────────────────────────
  $('#confirm-ok').addEventListener('click', () => {
    if (state.pendingRemove) removeModel(state.pendingRemove);
    state.pendingRemove = null;
    closeModal('confirm');
  });

  // ─── Add model modal ────────────────────────────────────────────
  $('#add-model').addEventListener('click', () => openModal('add'));
  $('#add-confirm').addEventListener('click', () => {
    const id = $('#add-id').value.trim();
    const name = $('#add-name').value.trim() || id;
    const desc = $('#add-desc').value.trim();
    const pi = $('#add-price-in').value;
    const po = $('#add-price-out').value;
    const ctx = parseInt($('#add-context').value, 10);
    if (!id || !/^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(id)) {
      $('#add-status').textContent = 'Use the OpenRouter format provider/model-name (e.g. openai/gpt-4o-mini).';
      $('#add-status').className = 'add-status add-status--err';
      return;
    }
    // Try to enrich from catalog if loaded
    const cat = state.catalog?.find?.(x => x.id === id);
    const pricing = cat?.pricing || { prompt: pi || '', completion: po || '' };
    const context_length = cat?.context_length || (Number.isFinite(ctx) ? ctx : null);
    const nameFinal = cat?.name || name;
    addModel({ id, name: nameFinal, description: desc, pricing, context_length });
    $('#add-id').value = ''; $('#add-name').value = ''; $('#add-desc').value = '';
    $('#add-price-in').value = ''; $('#add-price-out').value = ''; $('#add-context').value = '';
    $('#add-status').textContent = '';
    closeModal('add');
  });

  // ─── Paste modal ─────────────────────────────────────────────────
  $('#open-paste').addEventListener('click', () => openModal('paste'));
  $('#paste-add').addEventListener('click', () => {
    const lines = $('#paste-list').value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) {
      $('#paste-status').textContent = 'Paste at least one model id.';
      $('#paste-status').className = 'paste-status paste-status--err';
      return;
    }
    const cat = state.catalog;
    let added = 0, skipped = 0;
    for (const raw of lines) {
      const m = parsePastedModel(raw, cat);
      if (!m) { skipped++; continue; }
      if (state.pool.some(x => x.id === m.id)) { skipped++; continue; }
      state.pool.push(m);
      added++;
    }
    savePool();
    renderPool();
    $('#paste-status').textContent = `${added} added, ${skipped} skipped (duplicates or unparseable).`;
    $('#paste-status').className = 'paste-status paste-status--ok';
    if (added > 0) {
      $('#paste-list').value = '';
      setTimeout(() => closeModal('paste'), 600);
    }
  });

  // Parse a pasted line into a model record.
  // Accepts formats:
  //   provider/model
  //   provider/model — description
  //   provider/model | description [, key=val, ctx=val, in=val, out=val]
  //   provider/model [key=val, ...]
  function parsePastedModel(line, catalog) {
    let id = line;
    let description = '';
    let extras = {};
    // Strip bracket or pipe metadata
    const bracket = line.match(/^(.+?)\s*[\[\(](.+)[\]\)]\s*$/);
    const pipe = !bracket && line.includes('|') ? line.split('|') : null;
    const dash = !bracket && !pipe && line.includes('—') ? line.split('—') : (!bracket && !pipe && line.includes(' - ') ? line.split(' - ') : null);
    if (bracket) {
      id = bracket[1].trim();
      extras = parseExtras(bracket[2]);
    } else if (pipe) {
      id = pipe[0].trim();
      const rest = pipe.slice(1).join('|').trim();
      const { desc, kv } = splitDescAndKv(rest);
      description = desc; Object.assign(extras, kv);
    } else if (dash) {
      id = dash[0].trim();
      const rest = dash.slice(1).join('-').trim();
      const { desc, kv } = splitDescAndKv(rest);
      description = desc; Object.assign(extras, kv);
    }
    if (!/^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(id)) return null;
    const cat = catalog?.find?.(x => x.id === id);
    const pricing = cat?.pricing
      ? cat.pricing
      : { prompt: String(extras.in ?? extras.input ?? ''), completion: String(extras.out ?? extras.output ?? '') };
    const context_length = cat?.context_length || (extras.ctx ? parseInt(extras.ctx, 10) : null) || null;
    const descriptionFinal = description || extras.desc || '';
    const m = {
      id,
      name: cat?.name || id.split('/').pop() || id,
      description: descriptionFinal,
      pricing,
      context_length,
    };
    m.tier = tierFor(m);
    return m;
  }
  function parseExtras(s) {
    return s.split(',').reduce((acc, part) => {
      const [k, ...v] = part.split('=');
      if (k && v.length) acc[k.trim().toLowerCase()] = v.join('=').trim();
      return acc;
    }, {});
  }
  function splitDescAndKv(s) {
    const idx = s.search(/,?\s*(?:in|out|input|output|ctx)\s*=/i);
    if (idx < 0) return { desc: s.trim(), kv: {} };
    return { desc: s.slice(0, idx).replace(/[,;\s]+$/, '').trim(), kv: parseExtras(s.slice(idx).replace(/^,?\s*/, '')) };
  }

  // ─── Browse modal + catalog ─────────────────────────────────────
  $('#open-browse').addEventListener('click', async () => {
    openModal('browse');
    if (!state.catalog && !state.catalogLoading) await loadCatalog();
    renderBrowse();
  });
  $('#browse-search').addEventListener('input', renderBrowse);

  async function loadCatalog() {
    const key = loadSecret('openrouter');
    if (!key) {
      $('#browse-status').textContent = 'Add your OpenRouter key in Settings first.';
      return;
    }
    state.catalogLoading = true;
    $('#browse-status').textContent = 'Loading catalogue…';
    try {
      const r = await fetch(`${state.settings.openrouterUrl}/models`, {
        headers: { Authorization: `Bearer ${key}` }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      state.catalog = Array.isArray(data?.data) ? data.data : [];
      $('#browse-status').textContent = `${state.catalog.length} models available.`;
    } catch (e) {
      $('#browse-status').textContent = `Failed to load catalogue: ${e.message}`;
      state.catalog = [];
    } finally {
      state.catalogLoading = false;
    }
  }
  function renderBrowse() {
    const root = $('#browse-list');
    const q = $('#browse-search').value.trim().toLowerCase();
    if (state.catalogLoading) {
      root.innerHTML = '<div class="browse-empty">Loading the OpenRouter catalogue…</div>';
      return;
    }
    if (!state.catalog) {
      root.innerHTML = '<div class="browse-empty">Add your OpenRouter key in Settings, then re-open.</div>';
      return;
    }
    if (!state.catalog.length) {
      root.innerHTML = '<div class="browse-empty">No models returned.</div>';
      return;
    }
    const filtered = q
      ? state.catalog.filter(m => m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q))
      : state.catalog;
    const slice = filtered.slice(0, 200);
    root.innerHTML = slice.map(m => {
      const pi = parseFloat(m.pricing?.prompt);
      const po = parseFloat(m.pricing?.completion);
      const ctx = m.context_length;
      const meta = [
        Number.isFinite(pi) ? '$' + pi.toFixed(2) + ' / 1M in' : null,
        Number.isFinite(po) ? '$' + po.toFixed(2) + ' / 1M out' : null,
        ctx ? fmtCtx(ctx) + ' ctx' : null,
      ].filter(Boolean).join(' · ');
      const inPool = state.pool.some(x => x.id === m.id);
      return `
        <div class="browse-row">
          <div class="browse-row__main">
            <div class="browse-row__name">${escHtml(m.name || m.id)}</div>
            <div class="browse-row__id">${escHtml(m.id)}</div>
            <div class="browse-row__meta">${escHtml(meta)}</div>
          </div>
          <button class="btn btn--secondary browse-row__add" data-action="add-catalog" data-id="${escHtml(m.id)}" ${inPool ? 'disabled' : ''}>
            ${inPool ? 'In pool' : 'Add'}
          </button>
        </div>`;
    }).join('');
  }
  $('#browse-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="add-catalog"]');
    if (!btn) return;
    const id = btn.dataset.id;
    const m = state.catalog?.find(x => x.id === id);
    if (!m) return;
    addModel({ id: m.id, name: m.name, description: m.description || '', pricing: m.pricing, context_length: m.context_length });
    renderBrowse();
  });

  // ─── Settings modal ─────────────────────────────────────────────
  function openSettings() {
    // Clear any leftover toasts so they don't sit on top of the modal.
    $('#toast-stack').innerHTML = '';
    // Note: the direct→proxy migration now runs in loadSettings() on every
    // page load, so by the time the modal opens the URL is already correct.
    $('#set-jev-key').value = loadSecret('jev');
    $('#set-openrouter-key').value = loadSecret('openrouter');
    $('#set-jev-url').value = state.settings.jevUrl;
    $('#set-openrouter-url').value = state.settings.openrouterUrl;
    $('#test-result').textContent = '';
    $('#test-result').className = 'settings-actions__result';
    openModal('settings');
    updateJevUrlHint();
  }
  $('#open-settings').addEventListener('click', openSettings);
  // Optional quick-pick buttons inside the Jev URL hint.
  // Null-guard: if a future HTML edit removes the element, the page must still boot.
  const useDirectBtn = $('#use-direct');
  if (useDirectBtn) {
    useDirectBtn.addEventListener('click', () => {
      $('#set-jev-url').value = JEV_DIRECT_URL;
      toast('Switched to direct TypeSafe URL. Save to apply (will fail with CORS in browsers).', 'info');
    });
  }
  // Live warning if the user types the direct (browser-broken) URL.
  const jevUrlInput = $('#set-jev-url');
  const updateJevUrlHint = () => {
    if (!jevUrlInput) return;
    const isDirect = jevUrlInput.value.trim() === JEV_DIRECT_URL;
    jevUrlInput.style.borderColor = isDirect ? 'var(--danger)' : '';
    jevUrlInput.style.boxShadow = isDirect ? '0 0 0 3px rgba(220,38,38,0.15)' : '';
  };
  if (jevUrlInput) jevUrlInput.addEventListener('input', updateJevUrlHint);
  $('#save-settings').addEventListener('click', () => {
    saveSecret('jev', $('#set-jev-key').value.trim());
    saveSecret('openrouter', $('#set-openrouter-key').value.trim());
    state.settings.jevUrl = $('#set-jev-url').value.trim() || DEFAULT_ENDPOINTS.jev;
    state.settings.openrouterUrl = $('#set-openrouter-url').value.trim() || DEFAULT_ENDPOINTS.openrouter;
    saveSettings();
    state.catalog = null;
    closeModal('settings');
    setStatus('connected', 'Saved');
    setTimeout(() => setStatus(state.lastResult ? 'connected' : 'disconnected', state.lastResult ? 'Connected' : 'Disconnected'), 800);
    updateActivity();
    toast('Settings saved.', 'ok');
  });
  $('#test-connection').addEventListener('click', async () => {
    const jevKey = $('#set-jev-key').value.trim() || loadSecret('jev');
    const orKey = $('#set-openrouter-key').value.trim() || loadSecret('openrouter');
    const jevUrl = ($('#set-jev-url').value.trim() || state.settings.jevUrl);
    const orUrl = ($('#set-openrouter-url').value.trim() || state.settings.openrouterUrl);
    const out = $('#test-result');
    out.textContent = 'Testing…';
    out.className = 'settings-actions__result';
    const results = [];
    if (orKey) {
      try {
        const r = await fetch(`${orUrl}/models`, { headers: { Authorization: `Bearer ${orKey}` } });
        results.push(r.ok ? `OpenRouter ✓ (${r.status})` : `OpenRouter ✗ HTTP ${r.status}`);
      } catch (e) { results.push(`OpenRouter ✗ ${e.message}`); }
    } else { results.push('OpenRouter — no key'); }
    if (jevKey) {
      try {
        // Light probe: minimal request that should succeed.
        const probeBody = {
          model: 'jev-latest',
          state: { probe: true },
          questions: { p1: { type: 'noul', instructions: 'Confirm connectivity. Return 1.0.' } }
        };
        const r = await fetch(jevUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${jevKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(probeBody),
        });
        results.push(r.ok ? `Jev ✓ (${r.status})` : `Jev ✗ HTTP ${r.status}`);
      } catch (e) { results.push(`Jev ✗ ${e.message}`); }
    } else { results.push('Jev — no key'); }
    const ok = results.every(s => s.includes('✓') || s.includes('— no key'));
    out.textContent = results.join(' · ');
    out.className = 'settings-actions__result ' + (ok ? 'settings-actions__result--ok' : 'settings-actions__result--err');
    if (ok) setStatus('connected', 'Connected');
  });

  // ─── Modal open/close ───────────────────────────────────────────
  function openModal(name) { $('#modal-' + name).hidden = false; $('#modal-root').hidden = false; }
  function closeModal(name) { $('#modal-' + name).hidden = true; const any = $$('.modal', $('#modal-root')).some(m => !m.hidden); if (!any) $('#modal-root').hidden = true; }
  $('#modal-root').addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (!closer) return;
    closeModal(closer.dataset.close);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = $$('.modal', $('#modal-root')).find(m => !m.hidden);
      if (open) closeModal(open.id.replace('modal-', ''));
    }
  });

  // ─── Task input ─────────────────────────────────────────────────
  $('#task-prompt').addEventListener('input', (e) => {
    const v = e.target.value;
    $('#task-count').textContent = v.length;
    updateActivity();
  });

  // ─── Ask Jev to choose ──────────────────────────────────────────
  $('#ask-jev').addEventListener('click', askJev);

  async function askJev() {
    const jevKey = loadSecret('jev');
    const task = $('#task-prompt').value.trim();
    if (!jevKey || !task || state.pool.length < 2) return;
    if (state.busy) return;
    state.busy = true;
    setStatus('busy', 'Asking Jev…');
    updateActivity();
    clearDecision();

    const startedAt = Date.now();

    // Build Jev request — one NoUL question per candidate
    const questions = {};
    state.pool.forEach(m => {
      questions[m.id] = {
        type: 'noul',
        instructions: buildJevInstruction(m, task)
      };
    });
    const payload = {
      model: 'jev-latest',
      state: { task, candidates: state.pool.map(m => ({ id: m.id, name: m.name, description: m.description })) },
      questions,
    };

    try {
      const r = await fetch(state.settings.jevUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jevKey}`, 'Content-Type': 'application/json', 'User-Agent': 'Jev-Router-Playground/1.0' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text().catch(() => '')}`.slice(0, 240));
      const data = await r.json();
      if (!data.answers || typeof data.answers !== 'object') throw new Error('Jev: incomplete response.');

      // Validate + build probability list
      const probs = state.pool.map(m => {
        const a = data.answers[m.id];
        if (!a || a.type !== 'noul' || typeof a.noul !== 'number' || a.noul < 0 || a.noul > 1) {
          throw new Error(`Jev: missing or invalid probability for ${m.id}.`);
        }
        return { id: m.id, name: m.name, prob: a.noul };
      });
      // Sort descending
      probs.sort((a, b) => b.prob - a.prob);
      const chosen = probs[0];

      // Get a plain-language explanation (via cheap OpenRouter call)
      const explanation = await generateExplanation(chosen, probs, task);

      state.lastResult = {
        startedAt,
        task,
        routing: {
          chosenId: chosen.id,
          chosenName: chosen.name,
          probabilities: probs,
          explanation,
          confidence: confidenceFor(probs),
        },
        answers: { pickId: chosen.id, results: {} },
      };
      renderDecision();
      setStatus('connected', 'Connected');
      toast(`Jev chose ${chosen.name}.`, 'ok');
    } catch (e) {
      setStatus('error', 'Error');
      // Always log the attempted endpoint so failures are attributable.
      console.error(`[Jev] request failed via ${state.settings.jevUrl}:`, e);
      // CORS / network failure from browser → offer the one-click proxy switch.
      if (looksLikeCorsFailure(e) && state.settings.jevUrl !== DEFAULT_ENDPOINTS.jev) {
        offerCorsProxySwitch();
      } else {
        toast(`Jev failed via ${state.settings.jevUrl}: ${e.message}`, 'err', 7000);
      }
    } finally {
      state.busy = false;
      updateActivity();
    }
  }

  function looksLikeCorsFailure(e) {
    const msg = (e?.message || '').toLowerCase();
    return msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('cors') || e?.name === 'TypeError';
  }

  function offerCorsProxySwitch() {
    const stack = $('#toast-stack');
    const el = document.createElement('div');
    el.className = 'toast toast--err';
    el.style.maxWidth = '420px';
    el.innerHTML = `
      <div style="font-weight:700;margin-bottom:4px">Jev request blocked by CORS</div>
      <div style="opacity:.9;font-size:12px;margin-bottom:8px">Your browser can't reach TypeSafe directly. Switch to the CORS proxy?</div>
      <div style="display:flex;gap:6px">
        <button type="button" class="btn btn--secondary" data-action="apply-proxy" style="background:#fff;color:#dc2626;border-color:#fff">Switch to proxy</button>
        <button type="button" class="btn btn--ghost" data-action="dismiss-proxy" style="color:#fff">Not now</button>
      </div>
    `;
    stack.appendChild(el);
    el.querySelector('[data-action="apply-proxy"]').addEventListener('click', async () => {
      state.settings.jevUrl = DEFAULT_ENDPOINTS.jev;
      saveSettings();
      el.remove();
      toast(`Switched to CORS proxy. Retrying…`, 'info');
      await askJev();
    });
    el.querySelector('[data-action="dismiss-proxy"]').addEventListener('click', () => el.remove());
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 18000);
    setTimeout(() => el.remove(), 20000);
  }

  function buildJevInstruction(model, task) {
    return [
      `Task to route: """${task}"""`,
      ``,
      `Candidate: ${model.name} (${model.id})`,
      `Strengths: ${model.description || '(no description provided)'}`,
      ``,
      `Given the task and this candidate's strengths, return the probability (0–1) that this candidate is the best fit for the task.`,
      `Consider capability fit, not cost or speed. Use the full 0–1 range.`
    ].join('\n');
  }
  function confidenceFor(probs) {
    const top = probs[0]?.prob ?? 0;
    const second = probs[1]?.prob ?? 0;
    const gap = top - second;
    if (top >= 0.5 && gap >= 0.30) return 'strong';
    if (top >= 0.35 && gap >= 0.15) return 'moderate';
    return 'weak';
  }
  async function generateExplanation(chosen, probs, task) {
    const orKey = loadSecret('openrouter');
    if (!orKey) return `Best fit: ${chosen.name}.`;
    // Pick cheapest in-pool model as the explainer; fall back to a tiny default.
    const explainerId = pickExplainer();
    try {
      const r = await fetch(`${state.settings.openrouterUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: explainerId,
          messages: [
            { role: 'system', content: 'You are an analyst writing a single short paragraph (2–3 sentences) explaining why a router chose a specific AI model for a given task. Be specific to the task and the model. No preamble, no headings, no bullet points.' },
            { role: 'user', content: [
                `Task: ${task}`,
                ``,
                `Router chose: ${chosen.name} (${chosen.id})`,
                `Candidate strengths: ${(state.pool.find(m => m.id === chosen.id)?.description) || '(no description)'}`,
                ``,
                `Routing probabilities:`,
                ...probs.map(p => `- ${p.name}: ${(p.prob * 100).toFixed(0)}%`),
                ``,
                `Explain in 2–3 sentences why the router's pick is the best fit.`,
              ].join('\n') }
          ],
          temperature: 0.2,
          max_tokens: 220,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      return text || `Best fit: ${chosen.name}.`;
    } catch {
      return `Best fit: ${chosen.name} (top probability ${(chosen.prob * 100).toFixed(0)}%).`;
    }
  }
  function pickExplainer() {
    // Prefer a cheap in-pool model, then fall back to gemini flash.
    const cheap = state.pool
      .filter(m => Number.isFinite(parseFloat(m.pricing?.completion)))
      .sort((a, b) => parseFloat(a.pricing.completion) - parseFloat(b.pricing.completion))[0];
    return cheap?.id || 'google/gemini-2.5-flash-lite';
  }

  // ─── Run every model ────────────────────────────────────────────
  $('#run-every').addEventListener('click', runEveryModel);

  // Per-model timeout. Slow or hung models must not freeze the whole batch.
  const RUN_TIMEOUT_MS = 60_000;

  async function runEveryModel() {
    const orKey = loadSecret('openrouter');
    const task = $('#task-prompt').value.trim();
    if (!orKey || !task || !state.pool.length) return;
    if (state.busy) return;
    state.busy = true;
    setStatus('busy', 'Running models…');
    updateActivity();

    if (!state.lastResult) clearDecision();
    $('#decision-empty').hidden = true;
    $('#decision-region').hidden = false;
    renderAnswerSkeleton();

    if (!state.lastResult) {
      state.lastResult = { startedAt: Date.now(), task, routing: null, answers: { results: {} } };
    } else if (!state.lastResult.task) {
      state.lastResult.task = task;
    }
    state.lastResult.answers.results = {};
    state.lastResult.answers.pickId = null;
    $('#decision-footer').hidden = true;

    // Per-model fetch with timeout. Each model updates its own card as soon as
    // it finishes, so progress is visible even while the others are still running.
    let cancelled = false;
    const fetches = state.pool.map(async (m) => {
      const t0 = performance.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error(`Timeout after ${RUN_TIMEOUT_MS / 1000}s`)), RUN_TIMEOUT_MS);
      try {
        const r = await fetch(`${state.settings.openrouterUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${orKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: m.id,
            messages: [{ role: 'user', content: task }],
            temperature: 0.2,
            stream: false,
          }),
          signal: ac.signal,
        });
        clearTimeout(timer);
        const elapsed = performance.now() - t0;
        if (!r.ok) {
          const errBody = await r.text().catch(() => '');
          const result = { id: m.id, ok: false, status: r.status, error: errBody.slice(0, 240) || `HTTP ${r.status}`, elapsed_ms: elapsed };
          state.lastResult.answers.results[m.id] = result;
          updateSingleAnswerCard(m.id);
          return result;
        }
        const data = await r.json();
        const text = data?.choices?.[0]?.message?.content ?? '';
        const usage = data?.usage || {};
        const promptTokens = usage.prompt_tokens || 0;
        const completionTokens = usage.completion_tokens || 0;
        const costUsd = estimateCost(m, promptTokens, completionTokens);
        const result = {
          id: m.id, ok: true, text,
          prompt_tokens: promptTokens, completion_tokens: completionTokens,
          cost_usd: costUsd, elapsed_ms: elapsed,
        };
        state.lastResult.answers.results[m.id] = result;
        updateSingleAnswerCard(m.id);
        return result;
      } catch (e) {
        clearTimeout(timer);
        const result = { id: m.id, ok: false, error: e.message || String(e), elapsed_ms: performance.now() - t0 };
        state.lastResult.answers.results[m.id] = result;
        updateSingleAnswerCard(m.id);
        return result;
      }
    });

    try {
      await Promise.all(fetches);
    } finally {
      state.busy = false;
      setStatus('connected', 'Connected');
      updateActivity();
      // Final render so verdict + selection state appear together.
      renderVerdict();
    }
  }

  // Update just one answer card in place — used as each model finishes so the
  // user sees progress without re-rendering the whole grid (which costs DOM
  // work and could lose focus / scroll position on the running cards).
  function updateSingleAnswerCard(id) {
    const card = document.querySelector(`.answer-card[data-id="${cssEscape(id)}"]`);
    if (!card) return;
    const res = state.lastResult?.answers?.results?.[id];
    if (!res) return;
    const m = state.pool.find(x => x.id === id);
    const isJevPick = state.lastResult?.routing?.chosenId === id;
    let body, metrics = '';
    if (!res.ok) {
      card.classList.add('answer-card--error');
      body = `<pre class="answer-card__body answer-card__body--loading">Failed: ${escHtml(res.error || 'unknown error')}</pre>`;
    } else {
      body = `<pre class="answer-card__body">${escHtml(res.text)}</pre>`;
      metrics = `
        <span class="answer-card__metric" title="Response time">⏱ <strong>${fmtMs(res.elapsed_ms)}</strong></span>
        <span class="answer-card__metric" title="Approximate cost">💲 <strong>${fmtUsd(res.cost_usd)}</strong></span>
      `;
    }
    card.classList.toggle('answer-card--best', isJevPick && res.ok);
    card.querySelector('.answer-card__metrics').innerHTML = metrics;
    const oldBody = card.querySelector('.answer-card__body');
    if (oldBody) oldBody.outerHTML = body;
    // Enable the radio for this card.
    const radio = card.querySelector('input[type="radio"][name="best-answer"]');
    if (radio && res.ok) radio.disabled = false;
    // Add the Jev-pick label.
    const footer = card.querySelector('.answer-card__footer');
    let pickLabel = footer?.querySelector('.answer-card__best-label');
    if (isJevPick && !pickLabel) {
      const span = document.createElement('span');
      span.className = 'answer-card__best-label';
      span.textContent = '★ Jev\'s pick';
      footer?.appendChild(span);
    } else if (!isJevPick && pickLabel) {
      pickLabel.remove();
    }
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);
  }
  function estimateCost(model, promptTokens, completionTokens) {
    const pi = parseFloat(model.pricing?.prompt) || 0;
    const po = parseFloat(model.pricing?.completion) || 0;
    return (promptTokens * pi + completionTokens * po) / 1_000_000;
  }

  // ─── Render: decision region ────────────────────────────────────
  function clearDecision() {
    $('#decision-empty').hidden = false;
    $('#decision-region').hidden = true;
    $('#decision-footer').hidden = true;
    $('#answers-grid').innerHTML = '';
    $('#prob-list').innerHTML = '';
    state.lastResult = null;
    renderPool();
    updateActivity();
  }

  function renderDecision() {
    const r = state.lastResult;
    if (!r) { clearDecision(); return; }
    $('#decision-empty').hidden = true;
    $('#decision-region').hidden = false;

    if (r.routing) {
      // Jev choice card
      $('#jev-choice-name').textContent = r.routing.chosenName;
      const confBadge = $('#jev-choice-confidence');
      confBadge.textContent = ({ strong: 'Strong preference', moderate: 'Moderate preference', weak: 'Close call' })[r.routing.confidence] || 'Decision';
      confBadge.className = 'confidence-badge confidence-badge--' + r.routing.confidence;
      $('#jev-choice-explanation').textContent = r.routing.explanation;
      const top = r.routing.probabilities[0];
      $('#jev-choice-meta').textContent = `Confidence: ${(top.prob * 100).toFixed(0)}% · Confidence level: ${r.routing.confidence}`;

      // Probabilities list
      const list = $('#prob-list');
      list.innerHTML = r.routing.probabilities.map((p, i) => `
        <li class="prob-row${i === 0 ? ' prob-row--top' : ''}">
          <span class="prob-row__name" title="${escHtml(p.name)}">${escHtml(p.name)}</span>
          <span class="prob-row__bar"><i style="width:${Math.max(2, p.prob * 100).toFixed(1)}%"></i></span>
          <span class="prob-row__pct">${(p.prob * 100).toFixed(0)}%</span>
        </li>
      `).join('');

      // Confidence card
      const cc = $('#confidence-card');
      const level = r.routing.confidence;
      cc.dataset.level = level;
      const titleMap = { strong: 'Strong preference', moderate: 'Moderate preference', weak: 'Close call' };
      $('#confidence-title').textContent = titleMap[level];
      $('#confidence-body').textContent = ({
        strong: `Jev was much more confident in this choice (${(top.prob * 100).toFixed(0)}% for ${r.routing.chosenName}).`,
        moderate: `Jev leaned towards ${r.routing.chosenName}, but the second candidate (${(r.routing.probabilities[1].prob * 100).toFixed(0)}%) is a credible alternative.`,
        weak: `Jev picked ${r.routing.chosenName}, but the top probabilities are close — the decision is sensitive to descriptions.`,
      })[level];
    }

    renderAnswers();
  }

  function renderAnswerSkeleton() {
    // Renders placeholder answer cards. Always idempotent — never calls back
    // into renderDecision (would recurse forever once routing is present).
    $('#decision-region').hidden = false;
    $('#decision-empty').hidden = true;
    const grid = $('#answers-grid');
    grid.innerHTML = state.pool.map((m) => `
      <article class="answer-card" data-id="${escHtml(m.id)}">
        <div class="answer-card__head">
          <span class="answer-card__name">${escHtml(m.name)}</span>
          <span class="answer-card__metrics">
            <span class="answer-card__metric" data-metric="time">—</span>
            <span class="answer-card__metric" data-metric="cost">—</span>
          </span>
        </div>
        <pre class="answer-card__body answer-card__body--loading">Running…</pre>
        <div class="answer-card__footer">
          <label class="answer-card__radio"><input type="radio" name="best-answer" value="${escHtml(m.id)}" disabled> Choose as best answer</label>
        </div>
      </article>
    `).join('');
  }

  function renderAnswers() {
    const r = state.lastResult;
    if (!r) return;
    const grid = $('#answers-grid');
    const results = r.answers?.results || {};
    // If we have no answers yet (just routing), render placeholder
    if (!Object.keys(results).length) {
      renderAnswerSkeleton();
      return;
    }
    grid.innerHTML = state.pool.map((m, i) => {
      const res = results[m.id];
      const isJevPick = r.routing?.chosenId === m.id;
      let body;
      let metrics = '';
      let error = false;
      if (!res) {
        body = '<pre class="answer-card__body answer-card__body--loading">Not run yet.</pre>';
      } else if (!res.ok) {
        error = true;
        body = `<pre class="answer-card__body answer-card__body--loading">Failed: ${escHtml(res.error || 'unknown error')}</pre>`;
      } else {
        body = `<pre class="answer-card__body">${escHtml(res.text)}</pre>`;
        metrics = `
          <span class="answer-card__metric" title="Response time">⏱ <strong>${fmtMs(res.elapsed_ms)}</strong></span>
          <span class="answer-card__metric" title="Approximate cost">💲 <strong>${fmtUsd(res.cost_usd)}</strong></span>
        `;
      }
      return `
        <article class="answer-card ${error ? 'answer-card--error' : ''} ${isJevPick ? 'answer-card--best' : ''}" data-id="${escHtml(m.id)}">
          <div class="answer-card__head">
            <span class="answer-card__name">${escHtml(m.name)}</span>
            <span class="answer-card__metrics">${metrics}</span>
          </div>
          ${body}
          <div class="answer-card__footer">
            <label class="answer-card__radio">
              <input type="radio" name="best-answer" value="${escHtml(m.id)}" ${res && res.ok ? '' : 'disabled'} ${r.answers?.pickId === m.id ? 'checked' : ''}>
              Choose as best answer
            </label>
            ${isJevPick ? '<span class="answer-card__best-label">★ Jev\'s pick</span>' : ''}
          </div>
        </article>
      `;
    }).join('');
    // Wire up radio change
    grid.querySelectorAll('input[name="best-answer"]').forEach(r => {
      r.addEventListener('change', () => onUserPick(r.value));
    });
    renderVerdict();
    renderPool(); // refresh selected card highlight
  }

  function onUserPick(id) {
    if (!state.lastResult) return;
    state.lastResult.answers.pickId = id;
    renderAnswers();
  }

  function renderVerdict() {
    const r = state.lastResult;
    if (!r || !r.routing || !r.answers?.results || !Object.keys(r.answers.results).length) {
      $('#decision-footer').hidden = true;
      return;
    }
    const userPick = r.answers.pickId;
    if (!userPick) {
      $('#decision-footer').hidden = false;
      $('#verdict-banner').className = 'decision-footer__verdict';
      $('#verdict-icon').textContent = '✓';
      $('#verdict-text').innerHTML = `Jev chose <strong>${escHtml(r.routing.chosenName)}</strong>. Pick the answer you prefer to compare.`;
      $('#verdict-praise').hidden = true;
      return;
    }
    const match = userPick === r.routing.chosenId;
    $('#decision-footer').hidden = false;
    $('#decision-footer').className = 'decision-footer' + (match ? '' : ' decision-footer--mismatch');
    $('#verdict-icon').textContent = match ? '✓' : '✗';
    const userPickName = state.pool.find(m => m.id === userPick)?.name || userPick;
    if (match) {
      $('#verdict-text').innerHTML = `Jev chose <strong>${escHtml(r.routing.chosenName)}</strong>. You preferred <strong>${escHtml(userPickName)}</strong>. <span style="color:var(--accent-mint-ink)">Match.</span>`;
      $('#verdict-praise').hidden = false;
      $('#verdict-praise').textContent = `Nice! Jev's choice matched your pick.`;
    } else {
      $('#verdict-text').innerHTML = `Jev chose <strong>${escHtml(r.routing.chosenName)}</strong>. You preferred <strong>${escHtml(userPickName)}</strong>. <span style="color:var(--danger)">Mismatch.</span>`;
      $('#verdict-praise').hidden = false;
      $('#verdict-praise').textContent = `Different picks — useful signal for routing evaluation.`;
    }
  }

  $('#run-another').addEventListener('click', () => {
    clearDecision();
    $('#task-prompt').focus();
  });

  // ─── Export ─────────────────────────────────────────────────────
  $('#export-result').addEventListener('click', () => {
    const r = state.lastResult;
    if (!r) return;
    const data = {
      exported_at: new Date().toISOString(),
      task: r.task,
      started_at: new Date(r.startedAt).toISOString(),
      pool: state.pool.map(m => ({
        id: m.id, name: m.name, description: m.description,
        pricing: m.pricing, context_length: m.context_length, tier: m.tier,
      })),
      routing: r.routing ? {
        chosen: r.routing.chosenId,
        chosen_name: r.routing.chosenName,
        confidence: r.routing.confidence,
        explanation: r.routing.explanation,
        probabilities: r.routing.probabilities,
      } : null,
      user_pick: r.answers?.pickId || null,
      match: r.routing ? (r.answers?.pickId === r.routing.chosenId) : null,
      answers: Object.fromEntries(Object.entries(r.answers?.results || {}).map(([id, v]) => [id, v.ok ? {
        text: v.text,
        elapsed_ms: v.elapsed_ms,
        prompt_tokens: v.prompt_tokens,
        completion_tokens: v.completion_tokens,
        cost_usd: v.cost_usd,
      } : { ok: false, error: v.error, status: v.status }])),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jev-router-${data.started_at.replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 200);
    toast('Exported result.', 'ok');
  });

  // ─── Initial render + status ────────────────────────────────────
  function init() {
    renderPool();
    updateActivity();
    setStatus('disconnected', 'Disconnected');
  }
  init();
})();