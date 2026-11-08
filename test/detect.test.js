'use strict';
// Unit tests for src/detect.js: finding regexes in source code and writing them back ("Copy as").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const D = require('../src/detect.js');
const P = require('../media/core/regex-parse.js');

const sample = (f) => fs.readFileSync(path.join(__dirname, '..', 'samples', f), 'utf8');
const find = (f, lang) => D.findRegexes(sample(f), lang);
const pats = (r) => r.map((x) => x.pattern);

test('samples/validators.ts: 6 literals with exact text and flags', () => {
  const r = find('validators.ts', 'typescript');
  assert.equal(r.length, 6);
  assert.equal(r[0].pattern, '^[\\w.+-]+@(?:[a-z0-9-]+\\.)+[a-z]{2,}$');
  assert.equal(r[0].flags, 'i');
  assert.equal(r[1].pattern, '(?<year>\\d{4})-(?<month>0[1-9]|1[0-2])-(?<day>0[1-9]|[12]\\d|3[01])');
  assert.equal(r[3].pattern, '(?<=\\$)\\d+(?:\\.\\d{2})?');
  assert.deepEqual([r[4].pattern, r[4].flags], ['[^\\p{L}\\p{N}]+', 'gu']);
  assert.deepEqual([r[5].pattern, r[5].flags], ['^-|-$', 'g']);
  assert.ok(r.every((x) => x.flavor === 'javascript'));
});

test('samples: offset and length cover the literal in the source', () => {
  const text = sample('validators.ts');
  for (const x of D.findRegexes(text, 'typescript')) {
    const lit = text.slice(x.offset, x.offset + x.length);
    assert.equal(lit, '/' + x.pattern + '/' + x.flags);
  }
});

test('samples/url_tools.js: 2 literals and a RegExp() string with flags', () => {
  const r = find('url_tools.js', 'javascript');
  assert.equal(r.length, 3);
  assert.equal(r[0].flags, 'gi');
  assert.ok(r[0].pattern.startsWith('\\bhttps?:\\/\\/'));
  assert.equal(r[2].pattern, '(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4}');
  assert.equal(r[2].flags, 'gi');
});

test('samples/log_parser.py: 4 calls, re.VERBOSE -> x, re.IGNORECASE -> i, raw strings unescaped', () => {
  const r = find('log_parser.py', 'python');
  assert.equal(r.length, 4);
  assert.equal(r[0].flags, 'x');
  assert.ok(r[0].pattern.includes('(?P<ip>\\d{1,3}(?:\\.\\d{1,3}){3})'));
  assert.ok(r[0].pattern.includes('# client and user'));
  assert.deepEqual([r[1].pattern, r[1].flags], ['rt=(?P<rt>\\d+\\.\\d+)', 'i']);
  assert.deepEqual([r[2].pattern, r[2].flags], ['\\b\\w++\\b', '']);
  assert.equal(r[3].pattern, '(?P<user>[\\w.]+)@(?P<host>[\\w.-]+)');
  assert.ok(r.every((x) => x.flavor === 'python'));
});

test('samples/router.go: backtick and interpreted strings', () => {
  const r = find('router.go', 'go');
  assert.deepEqual(pats(r), [
    '^/api/v(?P<version>\\d+)/(?P<resource>[a-z]+)(?:/(?P<id>[0-9a-f-]{36}))?$',
    '^v(\\d+)\\.(\\d+)\\.(\\d+)$',
    '#(?:[0-9a-fA-F]{3}){1,2}\\b',
  ]);
  assert.ok(r.every((x) => x.flavor === 'go'));
});

test('samples/Validator.java: Pattern.compile with flags and String.replaceAll', () => {
  const r = find('Validator.java', 'java');
  assert.equal(r.length, 3);
  assert.equal(r[0].pattern, '^\\+?(\\d{1,3})?[-. ]?\\(?(\\d{3})\\)?[-. ]?(\\d{3})[-. ]?(\\d{4})$');
  assert.deepEqual([r[1].pattern, r[1].flags], ['<(?<tag>[a-z][a-z0-9]*)\\b[^>]*>(.*?)</\\k<tag>>', 'is']);
  assert.deepEqual([r[2].pattern, r[2].flags], ['\\s{2,}', '']);
});

