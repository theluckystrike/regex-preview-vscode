/* Regex Preview panel. Runs every match in a Web Worker and stops it after the time limit, so a pattern that
 * backtracks forever never freezes the panel or VS Code. All text from patterns and samples goes into the page as
 * text nodes (textContent) or through the railroad module's XML escaping; nothing from them is ever run. */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const RP = window.RegexPreview;
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const el = {
    pattern: $('pattern'), flavor: $('flavor'), status: $('status'), source: $('source'), warnings: $('warnings'),
    sample: $('sample'), backdrop: $('backdrop'), sampleInfo: $('sampleInfo'), replacement: $('replacement'), replaced: $('replaced'),
    matchInfo: $('matchInfo'), table: $('matches'), diagram: $('diagram'), explain: $('explain'), copyAs: $('copyAs'), fit: $('fit'),
  };
  const HL_CHARS = 200000; // highlights cover the first 200,000 characters of the sample
  const HL_MAX = 20000; // and at most this many matches
  const settings = { timeoutMs: Number(app.dataset.timeout) || 1000, maxMatchRows: 1000, defaultFlags: 'g' };
  const st = {
    flags: new Set(['g']), tab: 'matches', fit: false, label: '', sampleName: '', sampleSize: 0, sampleTruncated: false,
    prepared: null, result: null, timedOut: false, runSeq: 0, doneSeq: 0, busy: false, lastMs: 0, diagramSvg: '', diagramBoxes: 0,
    loadedFromSource: false, error: '', selectedRow: -1, notice: '',
  };

  // ---------- worker ----------
  let worker = null;
  let workerUrl = null;
  let timer = null;
  let started = 0;
  function newWorker() {
    if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([RP.workerSource()], { type: 'text/javascript' }));
    const w = new Worker(workerUrl);
    w.onmessage = (e) => onResult(e.data);
    w.onerror = (e) => { e.preventDefault(); finish(); showError('The matcher stopped: ' + (e.message || 'unknown error')); vscode.postMessage({ type: 'result', ok: false, crashed: true }); };
    return w;
  }
  function stopWorker() {
    if (worker) { worker.terminate(); worker = null; }
    if (timer) { clearTimeout(timer); timer = null; }
  }

  // ---------- state ----------
  const flagStr = () => ['d', 'g', 'i', 'm', 's', 'u', 'v', 'y', 'x'].filter((f) => st.flags.has(f)).join('');
  function setFlags(f) {
    st.flags = new Set(String(f || '').split('').filter((c) => 'dgimsuvyx'.includes(c)));
    if (st.flags.has('v')) st.flags.delete('u'); // v (unicodeSets) replaces u; JavaScript refuses both at once
    for (const b of document.querySelectorAll('.flag')) b.setAttribute('aria-pressed', String(st.flags.has(b.dataset.flag)));
  }
  let saveTimer = null;
  function save() {
    vscode.setState({ pattern: el.pattern.value, flags: flagStr(), flavor: el.flavor.value, replacement: el.replacement.value, tab: st.tab, label: st.label });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const sample = el.sample.value;
      vscode.postMessage({ type: 'state', pattern: el.pattern.value, flags: flagStr(), flavor: el.flavor.value, replacement: el.replacement.value, tab: st.tab,
        sample: !st.sampleName && sample.length <= 512 * 1024 ? sample : undefined });
    }, 500);
  }

  // ---------- running ----------
  let runTimer = null;
  function schedule(ms) {
    clearTimeout(runTimer);
    const big = el.sample.value.length > 1000000;
    runTimer = setTimeout(run, ms !== undefined ? ms : (big ? 350 : 120));
  }

  function setStatus(text, cls) {
    el.status.textContent = text;
    el.status.className = 'status' + (cls ? ' ' + cls : '');
  }
  function showError(msg) {
    st.error = msg;
    setStatus(msg, 'error');
  }

  function renderWarnings(p) {
    el.warnings.textContent = '';
    const add = (t, cls) => { const li = document.createElement('li'); li.className = cls; li.textContent = t; el.warnings.appendChild(li); };
    if (p && p.warnings) for (const w of p.warnings) add(w, 'warn');
    if (st.flags.has('x') && el.flavor.value === 'javascript') add('The x flag is not a JavaScript flag; it is ignored for JavaScript. Pick another flavor to use verbose mode.', 'warn');
    if (p && p.notes) for (const n of p.notes) add(n, 'note');
    if (st.notice) add(st.notice, 'note');
  }

  let lastDiagramKey = '';
  function run() {
    const pattern = el.pattern.value;
    const flavor = el.flavor.value;
    const flags = flagStr();
    st.error = '';
    stopWorker();
    st.busy = false;
    const p = RP.prepare(pattern, flags, flavor);
    st.prepared = p;
    renderWarnings(p);
    const dKey = pattern + '\u0000' + flavor + '\u0000' + flags;
    if (dKey !== lastDiagramKey) { lastDiagramKey = dKey; renderDiagram(p); renderExplain(p); }
    if (!pattern) {
      clearResults();
      setStatus('Type a pattern, or click "Test regex" above a regex in your code.', 'idle');
      return;
    }
    if (!p.ok) {
      clearResults();
      showError('Invalid pattern: ' + p.error + (p.errorPos !== undefined ? ' (at character ' + (p.errorPos + 1) + ')' : ''));
      return;
    }
    // compile once here, so a JavaScript error shows at once and not from the worker
    try { new RegExp(p.source, p.flags.replace(/[gd]/g, '')); } catch (e) {
      clearResults();
      showError('Invalid pattern: ' + String(e.message).replace(/^Invalid regular expression: /, ''));
      return;
    }
    const id = ++st.runSeq;
    st.busy = true;
    st.timedOut = false;
    setStatus('Matching…', 'busy');
    worker = newWorker();
    started = performance.now();
    const groupNames = [];
    for (const g of p.groups || []) groupNames[g.index - 1] = g.name || '';
    worker.postMessage({
      id, source: p.source, flags: p.flags, text: el.sample.value, maxRows: settings.maxMatchRows, hlChars: HL_CHARS, hlMax: HL_MAX,
      replacement: el.replacement.value ? el.replacement.value : null, flavor, groupNames, replaceCap: 200000,
    });
    timer = setTimeout(() => {
      if (st.runSeq !== id || !st.busy) return;
      stopWorker();
      st.busy = false;
      st.timedOut = true;
      st.doneSeq = id;
      st.lastMs = Math.round(performance.now() - started);
      clearResults();
      setStatus('Stopped after ' + (settings.timeoutMs / 1000).toFixed(1) + ' s: this pattern takes too long on this text (catastrophic backtracking, for example (a+)+ against "aaaa…!"). Nothing is frozen. Change the pattern or the text, or raise regexPreview.timeoutMs.', 'timeout');
      el.matchInfo.textContent = 'Stopped: no results.';
    }, settings.timeoutMs);
  }

  function finish() { if (timer) { clearTimeout(timer); timer = null; } st.busy = false; }

  function clearResults() {
    st.result = null;
    el.backdrop.textContent = '';
    el.table.tHead.textContent = '';
    el.table.tBodies[0].textContent = '';
    el.matchInfo.textContent = '';
    el.replaced.textContent = '';
    el.replaced.classList.add('empty');
  }

  function fmt(n) { return Number(n).toLocaleString('en-US'); }

  function onResult(r) {
    if (r.id !== st.runSeq) return; // an old run
    finish();
    st.doneSeq = r.id;
    st.lastMs = Math.round(performance.now() - started);
    if (worker) { worker.terminate(); worker = null; }
    if (!r.ok) { clearResults(); showError('Invalid pattern: ' + String(r.error).replace(/^Invalid regular expression: /, '')); return; }
    st.result = r;
    const all = st.flags.has('g');
    const countText = r.count === 0 ? 'No match' : (r.countCapped ? fmt(r.count) + '+ matches (stopped counting)' : fmt(r.count) + (r.count === 1 ? ' match' : ' matches'));
    setStatus(countText + ' · ' + r.ms + ' ms' + (all ? '' : ' · first match only (turn on g for all)'), r.count ? 'ok' : 'none');
    renderHighlights(r);
    renderTable(r);
    renderReplace(r);
    vscode.postMessage({ type: 'result', ok: true, count: r.count, pattern: el.pattern.value });
  }

  // ---------- sample highlights ----------
  function renderHighlights(r) {
    const text = el.sample.value;
    const lim = Math.min(text.length, HL_CHARS);
    const frag = document.createDocumentFragment();
    let pos = 0;
    const hl = r.hl || [];
    for (let k = 0; k < hl.length; k += 2) {
      const s = hl[k], e = Math.min(hl[k + 1], lim);
      if (s >= lim) break;
      if (s > pos) frag.appendChild(document.createTextNode(text.slice(pos, s)));
      const m = document.createElement('mark');
      m.className = (k / 2) % 2 ? 'm1' : 'm0';
      if (e === s) m.className += ' zero';
      m.textContent = text.slice(s, e);
      frag.appendChild(m);
      pos = Math.max(pos, e);
    }
    if (pos < lim) frag.appendChild(document.createTextNode(text.slice(pos, lim)));
    frag.appendChild(document.createTextNode('\n '));
    el.backdrop.textContent = '';
    el.backdrop.appendChild(frag);
    el.backdrop.scrollTop = el.sample.scrollTop;
  }

  // ---------- matches table ----------
  function cell(tr, text, cls, title) {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    td.textContent = text;
    if (title) td.title = title;
    tr.appendChild(td);
    return td;
  }
  function renderTable(r) {
    const groups = (st.prepared && st.prepared.groups) || [];
    const thead = el.table.tHead;
    const tbody = el.table.tBodies[0];
    thead.textContent = '';
    tbody.textContent = '';
    const hr = document.createElement('tr');
    for (const h of ['#', 'at', 'match']) { const th = document.createElement('th'); th.textContent = h; hr.appendChild(th); }
    const nGroups = r.rows.length ? r.rows[0].groups.length : groups.length;
    for (let k = 0; k < nGroups; k++) {
      const th = document.createElement('th');
      const g = groups[k];
      th.textContent = String(k + 1) + (g && g.name ? ' ' + g.name : '');
      th.title = 'Group ' + (k + 1) + (g && g.name ? ' "' + g.name + '"' : '');
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    const frag = document.createDocumentFragment();
    r.rows.forEach((row, k) => {
      const tr = document.createElement('tr');
      tr.dataset.k = String(k);
      tr.tabIndex = 0;
      cell(tr, String(k + 1), 'num');
      cell(tr, row.index + '-' + row.end, 'num');
      cell(tr, row.text === '' ? '(empty)' : RP.visible(row.text, 160) + (row.cut ? '…' : ''), row.text === '' ? 'empty' : 'm', row.text.length > 160 ? row.text.slice(0, 1000) : '');
      for (const g of row.groups) {
        if (!g) cell(tr, '–', 'unset', 'This group did not take part in the match');
        else cell(tr, g.v === '' ? '(empty)' : RP.visible(g.v, 80) + (g.cut ? '…' : ''), g.v === '' ? 'empty' : 'g', g.s + '-' + g.e);
      }
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
    const shown = r.rows.length;
    el.matchInfo.textContent = r.count === 0 ? 'No match in the sample text.' : (shown < r.count ? 'Showing the first ' + fmt(shown) + ' of ' + fmt(r.count) + ' matches.' : fmt(r.count) + (r.count === 1 ? ' match' : ' matches') + (nGroups ? ', ' + nGroups + (nGroups === 1 ? ' group' : ' groups') : '') + '. Click a row to select it in the sample.')
      + (el.sample.value.length > HL_CHARS ? ' Highlights cover the first ' + fmt(HL_CHARS) + ' characters.' : '');
  }

  el.table.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-k]');
    if (!tr || !st.result) return;
    selectRow(Number(tr.dataset.k));
  });
  el.table.addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr[data-k]');
    if (!tr) return;
    if (e.key === 'Enter') selectRow(Number(tr.dataset.k));
    if (e.key === 'ArrowDown' && tr.nextElementSibling) { tr.nextElementSibling.focus(); e.preventDefault(); }
    if (e.key === 'ArrowUp' && tr.previousElementSibling) { tr.previousElementSibling.focus(); e.preventDefault(); }
  });
  function selectRow(k) {
    const row = st.result && st.result.rows[k];
    if (!row) return;
    st.selectedRow = k;
    for (const t of el.table.querySelectorAll('tr.sel')) t.classList.remove('sel');
    const tr = el.table.querySelector('tr[data-k="' + k + '"]');
    if (tr) tr.classList.add('sel');
    el.sample.focus();
    el.sample.setSelectionRange(row.index, Math.max(row.index, row.end));
    // scroll the selection into view: put the caret line near the top
    const before = el.sample.value.slice(0, row.index);
    const lines = before.split('\n').length - 1;
    const lh = parseFloat(getComputedStyle(el.sample).lineHeight) || 18;
    if (el.sample.value.length < HL_CHARS) el.sample.scrollTop = Math.max(0, lines * lh - 40);
    el.backdrop.scrollTop = el.sample.scrollTop;
  }

  // ---------- replace ----------
  function renderReplace(r) {
    if (r.replaced === null || r.replaced === undefined) {
      el.replaced.textContent = el.replacement.value ? '' : 'Type a replacement above to see the result here.';
      el.replaced.classList.add('empty');
      return;
    }
    el.replaced.classList.remove('empty');
    el.replaced.textContent = r.replaced + (r.replacedCut ? '\n… (preview cut at 200,000 characters)' : '');
  }

  // ---------- diagram and explain ----------
  function renderDiagram(p) {
    el.diagram.textContent = '';
    st.diagramSvg = '';
    st.diagramBoxes = 0;
    if (!p || !p.ok || !el.pattern.value || !p.ast) {
      const d = document.createElement('div');
      d.className = 'muted pad';
      d.textContent = !el.pattern.value ? 'The railroad diagram of your pattern shows here.' : (p && p.ok ? 'This pattern runs, but its diagram cannot be drawn.' : 'Fix the pattern to see its diagram.');
      el.diagram.appendChild(d);
      return;
    }
    const r = RP.railroad(p.ast, { dotAll: st.flags.has('s') });
    if (r.error) {
      const d = document.createElement('div');
      d.className = 'muted pad';
      d.textContent = 'This pattern has more than ' + fmt(RP.MAX_BOXES) + ' parts; the diagram is left out so the panel stays fast.';
      el.diagram.appendChild(d);
      return;
    }
    st.diagramBoxes = r.boxes;
    // r.svg is built only from numbers and XML-escaped text (railroad.js esc()), so it is safe markup.
    el.diagram.innerHTML = r.svg;
    applyFit();
  }
  function applyFit() {
    const svg = el.diagram.querySelector('svg');
    if (!svg) return;
    svg.classList.toggle('fit', st.fit);
    el.fit.setAttribute('aria-pressed', String(st.fit));
  }
  function renderExplain(p) {
    el.explain.textContent = '';
    if (!p || !p.ok || !el.pattern.value || !p.ast) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = !el.pattern.value ? 'A plain explanation of each part of the pattern shows here.' : 'Fix the pattern to see the explanation.';
      el.explain.appendChild(li);
      return;
    }
    const lines = RP.explain(p.ast, { dotAll: st.flags.has('s') });
    const frag = document.createDocumentFragment();
    const src = el.pattern.value;
    for (const ln of lines.slice(0, 3000)) {
      const li = document.createElement('li');
      li.style.paddingLeft = (ln.depth * 16 + 4) + 'px';
      const code = document.createElement('code');
      const piece = src.slice(ln.start, ln.end);
      code.textContent = piece.length > 40 ? piece.slice(0, 39) + '…' : piece;
      const span = document.createElement('span');
      span.textContent = ln.text;
      li.appendChild(code);
      li.appendChild(span);
      frag.appendChild(li);
    }
    el.explain.appendChild(frag);
  }

  // ---------- export ----------
  function exportSvgText() {
    const p = st.prepared;
    if (!p || !p.ok || !p.ast) return '';
    const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
    const colors = dark ? { fg: '#e6edf3', line: '#8b949e', lit: '#12361f', litStroke: '#3fb950', cls: '#0c2d4f', clsStroke: '#58a6ff', esc: '#3b2e0a', escStroke: '#d29922', assert: '#2f1d48', assertStroke: '#bc8cff', frame: '#8b949e' } : {};
    const r = RP.railroad(p.ast, { dotAll: st.flags.has('s'), style: RP.exportStyle(colors), background: dark ? '#0d1117' : '#ffffff' });
    return r.svg || '';
  }
  $('exportSvg').addEventListener('click', () => {
    const svg = exportSvgText();
    if (svg) vscode.postMessage({ type: 'export', format: 'svg', data: svg });
  });
  $('exportPng').addEventListener('click', () => {
    const svg = exportSvgText();
    if (!svg) return;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const w = Math.min(16000, img.naturalWidth * scale), h = Math.min(16000, img.naturalHeight * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      vscode.postMessage({ type: 'export', format: 'png', data: c.toDataURL('image/png') });
    };
    img.onerror = () => { URL.revokeObjectURL(url); setStatus('The PNG could not be made from this diagram.', 'error'); };
    img.src = url;
  });

  // ---------- events ----------
  // The pattern box grows with multi-line (verbose) patterns, up to about 6 lines.
  function fitPattern() { el.pattern.style.height = 'auto'; el.pattern.style.height = Math.min(el.pattern.scrollHeight + 2, 150) + 'px'; }
  el.pattern.addEventListener('input', () => { fitPattern(); save(); schedule(); });
  el.pattern.addEventListener('keydown', (e) => {
    // Enter runs at once; a new line needs Shift+Enter or the x (verbose) flag
    if (e.key === 'Enter' && !e.shiftKey && !st.flags.has('x')) { e.preventDefault(); schedule(0); }
  });
  el.replacement.addEventListener('input', () => { save(); schedule(); });
  el.sample.addEventListener('input', () => {
    if (st.sampleName) { st.sampleName = ''; st.sampleTruncated = false; updateSampleInfo(); }
    save(); schedule();
  });
  el.sample.addEventListener('scroll', () => { el.backdrop.scrollTop = el.sample.scrollTop; el.backdrop.scrollLeft = el.sample.scrollLeft; });
  el.flavor.addEventListener('change', () => { save(); lastDiagramKey = ''; schedule(0); });
  for (const b of document.querySelectorAll('.flag')) {
    b.addEventListener('click', () => {
      const f = b.dataset.flag;
      if (st.flags.has(f)) st.flags.delete(f); else st.flags.add(f);
      if (st.flags.has(f) && (f === 'u' || f === 'v')) st.flags.delete(f === 'u' ? 'v' : 'u');
      for (const x of document.querySelectorAll('.flag')) x.setAttribute('aria-pressed', String(st.flags.has(x.dataset.flag)));
      save(); lastDiagramKey = ''; schedule(0);
    });
  }
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
  function showTab(name) {
    st.tab = ['matches', 'diagram', 'explain'].includes(name) ? name : 'matches';
    for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === st.tab));
    for (const k of ['matches', 'diagram', 'explain']) $('pane-' + k).classList.toggle('hidden', k !== st.tab);
    save();
  }
  el.fit.addEventListener('click', () => { st.fit = !st.fit; applyFit(); });
  $('loadFile').addEventListener('click', () => vscode.postMessage({ type: 'loadSample' }));
  $('resetSample').addEventListener('click', () => vscode.postMessage({ type: 'resetSample' }));
  el.copyAs.addEventListener('change', () => {
    const target = el.copyAs.value;
    el.copyAs.value = '';
    if (!target || !el.pattern.value) return;
    vscode.postMessage({ type: 'copyAs', target, pattern: el.pattern.value, flags: flagStr() });
  });

  function updateSampleInfo() {
    if (!st.sampleName) { el.sampleInfo.textContent = ''; return; }
    const sz = st.sampleSize >= 1024 * 1024 ? (st.sampleSize / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(st.sampleSize / 1024)) + ' KB';
    el.sampleInfo.textContent = st.sampleName + ' · ' + sz + (st.sampleTruncated ? ' · first ' + (el.sample.value.length / 1048576).toFixed(1) + ' MB used' : '');
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'init') {
      Object.assign(settings, m.settings || {});
      el.sample.value = typeof m.sample === 'string' ? m.sample : '';
      if (!st.loadedFromSource) {
        const s = Object.assign({}, m.state || {}, vscode.getState() || {});
        if (typeof s.pattern === 'string') { el.pattern.value = s.pattern; fitPattern(); }
        setFlags(typeof s.flags === 'string' ? s.flags : settings.defaultFlags);
        if (s.flavor && RP.FLAVORS[s.flavor]) el.flavor.value = s.flavor;
        if (typeof s.replacement === 'string') el.replacement.value = s.replacement;
        if (s.tab) showTab(s.tab);
      }
      schedule(0);
    } else if (m.type === 'load') {
      st.loadedFromSource = true;
      el.pattern.value = String(m.pattern || '');
      fitPattern();
      const f = String(m.flags || '');
      // a pattern from code keeps its own flags; g is added so every match in the sample shows
      setFlags((f.includes('g') ? '' : 'g') + f);
      el.flavor.value = RP.FLAVORS[m.flavor] ? m.flavor : 'javascript';
      st.label = String(m.label || '');
      el.source.textContent = st.label ? 'from ' + st.label : '';
      lastDiagramKey = '';
      save();
      schedule(0);
    } else if (m.type === 'sample') {
      el.sample.value = String(m.text || '');
      st.sampleName = String(m.name || '');
      st.sampleSize = Number(m.size) || el.sample.value.length;
      st.sampleTruncated = !!m.truncated;
      el.sample.scrollTop = 0;
      updateSampleInfo();
      save();
      schedule(0);
    } else if (m.type === 'notice') {
      st.notice = String(m.text || '');
      renderWarnings(st.prepared);
      setTimeout(() => { st.notice = ''; renderWarnings(st.prepared); }, 8000);
    }
  });

  // Test probe for the release gate (read-only).
  window.regexPreviewProbe = () => {
    const r = st.result;
    return {
      status: el.status.textContent, statusClass: el.status.className, busy: st.busy, timedOut: st.timedOut, runSeq: st.runSeq, doneSeq: st.doneSeq, lastMs: st.lastMs,
      pattern: el.pattern.value, flags: flagStr(), flavor: el.flavor.value, source: st.prepared && st.prepared.source, jsFlags: st.prepared && st.prepared.flags,
      count: r ? r.count : null, rows: r ? r.rows.slice(0, 50) : [], replaced: r && r.replaced ? r.replaced.slice(0, 4000) : null,
      warnings: [...el.warnings.querySelectorAll('li.warn')].map((x) => x.textContent), notes: [...el.warnings.querySelectorAll('li.note')].map((x) => x.textContent),
      svgBoxes: st.diagramBoxes, svg: !!el.diagram.querySelector('svg'), explainLines: el.explain.querySelectorAll('li').length,
      marks: el.backdrop.querySelectorAll('mark').length, sampleLen: el.sample.value.length, sampleName: st.sampleName, sampleInfo: el.sampleInfo.textContent,
      tableRows: el.table.tBodies[0].rows.length, matchInfo: el.matchInfo.textContent, tab: st.tab, label: st.label, error: st.error,
    };
  };

  vscode.postMessage({ type: 'ready' });
})();
