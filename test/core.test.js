'use strict';
// Unit tests for the pure core: parser / flavor translation, explain, runMatch, railroad.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../media/core/regex-parse.js');
const M = require('../media/core/match.js');
const RR = require('../media/core/railroad.js');

const compiles = (src, flags) => { try { new RegExp(src, flags); return true; } catch (e) { return false; } };
// Prepare for a flavor, assert ok + compiles, return a RegExp built from the translation.
function prep(p, flags, flavor) {
  const r = P.prepare(p, flags, flavor);
  assert.equal(r.ok, true, `${flavor} ${p}: ${r.error}`);
  assert.ok(compiles(r.source, r.flags), `${flavor} ${p} -> /${r.source}/${r.flags} does not compile`);
  return { r, re: new RegExp(r.source, r.flags) };
}
const full = (re, s) => { const m = new RegExp('^(?:' + re.source + ')$', re.flags.replace('g', '')).exec(s); return !!m; };

// ---------------- prepare: translation per flavor ----------------

test('prepare: every flavor translates a common pattern that compiles and matches the same strings', () => {
  const p = '^(\\w+)@([a-z]+)\\.(?:com|org)$';
  for (const fl of Object.keys(P.FLAVORS)) {
    const { re } = prep(p, '', fl);
    assert.equal(re.test('bob@example.com'), true, fl);
    assert.equal(re.test('bob@example.net'), false, fl);
    assert.equal(re.test('bob@@x.org'), false, fl);
  }
});

test('prepare: non-JS flavors always add the u flag and drop x', () => {
  for (const fl of ['python', 'java', 'dotnet', 'go', 'pcre']) {
    const r = P.prepare('a b', 'gix', fl);
    assert.equal(r.ok, true);
    assert.ok(r.flags.includes('u') && r.flags.includes('g') && r.flags.includes('i'), r.flags);
    assert.ok(!r.flags.includes('x'));
    assert.equal(r.source, 'ab');
  }
});

test('prepare python: (?P<n>..) and (?P=n) become JS named group and \\k<n>', () => {
  const { r, re } = prep('(?P<w>\\w+) (?P=w)', '', 'python');
  assert.equal(r.source, '(?<w>\\w+) \\k<w>');
  assert.equal(re.exec('hey hey').groups.w, 'hey');
  assert.equal(full(re, 'hey you'), false);
  assert.deepEqual(r.groups, [{ index: 1, name: 'w' }]);
});

test('prepare python: \\A and \\Z are absolute text anchors', () => {
  const { re } = prep('\\Aab\\Z', 'm', 'python');
  assert.equal(re.test('ab'), true);
  assert.equal(re.test('ab\n'), false, 'Python \\Z does not allow a final newline');
  assert.equal(re.test('x\nab'), false, '\\A is not a line start even with m');
});

test('prepare python: $ also matches before a trailing newline (no m flag), with a note', () => {
  const { r, re } = prep('abc$', '', 'python');
  assert.equal(re.test('abc'), true);
  assert.equal(re.test('abc\n'), true);
  assert.equal(re.test('abc\n\n'), false);
  assert.equal(re.test('abc\nx'), false);
  assert.ok(r.notes.some((n) => /\$ also matches before a newline/.test(n)));
});

test('prepare python: inline (?i) and (?s) at the start are hoisted into flags', () => {
  const { r, re } = prep('(?is)a.b', '', 'python');
  assert.equal(r.source, 'a.b');
  assert.ok(r.flags.includes('i') && r.flags.includes('s'));
  assert.equal(re.test('A\nB'), true);
});

test('prepare python: inline flags in the middle are not hoisted and warn', () => {
  const r = P.prepare('a(?i)b', '', 'python');
  assert.equal(r.ok, true);
  assert.ok(!r.flags.includes('i'));
  assert.ok(r.warnings.some((w) => /middle of the pattern/.test(w)));
});

test('prepare python: (?x) strips whitespace and comments, keeps class content and escaped spaces', () => {
  const { r, re } = prep('(?x) a b # comment ) here\n [ #]\\ c', '', 'python');
  assert.equal(r.source, 'ab[ #] c');
  assert.equal(re.test('ab# c'), true);
  assert.equal(re.test('ab  c'), true);
  assert.equal(re.test('abc'), false);
});

