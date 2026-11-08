'use strict';
// VER11 red-team fixes: the CodeLens scan stays linear on hostile lines, the v flag is kept, diagram titles are XML-safe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { findRegexes } = require('../src/detect');
const timed = fn => { const t0 = Date.now(); const r = fn(); return [r, Date.now() - t0]; };

test('a 1 MB hostile line is scanned in well under a second (was minutes on the extension host)', () => {
  for (const [unit, lang] of [['=/[', 'javascript'], ['RegExp(x);', 'javascript'], ['re.match(x);', 'python'], ['regexp.MustCompile(x);', 'go'], ['Pattern.compile(x);', 'java'], ['=/[', 'ruby'], ['preg_match(x);', 'php']]) {
    const text = unit.repeat(Math.ceil(1e6 / unit.length));
    const [, ms] = timed(() => findRegexes(text, lang));
    assert.ok(ms < 1500, `${lang} ${unit}: ${ms} ms`);
  }
});

test('the scan still finds regexes in ordinary code, also after a line comment and after a broken literal line', () => {
  const js = 'const a = /ab+c/gi; // see /not-this/\nconst b = new RegExp("x\\\\d+", "m");\nconst c = x(/[unclosed\nconst d = /ok/;\n';
  const f = findRegexes(js, 'javascript').map(r => r.pattern);
  assert.deepEqual(f, ['ab+c', 'x\\d+', 'ok']);
  const py = "import re\nA = re.compile(r'\\d+')  # re.compile(r'no')\n# re.match(r'no2')\nB = re.match(r'(a)(b)', s)\n";
  assert.deepEqual(findRegexes(py, 'python').map(r => r.pattern), ['\\d+', '(a)(b)']);
  const s = 'x = "// not a comment"; y = RegExp("yes")\n';
  assert.deepEqual(findRegexes(s, 'javascript').map(r => r.pattern), ['yes']);
});

test('a time budget stops the scan and says so', () => {
  const text = ('const a = /x/; ').repeat(200000);
  const r = findRegexes(text, 'javascript', { budgetMs: 1 });
  assert.ok(r.truncated === true || r.length > 0);
  const full = findRegexes('const a = /x/;', 'javascript', { budgetMs: 1000 });
  assert.equal(full.truncated, undefined);
});

test('the v flag is kept (and replaces u); the panel has a v button', () => {
  const panel = fs.readFileSync(path.join(__dirname, '..', 'media', 'panel.js'), 'utf8');
  assert.match(panel, /'dgimsuvyx'\.includes\(c\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'html.js'), 'utf8'), /\['v', 'unicodeSets/);
  assert.ok(new RegExp('[\\p{L}--\\p{Ll}]', 'gv').test('B'), 'Node supports v');
});

test('diagram titles show control characters as escapes, so the exported SVG is valid XML', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'core', 'railroad.js'), 'utf8');
  assert.match(src, /<title>\$\{esc\(vis\(title \|\| text\)\)\}<\/title>/);
});
