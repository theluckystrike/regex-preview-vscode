'use strict';
// Regex Preview & Regex Tester. A "Test regex" CodeLens over regexes in 9 languages and a side panel that tests the
// pattern on your own sample text, with groups, replace preview, a railroad diagram and explain lines.
// No language server, no TypeScript plugin, no network. Matching runs in a Web Worker in the panel with a time limit.
const vscode = require('vscode');
const fs = require('fs');
const { findRegexes, toSource } = require('./detect');
const { buildHtml } = require('./html');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const EXT_ID = 'zovo.zovo-regex-preview';
const SECTION = 'regexPreview';
const VIEW = 'regexPreview.panel';
const SAMPLE_KEY = 'regexPreview.sample.v1';
const STATE_KEY = 'regexPreview.state.v1';
const MAX_STORED_SAMPLE = 512 * 1024; // sample text kept per workspace
const LENS_LANGS = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'vue', 'svelte', 'astro', 'python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'php', 'ruby'];
const FLAVOR_OF_LANG = { python: 'python', go: 'go', rust: 'go', java: 'java', kotlin: 'java', csharp: 'dotnet', php: 'pcre', ruby: 'pcre' };

let rating = { success() {}, failure() {} };
let panel = null;

const cfg = () => vscode.workspace.getConfiguration(SECTION);

const DEFAULT_SAMPLE = [
  'Paste or type your own text here. Matches are highlighted as you type.',
  '',
  'alice@example.com, bob.smith+news@mail.example.org, not-an-email@',
  'Released v1.4.2 on 2026-11-08, hotfix v1.4.3-rc.1+build.7 on 2026-11-09.',
  'Server 192.168.1.20 answered https://example.com:8443/api/v2/users?id=42 in $12.50.',
  '203.0.113.7 - alice [08/Nov/2026:09:12:01 +0700] "GET /api/v2/users HTTP/1.1" 200 5123',
].join('\n');

class RegexPanel {
  constructor(context, wp, initial) {
    this.context = context;
    this.panel = wp;
    this.ready = false;
    this.pending = [];
    this.sourceUri = null;
    this.countNext = true; // the first good run after opening counts once for the rating ask
    this.disposables = [];
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    wp.webview.options = { enableScripts: true, localResourceRoots: [media], enableCommandUris: commandUris(SECTION) };
    wp.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'panel-icon.svg');
    wp.webview.html = buildHtml(wp.webview, context.extensionUri, { showSupportLinks: showLinks(vscode, SECTION), timeoutMs: this.timeoutMs() });
    wp.onDidDispose(() => this.dispose(), null, this.disposables);
    wp.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    if (initial) this.load(initial);
  }

  timeoutMs() { return Math.max(200, Math.min(10000, Number(cfg().get('timeoutMs', 1000)) || 1000)); }

  post(msg) {
    if (this.ready) this.panel.webview.postMessage(msg);
    else this.pending.push(msg);
  }

  /** Shows a pattern. p: { pattern, flags, flavor, label, uri } */
  load(p) {
    this.sourceUri = p.uri || null;
    this.countNext = true;
    this.post({ type: 'load', pattern: p.pattern, flags: p.flags || '', flavor: p.flavor || 'javascript', label: p.label || '' });
  }

  async onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'ready': {
        this.ready = true;
        const saved = this.context.workspaceState.get(STATE_KEY) || {};
        const sample = this.context.workspaceState.get(SAMPLE_KEY);
        this.panel.webview.postMessage({
          type: 'init',
          sample: typeof sample === 'string' ? sample : DEFAULT_SAMPLE,
          state: saved,
          settings: { timeoutMs: this.timeoutMs(), maxMatchRows: Number(cfg().get('maxMatchRows', 1000)) || 1000, defaultFlags: String(cfg().get('defaultFlags', 'g')) },
        });
        for (const x of this.pending.splice(0)) this.panel.webview.postMessage(x);
        break;
      }
      case 'state': {
        const st = { pattern: String(m.pattern || '').slice(0, 20000), flags: String(m.flags || '').slice(0, 10), flavor: String(m.flavor || ''), replacement: String(m.replacement || '').slice(0, 5000), tab: String(m.tab || '') };
        this.context.workspaceState.update(STATE_KEY, st);
        if (typeof m.sample === 'string' && m.sample.length <= MAX_STORED_SAMPLE) this.context.workspaceState.update(SAMPLE_KEY, m.sample);
        break;
      }
      case 'result': {
        // The tool worked: a valid pattern ran on the sample. Counts once per regex opened from code (or per panel),
        // not once per keystroke.
        if (m.ok && this.countNext) {
          this.countNext = false;
          if (this.sourceUri) rating.success(this.sourceUri);
          else rating.success();
        }
        break;
      }
      case 'loadSample': await pickSampleFile(this); break;
      case 'resetSample': this.context.workspaceState.update(SAMPLE_KEY, undefined); this.panel.webview.postMessage({ type: 'sample', text: DEFAULT_SAMPLE, name: '' }); break;
      case 'copy': if (typeof m.text === 'string') { await vscode.env.clipboard.writeText(m.text); vscode.window.setStatusBarMessage('Regex Preview: copied', 2500); } break;
      case 'copyAs': {
        if (typeof m.pattern !== 'string') break;
        const code = m.target === 'raw' ? m.pattern : toSource(m.pattern, String(m.flags || ''), String(m.target || ''));
        await vscode.env.clipboard.writeText(code);
        vscode.window.setStatusBarMessage('Regex Preview: copied ' + (code.length > 60 ? code.slice(0, 57) + '...' : code), 3000);
        break;
      }
      case 'export': await exportFile(m); break;
      case 'openSettings': vscode.commands.executeCommand('workbench.action.openSettings', SECTION); break;
      default: break;
    }
  }

  dispose() {
    if (panel === this) panel = null;
    for (const d of this.disposables.splice(0)) { try { d.dispose(); } catch { /* gone */ } }
  }
}