test('prepare python: the x flag works like (?x)', () => {
  const { r } = prep('\\d+ \\. # dot\n \\d+', 'x', 'python');
  assert.equal(r.source, '\\d+\\.\\d+');
});

test('prepare python: the verbose LINE pattern from log_parser.py parses an access.log line', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'samples', 'log_parser.py'), 'utf8');
  const pat = /r"""([\s\S]*?)"""/.exec(src)[1];
  const { re } = prep(pat, 'x', 'python');
  const line = fs.readFileSync(path.join(__dirname, '..', 'samples', 'access.log'), 'utf8').split('\n')[0];
  const m = re.exec(line);
  assert.ok(m);
  assert.equal(m.groups.ip, '203.0.113.7');
  assert.equal(m.groups.method, 'GET');
  assert.equal(m.groups.status, '200');
  assert.equal(m.groups.size, '5123');
});

test('prepare python: {,3} is a quantifier only in Python', () => {
  assert.equal(P.prepare('a{,3}', '', 'python').source, 'a{0,3}');
  const j = P.prepare('a{,3}', '', 'java');
  assert.ok(new RegExp(j.source, j.flags).test('a{,3}'));
});

test('prepare java: \\Q..\\E quotes metacharacters', () => {
  const { r, re } = prep('\\Qa.b*c\\E+?', '', 'java');
  assert.ok(re.test('a.b*c'));
  assert.equal(new RegExp('^' + r.source + '$', 'u').test('aXbbc'), false);
});

test('prepare java: \\Q..\\E followed by a quantifier repeats only the last character', () => {
  const { re } = prep('\\Qab\\E+', '', 'java');
  assert.equal(full(re, 'abb'), true);
  assert.equal(full(re, 'abab'), false);
});

test('prepare pcre: POSIX classes, \\h and \\R', () => {
  const { re } = prep('^[[:alpha:]]+\\h[[:digit:]]+\\R$', '', 'pcre');
  assert.ok(re.test('abc\t123\r\n'));
  assert.ok(re.test('abc 1\n'));
  assert.ok(!re.test('ab1 1\n'));
  const { re: x } = prep('[[:xdigit:]]{2}', '', 'pcre');
  assert.ok(x.test('fA') && !x.test('gg'));
});

test('prepare pcre: a negated POSIX class [[:^digit:]] matches non-digits', () => {
  const { re } = prep('[[:^digit:]]', '', 'pcre');
  assert.equal(re.test('a'), true);
  assert.equal(re.test('5'), false);
});

test('prepare pcre: \\g<1> is a subroutine call (PCRE/Ruby), not a backreference', () => {
  const r = P.prepare('(a|b)\\g<1>', '', 'pcre');
  // PCRE matches "ab"; a backreference would not. Either a warning or a correct translation is acceptable.
  const re = new RegExp('^(?:' + r.source + ')$', r.flags);
  assert.ok(re.test('ab') || r.warnings.some((w) => /subroutine|recursion/i.test(w)));
});

test('prepare pcre: \\g{-1} relative backreference', () => {
  const { re } = prep('(a)(b)\\g{-1}', '', 'pcre');
  assert.ok(full(re, 'abb') && !full(re, 'aba'));
});

test('prepare go: \\pL and \\z', () => {
  const { r, re } = prep('^\\pL+\\z', '', 'go');
  assert.equal(r.source, '^\\p{L}+(?![\\s\\S])');
  assert.ok(re.test('héllo'));
  assert.ok(!re.test('h3llo'));
});

test('prepare java/pcre: \\p{Alpha} becomes an ASCII class', () => {
  const { re } = prep('^\\p{Alpha}+$', '', 'java');
  assert.ok(re.test('abc') && !re.test('é'));
});

test('prepare: quantified lookahead in Python compiles', () => {
  prep('(?=a)?b', '', 'python');
});

test('prepare dotnet: duplicate group names say they cannot be tested in JavaScript', () => {
  const r = P.prepare('(?<n>a)|(?<n>b)', '', 'dotnet');
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot be tested in JavaScript/);
});

