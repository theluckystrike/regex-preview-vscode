# Changelog

## 0.1.0

- First release: Test regex CodeLens in JavaScript, TypeScript, Python, Go, Rust, Java, Kotlin, C#, PHP and Ruby; Test Selected Text as Regex in any file.
- Panel with your own sample text (kept per workspace, or loaded from a file), highlighted matches, a table of numbered and named groups, and a replace preview in each flavor's syntax.
- Railroad diagram with SVG and PNG export, and an explain list with one line per part of the pattern.
- Flavor warnings for Python, Java, .NET, Go/Rust and PCRE.
- Every match runs in a worker with a 1 second limit, so catastrophic backtracking is stopped and VS Code keeps working.
