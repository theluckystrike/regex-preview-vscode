/* Regex Preview core: parser, flavor check and translation to JavaScript, explain lines.
 * Pure code with no DOM and no VS Code API. The webview loads it as a script (global RegexPreview), the unit
 * tests load it with require(). One parser reads the syntax of all flavors (JavaScript, Python, Java, .NET, Go,
 * PCRE); the flavor only decides what is allowed and how it is written for the JavaScript engine that runs it. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.RegexPreview = root.RegexPreview || {}; Object.assign(root.RegexPreview, api); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FLAVORS = {
    javascript: 'JavaScript',
    python: 'Python (re)',
    java: 'Java',
    dotnet: '.NET (C#)',
    go: 'Go / Rust (RE2)',
    pcre: 'PCRE (PHP, Ruby)',
  };

  class RegexSyntaxError extends Error {
    constructor(message, pos) { super(message); this.pos = pos; }
  }

  const SHORT = { d: 'digit', D: 'non-digit', w: 'word character', W: 'non-word character', s: 'whitespace', S: 'non-whitespace',
    h: 'horizontal space', H: 'non-horizontal space', v: 'vertical space', V: 'non-vertical space', R: 'line break', N: 'non-line-break', X: 'Unicode grapheme' };
  const CHAR_ESC = { t: '\t', n: '\n', r: '\r', f: '\f', v: '\v', a: '\x07', e: '\x1b' };

  /** Parses a pattern. opts: { flavor, extended (x flag), unicode (u or v flag) }. Throws RegexSyntaxError. */
  function parse(src, opts) {
    const o = opts || {};
    const flavor = FLAVORS[o.flavor] ? o.flavor : 'javascript';
    const js = flavor === 'javascript';
    let extended = !!o.extended;
    const s = String(src);
    const n = s.length;
    let i = 0;
    let groupCount = 0;
    const groups = [];
    const hasNamed = /\(\?<[^=!]/.test(s);
    const err = (msg, at) => { throw new RegexSyntaxError(msg, at === undefined ? i : at); };

    function skipExtended() {
      while (extended && i < n) {
        const c = s[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
        if (c === '#') { while (i < n && s[i] !== '\n') i++; continue; }
        break;
      }
    }

    function parseAlt() {
      const start = i;
      const alts = [parseSeq()];
      while (i < n && s[i] === '|') { i++; alts.push(parseSeq()); }
      return alts.length === 1 ? alts[0] : { type: 'alt', alts, start, end: i };
    }

    function parseSeq() {
      const start = i;
      const items = [];
      for (;;) {
        skipExtended();
        if (i >= n || s[i] === '|' || s[i] === ')') break;
        let atom = parseAtom();
        if (!atom) continue;
        skipExtended();
        if (atom.type === 'literal' && atom.quoted && [...atom.text].length > 1 && /[*+?{]/.test(s[i] || '')) {
          const chars = [...atom.text];
          const lastCh = chars.pop();
          const prev = items[items.length - 1];
          if (prev && prev.type === 'literal' && !prev.closed) prev.text += chars.join('');
          else items.push({ type: 'literal', text: chars.join(''), start: atom.start, end: atom.end - 1 });
          atom = { type: 'char', text: lastCh, start: atom.end - 1, end: atom.end };
        }
        atom = parseQuant(atom);
        const last = items[items.length - 1];
        if (atom.type === 'char' && last && last.type === 'literal' && !last.closed) {
          last.text += atom.text; last.end = atom.end;
        } else if (atom.type === 'char') {
          items.push({ type: 'literal', text: atom.text, start: atom.start, end: atom.end });
        } else {
          if (last && last.type === 'literal') last.closed = true;
          items.push(atom);
        }
      }
      for (const it of items) delete it.closed;
      return { type: 'seq', items, start, end: i };
    }

    function readName(close) {
      const st = i;
      while (i < n && s[i] !== close) i++;
      if (i >= n) err('Group name is not closed with ' + close, st);
      const name = s.slice(st, i);
      i++;
      if (!/^[A-Za-z_$À-￿][\w$À-￿]*$/.test(name)) err('Invalid group name "' + name + '"', st);
      return name;
    }

    function parseGroup() {
      const start = i;
      i++; // (
      let kind = 'capture';
      let name = null;
      let flags = null;
      if (s[i] === '?') {
        const t = s.slice(i, i + 4);
        if (t.startsWith('?:')) { kind = 'noncap'; i += 2; }
        else if (t.startsWith('?=')) { kind = 'lookahead'; i += 2; }
        else if (t.startsWith('?!')) { kind = 'neglookahead'; i += 2; }
        else if (t.startsWith('?<=')) { kind = 'lookbehind'; i += 3; }
        else if (t.startsWith('?<!')) { kind = 'neglookbehind'; i += 3; }
        else if (t.startsWith('?>')) { kind = 'atomic'; i += 2; }
        else if (t.startsWith('?|')) { kind = 'branchreset'; i += 2; }
        else if (t.startsWith('?#')) {
          const e = s.indexOf(')', i);
          if (e < 0) err('Comment (?#...) is not closed', start);
          i = e + 1;
          return { type: 'comment', text: s.slice(start + 3, e), start, end: i };
        } else if (t.startsWith('?P<')) { kind = 'named'; i += 3; name = readName('>'); }
        else if (t.startsWith('?P=')) {
          i += 3; const nm = readName(')');
          return { type: 'backref', ref: nm, syntax: 'python', start, end: i };
        } else if (t.startsWith('?P>')) {
          i += 3; const nm = readName(')');
          return { type: 'subroutine', ref: nm, start, end: i };
        } else if (t.startsWith('?<')) { kind = 'named'; i += 2; name = readName('>'); }
        else if (t.startsWith("?'")) { kind = 'named'; i += 2; name = readName("'"); }
        else if (/^\?[R0-9+-]/.test(t) && /^\?(R|[+-]?\d+)\)/.test(s.slice(i, i + 8))) {
          const m = /^\?(R|[+-]?\d+)\)/.exec(s.slice(i, i + 8));
          i += m[0].length;
          return { type: 'subroutine', ref: m[1], start, end: i };
        } else {
          const m = /^\?([a-zA-Z]*)(?:-([a-zA-Z]*))?([:)])/.exec(s.slice(i, i + 24));
          if (!m || (!m[1] && !m[2] && m[3] === ')')) err('Unknown group type (?' + (s[i + 1] || '') + ' ...', start);
          flags = { on: m[1] || '', off: m[2] || '' };
          i += m[0].length;
          if (m[3] === ')') {
            if (flags.on.includes('x')) extended = true;
            if (flags.off.includes('x')) extended = false;
            return { type: 'flags', on: flags.on, off: flags.off, start, end: i };
          }
          kind = 'flaggroup';
        }
      }
      let index = 0;
      if (kind === 'capture' || kind === 'named') {
        index = ++groupCount;
        groups.push({ index, name });
      }
      const saveExt = extended;
      if (flags && flags.on.includes('x')) extended = true;
      const body = parseAlt();
      extended = saveExt;
      if (s[i] !== ')') err('Missing ) to close the group', start);
      i++;
      const g = { type: 'group', kind, index, name, body, start, end: i };
      if (flags) g.flags = flags;
      return g;
    }

    function readBraceCount() {
      const m = /^\{(\d*)(?:(,)(\d*))?\}/.exec(s.slice(i, i + 24));
      if (!m) return null;
      if (m[1] === '' && !m[2]) return null;
      if (m[1] === '' && flavor !== 'python') return null; // {,n} is only a quantifier in Python
      const min = m[1] === '' ? 0 : Number(m[1]);
      const max = m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : min;
      return { min, max, len: m[0].length };
    }

    function parseQuant(atom) {
      if (i >= n) return atom;
      let min, max, len;
      const c = s[i];
      if (c === '*') { min = 0; max = Infinity; len = 1; }
      else if (c === '+') { min = 1; max = Infinity; len = 1; }
      else if (c === '?') { min = 0; max = 1; len = 1; }
      else if (c === '{') {
        const b = readBraceCount();
        if (!b) return atom;
        ({ min, max, len } = b);
        if (max < min) err('Numbers out of order in {' + min + ',' + max + '}');
      } else return atom;
      if (atom.type === 'flags' || atom.type === 'comment') err('Nothing to repeat');
      if (atom.type === 'assert' && js && o.unicode) err('Nothing to repeat');
      const start = atom.start;
      i += len;
      let lazy = false, possessive = false;
      if (s[i] === '?') { lazy = true; i++; }
      else if (s[i] === '+' && !js) { possessive = true; i++; }
      if (!js && i < n && (s[i] === '*' || s[i] === '+' || (s[i] === '?' && !lazy))) err('Multiple repeat');
      const body = atom.type === 'char' ? { type: 'literal', text: atom.text, start: atom.start, end: atom.end } : atom;
      return { type: 'quant', min, max, lazy, possessive, body, start, end: i };
    }

    function codePointAtI() {
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      return ch;
    }

    function readHex(min, max) {
      const m = new RegExp('^[0-9a-fA-F]{' + min + ',' + max + '}').exec(s.slice(i, i + max));
      if (!m) return null;
      i += m[0].length;
      return m[0];
    }

    // An escape. inClass: inside [...]. Returns a node or a class item.
    function parseEscape(inClass) {
      const start = i;
      i++; // backslash
      if (i >= n) err('\\ at end of pattern', start);
      const c = s[i];
      const node = (o2) => Object.assign({ start, end: i }, o2);
      if (SHORT[c] && 'dDwWsS'.includes(c)) { i++; return node({ type: 'esc', code: c }); }
      if (SHORT[c] && !js) { i++; return node({ type: 'esc', code: c }); }
      if (c === 'b' && inClass) { i++; return node({ type: 'char', text: '\b' }); }
      if (c === 'b' || c === 'B') { i++; return node({ type: 'assert', kind: c === 'b' ? 'wordb' : 'nonwordb' }); }
      if (!inClass && !js && 'AzZG'.includes(c)) {
        i++;
        const kind = { A: 'strstart', z: 'strend', Z: flavor === 'python' ? 'strend' : 'strendnl', G: 'lastmatch' }[c];
        return node({ type: 'assert', kind, code: c });
      }
      if (!inClass && !js && c === 'K') { i++; return node({ type: 'esc', code: 'K' }); }
      if (c === 'p' || c === 'P') {
        i++;
        let name;
        if (s[i] === '{') {
          const e = s.indexOf('}', i);
          if (e < 0) err('\\' + c + '{ is not closed', start);
          name = s.slice(i + 1, e); i = e + 1;
        } else if (!js && /[A-Za-z]/.test(s[i] || '')) { name = s[i]; i++; }
        else if (js && !o.unicode) return node({ type: 'char', text: c });
        else err('Invalid property escape', start);
        let negate = c === 'P';
        if (name.startsWith('^')) { negate = !negate; name = name.slice(1); }
        return node({ type: 'prop', name, negate });
      }
      if (/[1-9]/.test(c) && !inClass) {
        const m = /^\d+/.exec(s.slice(i, i + 6));
        i += m[0].length;
        return node({ type: 'backref', ref: Number(m[0]) });
      }
      if (c === 'k' && js && !o.unicode && !hasNamed && !inClass) { i++; return node({ type: 'char', text: 'k' }); }
      if (c === 'k' && (s[i + 1] === '<' || s[i + 1] === '{' || s[i + 1] === "'")) {
        const close = { '<': '>', '{': '}', "'": "'" }[s[i + 1]];
        i += 2;
        const nm = readName(close);
        return node({ type: 'backref', ref: nm });
      }
      if (c === 'k' && js && !o.unicode && !inClass) { i++; return node({ type: 'char', text: 'k' }); }
      if (c === 'g' && !js && !inClass) {
        const m = /^g(?:\{(-?\d+|[A-Za-z_]\w*)\}|<([A-Za-z_]\w*|-?\d+)>|(-?\d+))/.exec(s.slice(i, i + 40));
        if (m) {
          i += m[0].length;
          const r = m[1] || m[2] || m[3];
          if (m[2]) return node({ type: 'subroutine', ref: r });
          return node({ type: 'backref', ref: /^-?\d+$/.test(r) ? Number(r) : r });
        }
      }
      if (c === 'u') {
        i++;
        if (s[i] === '{' && (o.unicode || !js)) {
          const e = s.indexOf('}', i);
          const h = e > 0 ? s.slice(i + 1, e) : '';
          if (!/^[0-9a-fA-F]{1,6}$/.test(h) || parseInt(h, 16) > 0x10FFFF) err('Invalid \\u{...} escape', start);
          i = e + 1;
          return node({ type: 'char', text: String.fromCodePoint(parseInt(h, 16)) });
        }
        const h = readHex(4, 4);
        if (h) {
          let cp = parseInt(h, 16);
          // a surrogate pair written as two \u escapes is one character
          if (cp >= 0xD800 && cp <= 0xDBFF && s.slice(i, i + 2) === '\\u') {
            const lo = /^[0-9a-fA-F]{4}/.exec(s.slice(i + 2, i + 6));
            const lv = lo ? parseInt(lo[0], 16) : 0;
            if (lv >= 0xDC00 && lv <= 0xDFFF) { i += 6; cp = (cp - 0xD800) * 0x400 + (lv - 0xDC00) + 0x10000; }
          }
          return node({ type: 'char', text: String.fromCodePoint(cp) });
        }
        if (js && o.unicode) err('Invalid \\u escape', start);
        return node({ type: 'char', text: 'u' });
      }
      if (c === 'x') {
        i++;
        if (s[i] === '{' && !js) {
          const e = s.indexOf('}', i);
          const h = e > 0 ? s.slice(i + 1, e) : '';
          if (!/^[0-9a-fA-F]{1,8}$/.test(h) || parseInt(h, 16) > 0x10FFFF) err('Invalid \\x{...} escape', start);
          i = e + 1;
          return node({ type: 'char', text: String.fromCodePoint(parseInt(h, 16)) });
        }
        const h = readHex(2, 2);
        if (h) return node({ type: 'char', text: String.fromCharCode(parseInt(h, 16)) });
        if (js && o.unicode) err('Invalid \\x escape', start);
        return node({ type: 'char', text: 'x' });
      }
      if (c === 'c') {
        const l = s[i + 1] || '';
        if (/[A-Za-z]/.test(l)) { i += 2; return node({ type: 'char', text: String.fromCharCode(l.charCodeAt(0) % 32) }); }
        i++;
        return node({ type: 'char', text: inClass ? 'c' : '\\c' });
      }
      if (c === '0') {
        i++;
        if (!js) { const m = /^[0-7]{1,2}/.exec(s.slice(i, i + 2)); if (m) { i += m[0].length; return node({ type: 'char', text: String.fromCharCode(parseInt(m[0], 8)) }); } }
        return node({ type: 'char', text: '\0' });
      }
      if (c === 'Q' && !js) {
        i++;
        const e = s.indexOf('\\E', i);
        const text = e < 0 ? s.slice(i) : s.slice(i, e);
        i = e < 0 ? n : e + 2;
        return node({ type: 'quote', text });
      }
      if (c === 'E' && !js) { i++; return null; }
      if (CHAR_ESC[c] && (c !== 'a' && c !== 'e' || !js)) { i++; return node({ type: 'char', text: CHAR_ESC[c] }); }
      if (js && o.unicode && !/[\^$\\.*+?()[\]{}|/-]/.test(c)) err('Invalid escape \\' + c, start);
      return node({ type: 'char', text: codePointAtI() });
    }

    const POSIX = new Set(['alpha', 'digit', 'alnum', 'upper', 'lower', 'space', 'punct', 'xdigit', 'word', 'blank', 'cntrl', 'graph', 'print', 'ascii']);

    function parseClass() {
      const start = i;
      i++; // [
      let negate = false;
      if (s[i] === '^') { negate = true; i++; }
      const items = [];
      let first = true;
      let intersect = false;
      while (i < n && !(s[i] === ']' && !(first && !js))) {
        first = false;
        let item;
        if (s[i] === '[' && s[i + 1] === ':' && !js) {
          const m = /^\[:(\^?)([a-z]+):\]/.exec(s.slice(i, i + 16));
          if (m && POSIX.has(m[2])) { i += m[0].length; items.push({ kind: 'posix', name: m[2], negate: !!m[1] }); continue; }
        }
        if (s[i] === '&' && s[i + 1] === '&' && flavor === 'java') { intersect = true; i += 2; continue; }
        if (s[i] === '[' && flavor === 'java') {
          const inner = parseClass();
          items.push({ kind: 'class', node: inner });
          continue;
        }
        const st = i;
        if (s[i] === '\\') {
          const e = parseEscape(true);
          if (!e) continue;
          if (e.type === 'quote') { for (const ch of e.text) items.push({ kind: 'char', text: ch }); continue; }
          item = e.type === 'char' ? { kind: 'char', text: e.text } : (e.type === 'esc' ? { kind: 'esc', code: e.code } : (e.type === 'prop' ? { kind: 'prop', name: e.name, negate: e.negate } : { kind: 'char', text: s.slice(st + 1, i) }));
        } else {
          item = { kind: 'char', text: codePointAtI() };
        }
        // range a-z
        if (item.kind === 'char' && s[i] === '-' && s[i + 1] !== undefined && s[i + 1] !== ']') {
          const save = i;
          i++;
          let to;
          if (s[i] === '\\') { const e = parseEscape(true); to = e && e.type === 'char' ? e.text : null; }
          else if (s[i] === '[' && s[i + 1] === ':' && !js) to = null;
          else to = codePointAtI();
          if (to === null) {
            if (js && o.unicode) err('Invalid character class range', st);
            i = save; items.push(item); continue;
          }
          if (to.codePointAt(0) < item.text.codePointAt(0)) err('Range out of order in character class', st);
          items.push({ kind: 'range', from: item.text, to });
          continue;
        }
        items.push(item);
      }
      if (i >= n) err('Missing ] to close the character class', start);
      i++;
      const node = { type: 'class', negate, items, start, end: i };
      if (intersect) node.intersect = true;
      return node;
    }

    function parseAtom() {
      const start = i;
      const c = s[i];
      if (c === '(') return parseGroup();
      if (c === '[') return parseClass();
      if (c === '.') { i++; return { type: 'any', start, end: i }; }
      if (c === '^') { i++; return { type: 'assert', kind: 'start', start, end: i }; }
      if (c === '$') { i++; return { type: 'assert', kind: 'end', start, end: i }; }
      if (c === '\\') {
        const e = parseEscape(false);
        if (e && e.type === 'quote') {
          if (!e.text) return null;
          return { type: 'literal', text: e.text, start: e.start, end: e.end, quoted: true };
        }
        return e;
      }
      if (c === '*' || c === '+' || c === '?') err('Nothing to repeat');
      if (c === '{') {
        if (readBraceCount()) err('Nothing to repeat');
        if (js && o.unicode) err('Lone { must be escaped with the u flag');
      }
      if (c === '}' && js && o.unicode) err('Lone } must be escaped with the u flag');
      if (c === ']' && js && o.unicode) err('Lone ] must be escaped with the u flag');
      return { type: 'char', text: codePointAtI(), start, end: i };
    }

    const ast = parseAlt();
    if (i < n) err(s[i] === ')' ? 'Unmatched )' : 'Unexpected ' + s[i]);
    // backreferences must name a group that exists
    const names = new Set(groups.filter((g) => g.name).map((g) => g.name));
    const dupe = groups.filter((g) => g.name).find((g, k, a) => a.findIndex((x) => x.name === g.name) !== k);
    if (dupe && flavor !== 'dotnet') err('Duplicate group name "' + dupe.name + '"', 0);
    walk(ast, (nd) => {
      if (nd.type !== 'backref') return;
      if (typeof nd.ref === 'string' && !names.has(nd.ref)) throw new RegexSyntaxError('No group named "' + nd.ref + '"', nd.start);
      if (typeof nd.ref === 'number' && nd.ref > 0 && nd.ref > groupCount && !js) throw new RegexSyntaxError('No group ' + nd.ref, nd.start);
    });
    return { ast, groups, groupCount };
  }

  function walk(node, fn, parent) {
    if (!node) return;
    fn(node, parent);
    if (node.type === 'alt') for (const a of node.alts) walk(a, fn, node);
    else if (node.type === 'seq') for (const it of node.items) walk(it, fn, node);
    else if (node.type === 'group' || node.type === 'quant') walk(node.body, fn, node);
  }

  // Width in characters: [min, max]. Used to find variable-width lookbehind.
  function width(node) {
    switch (node.type) {
      case 'alt': { let lo = Infinity, hi = 0; for (const a of node.alts) { const [l, h] = width(a); lo = Math.min(lo, l); hi = Math.max(hi, h); } return [lo, hi]; }
      case 'seq': { let lo = 0, hi = 0; for (const it of node.items) { const [l, h] = width(it); lo += l; hi += h; } return [lo, hi]; }
      case 'literal': { const k = [...node.text].length; return [k, k]; }
      case 'char': case 'any': case 'class': case 'esc': case 'prop': return node.code === 'R' ? [1, 2] : (node.code === 'X' ? [1, Infinity] : [1, 1]);
      case 'quant': { const [l, h] = width(node.body); return [l * node.min, node.max === Infinity ? (h === 0 ? 0 : Infinity) : h * node.max]; }
      case 'group': if (/look/.test(node.kind)) return [0, 0]; return width(node.body);
      case 'backref': case 'subroutine': return [0, Infinity];
      default: return [0, 0];
    }
  }

  const POSIX_JS = {
    alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s', punct: '!-\\/:-@\\[-`{-~',
    xdigit: '0-9A-Fa-f', word: '\\w', blank: ' \\t', cntrl: '\\x00-\\x1f\\x7f', graph: '!-~', print: ' -~', ascii: '\\x00-\\x7f',
  };
  // Java's \p{Alpha} style names (ASCII classes) and a few common aliases.
  const JAVA_PROPS = { Lower: 'a-z', Upper: 'A-Z', ASCII: '\\x00-\\x7f', Alpha: 'a-zA-Z', Digit: '0-9', Alnum: 'a-zA-Z0-9', Punct: '!-\\/:-@\\[-`{-~', Graph: '!-~', Print: ' -~', Blank: ' \\t', Cntrl: '\\x00-\\x1f\\x7f', XDigit: '0-9a-fA-F', Space: ' \\t\\n\\x0b\\f\\r' };
  const PROP_ALIAS = { L: 'L', Lu: 'Lu', Ll: 'Ll', N: 'N', Nd: 'Nd', P: 'P', S: 'S', Z: 'Z', M: 'M', C: 'C' };

  function escLiteralChar(ch, inClass) {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    if (ch === '\f') return '\\f';
    if (ch === '\v') return '\\v';
    if (ch === '\0') return '\\0';
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || cp === 0x7f) return '\\x' + cp.toString(16).padStart(2, '0');
    if (cp === 0x2028 || cp === 0x2029) return '\\u' + cp.toString(16);
    if (inClass) return /[\\\]^\-[]/.test(ch) ? '\\' + ch : ch;
    return /[\\^$.*+?()[\]{}|/]/.test(ch) ? '\\' + ch : ch;
  }

  /**
   * Checks a pattern for one flavor and writes it for the JavaScript engine.
   * flags: a string of letters (g i m s u y x d v). Returns
   * { ok, error, errorPos, source, flags, warnings: [text], notes: [text], ast, groups, groupCount }.
   * For JavaScript the pattern is used as written. For other flavors it is rebuilt from the parse tree.
   */
  function prepare(pattern, flags, flavor) {
    const fl = FLAVORS[flavor] ? flavor : 'javascript';
    const js = fl === 'javascript';
    let f = String(flags || '').replace(/[^gimsuyxdv]/g, '');
    const warnings = [];
    const notes = [];
    const warn = (t) => { if (!warnings.includes(t)) warnings.push(t); };
    const note = (t) => { if (!notes.includes(t)) notes.push(t); };
    let parsed;
    let perr = null;
    try {
      parsed = parse(pattern, { flavor: fl, extended: !js && f.includes('x'), unicode: js && /[uv]/.test(f) });
    } catch (e) {
      perr = e;
    }
    if (js) {
      // JavaScript: the engine itself decides what is valid; the parser is only for the diagram and explain.
      let engineErr = null;
      try { new RegExp(pattern, f.replace(/[gx]/g, '')); } catch (e) { engineErr = String(e.message || e).replace(/^Invalid regular expression: \/.*\/[a-z]*: /, ''); }
      if (engineErr) return { ok: false, error: perr ? perr.message : engineErr, errorPos: perr ? perr.pos : undefined, warnings, notes, flags: f, source: pattern };
      if (perr) {
        note('The diagram and explain list cannot show this pattern (' + perr.message + '), but it runs.');
        return { ok: true, source: pattern, flags: f.replace(/x/g, ''), warnings, notes, ast: null, groups: [], groupCount: 0 };
      }
    } else if (perr) {
      return { ok: false, error: perr.message, errorPos: perr.pos, warnings, notes, flags: f, source: pattern };
    }
    const { ast, groups, groupCount } = parsed;
    const name = FLAVORS[fl];
    const has = (pred) => { let hit = null; walk(ast, (nd) => { if (!hit && pred(nd)) hit = nd; }); return hit; };
    const look = has((nd) => nd.type === 'group' && /look/.test(nd.kind));
    const lookbehind = has((nd) => nd.type === 'group' && /lookbehind/.test(nd.kind));
    const backref = has((nd) => nd.type === 'backref');
    const possessive = has((nd) => nd.type === 'quant' && nd.possessive);
    const atomic = has((nd) => nd.type === 'group' && nd.kind === 'atomic');
    const prop = has((nd) => nd.type === 'prop' || (nd.type === 'class' && nd.items.some((x) => x.kind === 'prop')));
    const pyNamed = has((nd) => nd.type === 'group' && nd.kind === 'named' && pattern.slice(nd.start, nd.start + 3) === '(?P');
    const plainNamed = has((nd) => nd.type === 'group' && nd.kind === 'named' && pattern.slice(nd.start, nd.start + 3) !== '(?P');
    const kref = has((nd) => nd.type === 'backref' && typeof nd.ref === 'string' && nd.syntax !== 'python');
    const pyRef = has((nd) => nd.type === 'backref' && nd.syntax === 'python');
    const shorthand = has((nd) => (nd.type === 'esc' && 'dwsDWS'.includes(nd.code)) || (nd.type === 'class' && nd.items.some((x) => x.kind === 'esc' && 'dwsDWS'.includes(x.code))));
    const varBehind = (() => { let v = null; walk(ast, (nd) => { if (!v && nd.type === 'group' && /lookbehind/.test(nd.kind)) { const [lo, hi] = width(nd.body); if (lo !== hi) v = { nd, hi }; } }); return v; })();
    const inlineFlags = has((nd) => nd.type === 'flags' || (nd.type === 'group' && nd.kind === 'flaggroup'));
    const subroutine = has((nd) => nd.type === 'subroutine');
    const branchreset = has((nd) => nd.type === 'group' && nd.kind === 'branchreset');
    const intersect = has((nd) => nd.type === 'class' && nd.intersect);
    const endDollar = has((nd) => nd.type === 'assert' && nd.kind === 'end');
    const strAnch = has((nd) => nd.type === 'assert' && nd.code);
    const unsupportedEsc = has((nd) => nd.type === 'esc' && 'KXG'.includes(nd.code));

    if (possessive) {
      const what = 'Possessive quantifier ' + pattern.slice(possessive.start, possessive.end).slice(-3);
      if (fl === 'python') warn(what + ': Python supports it only from 3.11 (an error in 3.10 and older). JavaScript has none, so it is tested here as a normal greedy quantifier; results can differ when backtracking matters.');
      else if (fl === 'go') warn(what + ': not supported in Go or Rust (RE2); the pattern does not compile there.');
      else if (fl === 'dotnet') warn(what + ': .NET has no possessive quantifiers (use an atomic group (?>...)); the pattern does not compile in .NET.');
      else warn(what + ': JavaScript has none, so it is tested here as a normal greedy quantifier; results can differ when backtracking matters.');
    }
    if (atomic) {
      if (fl === 'python') warn('Atomic group (?>...): Python supports it only from 3.11. Tested here as a plain group (?:...); results can differ when backtracking matters.');
      else if (fl === 'go') warn('Atomic group (?>...): not supported in Go or Rust (RE2).');
      else warn('Atomic group (?>...): tested here as a plain group (?:...), because JavaScript has none; results can differ when backtracking matters.');
    }
    if (fl === 'go') {
      if (look) warn('Go and Rust (RE2) have no lookahead or lookbehind: ' + pattern.slice(look.start, Math.min(look.end, look.start + 12)) + ' does not compile there.');
      if (backref) warn('Go and Rust (RE2) have no backreferences: ' + pattern.slice(backref.start, backref.end) + ' does not compile there.');
      if (plainNamed) note('Named groups written (?<name>...) need Go 1.22 or newer; (?P<name>...) works in every version.');
      if (has((nd) => nd.type === 'assert' && nd.code === 'Z')) warn('\\Z is not in Go or Rust; use \\z.');
    }
    if (fl === 'python') {
      if (plainNamed) warn('Python\'s re module needs (?P<name>...) for a named group; (?<name>...) is a syntax error there.');
      if (kref) warn('Python\'s re module has no \\k<name>; use (?P=name).');
      if (prop) warn('Python\'s re module has no \\p{...} Unicode properties (the third-party regex module has them).');
      if (has((nd) => nd.type === 'assert' && nd.code === 'z')) warn('\\z needs Python 3.14 or newer; \\Z works in every version.');
      if (varBehind) warn('Lookbehind must have a fixed width in Python ("look-behind requires fixed-width pattern"): ' + pattern.slice(varBehind.nd.start, Math.min(varBehind.nd.end, varBehind.nd.start + 30)));
      if (shorthand) note('In Python, \\d, \\w and \\s on str patterns also match non-ASCII digits, letters and spaces unless re.ASCII is set. This preview matches ASCII only.');
      if (endDollar && !f.includes('m')) note('Python\'s $ also matches before a newline at the very end of the text. This preview does the same.');
    }
    if (fl === 'java') {
      if (pyNamed) warn('Java has no (?P<name>...); write (?<name>...).');
      if (pyRef) warn('Java has no (?P=name); write \\k<name>.');
      if (varBehind && varBehind.hi === Infinity) warn('Java lookbehind needs a bounded length (no * or + inside).');
      if (intersect) warn('Java class intersection [..&&..] is not tested here: the classes are joined as a union.');
      if (plainNamed && has((nd) => nd.type === 'group' && nd.kind === 'named' && !/^[A-Za-z][A-Za-z0-9]*$/.test(nd.name))) warn('Java group names may only use ASCII letters and digits, starting with a letter.');
    }
    if (fl === 'dotnet') {
      if (pyNamed) warn('.NET has no (?P<name>...); write (?<name>...).');
      if (pyRef) warn('.NET has no (?P=name); write \\k<name>.');
      if (shorthand) note('In .NET, \\d and \\w also match non-ASCII digits and letters unless RegexOptions.ECMAScript is set. This preview matches ASCII only.');
    }
    if (fl === 'pcre') {
      if (varBehind && varBehind.hi === Infinity) warn('PCRE lookbehind cannot be unbounded (no * or + inside).');
      else if (varBehind) note('Lookbehind alternatives of different lengths need PCRE2 10.43 or newer when one branch has a variable length.');
    }
    if (fl !== 'javascript' && fl !== 'python' && fl !== 'dotnet' && endDollar && !f.includes('m') && fl !== 'go') note('$ here also matches before a newline at the very end of the text, as in ' + name + '.');
    if (subroutine) warn('Recursion and subroutine calls ' + pattern.slice(subroutine.start, subroutine.end) + ' cannot be tested in JavaScript.');
    if (branchreset) warn('Branch reset groups (?|...) are tested here as plain groups; group numbers can differ.');
    if (unsupportedEsc) warn('\\' + unsupportedEsc.code + ' cannot be tested in JavaScript; it is left out of the test.');
    if (strAnch && js) note('In JavaScript, \\A, \\z and \\Z are the plain letters A, z and Z.');

    if (js) {
      return { ok: true, source: pattern, flags: f.replace(/x/g, ''), warnings, notes, ast, groups, groupCount };
    }

    // Rebuild for JavaScript.
    let hoisted = '';
    let firstItem = true;
    const out = [];
    const ser = (nd) => {
      switch (nd.type) {
        case 'alt': return nd.alts.map(ser).join('|');
        case 'seq': return nd.items.map((x) => { const r = ser(x); if (x.type !== 'flags' && x.type !== 'comment') firstItem = false; return r; }).join('');
        case 'literal': return [...nd.text].map((c) => escLiteralChar(c, false)).join('');
        case 'char': return escLiteralChar(nd.text, false);
        case 'any': return '.';
        case 'esc':
          if ('dDwWsS'.includes(nd.code)) return '\\' + nd.code;
          if (nd.code === 'h') return '[\\t \\u00a0\\u1680\\u180e\\u2000-\\u200a\\u202f\\u205f\\u3000]';
          if (nd.code === 'H') return '[^\\t \\u00a0\\u1680\\u180e\\u2000-\\u200a\\u202f\\u205f\\u3000]';
          if (nd.code === 'v') return '[\\n\\x0b\\f\\r\\x85\\u2028\\u2029]';
          if (nd.code === 'V') return '[^\\n\\x0b\\f\\r\\x85\\u2028\\u2029]';
          if (nd.code === 'R') return '(?:\\r\\n|[\\n\\x0b\\f\\r\\x85\\u2028\\u2029])';
          if (nd.code === 'N') return '[^\\n]';
          return '';
        case 'prop': return serProp(nd.name, nd.negate);
        case 'class': {
          const parts = nd.items.map(serItem).join('');
          return '[' + (nd.negate ? '^' : '') + parts + ']';
        }
        case 'quote': return [...nd.text].map((c) => escLiteralChar(c, false)).join('');
        case 'assert':
          switch (nd.kind) {
            case 'start': return '^';
            case 'end': return (f.includes('m') || fl === 'go') ? '$' : '(?=\\n?(?![\\s\\S]))';
            case 'wordb': return '\\b';
            case 'nonwordb': return '\\B';
            case 'strstart': return '(?<![\\s\\S])';
            case 'strend': return '(?![\\s\\S])';
            case 'strendnl': return '(?=\\n?(?![\\s\\S]))';
            default: return '';
          }
        case 'backref': {
          if (typeof nd.ref === 'number') {
            const k = nd.ref < 0 ? groupsBefore(nd.start) + nd.ref + 1 : nd.ref;
            return '\\' + k + '(?:)';
          }
          return '\\k<' + nd.ref + '>';
        }
        case 'group': {
          const body = ser(nd.body);
          switch (nd.kind) {
            case 'capture': return '(' + body + ')';
            case 'named': return '(?<' + nd.name + '>' + body + ')';
            case 'lookahead': return '(?=' + body + ')';
            case 'neglookahead': return '(?!' + body + ')';
            case 'lookbehind': return '(?<=' + body + ')';
            case 'neglookbehind': return '(?<!' + body + ')';
            case 'flaggroup':
              warn('Inline flags on part of the pattern ' + pattern.slice(nd.start, nd.start + 2 + nd.flags.on.length + (nd.flags.off ? nd.flags.off.length + 1 : 0) + 1) + ' are not tested here (VS Code\'s engine may not have them); that part is tested without them.');
              return '(?:' + body + ')';
            default: return '(?:' + body + ')';
          }
        }
        case 'quant': {
          let b = ser(nd.body);
          const bt = nd.body.type;
          if ((bt === 'literal' && [...nd.body.text].length > 1) || bt === 'quote' || bt === 'seq' || bt === 'alt' || bt === 'quant' || bt === 'backref' || bt === 'assert' || (bt === 'group' && /look/.test(nd.body.kind))) b = '(?:' + b + ')';
          let q;
          if (nd.min === 0 && nd.max === Infinity) q = '*';
          else if (nd.min === 1 && nd.max === Infinity) q = '+';
          else if (nd.min === 0 && nd.max === 1) q = '?';
          else if (nd.max === Infinity) q = '{' + nd.min + ',}';
          else if (nd.max === nd.min) q = '{' + nd.min + '}';
          else q = '{' + nd.min + ',' + nd.max + '}';
          return b + q + (nd.lazy ? '?' : '');
        }
        case 'flags': {
          if (firstItem) {
            for (const c of nd.on) {
              if ('ims'.includes(c)) { if (!f.includes(c)) { f += c; hoisted += c; } }
              else if (c === 'x' || c === 'u' || c === 'a' || c === 'L') { /* x is handled by the parser; u, a, L change only Unicode details */ }
              else warn('Inline flag (?' + c + ') is not tested here.');
            }
            for (const c of nd.off) f = f.replace(c, '');
          } else {
            warn('Inline flags (?' + nd.on + (nd.off ? '-' + nd.off : '') + ') in the middle of the pattern are not tested here; put them at the start.');
          }
          return '';
        }
        default: return '';
      }
    };
    const groupsBefore = (pos) => groups.filter((g) => true && findGroupStart(g.index) < pos).length;
    const starts = [];
    walk(ast, (nd) => { if (nd.type === 'group' && nd.index) starts[nd.index] = nd.start; });
    const findGroupStart = (k) => starts[k];
    const serProp = (name, negate) => {
      const P = negate ? 'P' : 'p';
      if (JAVA_PROPS[name] && (fl === 'java' || fl === 'pcre')) return (negate ? '[^' : '[') + JAVA_PROPS[name] + ']';
      let nm = name;
      if (/^Is[A-Z]/.test(nm)) nm = 'Script=' + nm.slice(2);
      else if (/^In[A-Z]/.test(nm)) { warn('Unicode block \\p{' + name + '} cannot be tested in JavaScript; it is tested as "any character".'); return negate ? '[^\\s\\S]' : '[\\s\\S]'; }
      else if (PROP_ALIAS[nm]) nm = PROP_ALIAS[nm];
      return '\\' + P + '{' + nm + '}';
    };
    const serItem = (it) => {
      switch (it.kind) {
        case 'char': return escLiteralChar(it.text, true);
        case 'range': return escLiteralChar(it.from, true) + '-' + escLiteralChar(it.to, true);
        case 'esc':
          if ('dDwWsS'.includes(it.code)) return '\\' + it.code;
          if (it.code === 'h') return '\\t \\u00a0\\u1680\\u180e\\u2000-\\u200a\\u202f\\u205f\\u3000';
          if (it.code === 'v') return '\\n\\x0b\\f\\r\\x85\\u2028\\u2029';
          return '';
        case 'prop': { const r = serProp(it.name, it.negate); return r.startsWith('[') ? r.slice(1, -1) : r; }
        case 'posix':
          if (!it.negate) return POSIX_JS[it.name] || '';
          if ({ digit: 1, word: 1, space: 1 }[it.name]) return { digit: '\\D', word: '\\W', space: '\\S' }[it.name];
          warn('Negated POSIX class [:^' + it.name + ':] inside a class cannot be tested here; it is left out.');
          return '';
        case 'class': return it.node.items.map(serItem).join('');
        default: return '';
      }
    };
    let source;
    try {
      source = ser(ast);
    } catch (e) {
      return { ok: false, error: e.message, warnings, notes, flags: f, source: pattern };
    }
    // u: every non-JavaScript flavor reads the pattern by code point and allows \p{...}
    f = f.replace(/x/g, '');
    if (!f.includes('u') && !f.includes('v')) f += 'u';
    out.push(source);
    void hoisted;
    try { new RegExp(source, f); } catch (e) {
      return { ok: false, error: 'This pattern cannot be tested in JavaScript: ' + String(e.message || e).replace(/^Invalid regular expression: \/.*\/[a-z]*: /, ''), warnings, notes, flags: f, source };
    }
    return { ok: true, source, flags: f, warnings, notes, ast, groups, groupCount };
  }

  function visible(text, max) {
    let t = String(text).replace(/[\n\r\t\f\v\0]/g, (c) => ({ '\n': '\\n', '\r': '\\r', '\t': '\\t', '\f': '\\f', '\v': '\\v', '\0': '\\0' })[c]);
    if (max && t.length > max) t = t.slice(0, max - 1) + '…';
    return t;
  }

  function classItemText(it) {
    switch (it.kind) {
      case 'char': return it.text === ' ' ? 'space' : visible(it.text);
      case 'range': return visible(it.from) + ' to ' + visible(it.to);
      case 'esc': return 'a ' + (SHORT[it.code] || '\\' + it.code);
      case 'prop': return (it.negate ? 'not ' : '') + 'Unicode ' + it.name;
      case 'posix': return (it.negate ? 'not ' : '') + it.name;
      case 'class': return '[' + it.node.items.map(classItemText).join(', ') + ']';
      default: return '?';
    }
  }

  const ASSERT_TEXT = {
    start: 'Start of the text (start of a line with the m flag)',
    end: 'End of the text (end of a line with the m flag)',
    wordb: 'Word boundary',
    nonwordb: 'Not a word boundary',
    strstart: 'Start of the text (always)',
    strend: 'End of the text (always)',
    strendnl: 'End of the text, or before a final newline',
    lastmatch: 'Where the last match ended',
  };
  const PROP_NAMES = { L: 'letter', Lu: 'uppercase letter', Ll: 'lowercase letter', N: 'number', Nd: 'decimal digit', P: 'punctuation', S: 'symbol', Z: 'separator', M: 'mark', Emoji: 'emoji' };

  function quantText(q) {
    let t;
    if (q.min === 0 && q.max === Infinity) t = 'zero or more times';
    else if (q.min === 1 && q.max === Infinity) t = 'one or more times';
    else if (q.min === 0 && q.max === 1) t = 'optionally (zero or one time)';
    else if (q.max === Infinity) t = q.min + ' or more times';
    else if (q.min === q.max) t = 'exactly ' + q.min + ' time' + (q.min === 1 ? '' : 's');
    else t = q.min + ' to ' + q.max + ' times';
    if (q.lazy) t += ', as few as possible (lazy)';
    else if (q.possessive) t += ', as many as possible, never giving any back (possessive)';
    else if (q.max !== q.min) t += ', as many as possible (greedy)';
    return t;
  }

  /** One plain line per token: [{ depth, text, start, end }]. */
  function explain(ast, opts) {
    const o = opts || {};
    const lines = [];
    const add = (depth, text, nd) => lines.push({ depth, text, start: nd.start, end: nd.end });
    const rec = (nd, d) => {
      switch (nd.type) {
        case 'alt':
          add(d, 'Either of ' + nd.alts.length + ' options:', nd);
          nd.alts.forEach((a, k) => { add(d + 1, 'Option ' + (k + 1) + ':', a); rec(a, d + 2); });
          return;
        case 'seq':
          if (!nd.items.length) add(d, 'Nothing (an empty match)', nd);
          for (const it of nd.items) rec(it, d);
          return;
        case 'literal': add(d, 'The text "' + visible(nd.text, 80) + '"', nd); return;
        case 'char': add(d, 'The character "' + visible(nd.text) + '"', nd); return;
        case 'quote': add(d, 'The exact text "' + visible(nd.text, 80) + '" (quoted)', nd); return;
        case 'any': add(d, o.dotAll ? 'Any character' : 'Any character except a line break', nd); return;
        case 'esc': add(d, 'A ' + (SHORT[nd.code] || ('\\' + nd.code)) + ({ d: ' (0-9)', w: ' (letter, digit or _)', s: ' (space, tab, line break)' }[nd.code] || ''), nd); return;
        case 'prop': add(d, 'A character ' + (nd.negate ? 'without' : 'with') + ' the Unicode property ' + nd.name + (PROP_NAMES[nd.name] ? ' (' + PROP_NAMES[nd.name] + ')' : ''), nd); return;
        case 'class': {
          const parts = nd.items.map(classItemText);
          if (!nd.items.length) add(d, nd.negate ? 'Any character' : 'Nothing (an empty class never matches)', nd);
          else add(d, (nd.negate ? 'One character that is not: ' : 'One character from: ') + visible(parts.join(', '), 200), nd);
          return;
        }
        case 'assert': add(d, ASSERT_TEXT[nd.kind] || nd.kind, nd); return;
        case 'backref': add(d, 'The same text that group ' + (typeof nd.ref === 'number' ? nd.ref : '"' + nd.ref + '"') + ' matched', nd); return;
        case 'subroutine': add(d, 'The pattern of group ' + nd.ref + ' again (recursion)', nd); return;
        case 'comment': add(d, 'Comment: ' + visible(nd.text, 80), nd); return;
        case 'flags': add(d, 'Turn ' + (nd.on ? 'on flags ' + nd.on : '') + (nd.on && nd.off ? ' and ' : '') + (nd.off ? 'off flags ' + nd.off : '') + ' from here', nd); return;
        case 'quant':
          add(d, 'Repeat ' + quantText(nd) + ':', nd);
          rec(nd.body, d + 1);
          return;
        case 'group': {
          const head = {
            capture: 'Group ' + nd.index + ' (captured):',
            named: 'Group ' + nd.index + ' named "' + nd.name + '" (captured):',
            noncap: 'Group (not captured):',
            lookahead: 'Followed by (lookahead, not part of the match):',
            neglookahead: 'Not followed by (negative lookahead):',
            lookbehind: 'Preceded by (lookbehind, not part of the match):',
            neglookbehind: 'Not preceded by (negative lookbehind):',
            atomic: 'Atomic group (no backtracking into it):',
            branchreset: 'Branch reset group:',
            flaggroup: 'Group with flags ' + (nd.flags ? nd.flags.on + (nd.flags.off ? '-' + nd.flags.off : '') : '') + ':',
          }[nd.kind];
          add(d, head, nd);
          rec(nd.body, d + 1);
          return;
        }
        default: add(d, nd.type, nd);
      }
    };
    rec(ast, 0);
    return lines;
  }

  return { FLAVORS, RegexSyntaxError, parse, prepare, explain, walk, width, visible, classItemText, quantText, SHORT, ASSERT_TEXT, PROP_NAMES };
});
