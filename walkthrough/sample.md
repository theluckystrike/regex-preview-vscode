# Your own sample text

Type or paste text in the Sample text box. Every match is highlighted as you type, and the box keeps its text for this workspace.

Load file uses a log or data file as the sample. For a big file, only the first part is read (10 MB by default, setting `regexPreview.maxSampleMB`). The table lists the first 1,000 matches and counts all of them.

Each match runs in a background worker with a 1 second limit. A pattern that backtracks without end, such as `(a+)+$` on `aaaa…!`, is stopped and the panel tells you so. VS Code keeps working.