test('samples/Parser.cs: verbatim strings, "" unescaped, RegexOptions.IgnoreCase -> i', () => {
  const r = find('Parser.cs', 'csharp');
  assert.equal(r.length, 3);
  assert.deepEqual([r[0].pattern, r[0].flags], ['\\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\b', 'i']);
  assert.equal(r[1].pattern, '"(?<text>(?:[^"\\\\]|\\\\.)*)"');
  assert.equal(r[2].pattern, '(?<![\\w.])\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?\\s?(?:USD|EUR|THB)\\b');
});

test('samples/slugify.php: delimiters removed, /u and #..#i flags', () => {
  const r = find('slugify.php', 'php');
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].pattern, r[0].flags], ['[^\\p{L}\\p{N}]+', 'u']);
  assert.deepEqual([r[1].pattern, r[1].flags], ['(?<!\\w)\\#(?<tag>[a-z][\\w-]{1,30})', 'i']);
  assert.ok(r.every((x) => x.flavor === 'pcre'));
});

test('samples/mailer.rb: literal and %r{}, Ruby ^/$ are line anchors (m)', () => {
  const r = find('mailer.rb', 'ruby');
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].pattern, r[0].flags], ['\\A[\\w+\\-.]+@[a-z\\d\\-]+(\\.[a-z\\d\\-]+)*\\.[a-z]+\\z', 'im']);
  assert.deepEqual([r[1].pattern, r[1].flags], ['^(?<name>[A-Za-z-]+):\\s*(?<value>.*)$', 'm']);
});

test('samples/tokens.rs: r"" and r#""# raw strings', () => {
  const r = find('tokens.rs', 'rust');
  assert.deepEqual(pats(r), ['\\b[A-Za-z_][A-Za-z0-9_]*\\b', '(?P<y>\\d{4})-(?P<m>\\d{2})-(?P<d>\\d{2})']);
  assert.ok(r.every((x) => x.flavor === 'go'));
});

test('samples/hostile-*: regex in a comment is skipped, broken pattern still found', () => {
  assert.deepEqual(pats(find('hostile-backtrack.ts', 'typescript')), ['(a+)+$', '(?=a)|\\b', '(unclosed[group']);
  const h = find('hostile-markup.js', 'javascript');
  assert.equal(h.length, 1, 'the SAMPLE string is not a regex');
  assert.equal(h[0].pattern, '(?<script>\\x3cscript\\x3e)(?<img>\\x3cimg src=x onerror=alert\\(1\\)\\x3e)?');
});

test('samples: every detected pattern prepares for its flavor and compiles (except the broken one)', () => {
  const files = { 'validators.ts': 'typescript', 'url_tools.js': 'javascript', 'log_parser.py': 'python', 'router.go': 'go', 'Validator.java': 'java', 'Parser.cs': 'csharp', 'slugify.php': 'php', 'mailer.rb': 'ruby', 'tokens.rs': 'rust', 'hostile-backtrack.ts': 'typescript', 'hostile-markup.js': 'javascript' };
  let n = 0;
  for (const [f, lang] of Object.entries(files)) {
    for (const x of find(f, lang)) {
      const r = P.prepare(x.pattern, x.flags, x.flavor);
      if (x.pattern === '(unclosed[group') { assert.equal(r.ok, false); continue; }
      assert.equal(r.ok, true, `${f}: ${x.pattern}: ${r.error}`);
      assert.doesNotThrow(() => new RegExp(r.source, r.flags), `${f}: ${r.source}`);
      n++;
    }
  }
  assert.equal(n, 31);
});

// ---------------- flags mapping ----------------

test('flags: Python re.I | re.M | re.S | re.X and keyword flags=', () => {
  assert.equal(D.findRegexes('re.compile(r"a", re.I | re.MULTILINE | re.DOTALL | re.VERBOSE)', 'python')[0].flags, 'imsx');
  assert.equal(D.findRegexes('re.sub(r"a", "b", s, flags=re.IGNORECASE)', 'python')[0].flags, 'i');
  assert.equal(D.findRegexes('re.search(pattern=r"a", string=s)', 'python')[0].pattern, 'a');
});