test('prepare: escaping of literal metacharacters after rebuild', () => {
  const { re } = prep('a\\.b\\*c\\/d\\[e\\]\\{f\\}', '', 'python');
  assert.ok(re.test('a.b*c/d[e]{f}'));
});

// ---------------- prepare: warnings ----------------

const warns = (p, fl, f) => P.prepare(p, f || '', fl).warnings.join('\n');

test('warning: possessive quantifier in Python mentions 3.11', () => {
  assert.match(warns('\\w++', 'python'), /3\.11/);
  assert.match(warns('a*+', 'go'), /RE2/);
  assert.match(warns('a?+', 'dotnet'), /atomic/);
});

test('warning: atomic group', () => {
  assert.match(warns('(?>ab|a)c', 'python'), /Atomic group.*3\.11/);
  assert.match(warns('(?>ab|a)c', 'java'), /Atomic group/);
  assert.equal(P.prepare('(?>ab|a)c', '', 'java').source, '(?:ab|a)c');
});

test('warning: Go lookaround and backreference', () => {
  assert.match(warns('a(?=b)', 'go'), /no lookahead or lookbehind/);
  assert.match(warns('(?<=a)b', 'go'), /no lookahead or lookbehind/);
  assert.match(warns('(a)\\1', 'go'), /no backreferences/);
  assert.equal(warns('(a)b', 'go'), '');
});

test('warning: Python (?<name>) and \\p{}', () => {
  assert.match(warns('(?<n>a)', 'python'), /\(\?P<name>/);
  assert.match(warns('\\p{L}', 'python'), /no \\p\{\.\.\.\}/);
  assert.match(warns('(?P<n>a)\\k<n>', 'python'), /no \\k<name>/);
  assert.equal(warns('(?P<n>a)(?P=n)', 'python'), '');
});

test('warning: Python variable-width lookbehind, fixed width is fine', () => {
  assert.match(warns('(?<=a|bc)d', 'python'), /fixed width/);
  assert.match(warns('(?<!x+)d', 'python'), /fixed width/);
  assert.equal(warns('(?<=ab|cd)e', 'python'), '');
});

test('warning: Java unbounded lookbehind, bounded is fine', () => {
  assert.match(warns('(?<=a+)b', 'java'), /bounded length/);
  assert.equal(warns('(?<=a{1,3})b', 'java'), '');
  assert.match(warns('(?<=a*)b', 'pcre'), /unbounded/);
});

test('warning: Java/.NET reject Python-style named groups', () => {
  assert.match(warns('(?P<n>a)', 'java'), /Java has no \(\?P<name>/);
  assert.match(warns('(?P<n>a)(?P=n)', 'dotnet'), /\.NET has no \(\?P=name\)/);
});

test('warning: PCRE \\K and recursion cannot be tested', () => {
  assert.match(warns('a\\Kb', 'pcre'), /\\K cannot be tested/);
  assert.match(warns('a(?R)?b', 'pcre'), /Recursion/);
});

// ---------------- prepare: errors with positions ----------------

test('error: unclosed group points at the (', () => {
  const r = P.prepare('ab(cd', '', 'python');
  assert.equal(r.ok, false);
  assert.match(r.error, /Missing \)/);
  assert.equal(r.errorPos, 2);
});

test('error: unmatched )', () => {
  const r = P.prepare('ab)c', '', 'java');
  assert.equal(r.ok, false);
  assert.match(r.error, /Unmatched \)/);
  assert.equal(r.errorPos, 2);
});

test('error: nothing to repeat', () => {
  for (const [p, pos] of [['*a', 0], ['a|+b', 2], ['(?:?)', 3], ['a{2}', null]]) {
    const r = P.prepare(p, '', 'python');
    if (pos === null) { assert.equal(r.ok, true); continue; }
    assert.equal(r.ok, false, p);
    assert.match(r.error, /Nothing to repeat/);
    assert.equal(r.errorPos, pos, p);
  }
  assert.match(P.prepare('a**', '', 'python').error, /Multiple repeat/);
});

