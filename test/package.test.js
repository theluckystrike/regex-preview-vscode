'use strict';
// package.json rules for every Zovo build, the webview CSP, and the extension wiring with a fake VS Code API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('display name has every word of each target phrase, phrase first', () => {
  const name = pkg.displayName.toLowerCase();
  assert.ok(name.startsWith('regex preview'), name);
  for (const phrase of ['regex preview', 'regex tester', 'regex visualizer', 'railroad diagram']) {
    for (const w of phrase.split(' ')) assert.ok(name.includes(w), `${w} missing from ${pkg.displayName}`);
  }
});

test('engines floor and @types/vscode follow out/OVX1-engine.txt', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.devDependencies['@types/vscode'], '~1.90.0');
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'no runtime dependencies');
});

test('id, publisher, icon, repository, sponsor, licence', () => {
  assert.equal(pkg.publisher, 'zovo');
  assert.equal(pkg.name, 'zovo-regex-preview');
  assert.equal(pkg.license, 'MIT');
  assert.ok(fs.existsSync(path.join(root, pkg.icon)));
  assert.match(pkg.repository.url, /github\.com\/theluckystrike\/regex-preview-vscode$/);
  assert.equal(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike');
  assert.ok(fs.existsSync(path.join(root, 'LICENSE')));
});

test('every contributed command has a handler string in extension.js or support.js', () => {
  const src = fs.readFileSync(path.join(root, 'src/extension.js'), 'utf8') + fs.readFileSync(path.join(root, 'src/support.js'), 'utf8');
  for (const c of pkg.contributes.commands) {
    const short = c.command.split('.')[1];
    assert.ok(src.includes(`'${c.command}'`) || src.includes(`.${short}\``) || src.includes(`\${prefix}.${short}`), c.command);
  }
});

test('settings: rating and support switches exist; walkthrough media files exist', () => {
  const props = pkg.contributes.configuration.properties;
  assert.equal(props['regexPreview.askForRating'].default, true);
  assert.equal(props['regexPreview.showSupportLinks'].default, true);
  assert.equal(props['regexPreview.timeoutMs'].default, 1000);
  for (const w of pkg.contributes.walkthroughs) for (const s of w.steps) assert.ok(fs.existsSync(path.join(root, s.media.markdown)), s.media.markdown);
});

test('the vsix keeps tests, scripts, samples and images out', () => {
  const ign = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  for (const p of ['test/**', 'scripts/**', 'samples/**', 'images/**']) assert.ok(ign.includes(p), p);
});

test('no network code in the shipped files', () => {
  const files = ['src/extension.js', 'src/detect.js', 'src/html.js', 'media/panel.js', 'media/core/regex-parse.js', 'media/core/match.js', 'media/core/railroad.js'];
  for (const f of files) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|require\(['"]https?['"]\)|sendBeacon|EventSource/.test(s), f);
  }
});

// ---- the panel HTML and CSP ----
function withFakeVscode(fn) {
  const fake = {
    Uri: { joinPath: (u, ...p) => ({ toString: () => [u.toString(), ...p].join('/'), path: [u.path || '', ...p].join('/') }) },
  };
  const orig = Module._load;
  Module._load = function (req, parent, isMain) { if (req === 'vscode') return fake; return orig.call(this, req, parent, isMain); };
  try { return fn(fake); } finally { Module._load = orig; }
}

test('panel HTML: strict CSP, nonce scripts, blob worker, no inline handlers', () => {
  withFakeVscode(() => {
    delete require.cache[require.resolve('../src/html.js')];
    const { buildHtml } = require('../src/html.js');
    const webview = { cspSource: 'vscode-webview://x', asWebviewUri: (u) => 'vscode-resource:' + u.toString() };
    const html = buildHtml(webview, { toString: () => 'ext', path: '/ext' }, { showSupportLinks: true, timeoutMs: 1000 });
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1].replace(/&#39;/g, "'");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9]+'/);
    assert.match(csp, /worker-src blob:/);
    assert.match(csp, /connect-src 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval|https?:/.test(csp), csp);
    const nonce = /'nonce-([A-Za-z0-9]+)'/.exec(csp)[1];
    const scripts = html.match(/<script[^>]*>/g);
    assert.equal(scripts.length, 4);
    for (const s of scripts) assert.ok(s.includes(`nonce="${nonce}"`), s);
    assert.ok(!/\son[a-z]+=/.test(html.replace(/onerror|onload/g, (m) => m)), 'inline event handler');
    assert.ok(html.includes('id="zovo-support"'), 'support footer');
    assert.ok(html.includes('data-timeout="1000"'));
  });
});

test('panel HTML without support links when the setting is off', () => {
  withFakeVscode(() => {
    const { buildHtml } = require('../src/html.js');
    const webview = { cspSource: 'x', asWebviewUri: (u) => String(u) };
    const html = buildHtml(webview, { toString: () => 'e' }, { showSupportLinks: false });
    assert.ok(!html.includes('id="zovo-support"'));
  });
});

test('readSample reads only up to the cap from a big local file (range read)', async () => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b13-'));
  const big = path.join(dir, 'big.log');
  const fd = fs.openSync(big, 'w');
  const line = 'x'.repeat(1023) + '\n';
  for (let i = 0; i < 3 * 1024; i++) fs.writeSync(fd, line); // 3 MB
  fs.closeSync(fd);
  const bin = path.join(dir, 'b.bin');
  fs.writeFileSync(bin, Buffer.from([1, 2, 0, 3]));
  const fake = {
    Uri: { file: (p) => ({ scheme: 'file', fsPath: p, path: p }) },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => (k === 'maxSampleMB' ? 1 : d) }),
      fs: { stat: async (u) => ({ size: fs.statSync(u.fsPath).size }), readFile: async () => { throw new Error('must not read the whole file'); } },
    },
  };
  const orig = Module._load;
  Module._load = function (req, parent, isMain) { if (req === 'vscode') return fake; return orig.call(this, req, parent, isMain); };
  try {
    delete require.cache[require.resolve('../src/extension.js')];
    const ext = require('../src/extension.js');
    const r = await ext.readSample(fake.Uri.file(big));
    assert.equal(r.truncated, true);
    assert.equal(r.text.length, 1024 * 1024);
    assert.equal(r.size, 3 * 1024 * 1024);
    const b = await ext.readSample(fake.Uri.file(bin));
    assert.match(b.error, /binary/);
  } finally {
    Module._load = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CodeLens languages match the activation events', () => {
  const orig = Module._load;
  Module._load = function (req, parent, isMain) { if (req === 'vscode') return {}; return orig.call(this, req, parent, isMain); };
  try {
    delete require.cache[require.resolve('../src/extension.js')];
    const { LENS_LANGS } = require('../src/extension.js');
    for (const l of LENS_LANGS) {
      if (l === 'astro') continue;
      assert.ok(pkg.activationEvents.includes('onLanguage:' + l), l);
    }
  } finally { Module._load = orig; }
});
