/* Regex Preview core: runs a pattern over the sample text. The webview runs runMatch in a Web Worker (built from
 * these functions' source text) and stops the worker when it takes longer than the time limit, so a pattern that
 * backtracks forever never freezes anything. The functions are self-contained on purpose: each one must work after
 * Function.prototype.toString. Unit tests call them directly. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.RegexPreview = root.RegexPreview || {}; Object.assign(root.RegexPreview, api); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Next index after an empty match: one code point with the u or v flag, else one UTF-16 unit. */
  function advanceIndex(text, index, unicode) {
    if (unicode && index < text.length) {
      const c = text.charCodeAt(index);
      if (c >= 0xD800 && c <= 0xDBFF && index + 1 < text.length) {
        const d = text.charCodeAt(index + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) return index + 2;
      }
    }
    return index + 1;
  }

  /**
   * Replacement text for one match, in the syntax of the flavor.
   * m: a RegExp exec result (with .index, .input and .groups). flavor: javascript, python, java, dotnet, go, pcre.
   *   javascript: $1 $<name> $& $` $' $$        python: \1 \g<1> \g<name> \\ \n \t
   *   java: $1 ${name} \$ \\                    dotnet: $1 ${name} ${1} $& $` $' $$ $_
   *   go: $1 ${1} $name ${name} $$              pcre (PHP): $1 \1 ${1} \\
   */
  function expandReplacement(tpl, m, flavor) {
    const t = String(tpl);
    const g = (k) => {
      if (typeof k === 'number' || /^\d+$/.test(k)) { const v = m[Number(k)]; return v === undefined ? '' : v; }
      const v = m.groups ? m.groups[k] : undefined;
      return v === undefined ? '' : v;
    };
    const groupCount = m.length - 1;
    let out = '';
    let i = 0;
    const n = t.length;
    const fl = flavor || 'javascript';
    while (i < n) {
      const c = t[i];
      if (fl === 'python') {
        if (c === '\\' && i + 1 < n) {
          const d = t[i + 1];
          const mm = /^\\g<([^>]+)>/.exec(t.slice(i, i + 64));
          if (mm) { out += g(mm[1]); i += mm[0].length; continue; }
          const num = /^\\(\d{1,2})/.exec(t.slice(i, i + 3));
          if (num) { out += g(num[1]); i += num[0].length; continue; }
          const esc = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', a: '\x07', b: '\b', '\\': '\\' }[d];
          if (esc !== undefined) { out += esc; i += 2; continue; }
          out += c + d; i += 2; continue;
        }
        out += c; i++; continue;
      }
      if (fl === 'java') {
        if (c === '\\' && i + 1 < n) { out += t[i + 1]; i += 2; continue; }
        if (c === '$') {
          const nm = /^\$\{([A-Za-z][A-Za-z0-9]*)\}/.exec(t.slice(i, i + 64));
          if (nm) { out += g(nm[1]); i += nm[0].length; continue; }
          // Java reads as many digits as still name an existing group
          const dm = /^\$(\d+)/.exec(t.slice(i, i + 12));
          if (dm) {
            let digits = dm[1][0];
            for (let k = 1; k < dm[1].length; k++) { if (Number(digits + dm[1][k]) <= groupCount) digits += dm[1][k]; else break; }
            out += g(digits); i += 1 + digits.length; continue;
          }
        }
        out += c; i++; continue;
      }
      if (fl === 'pcre') {
        if (c === '\\' && i + 1 < n) {
          const num = /^\\(\d{1,2})/.exec(t.slice(i, i + 3));
          if (num) { out += g(num[1]); i += num[0].length; continue; }
          if (t[i + 1] === '\\') { out += '\\'; i += 2; continue; }
        }
        if (c === '$') {
          const b = /^\$\{(\d{1,2})\}/.exec(t.slice(i, i + 6));
          if (b) { out += g(b[1]); i += b[0].length; continue; }
          const num = /^\$(\d{1,2})/.exec(t.slice(i, i + 3));
          if (num) { out += g(num[1]); i += num[0].length; continue; }
        }
        out += c; i++; continue;
      }
      if (fl === 'go') {
        if (c === '$') {
          if (t[i + 1] === '$') { out += '$'; i += 2; continue; }
          const b = /^\$\{(\w+)\}/.exec(t.slice(i, i + 64));
          if (b) { out += g(b[1]); i += b[0].length; continue; }
          const w = /^\$(\w+)/.exec(t.slice(i, i + 64));
          if (w) { out += /^\d+$/.test(w[1]) ? g(w[1]) : g(w[1]); i += w[0].length; continue; }
        }
        out += c; i++; continue;
      }
      // javascript and dotnet
      if (c === '$' && i + 1 < n) {
        const d = t[i + 1];
        if (d === '$') { out += '$'; i += 2; continue; }
        if (d === '&') { out += m[0]; i += 2; continue; }
        if (d === '`') { out += m.input.slice(0, m.index); i += 2; continue; }
        if (d === "'") { out += m.input.slice(m.index + m[0].length); i += 2; continue; }
        if (fl === 'dotnet' && d === '_') { out += m.input; i += 2; continue; }
        if (fl === 'dotnet' && d === '{') {
          const b = /^\$\{(\w+)\}/.exec(t.slice(i, i + 64));
          if (b) { out += g(b[1]); i += b[0].length; continue; }
        }
        if (fl === 'javascript' && d === '<' && m.groups) {
          const e = t.indexOf('>', i);
          if (e > 0) { out += g(t.slice(i + 2, e)); i = e + 1; continue; }
        }
        if (/\d/.test(d)) {
          const two = t.slice(i + 1, i + 3);
          if (/^\d\d$/.test(two) && Number(two) >= 1 && Number(two) <= groupCount) { out += g(two); i += 3; continue; }
          if (Number(d) >= 1 && Number(d) <= groupCount) { out += g(d); i += 2; continue; }
        }
      }
      out += c; i++;
    }
    return out;
  }

  /**
   * Runs the pattern. req: { source, flags, text, maxRows, hlChars, hlMax, maxCount, replacement, flavor, replaceCap }
   * The g flag decides between all matches and the first one. Returns
   * { ok, error, count, countCapped, rows: [{ index, end, text, groups: [{ v, s, e }] }], names, hl: [s, e, ...],
   *   replaced, replacedCut, ms }
   */
  function runMatch(req) {
    const t0 = Date.now();
    const text = String(req.text || '');
    const flags = String(req.flags || '');
    const all = flags.includes('g');
    const unicode = /[uv]/.test(flags);
    const maxRows = req.maxRows || 1000;
    const hlChars = req.hlChars || 200000;
    const hlMax = req.hlMax || 20000;
    const maxCount = req.maxCount || 1000000;
    const replaceCap = req.replaceCap || 200000;
    const doReplace = typeof req.replacement === 'string';
    const base = flags.replace(/[gd]/g, '');
    let reD, reFast;
    try {
      reD = new RegExp(req.source, base + 'gd');
      reFast = new RegExp(req.source, base + 'g');
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), ms: Date.now() - t0 };
    }
    const names = [];
    const rows = [];
    const hl = [];
    let count = 0;
    let countCapped = false;
    let replaced = '';
    let replacedCut = false;
    let last = 0;
    let re = reD;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      count++;
      const end = m.index + m[0].length;
      if (re === reD) {
        if (!names.length && m.length > 1) {
          for (let k = 1; k < m.length; k++) names.push('');
          if (req.groupNames) for (let k = 1; k < m.length && k <= req.groupNames.length; k++) names[k - 1] = req.groupNames[k - 1] || '';
        }
        const groups = [];
        for (let k = 1; k < m.length; k++) {
          const sp = m.indices[k];
          groups.push(sp ? { v: m[k].length > 2000 ? m[k].slice(0, 2000) : m[k], s: sp[0], e: sp[1], cut: m[k].length > 2000 } : null);
        }
        rows.push({ index: m.index, end, text: m[0].length > 2000 ? m[0].slice(0, 2000) : m[0], cut: m[0].length > 2000, groups });
        if (rows.length >= maxRows) { reFast.lastIndex = re.lastIndex; re = reFast; }
      }
      if (m.index < hlChars && hl.length < hlMax * 2) hl.push(m.index, end);
      if (doReplace && !replacedCut) {
        replaced += text.slice(last, m.index) + expandReplacement(req.replacement, m, req.flavor);
        last = end;
        if (replaced.length > replaceCap) { replaced = replaced.slice(0, replaceCap); replacedCut = true; }
      }
      if (m[0] === '') re.lastIndex = advanceIndex(text, re.lastIndex, unicode);
      if (!all) break;
      if (count >= maxCount) {
        // capped only when another match really follows
        if (re === reD) reFast.lastIndex = re.lastIndex;
        countCapped = reFast.lastIndex <= text.length && reFast.exec(text) !== null;
        break;
      }
    }
    if (doReplace && !replacedCut) {
      replaced += text.slice(last);
      if (replaced.length > replaceCap) { replaced = replaced.slice(0, replaceCap); replacedCut = true; }
    }
    return { ok: true, count, countCapped, rows, names, hl, replaced: doReplace ? replaced : null, replacedCut, ms: Date.now() - t0 };
  }

  /** Source text of a Worker that runs runMatch. The webview makes a blob: URL from it. */
  function workerSource() {
    return [
      '"use strict";',
      advanceIndex.toString(),
      expandReplacement.toString(),
      runMatch.toString(),
      'self.onmessage = function (e) { var r; try { r = runMatch(e.data); } catch (err) { r = { ok: false, error: String(err && err.message || err) }; } r.id = e.data.id; self.postMessage(r); };',
    ].join('\n');
  }

  return { advanceIndex, expandReplacement, runMatch, workerSource };
});