test('error: range out of order in a class and in {n,m}', () => {
  const r = P.prepare('x[z-a]', '', 'pcre');
  assert.equal(r.ok, false);
  assert.match(r.error, /Range out of order/);
  assert.equal(r.errorPos, 2);
  assert.match(P.prepare('a{3,2}', '', 'java').error, /out of order/);
});

test('error: unknown group name in a backreference', () => {
  const r = P.prepare('(?P<a>x)(?P=b)', '', 'python');
  assert.equal(r.ok, false);
  assert.match(r.error, /No group named "b"/);
  assert.equal(r.errorPos, 8);
  const j = P.prepare('(?<a>x)\\k<b>', '', 'java');
  assert.equal(j.errorPos, 7);
  assert.match(P.prepare('(a)\\2', '', 'pcre').error, /No group 2/);
});

test('error: duplicate group names (except .NET)', () => {
  for (const fl of ['javascript', 'python', 'java', 'go', 'pcre']) {
    const p = fl === 'python' || fl === 'go' ? '(?P<a>x)(?P<a>y)' : '(?<a>x)(?<a>y)';
    const r = P.prepare(p, '', fl);
    assert.equal(r.ok, false, fl);
    assert.match(r.error, /Duplicate group name "a"/);
  }
  assert.match(P.prepare('(?<a>x)(?<a>y)', '', 'dotnet').error, /cannot be tested in JavaScript/);
});

test('error: unclosed class and trailing backslash', () => {
  const r = P.prepare('ab[cd', '', 'go');
  assert.equal(r.ok, false);
  assert.equal(r.errorPos, 2);
  assert.match(P.prepare('ab\\', '', 'python').error, /at end of pattern/);
});

// ---------------- JavaScript flavor vs the engine ----------------

const JS_VALID = [
  'abc', '^\\d{3}-\\d{4}$', '[a-z]+', '(a|b)*c', '(?:x)+?', 'a{2,}', 'a{,3}', '\\bword\\b', '(?<y>\\d{4})-\\k<y>',
  '(?=a)\\w', '(?!a)\\w', '(?<=\\$)\\d+', '(?<!-)\\d', '[^\\]]', '[]', '[^]', '\\u00e9', '\\x41', '\\cJ', 'a|', '()',
  '[\\w.-]+@[\\w-]+', '(a)\\1', '.*?', 'a{', '\\/', '[/]', '\\p{L}',
];
for (const p of JS_VALID) {
  test(`js valid: ${p}`, () => {
    assert.ok(compiles(p, 'g'), 'engine accepts');
    const r = P.prepare(p, 'g', 'javascript');
    assert.equal(r.ok, true, r.error);
    assert.equal(r.source, p);
    assert.equal(r.flags, 'g');
  });
}

test('js valid with u: \\p{L}+ and \\u{1F600}', () => {
  for (const p of ['\\p{L}+', '\\u{1F600}', '[\\p{N}_]']) {
    assert.equal(P.prepare(p, 'gu', 'javascript').ok, true, p);
    assert.ok(compiles(p, 'gu'));
  }
});

// [pattern, flags, todo message when our parser and the engine are known to disagree]
const JS_INVALID = [
  ['(', ''], ['[a', ''], ['a**', ''], ['*a', ''], ['(?<n>a)(?<n>b)', ''], ['\\k<x>', 'u'], [')', ''], ['a{2,1}', ''],
  ['[z-a]', ''], ['\\', ''], ['(?<n>a)\\k<m>', ''], ['a{', 'u'], ['\\p{L', 'u'], ['\\u{110000}', 'u'],
  ['\\k<x>', ''],
  ['(?i)a', ''],
  ['(?>a)', ''],
  ['(?P<n>a)', ''],
  ['^*', ''],
  ['(?<=a)*', ''],
  ['\\1', 'u'],
  ['\\-', 'u'],
];
for (const [p, f, todo] of JS_INVALID) {
  test(`js parser and engine agree: /${p}/${f}`, todo ? { todo } : {}, () => {
    const engineOk = compiles(p, f);
    const ours = P.prepare(p, f, 'javascript').ok;
    assert.equal(ours, engineOk, `prepare ok=${ours}, new RegExp ok=${engineOk}`);
  });
}

