"""Parse nginx access logs into rows."""
import re

LINE = re.compile(
    r"""
    (?P<ip>\d{1,3}(?:\.\d{1,3}){3})\s+-\s+(?P<user>\S+)\s+   # client and user
    \[(?P<time>[^\]]+)\]\s+                                   # [10/Oct/2026:13:55:36 +0700]
    "(?P<method>[A-Z]+)\s+(?P<path>\S+)\s+HTTP/(?P<ver>[\d.]+)"\s+
    (?P<status>\d{3})\s+(?P<size>\d+|-)
    """,
    re.VERBOSE,
)
SLOW = re.compile(r"rt=(?P<rt>\d+\.\d+)", re.IGNORECASE)
WORD = re.compile(r"\b\w++\b")  # possessive: needs Python 3.11


def parse(path):
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            m = LINE.match(raw)
            if m:
                yield m.groupdict()


def redact(text):
    return re.sub(r"(?P<user>[\w.]+)@(?P<host>[\w.-]+)", r"\g<user>@redacted", text)
