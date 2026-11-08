/* Regex Preview core: railroad diagram of a parsed pattern, as an SVG string. No DOM needed.
 * Every text goes through esc(), so pattern text can never become markup. Colors come from CSS classes
 * (rr-*): the webview styles them with VS Code theme colors, and the export puts a <style> with fixed colors in. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.RegexPreview = root.RegexPreview || {}; Object.assign(root.RegexPreview, api); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const H = 24; // box height
  const CH = 7.25; // width of one character at 12px monospace
  const PAD = 9; // text padding in a box
  const GAP = 12; // line between items of a sequence
  const R = 10; // curve radius
  const VS = 10; // vertical space between branches
  const MAX_TEXT = 36; // characters shown in one box
  const MAX_BOXES = 6000; // bigger patterns get a short notice instead of a diagram

  const SHORT = { d: 'digit', D: 'non-digit', w: 'word char', W: 'non-word char', s: 'whitespace', S: 'non-whitespace', h: 'horizontal space', H: 'non-horizontal space', v: 'vertical space', V: 'non-vertical space', R: 'line break', N: 'not line break', X: 'grapheme', K: 'reset match start' };
  const ASSERT = { start: 'start', end: 'end', wordb: 'word boundary', nonwordb: 'not word boundary', strstart: 'start of text', strend: 'end of text', strendnl: 'end of text (before final \\n)', lastmatch: 'end of last match' };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function vis(s) {
    return String(s).replace(/[\n\r\t\f\v\0]/g, (c) => ({ '\n': '\\n', '\r': '\\r', '\t': '\\t', '\f': '\\f', '\v': '\\v', '\0': '\\0' })[c])
      .replace(/[\x00-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  }
  function cut(s, max) {
    const a = [...s];
    return a.length > max ? a.slice(0, max - 1).join('') + '…' : s;
  }
  const textW = (s) => [...s].length * CH;

  // ---- layout primitives: each returns { w, up, down, draw(x, y, out) } ----
  function line(w) { return { w, up: 0, down: 0, draw(x, y, out) { if (w > 0) out.push(`<path class="rr-path" d="M${x} ${y}h${w}"/>`); } }; }

  function box(text, cls, title) {
    const t = cut(text, MAX_TEXT);
    const w = Math.max(28, Math.round(textW(t) + 2 * PAD));
    return {
      w, up: H / 2, down: H / 2, boxes: 1,
      draw(x, y, out) {
        const rx = cls === 'rr-lit' ? 11 : 3;
        out.push(`<g class="rr-node ${cls}"><title>${esc(vis(title || text))}</title><rect x="${x}" y="${y - H / 2}" width="${w}" height="${H}" rx="${rx}"/>`
          + `<text x="${x + w / 2}" y="${y + 4}" text-anchor="middle">${esc(t)}</text></g>`);
      },
    };
  }

  function seq(items) {
    if (!items.length) return line(GAP * 2);
    let w = 0, up = 0, down = 0;
    items.forEach((it, k) => { w += it.w + (k ? GAP : 0); up = Math.max(up, it.up); down = Math.max(down, it.down); });
    return {
      w, up, down,
      draw(x, y, out) {
        let cx = x;
        items.forEach((it, k) => {
          if (k) { out.push(`<path class="rr-path" d="M${cx} ${y}h${GAP}"/>`); cx += GAP; }
          it.draw(cx, y, out); cx += it.w;
        });
      },
    };
  }

  function choice(branches) {
    const maxW = Math.max(...branches.map((b) => b.w));
    const w = maxW + 4 * R;
    const up = branches[0].up;
    const ys = [0];
    let down = branches[0].down;
    for (let k = 1; k < branches.length; k++) {
      const off = down + VS + branches[k].up;
      const dy = Math.max(off, 2 * R);
      ys.push(dy);
      down = dy + branches[k].down;
    }
    return {
      w, up, down,
      draw(x, y, out) {
        branches.forEach((b, k) => {
          const by = y + ys[k];
          const bx = x + 2 * R;
          if (k === 0) out.push(`<path class="rr-path" d="M${x} ${y}h${2 * R}"/>`);
          else out.push(`<path class="rr-path" d="M${x} ${y}q${R} 0 ${R} ${R}V${by - R}q0 ${R} ${R} ${R}"/>`);
          b.draw(bx, by, out);
          const ex = bx + b.w;
          if (b.w < maxW) out.push(`<path class="rr-path" d="M${ex} ${by}H${bx + maxW}"/>`);
          const rx = bx + maxW;
          if (k === 0) out.push(`<path class="rr-path" d="M${rx} ${y}h${2 * R}"/>`);
          else out.push(`<path class="rr-path" d="M${rx} ${by}q${R} 0 ${R} ${-R}V${y + R}q0 ${-R} ${R} ${-R}"/>`);
        });
      },
    };
  }

  function optional(body) {
    const lift = Math.max(body.up + VS, 2 * R);
    return {
      w: body.w + 4 * R, up: lift, down: body.down, boxes: body.boxes,
      draw(x, y, out) {
        const by = y - lift;
        out.push(`<path class="rr-path" d="M${x} ${y}h${2 * R}"/>`);
        body.draw(x + 2 * R, y, out);
        out.push(`<path class="rr-path" d="M${x + 2 * R + body.w} ${y}h${2 * R}"/>`);
        out.push(`<path class="rr-path rr-skip" d="M${x} ${y}q${R} 0 ${R} ${-R}V${by + R}q0 ${-R} ${R} ${-R}H${x + 2 * R + body.w}q${R} 0 ${R} ${R}V${y - R}q0 ${R} ${R} ${R}"/>`);
      },
    };
  }

  function loop(body, label) {
    const lw = label ? textW(label) * 0.85 + 8 : 0;
    const inner = Math.max(body.w, lw);
    const drop = Math.max(body.down + VS, 2 * R);
    return {
      w: inner + 4 * R, up: body.up, down: drop + (label ? 16 : 0),
      draw(x, y, out) {
        const bx = x + 2 * R + (inner - body.w) / 2;
        const ly = y + drop;
        out.push(`<path class="rr-path" d="M${x} ${y}H${bx}"/>`);
        body.draw(bx, y, out);
        out.push(`<path class="rr-path" d="M${bx + body.w} ${y}H${x + 4 * R + inner}"/>`);
        const r0 = x + 2 * R + inner;
        out.push(`<path class="rr-path rr-back" d="M${r0} ${y}q${R} 0 ${R} ${R}V${ly - R}q0 ${R} ${-R} ${R}H${x + 2 * R}q${-R} 0 ${-R} ${-R}V${y + R}q0 ${-R} ${R} ${-R}"/>`);
        out.push(`<path class="rr-arrow" d="M${x + 2 * R + inner / 2 + 4} ${ly - 4}l-6 4l6 4z"/>`);
        if (label) out.push(`<text class="rr-label" x="${x + 2 * R + inner / 2}" y="${ly + 14}" text-anchor="middle">${esc(label)}</text>`);
      },
    };
  }

  function frame(body, label, cls) {
    const lw = textW(label) * 0.85 + 12;
    const w = Math.max(body.w + 20, lw);
    return {
      w, up: body.up + 20, down: body.down + 9,
      draw(x, y, out) {
        const top = y - body.up - 18;
        const bot = y + body.down + 8;
        out.push(`<g class="${cls}"><rect class="rr-frame" x="${x}" y="${top}" width="${w}" height="${bot - top}" rx="5"/>`
          + `<text class="rr-glabel" x="${x + 6}" y="${top + 11}">${esc(label)}</text></g>`);
        const bx = x + (w - body.w) / 2;
        out.push(`<path class="rr-path" d="M${x} ${y}H${bx}"/>`);
        body.draw(bx, y, out);
        out.push(`<path class="rr-path" d="M${bx + body.w} ${y}H${x + w}"/>`);
      },
    };
  }

  function terminal(kind) {
    return {
      w: 14, up: 7, down: 7,
      draw(x, y, out) {
        if (kind === 'start') out.push(`<circle class="rr-term" cx="${x + 5}" cy="${y}" r="5"/><path class="rr-path" d="M${x + 10} ${y}h4"/>`);
        else out.push(`<path class="rr-path" d="M${x} ${y}h4"/><circle class="rr-term rr-end" cx="${x + 9}" cy="${y}" r="5"/>`);
      },
    };
  }

  function classText(nd) {
    const parts = nd.items.map((it) => {
      switch (it.kind) {
        case 'char': return it.text === ' ' ? '␣' : vis(it.text);
        case 'range': return vis(it.from) + '-' + vis(it.to);
        case 'esc': return SHORT[it.code] || '\\' + it.code;
        case 'prop': return (it.negate ? '\\P{' : '\\p{') + it.name + '}';
        case 'posix': return '[:' + it.name + ':]';
        case 'class': return '[' + classText(it.node).replace(/^(one of|none of) /, '') + ']';
        default: return '?';
      }
    });
    return (nd.negate ? 'none of ' : 'one of ') + parts.join(' ');
  }

  function quantLabel(q) {
    let t;
    if (q.max === Infinity) t = q.min <= 1 ? '' : q.min + '+ times';
    else if (q.min === q.max) t = q.min + ' times';
    else if (q.min === 0) t = 'up to ' + q.max + ' times';
    else t = q.min + '-' + q.max + ' times';
    if (q.lazy) t += (t ? ', ' : '') + 'lazy';
    if (q.possessive) t += (t ? ', ' : '') + 'possessive';
    return t;
  }

  function build(nd, ctx) {
    ctx.boxes++;
    if (ctx.boxes > MAX_BOXES) throw new Error('too-big');
    switch (nd.type) {
      case 'alt': return choice(nd.alts.map((a) => build(a, ctx)));
      case 'seq': return seq(nd.items.filter((x) => x.type !== 'comment' && x.type !== 'flags').map((x) => build(x, ctx)));
      case 'literal': return box('"' + vis(nd.text) + '"', 'rr-lit', nd.text);
      case 'quote': return box('"' + vis(nd.text) + '"', 'rr-lit', nd.text);
      case 'char': return box('"' + vis(nd.text) + '"', 'rr-lit', nd.text);
      case 'any': return box(ctx.dotAll ? 'any char' : 'any char but \\n', 'rr-esc');
      case 'esc': return box(SHORT[nd.code] || '\\' + nd.code, 'rr-esc');
      case 'prop': return box((nd.negate ? 'not ' : '') + '\\p{' + nd.name + '}', 'rr-esc');
      case 'class': return box(classText(nd), 'rr-cls');
      case 'assert': return box(ASSERT[nd.kind] || nd.kind, 'rr-assert');
      case 'backref': return box('same as group ' + nd.ref, 'rr-ref');
      case 'subroutine': return box('recurse ' + nd.ref, 'rr-ref');
      case 'quant': {
        const body = build(nd.body, ctx);
        const label = quantLabel(nd);
        if (nd.min === 1 && nd.max === 1) return body;
        if (nd.min === 0 && nd.max === 1) return optional(body);
        if (nd.min === 0) return optional(loop(body, label));
        return loop(body, label);
      }
      case 'group': {
        const body = build(nd.body, ctx);
        const label = {
          capture: 'group ' + nd.index,
          named: 'group ' + nd.index + ' "' + cut(String(nd.name || ''), 30) + '"',
          noncap: '',
          lookahead: 'followed by',
          neglookahead: 'not followed by',
          lookbehind: 'preceded by',
          neglookbehind: 'not preceded by',
          atomic: 'atomic',
          branchreset: 'branch reset',
          flaggroup: 'flags ' + (nd.flags ? nd.flags.on + (nd.flags.off ? '-' + nd.flags.off : '') : ''),
        }[nd.kind];
        if (!label) return body;
        return frame(body, label, /look/.test(nd.kind) ? 'rr-look' : 'rr-group');
      }
      default: return line(GAP);
    }
  }

  /**
   * SVG text of the diagram. opts: { dotAll, style (CSS text put inside the SVG, for export) }.
   * Returns { svg, width, height, boxes } or { error: 'too-big', boxes }.
   */
  function railroad(ast, opts) {
    const o = opts || {};
    const ctx = { boxes: 0, dotAll: !!o.dotAll };
    let body;
    try { body = build(ast, ctx); } catch (e) {
      if (e && e.message === 'too-big') return { error: 'too-big', boxes: ctx.boxes };
      throw e;
    }
    const all = seq([terminal('start'), body, terminal('end')]);
    const M = 16;
    const width = Math.ceil(all.w + 2 * M);
    const height = Math.ceil(all.up + all.down + 2 * M);
    const out = [];
    all.draw(M, M + all.up, out);
    const style = o.style ? `<style>${esc(o.style).replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")}</style>` : '';
    const bg = o.background ? `<rect width="100%" height="100%" fill="${esc(o.background)}"/>` : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" class="rr" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Railroad diagram">${style}${bg}${out.join('')}</svg>`;
    return { svg, width, height, boxes: ctx.boxes };
  }

  /** Fixed colors for an exported SVG or PNG, so the file looks the same outside VS Code. */
  function exportStyle(c) {
    const p = Object.assign({ fg: '#1f2328', line: '#57606a', lit: '#dafbe1', litStroke: '#1a7f37', cls: '#ddf4ff', clsStroke: '#0969da', esc: '#fff8c5', escStroke: '#9a6700', assert: '#fbefff', assertStroke: '#8250df', frame: '#8c959f', font: 'Menlo, Consolas, "DejaVu Sans Mono", monospace' }, c || {});
    return [
      `.rr text{font-family:${p.font};font-size:12px;fill:${p.fg}}`,
      `.rr .rr-path{fill:none;stroke:${p.line};stroke-width:1.5}`,
      `.rr .rr-arrow{fill:${p.line}}`,
      `.rr .rr-term{fill:${p.line}}`,
      `.rr .rr-node rect{stroke-width:1.2}`,
      `.rr .rr-lit rect{fill:${p.lit};stroke:${p.litStroke}}`,
      `.rr .rr-cls rect{fill:${p.cls};stroke:${p.clsStroke}}`,
      `.rr .rr-esc rect{fill:${p.esc};stroke:${p.escStroke}}`,
      `.rr .rr-assert rect,.rr .rr-ref rect{fill:${p.assert};stroke:${p.assertStroke}}`,
      `.rr .rr-frame{fill:none;stroke:${p.frame};stroke-dasharray:4 3}`,
      `.rr .rr-look .rr-frame{stroke-dasharray:1 3;stroke-width:1.5}`,
      `.rr .rr-label,.rr .rr-glabel{font-size:10.5px;fill:${p.frame}}`,
    ].join('\n');
  }

  return { railroad, exportStyle, escXml: esc, MAX_BOXES };
});