// ---------------- explain ----------------

test('explain: depth, named groups and quantifier text', () => {
  const { ast } = P.parse('(?<year>\\d{4})-x+?|[^a-c]', { flavor: 'javascript' });
  const lines = P.explain(ast);
  assert.equal(lines[0].depth, 0);
  assert.match(lines[0].text, /Either of 2 options/);
  const named = lines.find((l) => /named "year"/.test(l.text));
  assert.ok(named);
  assert.equal(named.depth, 2);
  const inner = lines[lines.indexOf(named) + 1];
  assert.equal(inner.depth, 3);
  assert.match(inner.text, /exactly 4 times/);
  assert.ok(lines.some((l) => /one or more times, as few as possible \(lazy\)/.test(l.text)));
  assert.ok(lines.some((l) => /not: a to c/.test(l.text)));
  for (const l of lines) assert.ok(Number.isInteger(l.start) && Number.isInteger(l.end));
});

test('explain: lookarounds, backrefs, anchors, possessive and dotAll option', () => {
  const { ast } = P.parse('^(?=a)(?<!b)(x)\\1.a++$', { flavor: 'pcre' });
  const t = P.explain(ast).map((l) => l.text).join('\n');
  assert.match(t, /Start of the text/);
  assert.match(t, /lookahead/);
  assert.match(t, /negative lookbehind/);
  assert.match(t, /Group 1 \(captured\)/);
  assert.match(t, /same text that group 1 matched/);
  assert.match(t, /possessive/);
  assert.match(t, /Any character except a line break/);
  assert.match(P.explain(P.parse('.').ast, { dotAll: true })[0].text, /^Any character$/);
});

test('quantText and width helpers', () => {
  assert.equal(P.quantText({ min: 2, max: 5, lazy: false, possessive: false }), '2 to 5 times, as many as possible (greedy)');
  assert.deepEqual(P.width(P.parse('ab|c').ast), [1, 2]);
  assert.deepEqual(P.width(P.parse('a{2,3}').ast), [2, 3]);
  assert.deepEqual(P.width(P.parse('a+').ast), [1, Infinity]);
  assert.deepEqual(P.width(P.parse('(?=abc)x').ast), [1, 1]);
});

// ---------------- runMatch ----------------

function jsMatches(src, flags, text) {
  const f = flags.includes('g') ? flags : flags + 'g';
  const all = [...text.matchAll(new RegExp(src, f))];
  return flags.includes('g') ? all : all.slice(0, 1);
}

test('runMatch: counts, indices and groups equal a direct JS loop', () => {
  const src = '(\\d+)-(?<w>[a-z]+)?';
  const text = '1-a 22- 333-bcd x 4-';
  const r = M.runMatch({ source: src, flags: 'g', text });
  const want = jsMatches(src, 'g', text);
  assert.equal(r.ok, true);
  assert.equal(r.count, want.length);
  assert.deepEqual(r.rows.map((x) => [x.index, x.end, x.text]), want.map((m) => [m.index, m.index + m[0].length, m[0]]));
  for (let k = 0; k < want.length; k++) {
    assert.equal(r.rows[k].groups[0].v, want[k][1]);
    if (want[k][2] === undefined) assert.equal(r.rows[k].groups[1], null, 'non-participating group is null');
    else assert.deepEqual(r.rows[k].groups[1], { v: want[k][2], s: want[k].index + want[k][0].length - want[k][2].length, e: want[k].index + want[k][0].length, cut: false });
  }
  assert.deepEqual(r.hl, want.flatMap((m) => [m.index, m.index + m[0].length]));
});

test('runMatch: alternation with a group that does not participate gives null', () => {
  const r = M.runMatch({ source: '(a)|(b)', flags: 'g', text: 'b' });
  assert.equal(r.rows[0].groups[0], null);
  assert.deepEqual(r.rows[0].groups[1], { v: 'b', s: 0, e: 1, cut: false });
});