test('flags: Java Pattern constants', () => {
  const r = D.findRegexes('Pattern.compile("a", Pattern.CASE_INSENSITIVE | Pattern.MULTILINE | Pattern.COMMENTS);', 'java');
  assert.equal(r[0].flags, 'imx');
});

test('flags: C# RegexOptions and [GeneratedRegex]', () => {
  assert.equal(D.findRegexes('new Regex("a", RegexOptions.IgnoreCase | RegexOptions.Singleline)', 'csharp')[0].flags, 'is');
  const g = D.findRegexes('[GeneratedRegex(@"^\\d+$", RegexOptions.IgnoreCase | RegexOptions.Multiline)]', 'csharp');
  assert.deepEqual([g[0].pattern, g[0].flags], ['^\\d+$', 'im']);
  assert.equal(D.findRegexes('Regex.Replace(input, "\\\\s+", " ")', 'csharp')[0].pattern, '\\s+');
});

test('flags: PHP modifiers imsxu, other delimiters', () => {
  const r = D.findRegexes("preg_match('~a/b~imsxuU', $s); preg_split(\"{\\\\d+}\", $s);", 'php');
  assert.deepEqual([r[0].pattern, r[0].flags], ['a/b', 'imsxu']);
  assert.equal(r[1].pattern, '\\d+');
});

test('flags: Ruby /m -> s plus m, /x -> x', () => {
  assert.equal(D.findRegexes('x = /a.b/m', 'ruby')[0].flags, 'sm');
  assert.equal(D.findRegexes('x = /a b/ix', 'ruby')[0].flags, 'ixm');
  assert.equal(D.findRegexes('x = Regexp.new("a\\\\d")', 'ruby')[0].pattern, 'a\\d');
});

test('flags: JS RegExp("...", "gi") and unknown flag letters are ignored', () => {
  const r = D.findRegexes('const a = new RegExp("\\\\d+", "gi"); const b = RegExp(\'x\');', 'javascript');
  assert.deepEqual(r.map((x) => [x.pattern, x.flags]), [['\\d+', 'gi'], ['x', '']]);
  assert.deepEqual(D.findRegexes('x = /ab/zz;', 'javascript'), [], 'unknown flags: not a regex literal');
});

// ---------------- JS lexing ----------------

test('js: division is not a regex', () => {
  assert.deepEqual(D.findRegexes('const y = a / b / c;', 'javascript'), []);
  assert.deepEqual(D.findRegexes('const y = (a + 1) / 2 / (b);', 'javascript'), []);
  assert.deepEqual(D.findRegexes('const y = arr[0] / 2 / 3;', 'javascript'), []);
});

test('js: escaped slash and slash in a class', () => {
  const r = D.findRegexes('x = /a\\/b[/]c/g;', 'javascript');
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].pattern, r[0].flags], ['a\\/b[/]c', 'g']);
});

test('js: regex after return, (, ,, =, ! and &&', () => {
  const r = D.findRegexes('function f(s){ return /a/.test(s) && !/b/.test(s) || g(/c/, /d/); }', 'javascript');
  assert.deepEqual(pats(r), ['a', 'b', 'c', 'd']);
});

test('js: postfix ++ followed by division is not a regex', () => {
  assert.deepEqual(D.findRegexes('const y = i++ / 2 + j / 3;', 'javascript'), []);
});

test('js: regexes inside strings and comments are skipped', () => {
  const code = 's = "/abc/"; t = \'/x/\'; u = `/y/`; // /def/\n/* /ghi/ */ v = /real/;';
  assert.deepEqual(pats(D.findRegexes(code, 'javascript')), ['real']);
});

test('js: template literal with ${} is skipped, plain template is used', () => {
  assert.deepEqual(D.findRegexes('const r = new RegExp(`^${p}\\\\d+`);', 'javascript'), []);
  assert.deepEqual(pats(D.findRegexes('const r = new RegExp(`^\\\\d+`);', 'javascript')), ['^\\d+']);
});