function showPanel(context, initial) {
  if (panel) {
    panel.panel.reveal(panel.panel.viewColumn || vscode.ViewColumn.Beside, true);
    if (initial) panel.load(initial);
    return panel;
  }
  const wp = vscode.window.createWebviewPanel(VIEW, 'Regex Preview', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
  panel = new RegexPanel(context, wp, initial);
  return panel;
}

async function exportFile(m) {
  const isPng = m.format === 'png';
  const defName = 'regex-diagram.' + (isPng ? 'png' : 'svg');
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const target = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder.uri, defName) : undefined,
    filters: isPng ? { 'PNG image': ['png'] } : { 'SVG image': ['svg'] },
    saveLabel: 'Export',
  });
  if (!target) return;
  let bytes;
  if (isPng) {
    const b64 = String(m.data || '').replace(/^data:image\/png;base64,/, '');
    bytes = Buffer.from(b64, 'base64');
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) { vscode.window.showErrorMessage('Regex Preview: the PNG could not be made.'); return; }
  } else {
    const svg = String(m.data || '');
    if (!svg.startsWith('<svg')) return;
    bytes = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n' + svg, 'utf8');
  }
  await vscode.workspace.fs.writeFile(target, bytes);
  vscode.window.setStatusBarMessage('Regex Preview: saved ' + target.fsPath, 4000);
}

/** Reads a file as sample text. Big files are read only up to the limit (a range read), never whole. */
async function readSample(uri) {
  const maxMB = Math.max(1, Math.min(100, Number(cfg().get('maxSampleMB', 10)) || 10));
  const cap = Math.floor(maxMB * 1024 * 1024);
  const st = await vscode.workspace.fs.stat(uri);
  const size = st.size;
  let buf;
  if (uri.scheme === 'file') {
    const fd = fs.openSync(uri.fsPath, 'r');
    try {
      const want = Math.min(size, cap);
      buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) { const r = fs.readSync(fd, buf, got, want - got, got); if (r <= 0) break; got += r; }
      buf = buf.subarray(0, got);
    } finally { fs.closeSync(fd); }
  } else {
    if (size > cap) return { error: 'This file is ' + mb(size) + '. Files over ' + maxMB + ' MB can only be read from a local disk (setting regexPreview.maxSampleMB).' };
    buf = Buffer.from(await vscode.workspace.fs.readFile(uri));
  }
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  if (head.includes(0)) return { error: 'This looks like a binary file, so it was not used as sample text.' };
  let text = buf.toString('utf8');
  // a cut in the middle of a UTF-8 character leaves a replacement character at the end
  if (size > buf.length) text = text.replace(/�+$/, '');
  return { text, size, truncated: size > buf.length, cap };
}

