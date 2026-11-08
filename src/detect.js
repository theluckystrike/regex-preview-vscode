'use strict';
// Finds regular expressions in source code for the "Test regex" CodeLens. Pure text scanning with no VS Code API
// and no language server, so it never touches the language's own features (TypeScript, Pylance, gopls stay as
// they are). Returns [{ offset, length, pattern, flags, flavor }]; offset is where the literal starts.

const MAX_RESULTS = 500;

// ---------- string literal readers: return { value, end } or null ----------

function readQuoted(text, i, quote, escapes) {
  // escapes: function(text, j) -> { str, len } for a backslash at j, or null for "no escapes" (raw)
  let j = i + 1;
  let out = '';
  while (j < text.length) {
    const c = text[j];
    if (c === quote) return { value: out, end: j + 1 };
    if (c === '\n' && quote !== '`') return null;
    if (c === '\\' && escapes) {
      const e = escapes(text, j);
      out += e.str; j += e.len; continue;
    }
    out += c; j++;
  }
  return null;
}

// C-like escapes shared by JS, Java, Go, C#, Rust strings. Unknown escapes keep the character (JS) or the backslash.
function cEscapes(keepUnknownBackslash) {
  return (text, j) => {
    const d = text[j + 1];
    const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '\\': '\\', '"': '"', "'": "'", '`': '`' };
    if (d === 'u') {
      if (text[j + 2] === '{') { const e = text.indexOf('}', j); const h = text.slice(j + 3, e); if (/^[0-9a-fA-F]{1,6}$/.test(h)) return { str: String.fromCodePoint(parseInt(h, 16)), len: e - j + 1 }; }
      const h = text.slice(j + 2, j + 6); if (/^[0-9a-fA-F]{4}$/.test(h)) return { str: String.fromCharCode(parseInt(h, 16)), len: 6 };
    }
    if (d === 'x') { const h = text.slice(j + 2, j + 4); if (/^[0-9a-fA-F]{2}$/.test(h)) return { str: String.fromCharCode(parseInt(h, 16)), len: 4 }; }
    if (d === '\n') return { str: '', len: 2 };
    if (d in map) return { str: map[d], len: 2 };
    return { str: keepUnknownBackslash ? '\\' + d : d, len: 2 };
  };
}

// Python: unknown escapes keep the backslash ("\d" is backslash d).
function pyEscapes(text, j) {
  const d = text[j + 1];
  const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', a: '\x07', 0: '\0', '\\': '\\', '"': '"', "'": "'", '\n': '' };
  if (d === 'x') { const h = text.slice(j + 2, j + 4); if (/^[0-9a-fA-F]{2}$/.test(h)) return { str: String.fromCharCode(parseInt(h, 16)), len: 4 }; }
  if (d === 'u') { const h = text.slice(j + 2, j + 6); if (/^[0-9a-fA-F]{4}$/.test(h)) return { str: String.fromCharCode(parseInt(h, 16)), len: 6 }; }
  if (d in map) return { str: map[d], len: 2 };
  return { str: '\\' + d, len: 2 };
}