test('js: escapes in RegExp strings are unescaped', () => {
  assert.equal(D.findRegexes('RegExp("\\\\bx\\\\.y\\u0041\\x42")', 'javascript')[0].pattern, '\\bx\\.yAB');
});

test('python: f-strings are skipped, bytes and triple-quoted are read', () => {
  assert.deepEqual(D.findRegexes('re.compile(f"{x}\\d")', 'python'), []);
  assert.equal(D.findRegexes("re.match(rb'\\d+', b)", 'python')[0].pattern, '\\d+');
  assert.equal(D.findRegexes('re.match("\\\\d\\d", s)', 'python')[0].pattern, '\\d\\d', 'unknown escape keeps the backslash');
});

test('python: a commented-out call is skipped', () => {
  assert.deepEqual(D.findRegexes('# re.compile(r"abc")\nx = 1\n', 'python'), []);
});

test('MAX_RESULTS caps the results', () => {
  const r = D.findRegexes('x = /a/;\n'.repeat(D.MAX_RESULTS + 100), 'javascript');
  assert.equal(r.length, D.MAX_RESULTS);
  assert.equal(D.MAX_RESULTS, 500);
});

test('unknown language returns []', () => {
  assert.deepEqual(D.findRegexes('x = /a/; re.compile(r"b")', 'plaintext'), []);
  assert.deepEqual(D.findRegexes('x = /a/;', undefined), []);
});

test('splitDelimited helper', () => {
  assert.deepEqual(D.splitDelimited('/a/i'), { pattern: 'a', flags: 'i' });
  assert.deepEqual(D.splitDelimited('(a(b))x'), { pattern: 'a(b)', flags: 'x' });
  assert.equal(D.splitDelimited('abc'), null);
  assert.equal(D.splitDelimited('/a/1'), null);
});

// ---------------- toSource round trip ----------------

const LANG = { javascript: 'javascript', python: 'python', java: 'java', go: 'go', dotnet: 'csharp', php: 'php', rust: 'rust' };
const ROUND = ['\\d+(?:\\.\\d+)?', '^[a-z_]\\w*$', 'a"b', "it's", '\\\\server', 'x`y', '(?<n>\\w+)\\s*=\\s*\\k<n>', '[^\\]]+', 'end\\'];

for (const [target, lang] of Object.entries(LANG)) {
  test(`toSource round trip: ${target}`, () => {
    for (const p of ROUND) {
      if (target === 'javascript' && p === 'end\\') continue; // not a valid JS literal body
      const code = 'x = ' + D.toSource(p, '', target) + ';';
      const r = D.findRegexes(code, lang);
      assert.equal(r.length, 1, `${target}: ${code}`);
      assert.equal(r[0].pattern, p, `${target}: ${code}`);
    }
  });
}

test('toSource round trip keeps flags (javascript, python, php)', () => {
  assert.equal(D.findRegexes(D.toSource('a', 'gimsuy', 'javascript'), 'javascript')[0].flags, 'gimsuy');
  assert.equal(D.findRegexes(D.toSource('a', 'imsx', 'python'), 'python')[0].flags, 'imsx');
  assert.equal(D.findRegexes(D.toSource('a', 'imsxu', 'php'), 'php')[0].flags, 'imsxu');
});

test('toSource javascript: a slash is escaped and means the same pattern', () => {
  const r = D.findRegexes(D.toSource('a/b', '', 'javascript'), 'javascript');
  assert.equal(new RegExp(r[0].pattern).source, new RegExp('a/b').source);
});

test('toSource javascript: two slashes in a row are both escaped', () => {
  const r = D.findRegexes('x = ' + D.toSource('a//b', '', 'javascript') + ';', 'javascript');
  assert.equal(r.length, 1);
  assert.equal(new RegExp(r[0].pattern).source, new RegExp('a//b').source);
});

test('toSource python: pattern with both quote kinds ending in " round trips', () => {
  const p = 'it\'s "x"';
  const r = D.findRegexes(D.toSource(p, '', 'python'), 'python');
  assert.equal(r[0].pattern, p);
});

test('toSource: unknown target returns the pattern', () => {
  assert.equal(D.toSource('a+', 'g', 'cobol'), 'a+');
});