test('runMatch: without g only the first match', () => {
  const r = M.runMatch({ source: 'a', flags: 'i', text: 'xAaa' });
  assert.equal(r.count, 1);
  assert.equal(r.rows[0].index, 1);
  assert.equal(r.countCapped, false);
});

test('runMatch: zero-width matches on astral characters, with and without u', () => {
  const text = 'a😀b😀';
  for (const flags of ['g', 'gu']) {
    const r = M.runMatch({ source: '(?:)', flags, text });
    const want = jsMatches('(?:)', flags, text);
    assert.equal(r.count, want.length, flags);
    assert.deepEqual(r.rows.map((x) => x.index), want.map((m) => m.index));
  }
  assert.equal(M.runMatch({ source: '', flags: 'gu', text }).count, 5);
  assert.equal(M.runMatch({ source: '', flags: 'g', text }).count, 7);
  const zw = M.runMatch({ source: '(?=a)|\\b', flags: 'g', text: 'aa bb' });
  assert.equal(zw.count, jsMatches('(?=a)|\\b', 'g', 'aa bb').length);
});

test('advanceIndex steps one code point with unicode, one unit without', () => {
  assert.equal(M.advanceIndex('😀', 0, true), 2);
  assert.equal(M.advanceIndex('😀', 0, false), 1);
  assert.equal(M.advanceIndex('ab', 0, true), 1);
  assert.equal(M.advanceIndex('\ud83d', 0, true), 1, 'lone surrogate');
});

test('runMatch: maxRows switches to the fast regex and keeps counting', () => {
  const text = 'a'.repeat(5000);
  const r = M.runMatch({ source: '(a)', flags: 'g', text, maxRows: 100 });
  assert.equal(r.count, 5000);
  assert.equal(r.rows.length, 100);
  assert.equal(r.rows[99].index, 99);
  assert.equal(r.countCapped, false);
  const z = M.runMatch({ source: '', flags: 'g', text: 'abcdef', maxRows: 2 });
  assert.equal(z.count, 7, 'zero-width matches keep advancing after the switch');
});

test('runMatch: hlChars and hlMax caps', () => {
  const text = 'a'.repeat(1000);
  const r = M.runMatch({ source: 'a', flags: 'g', text, hlChars: 100 });
  assert.equal(r.hl.length, 200);
  assert.equal(r.count, 1000);
  const r2 = M.runMatch({ source: 'a', flags: 'g', text, hlMax: 10 });
  assert.equal(r2.hl.length, 20);
});

test('runMatch: maxCount caps the count and sets countCapped', () => {
  const r = M.runMatch({ source: 'a', flags: 'g', text: 'a'.repeat(100), maxCount: 50 });
  assert.equal(r.count, 50);
  assert.equal(r.countCapped, true);
});

test('runMatch: countCapped is false when the total equals maxCount exactly', () => {
  const r = M.runMatch({ source: 'a', flags: 'g', text: 'aaa', maxCount: 3 });
  assert.equal(r.count, 3);
  assert.equal(r.countCapped, false);
});

test('runMatch: replaceCap cuts the replaced text', () => {
  const r = M.runMatch({ source: 'a', flags: 'g', text: 'a'.repeat(1000), replacement: 'bb', replaceCap: 100 });
  assert.equal(r.replaced.length, 100);
  assert.equal(r.replacedCut, true);
  assert.equal(r.replaced, 'b'.repeat(100));
  const ok = M.runMatch({ source: 'a', flags: 'g', text: 'xax', replacement: 'b' });
  assert.equal(ok.replaced, 'xbx');
  assert.equal(ok.replacedCut, false);
  assert.equal(M.runMatch({ source: 'a', flags: 'g', text: 'a' }).replaced, null);
});

test('runMatch: replacement without g replaces only the first match', () => {
  assert.equal(M.runMatch({ source: 'a', flags: '', text: 'aaa', replacement: 'b' }).replaced, 'baa');
});