function mb(n) { return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB'; }

async function sendSample(p, uri) {
  try {
    const r = await readSample(uri);
    if (r.error) { vscode.window.showWarningMessage('Regex Preview: ' + r.error); p.post({ type: 'notice', text: r.error }); return; }
    const name = uri.path.split('/').pop();
    p.post({ type: 'sample', text: r.text, name, size: r.size, truncated: r.truncated, readBytes: Buffer.byteLength(r.text, 'utf8') });
    if (r.truncated) vscode.window.showInformationMessage(`Regex Preview: ${name} is ${mb(r.size)}; the first ${mb(r.cap)} is used as sample text (setting regexPreview.maxSampleMB).`);
  } catch (e) {
    vscode.window.showErrorMessage('Regex Preview: could not read the file: ' + (e && e.message || e));
    rating.failure();
  }
}

async function pickSampleFile(p) {
  const pick = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use as sample text' });
  if (pick && pick[0]) await sendSample(p, pick[0]);
}

function lensFor(doc, pos) {
  const text = doc.getText();
  const found = findRegexes(text, doc.languageId);
  if (!found.length) return null;
  const off = doc.offsetAt(pos);
  // the regex on the cursor line, or the nearest one above it
  let best = null;
  for (const r of found) {
    const line = doc.positionAt(r.offset).line;
    if (line === pos.line && off >= r.offset - 1 && off <= r.offset + r.length + 1) return r;
    if (line === pos.line && !best) best = r;
  }
  return best;
}

class LensProvider {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeCodeLenses = this.emitter.event; }
  provideCodeLenses(doc, token) {
    if (!cfg().get('codeLens', true)) return [];
    const maxKB = Number(cfg().get('codeLensMaxFileKB', 1024)) || 1024;
    const text = doc.getText();
    if (text.length > maxKB * 1024) return [];
    const found = findRegexes(text, doc.languageId);
    const lenses = [];
    for (const r of found) {
      if (token && token.isCancellationRequested) break;
      const start = doc.positionAt(r.offset);
      const range = new vscode.Range(start, doc.positionAt(r.offset + r.length));
      lenses.push(new vscode.CodeLens(range, {
        title: 'Test regex',
        tooltip: 'Open this regex in Regex Preview: matches, groups, replace and a railroad diagram',
        command: 'regexPreview.testAt',
        arguments: [{ pattern: r.pattern, flags: r.flags, flavor: r.flavor, uri: doc.uri.toString(), line: start.line }],
      }));
    }
    return lenses;
  }
}

function activate(context) {
  registerSupport({ vscode, context, prefix: SECTION, selfId: EXT_ID });
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: SECTION, name: 'Regex Preview' });
  const lens = new LensProvider();
  const label = (uri, line) => (uri ? uri.path.split('/').pop() + (line !== undefined ? ':' + (line + 1) : '') : '');

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(LENS_LANGS.map((language) => ({ language })), lens),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(SECTION)) lens.emitter.fire(); }),

    vscode.commands.registerCommand('regexPreview.testAt', (arg) => {
      if (!arg || typeof arg.pattern !== 'string') return showPanel(context);
      const uri = arg.uri ? vscode.Uri.parse(arg.uri) : null;
      showPanel(context, { pattern: arg.pattern, flags: arg.flags, flavor: arg.flavor, uri, label: label(uri, arg.line) });
    }),

    vscode.commands.registerCommand('regexPreview.open', () => {
      const ed = vscode.window.activeTextEditor;
      if (ed && !ed.selection.isEmpty) return openSelection(context, ed);
      if (ed) {
        const r = lensFor(ed.document, ed.selection.active);
        if (r) return showPanel(context, { pattern: r.pattern, flags: r.flags, flavor: r.flavor, uri: ed.document.uri, label: label(ed.document.uri, ed.document.positionAt(r.offset).line) });
      }
      return showPanel(context);
    }),

    vscode.commands.registerCommand('regexPreview.testSelection', () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) { vscode.window.showInformationMessage('Regex Preview: select the text of a pattern first.'); return; }
      return openSelection(context, ed);
    }),

    vscode.commands.registerCommand('regexPreview.useFileAsSample', async (uri) => {
      let target = uri instanceof vscode.Uri ? uri : null;
      const ed = vscode.window.activeTextEditor;
      const p = showPanel(context);
      if (!target && ed) {
        // the open editor's own text (it may have unsaved changes)
        const doc = ed.document;
        const maxMB = Math.max(1, Math.min(100, Number(cfg().get('maxSampleMB', 10)) || 10));
        let text = doc.getText();
        const truncated = text.length > maxMB * 1024 * 1024;
        if (truncated) text = text.slice(0, maxMB * 1024 * 1024);
        p.post({ type: 'sample', text, name: label(doc.uri), size: text.length, truncated });
        return;
      }
      if (!target) { await pickSampleFile(p); return; }
      await sendSample(p, target);
    }),

    vscode.commands.registerCommand('regexPreview.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#regexPreview.start`, false)),

    vscode.window.registerWebviewPanelSerializer(VIEW, {
      async deserializeWebviewPanel(wp) {
        wp.webview.options = { enableScripts: true };
        panel = new RegexPanel(context, wp, null);
      },
    }),
  );
}

function openSelection(context, ed) {
  let text = ed.document.getText(ed.selection);
  let flags = '';
  let flavor = FLAVOR_OF_LANG[ed.document.languageId] || 'javascript';
  // a selected /literal/flags is unwrapped
  const lit = /^\/([\s\S]+)\/([dgimsuyv]*)$/.exec(text.trim());
  if (lit && !FLAVOR_OF_LANG[ed.document.languageId]) { text = lit[1]; flags = lit[2]; }
  if (text.length > 20000) { vscode.window.showWarningMessage('Regex Preview: the selection is longer than 20,000 characters; select only the pattern.'); return; }
  const line = ed.selection.start.line;
  showPanel(context, { pattern: text, flags, flavor, uri: ed.document.uri, label: ed.document.uri.path.split('/').pop() + ':' + (line + 1) });
}

function deactivate() {}

module.exports = { activate, deactivate, readSample, DEFAULT_SAMPLE, LENS_LANGS };