function readPythonString(text, i) {
  const m = /^([rRbBuU]{0,2})('''|"""|'|")/.exec(text.slice(i, i + 6));
  if (!m || /[fF]/.test(m[1])) return null;
  const raw = /[rR]/.test(m[1]);
  const q = m[2];
  let j = i + m[0].length;
  let out = '';
  while (j < text.length) {
    if (text.startsWith(q, j)) return { value: out, end: j + q.length };
    const c = text[j];
    if (c === '\n' && q.length === 1) return null;
    if (c === '\\') {
      if (raw) { out += c + (text[j + 1] || ''); j += 2; continue; }
      const e = pyEscapes(text, j); out += e.str; j += e.len; continue;
    }
    out += c; j++;
  }
  return null;
}

function readCSharpString(text, i) {
  if (text.startsWith('@"', i)) {
    let j = i + 2, out = '';
    while (j < text.length) {
      if (text[j] === '"') { if (text[j + 1] === '"') { out += '"'; j += 2; continue; } return { value: out, end: j + 1 }; }
      out += text[j]; j++;
    }
    return null;
  }
  if (text.startsWith('"""', i)) {
    const e = text.indexOf('"""', i + 3);
    return e < 0 ? null : { value: text.slice(i + 3, e), end: e + 3 };
  }
  if (text[i] === '"') return readQuoted(text, i, '"', cEscapes(false));
  return null;
}

function readRustString(text, i) {
  const m = /^r(#*)"/.exec(text.slice(i, i + 12));
  if (m) {
    const close = '"' + m[1];
    const e = text.indexOf(close, i + m[0].length);
    return e < 0 ? null : { value: text.slice(i + m[0].length, e), end: e + close.length };
  }
  if (text[i] === '"') return readQuoted(text, i, '"', cEscapes(false));
  return null;
}

function readGoString(text, i) {
  if (text[i] === '`') { const e = text.indexOf('`', i + 1); return e < 0 ? null : { value: text.slice(i + 1, e), end: e + 1 }; }
  if (text[i] === '"') return readQuoted(text, i, '"', cEscapes(false));
  return null;
}

function readJavaString(text, i) {
  if (text.startsWith('"""', i)) return null; // text blocks: skip
  if (text[i] === '"') return readQuoted(text, i, '"', cEscapes(false));
  return null;
}

function readJsString(text, i) {
  const q = text[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  const r = readQuoted(text, i, q, cEscapes(false));
  if (r && q === '`' && /\$\{/.test(text.slice(i, r.end))) return null; // template with ${}: not a fixed pattern
  return r;
}

function readPhpString(text, i) {
  if (text[i] === "'") {
    return readQuoted(text, i, "'", (t, j) => (t[j + 1] === "'" || t[j + 1] === '\\' ? { str: t[j + 1], len: 2 } : { str: '\\' + t[j + 1], len: 2 }));
  }
  if (text[i] === '"') return readQuoted(text, i, '"', (t, j) => {
    const d = t[j + 1];
    const map = { n: '\n', t: '\t', r: '\r', v: '\v', f: '\f', '\\': '\\', $: '$', '"': '"' };
    return d in map ? { str: map[d], len: 2 } : { str: '\\' + d, len: 2 };
  });
  return null;
}

// PHP and other delimited patterns: "/abc/i", "#abc#", "{abc}x". Returns { pattern, flags } or null.
function splitDelimited(s) {
  const t = s.replace(/^\s+/, '');
  const open = t[0];
  if (!open || /[A-Za-z0-9\\\s]/.test(open)) return null;
  const close = { '(': ')', '[': ']', '{': '}', '<': '>' }[open] || open;
  const e = t.lastIndexOf(close);
  if (e <= 0) return null;
  const mods = t.slice(e + 1);
  if (!/^[a-zA-Z]*\s*$/.test(mods)) return null;
  return { pattern: t.slice(1, e), flags: mods.trim() };
}

// ---------- flags written as constants after the pattern ----------

function argsTail(text, from) {
  // the rest of the call: up to the ) that closes it, at most 300 characters
  let depth = 0;
  const end = Math.min(text.length, from + 300);
  for (let j = from; j < end; j++) {
    const c = text[j];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return text.slice(from, j); depth--; }
    else if (c === ';' && depth === 0) return text.slice(from, j);
  }
  return text.slice(from, end);
}

function pyFlags(tail) {
  let f = '';
  if (/\bre\.(I|IGNORECASE)\b/.test(tail)) f += 'i';
  if (/\bre\.(M|MULTILINE)\b/.test(tail)) f += 'm';
  if (/\bre\.(S|DOTALL)\b/.test(tail)) f += 's';
  if (/\bre\.(X|VERBOSE)\b/.test(tail)) f += 'x';
  return f;
}
function javaFlags(tail) {
  let f = '';
  if (/Pattern\.CASE_INSENSITIVE/.test(tail)) f += 'i';
  if (/Pattern\.MULTILINE/.test(tail)) f += 'm';
  if (/Pattern\.DOTALL/.test(tail)) f += 's';
  if (/Pattern\.COMMENTS/.test(tail)) f += 'x';
  return f;
}
function dotnetFlags(tail) {
  let f = '';
  if (/RegexOptions\.IgnoreCase/.test(tail)) f += 'i';
  if (/RegexOptions\.Multiline/.test(tail)) f += 'm';
  if (/RegexOptions\.Singleline/.test(tail)) f += 's';
  if (/RegexOptions\.IgnorePatternWhitespace/.test(tail)) f += 'x';
  return f;
}

// ---------- JavaScript / TypeScript / Ruby regex literals ----------

const REGEX_BEFORE_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof', 'and', 'or', 'not', 'if', 'unless', 'when', 'while', 'until', 'puts', 'then']);

// Scans code, skipping strings and comments, and finds /regex/flags literals.
function scanSlashLiterals(text, lang, push, overBudget = () => false) {
  const ruby = lang === 'ruby';
  const n = text.length;
  let i = 0;
  // A '/' whose scan found no closing '/' before the line end: no later '/' before that point is scanned again
  // (VER11: a long line of '=/[' made this quadratic and froze the extension host).
  let noLiteralBefore = -1;
  let steps = 0;
  let prevSig = ''; // last significant character
  let prevWord = '';
  while (i < n) {
    if ((++steps & 1023) === 0 && overBudget()) return;
    const c = text[i];
    // comments
    if (!ruby && c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (!ruby && c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (ruby && c === '#' && text[i + 1] !== '{') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    // strings
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let j = i + 1;
      while (j < n && text[j] !== q) { if (text[j] === '\\') j++; else if (text[j] === '\n' && q !== '`' && !ruby) break; j++; }
      i = j + 1; prevSig = q; prevWord = ''; continue;
    }
    if (ruby && c === '%' && text[i + 1] === 'r') {
      const open = text[i + 2];
      const close = { '{': '}', '(': ')', '[': ']', '<': '>' }[open] || open;
      if (open && !/[\s\w]/.test(open)) {
        let j = i + 3, depth = 0, pat = '';
        while (j < n) {
          const d = text[j];
          if (d === '\\') { pat += d + (text[j + 1] || ''); j += 2; continue; }
          if (d === open && open !== close) depth++;
          if (d === close) { if (depth === 0) break; depth--; }
          pat += d; j++;
        }
        const fm = /^[a-z]*/.exec(text.slice(j + 1, j + 8));
        push(i, j + 1 + fm[0].length - i, pat, rubyFlags(fm[0]), 'pcre');
        i = j + 1 + fm[0].length; prevSig = ')'; continue;
      }
    }
    if (c === '/') {
      const regexOk = prevSig === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prevSig) || REGEX_BEFORE_WORDS.has(prevWord);
      if (regexOk && i >= noLiteralBefore) {
        let j = i + 1, inClass = false, ok = false;
        while (j < n) {
          const d = text[j];
          if (d === '\n') break;
          if (d === '\\') { j += 2; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { ok = true; break; }
          j++;
        }
        if (ok && j > i + 1) {
          const fm = /^[a-z]*/.exec(text.slice(j + 1, j + 10));
          const pat = text.slice(i + 1, j);
          if (ruby) push(i, j + 1 + fm[0].length - i, pat.replace(/\\\//g, '/'), rubyFlags(fm[0]), 'pcre');
          else if (/^[dgimsuyv]*$/.test(fm[0])) push(i, j + 1 + fm[0].length - i, pat, fm[0], 'javascript');
          i = j + 1 + fm[0].length; prevSig = ')'; prevWord = ''; continue;
        }
        if (!ok) noLiteralBefore = j;
      }
    }
    if (/\s/.test(c)) { i++; continue; }
    if ((c === '+' || c === '-') && text[i + 1] === c) { prevSig = ')'; prevWord = ''; i += 2; continue; } // x++ / 2 divides
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 64));
      prevWord = m[0]; prevSig = 'a'; i += m[0].length; continue;
    }
    if (/[0-9]/.test(c)) { prevSig = '0'; prevWord = ''; i++; continue; }
    prevSig = c; prevWord = ''; i++;
  }
}

function rubyFlags(m) {
  let f = '';
  if (m.includes('i')) f += 'i';
  if (m.includes('m')) f += 's'; // Ruby /m is "dot matches newline"
  if (m.includes('x')) f += 'x';
  return f + 'm'; // ^ and $ are always line anchors in Ruby
}

// ---------- call patterns per language ----------

// A checker for "is this offset inside a line comment that starts with one of the markers ('#' or '//')?" for offsets
// that only grow. Each line is read once (VER11: re-reading the line for every match was quadratic on long lines).
function lineCommentChecker(text, markers) {
  let ls = 0, nextNl = text.indexOf('\n'), commentEnd = -2;
  return offset => {
    while (nextNl >= 0 && nextNl < offset) { ls = nextNl + 1; nextNl = text.indexOf('\n', ls); commentEnd = -2; }
    if (commentEnd === -2) {
      const le = nextNl < 0 ? text.length : nextNl;
      commentEnd = -1;
      let q = '';
      for (let k = ls; k < le; k++) {
        const c = text[k];
        if (q) { if (c === '\\') k++; else if (c === q) q = ''; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        const mk = markers.find(x => text.startsWith(x, k));
        if (mk) { commentEnd = k + mk.length; break; }
      }
    }
    return commentEnd >= 0 && commentEnd <= offset;
  };
}

function scanCalls(text, re, read, onFound, markers, overBudget = () => false) {
  re.lastIndex = 0;
  let m;
  const inComment = markers ? lineCommentChecker(text, markers) : null;
  let steps = 0;
  while ((m = re.exec(text)) !== null) {
    if ((++steps & 255) === 0 && overBudget()) return;
    if (inComment && inComment(m.index)) continue;
    const at = m.index + m[0].length;
    const s = read(text, at);
    if (!s) continue;
    onFound(at, s, m);
  }
}

/** All regexes in one document. languageId: VS Code language id. opts.budgetMs: stop after this time and return
 *  what was found so far, with out.truncated = true (the CodeLens runs on the extension host thread). */
function findRegexes(text, languageId, opts = {}) {
  const lang0 = String(languageId || '');
  const markers = lang0 === 'python' || lang0 === 'ruby' ? ['#'] : (lang0 === 'php' ? ['//', '#'] : ['//']);
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Infinity;
  let truncated = false;
  const overBudget = () => (truncated = truncated || Date.now() > deadline);
  const scan = (t, re, read, onFound) => scanCalls(t, re, read, onFound, markers, overBudget);
  const out = [];
  const seen = new Set();
  const push = (offset, length, pattern, flags, flavor) => {
    if (out.length >= MAX_RESULTS || seen.has(offset) || !pattern) return;
    seen.add(offset);
    out.push({ offset, length, pattern, flags: flags || '', flavor });
  };
  const lang = String(languageId || '');
  if (/^(javascript|typescript|javascriptreact|typescriptreact|vue|svelte|astro)$/.test(lang)) {
    scanSlashLiterals(text, 'js', push, overBudget);
    scan(text, /\b(?:new\s+)?RegExp\(\s*/g, readJsString, (at, s) => {
      const tail = argsTail(text, s.end);
      const fm = /^\s*,\s*(['"`])([dgimsuyv]*)\1/.exec(tail);
      push(at, s.end - at, s.value, fm ? fm[2] : '', 'javascript');
    });
  } else if (lang === 'python') {
    scan(text, /\b(?:re|regex)\.(?:compile|match|search|fullmatch|findall|finditer|sub|subn|split)\(\s*(?:pattern\s*=\s*)?/g, readPythonString, (at, s) => {
      push(at, s.end - at, s.value, pyFlags(argsTail(text, s.end)), 'python');
    });
  } else if (lang === 'go') {
    scan(text, /\bregexp\.(?:MustCompile|Compile|MustCompilePOSIX|CompilePOSIX|MatchString|Match)\(\s*/g, readGoString, (at, s) => push(at, s.end - at, s.value, '', 'go'));
  } else if (lang === 'rust') {
    scan(text, /\b(?:Regex|RegexBuilder|RegexSet|bytes::Regex)::new\(\s*|\bregex!\(\s*/g, readRustString, (at, s) => push(at, s.end - at, s.value, '', 'go'));
  } else if (lang === 'java' || lang === 'kotlin') {
    scan(text, /\bPattern\.(?:compile|matches)\(\s*/g, readJavaString, (at, s) => push(at, s.end - at, s.value, javaFlags(argsTail(text, s.end)), 'java'));
    scan(text, /\.(?:matches|replaceAll|replaceFirst|split)\(\s*/g, readJavaString, (at, s) => push(at, s.end - at, s.value, '', 'java'));
    if (lang === 'kotlin') scan(text, /\b(?:Regex|toRegex)\(\s*/g, readJavaString, (at, s) => push(at, s.end - at, s.value, '', 'java'));
  } else if (lang === 'csharp') {
    scan(text, /\bnew\s+Regex\(\s*/g, readCSharpString, (at, s) => push(at, s.end - at, s.value, dotnetFlags(argsTail(text, s.end)), 'dotnet'));
    scan(text, /\bRegex\.(?:IsMatch|Match|Matches|Replace|Split|Count|EnumerateMatches)\(\s*[^,()"]+,\s*/g, readCSharpString, (at, s) => push(at, s.end - at, s.value, dotnetFlags(argsTail(text, s.end)), 'dotnet'));
    scan(text, /\[GeneratedRegex\(\s*/g, readCSharpString, (at, s) => push(at, s.end - at, s.value, dotnetFlags(argsTail(text, s.end)), 'dotnet'));
  } else if (lang === 'php') {
    scan(text, /\bpreg_(?:match_all|match|replace_callback|replace|split|grep)\(\s*/g, readPhpString, (at, s) => {
      const d = splitDelimited(s.value);
      if (!d) return;
      let f = '';
      if (d.flags.includes('i')) f += 'i';
      if (d.flags.includes('m')) f += 'm';
      if (d.flags.includes('s')) f += 's';
      if (d.flags.includes('x')) f += 'x';
      if (d.flags.includes('u')) f += 'u';
      push(at, s.end - at, d.pattern, f, 'pcre');
    });
  } else if (lang === 'ruby') {
    scanSlashLiterals(text, 'ruby', push, overBudget);
    scan(text, /\bRegexp\.new\(\s*/g, (t, i) => (t[i] === "'" ? readQuoted(t, i, "'", (x, j) => (x[j + 1] === "'" || x[j + 1] === '\\' ? { str: x[j + 1], len: 2 } : { str: '\\' + x[j + 1], len: 2 })) : readQuoted(t, i, '"', cEscapes(true))), (at, s) => push(at, s.end - at, s.value, 'm', 'pcre'));
  }
  out.sort((a, b) => a.offset - b.offset);
  if (truncated) out.truncated = true;
  return out;
}

/** Writes a pattern back as source code for a language: used by "Copy as". */
function toSource(pattern, flags, target) {
  const p = String(pattern);
  const f = String(flags || '');
  switch (target) {
    case 'javascript': {
      let body = '';
      for (let k = 0; k < p.length; k++) {
        const c = p[k];
        if (c === '\\') { body += c + (p[k + 1] || ''); k++; continue; }
        body += c === '/' ? '\\/' : (c === '\n' ? '\\n' : c);
      }
      return '/' + body + '/' + f.replace(/[^dgimsuyv]/g, '');
    }
    case 'python': {
      const fl = [];
      if (f.includes('i')) fl.push('re.IGNORECASE'); if (f.includes('m')) fl.push('re.MULTILINE'); if (f.includes('s')) fl.push('re.DOTALL'); if (f.includes('x')) fl.push('re.VERBOSE');
      const q = !p.includes('"') ? '"' : (!p.includes("'") ? "'" : '');
      const body = !q || /\\$/.test(p) || p.includes('\n') ? JSON.stringify(p) : 'r' + q + p + q;
      return 're.compile(' + body + (fl.length ? ', ' + fl.join(' | ') : '') + ')';
    }
    case 'java': return 'Pattern.compile(' + JSON.stringify(p) + ')';
    case 'go': return 'regexp.MustCompile(' + (p.includes('`') ? JSON.stringify(p) : '`' + p + '`') + ')';
    case 'dotnet': return 'new Regex(@"' + p.replace(/"/g, '""') + '")';
    case 'php': return "preg_match('/" + p.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\//g, '\\/') + '/' + f.replace(/[^imsxu]/g, '') + "', $subject, $m)";
    case 'rust': return 'Regex::new(r#"' + p + '"#)';
    default: return p;
  }
}

module.exports = { findRegexes, toSource, splitDelimited, readPythonString, readCSharpString, readRustString, readGoString, readJsString, MAX_RESULTS };
