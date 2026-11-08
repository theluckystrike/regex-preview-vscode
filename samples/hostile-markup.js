// Hostile names and text: the preview must show these as text and never run them.
const TAG = /(?<script>\x3cscript\x3e)(?<img>\x3cimg src=x onerror=alert\(1\)\x3e)?/g;
const SAMPLE = '<script>window.__pwned = 1; alert("pwned")</script><img src=x onerror="window.__pwned=2">';
module.exports = { TAG, SAMPLE };
