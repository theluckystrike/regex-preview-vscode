# Diagram, explain and flavors

- Matches lists every match with each numbered and named group. A group that did not take part shows a dash.
- Replace shows the result of a replacement: `$1` and `$<name>` in JavaScript, `\1` and `\g<name>` in Python, `${name}` in Java, .NET and Go.
- Diagram draws a railroad diagram of the pattern. Export it as SVG or PNG.
- Explain gives one plain line for each part of the pattern.

The panel runs JavaScript patterns as they are. Pick Python, Java, .NET, Go or PCRE and it lists the syntax that works differently there, for example possessive quantifiers before Python 3.11 or lookbehind in Go, so you are not shown wrong results without a warning.