test('runMatch: invalid source returns ok false', () => {
  const r = M.runMatch({ source: '(', flags: 'g', text: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('runMatch: long matches are cut at 2000 characters', () => {
  const r = M.runMatch({ source: 'a+', flags: 'g', text: 'a'.repeat(3000) });
  assert.equal(r.rows[0].text.length, 2000);
  assert.equal(r.rows[0].cut, true);
  assert.equal(r.rows[0].end, 3000);
});

test('replacement javascript: same result as String.prototype.replace', () => {
  const src = '(\\w)(\\w)(?<n>\\d)?';
  const text = 'ab1 cd ef2';
  for (const tpl of ['$1', '$<n>', '$&', '$$', '[$`]', "[$']", '$2$1', '$10', '$0', '$<zz>', '$', '$3x']) {
    const r = M.runMatch({ source: src, flags: 'g', text, replacement: tpl, flavor: 'javascript' });
    assert.equal(r.replaced, text.replace(new RegExp(src, 'g'), tpl), tpl);
  }
});

test('replacement python: \\1 \\g<1> \\g<name> and escapes', () => {
  const { r } = prep('(?P<u>\\w+)@(?P<h>\\w+)', '', 'python');
  const out = M.runMatch({ source: r.source, flags: r.flags + 'g', text: 'x bob@home y', replacement: '\\2:\\g<1>:\\g<h>\\t\\\\', flavor: 'python' });
  assert.equal(out.replaced, 'x home:bob:home\t\\ y');
  assert.equal(M.expandReplacement('\\g<0>!', ['ab'], 'python'), 'ab!');
});

test('replacement java and dotnet: ${name} and $1', () => {
  const { r } = prep('(?<a>\\d)(\\d)', '', 'java');
  const j = M.runMatch({ source: r.source, flags: r.flags + 'g', text: '12', replacement: '${a}-$2-\\$', flavor: 'java' });
  assert.equal(j.replaced, '1-2-$');
  // Java reads $12 as group 1 then "2" when there are only 2 groups
  assert.equal(M.runMatch({ source: r.source, flags: r.flags, text: '12', replacement: '$12', flavor: 'java' }).replaced, '12');
  const d = M.runMatch({ source: r.source, flags: r.flags + 'g', text: 'x12', replacement: '${a}${2}$&$$[$_]', flavor: 'dotnet' });
  assert.equal(d.replaced, 'x1212$[x12]');
});

test('replacement go: $name ${1} $$ and $1x as a name', () => {
  const { r } = prep('(?P<a>\\d)(\\d)', '', 'go');
  const run = (tpl) => M.runMatch({ source: r.source, flags: r.flags, text: '12', replacement: tpl, flavor: 'go' }).replaced;
  assert.equal(run('$a/${2}/$$'), '1/2/$');
  assert.equal(run('$1x'), '', 'Go reads $1x as a group named 1x');
  assert.equal(run('${1}x'), '1x');
});

test('replacement pcre: \\1 ${1} $1 and \\\\', () => {
  const run = (tpl) => M.runMatch({ source: '(a)(b)', flags: 'g', text: 'ab', replacement: tpl, flavor: 'pcre' }).replaced;
  assert.equal(run('\\2${1}$2\\\\'), 'bab\\');
});

test('workerSource: functions are self-contained after toString', () => {
  const src = M.workerSource();
  const self = {};
  const runMatch = new Function('self', src + '\n; return runMatch;')(self);
  assert.equal(typeof self.onmessage, 'function');
  const r = runMatch({ source: '(\\d)', flags: 'gu', text: 'a1😀2', replacement: '<$1>', maxRows: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(r.replaced, 'a<1>😀<2>');
  const z = runMatch({ source: '', flags: 'gu', text: '😀😀' });
  assert.equal(z.count, 3);
  let posted;
  self.postMessage = (x) => { posted = x; };
  self.onmessage({ data: { id: 7, source: 'b', flags: 'g', text: 'abc', replacement: '$&$&', flavor: 'javascript' } });
  assert.equal(posted.id, 7);
  assert.equal(posted.replaced, 'abbc');
});

// ---------------- railroad ----------------

const svgOf = (p, flavor, f) => RR.railroad(P.parse(p, { flavor: flavor || 'javascript', unicode: /u/.test(f || '') }).ast);

test('railroad: SVG starts with <svg and ends with </svg>, sizes are numbers', () => {
  const r = svgOf('^a(b|c)*d$');
  assert.ok(r.svg.startsWith('<svg'));
  assert.ok(r.svg.endsWith('</svg>'));
  assert.ok(r.width > 0 && r.height > 0 && r.boxes > 0);
  assert.equal((r.svg.match(/<g\b/g) || []).length, (r.svg.match(/<\/g>/g) || []).length, 'balanced <g>');
  assert.match(r.svg, /group 1/);
});

test('railroad: <script> in a literal is escaped, never raw', () => {
  for (const p of ['<script>alert(1)</script>', '(?<script>\\x3cscript\\x3e)(?<img>\\x3cimg src=x onerror=alert\\(1\\)\\x3e)?', '[<>"\'&]']) {
    const r = svgOf(p);
    assert.ok(!/<script/i.test(r.svg), p);
    assert.ok(!/<img/i.test(r.svg), p);
  }
  assert.match(svgOf('<script>').svg, /&lt;script&gt;/);
  assert.match(svgOf('(?<script>a)').svg, /group 1 &quot;script&quot;/);
});

test('railroad: export style cannot close the style element', () => {
  const r = RR.railroad(P.parse('a').ast, { style: RR.exportStyle() + '</style><script>x</script>', background: '"><script>' });
  assert.ok(!/<script/i.test(r.svg));
  assert.match(r.svg, /<style>\.rr text\{/);
  assert.match(RR.exportStyle({ fg: '#123456' }), /fill:#123456/);
});

test('railroad: group labels and lookaround frames', () => {
  const s = svgOf('(?<y>a)(?:b)(?=c)(?!d)(?<=e)(?<!f)').svg;
  for (const label of ['group 1 &quot;y&quot;', 'followed by', 'not followed by', 'preceded by', 'not preceded by']) assert.ok(s.includes(label), label);
  assert.match(s, /rr-look/);
  assert.match(svgOf('a{2,5}?').svg, /2-5 times, lazy/);
});

test('railroad: too-big for 7000 alternations', () => {
  const p = Array.from({ length: 7000 }, (_, k) => 'w' + k).join('|');
  const r = svgOf(p);
  assert.equal(r.error, 'too-big');
  assert.ok(r.boxes > RR.MAX_BOXES);
});

test('railroad and explain handle every node type', () => {
  const p = '^(?<n>a|b)(?:c)(?=d)(?!e)(?<=f)(?<!g)(?>h)(?|i)(?i:j)(?i)\\d\\p{L}[a-z[:alpha:]\\w\\p{N}]\\1\\k<n>(?R)\\Qq\\E.(?#c)\\b\\A\\z\\Z\\G\\Kx*y+z?w{2}v{2,3}u{2,}t*?s++\\h\\R$';
  const { ast } = P.parse(p, { flavor: 'pcre' });
  const types = new Set();
  P.walk(ast, (nd) => types.add(nd.type + (nd.kind ? ':' + nd.kind : '')));
  for (const t of ['alt', 'seq', 'literal', 'any', 'esc', 'prop', 'class', 'assert:start', 'backref', 'subroutine', 'comment', 'flags', 'quant', 'group:atomic', 'group:branchreset', 'group:flaggroup']) assert.ok(types.has(t), t);
  const r = RR.railroad(ast, { dotAll: true });
  assert.ok(r.svg.startsWith('<svg') && r.svg.endsWith('</svg>'));
  for (const label of ['atomic', 'branch reset', 'flags i', 'recurse R', 'same as group 1', 'same as group n', 'any char', 'start of text', 'end of last match']) assert.ok(r.svg.includes(label), label);
  const lines = P.explain(ast);
  assert.ok(lines.length > 30);
  assert.ok(lines.every((l) => typeof l.text === 'string' && l.text && !/undefined/.test(l.text)));
  const pr = P.prepare(p, '', 'pcre');
  assert.equal(pr.ok, true);
});

test('railroad: empty pattern and empty alternative', () => {
  for (const p of ['', 'a|', '()', '[]']) {
    const r = svgOf(p);
    assert.ok(r.svg.startsWith('<svg') && r.svg.endsWith('</svg>'), p);
  }
});
