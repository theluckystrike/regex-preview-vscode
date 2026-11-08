'use strict';
// The panel page. CSP: nothing from the network (default-src 'none'), scripts only by nonce, the matching worker
// only from a blob: URL the page makes itself, images only from the extension or blob:/data: (PNG export).
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

function nonce() { return crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, ''); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

function csp(cspSource, n) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${n}'`,
    `style-src ${cspSource} 'nonce-${n}'`,
    `img-src ${cspSource} blob: data:`,
    `font-src ${cspSource}`,
    'worker-src blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const FLAG_INFO = [
  ['g', 'global: find every match, not only the first'],
  ['i', 'ignore case'],
  ['m', 'multiline: ^ and $ match at line starts and ends'],
  ['s', 'dotAll: . also matches line breaks'],
  ['u', 'unicode: code points, \\p{...} properties'],
  ['y', 'sticky: match only at lastIndex'],
  ['x', 'verbose: ignore spaces and # comments (not in JavaScript)'],
];

function buildHtml(webview, extUri, opts) {
  const o = opts || {};
  const n = nonce();
  const uri = (...p) => webview.asWebviewUri(require('vscode').Uri.joinPath(extUri, 'media', ...p));
  const footer = footerHtml('regexPreview', o.showSupportLinks !== false, '');
  const flags = FLAG_INFO.map(([f, t]) => `<button type="button" class="flag" data-flag="${f}" title="${esc(t)}" aria-pressed="false">${f}</button>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${esc(csp(webview.cspSource, n))}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('panel.css')}">
<style nonce="${n}">${footer ? FOOTER_CSS : ''}</style>
<title>Regex Preview</title>
</head>
<body>
<div id="app" data-timeout="${Number(o.timeoutMs) || 1000}">
  <header class="bar">
    <div class="pattern-row">
      <span class="slash" aria-hidden="true">/</span>
      <textarea id="pattern" class="mono" rows="1" spellcheck="false" autocomplete="off" wrap="soft" placeholder="Type a regular expression, or click &quot;Test regex&quot; above one in your code" aria-label="Pattern"></textarea>
      <span class="slash" aria-hidden="true">/</span>
      <span class="flags" role="group" aria-label="Flags">${flags}</span>
      <select id="flavor" aria-label="Flavor" title="Regex flavor: JavaScript runs as is; other flavors are checked for syntax that differs">
        <option value="javascript">JavaScript</option>
        <option value="python">Python (re)</option>
        <option value="java">Java</option>
        <option value="dotnet">.NET (C#)</option>
        <option value="go">Go / Rust (RE2)</option>
        <option value="pcre">PCRE (PHP, Ruby)</option>
      </select>
    </div>
    <div class="status-row">
      <span id="status" class="status" role="status" aria-live="polite">Ready</span>
      <span id="source" class="source"></span>
      <span class="spacer"></span>
      <select id="copyAs" aria-label="Copy as" title="Copy the pattern as code for a language">
        <option value="">Copy as…</option>
        <option value="raw">Pattern only</option>
        <option value="javascript">JavaScript /literal/</option>
        <option value="python">Python re.compile(r"")</option>
        <option value="java">Java Pattern.compile("")</option>
        <option value="go">Go regexp.MustCompile(\`\`)</option>
        <option value="dotnet">C# new Regex(@"")</option>
        <option value="php">PHP preg_match('//')</option>
        <option value="rust">Rust Regex::new(r#""#)</option>
      </select>
    </div>
    <ul id="warnings" class="warnings" aria-label="Flavor warnings"></ul>
  </header>
  <main class="cols">
    <section class="col left" aria-label="Sample text">
      <div class="head">
        <span class="title">Sample text</span>
        <span id="sampleInfo" class="muted"></span>
        <span class="spacer"></span>
        <button type="button" id="loadFile" class="link" title="Use a file as sample text (large files: the first part is read)">Load file…</button>
        <button type="button" id="resetSample" class="link" title="Put the example text back">Reset</button>
      </div>
      <div class="editor" id="editorBox">
        <div id="backdrop" class="backdrop mono" aria-hidden="true"></div>
        <textarea id="sample" class="mono" spellcheck="false" autocomplete="off" aria-label="Sample text"></textarea>
      </div>
      <div class="head">
        <span class="title">Replace</span>
        <input id="replacement" class="mono grow" type="text" spellcheck="false" autocomplete="off" placeholder="Replacement, e.g. $1 or \\g<name> (Python)" aria-label="Replacement">
      </div>
      <pre id="replaced" class="replaced mono" aria-label="Replace preview"></pre>
    </section>
    <section class="col right" aria-label="Results">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" class="tab" data-tab="matches" aria-selected="true">Matches</button>
        <button type="button" role="tab" class="tab" data-tab="diagram" aria-selected="false">Diagram</button>
        <button type="button" role="tab" class="tab" data-tab="explain" aria-selected="false">Explain</button>
      </div>
      <div id="pane-matches" class="pane" role="tabpanel">
        <div id="matchInfo" class="muted"></div>
        <div class="table-wrap"><table id="matches" class="mono"><thead></thead><tbody></tbody></table></div>
      </div>
      <div id="pane-diagram" class="pane hidden" role="tabpanel">
        <div class="head">
          <button type="button" id="fit" class="link" aria-pressed="false" title="Fit the diagram to the panel width">Fit width</button>
          <span class="spacer"></span>
          <button type="button" id="exportSvg" class="link" title="Save the diagram as an SVG file">Export SVG</button>
          <button type="button" id="exportPng" class="link" title="Save the diagram as a PNG file (2x)">Export PNG</button>
        </div>
        <div id="diagram" class="diagram"></div>
      </div>
      <div id="pane-explain" class="pane hidden" role="tabpanel">
        <ol id="explain" class="explain"></ol>
      </div>
    </section>
  </main>
  ${footer}
</div>
<script nonce="${n}" src="${uri('core', 'regex-parse.js')}"></script>
<script nonce="${n}" src="${uri('core', 'match.js')}"></script>
<script nonce="${n}" src="${uri('core', 'railroad.js')}"></script>
<script nonce="${n}" src="${uri('panel.js')}"></script>
</body>
</html>`;
}

module.exports = { buildHtml, csp, esc, nonce, FLAG_INFO };
