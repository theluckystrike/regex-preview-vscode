'use strict';
// URL and network helpers for the crawler.
const URL_RE = /\bhttps?:\/\/(?:[\w-]+\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[^\s"'<>]*)?/gi;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const IPV6 = new RegExp('(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4}', 'gi');

function links(html) {
  return html.match(URL_RE) || [];
}

function addresses(text) {
  return { v4: text.match(IPV4) || [], v6: text.match(IPV6) || [] };
}

module.exports = { links, addresses };
