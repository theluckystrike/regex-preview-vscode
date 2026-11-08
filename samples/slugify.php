<?php
// Slug and tag helpers for the blog.
function slugify(string $title): string {
    $s = preg_replace('/[^\p{L}\p{N}]+/u', '-', mb_strtolower($title));
    return trim($s, '-');
}

function hashtags(string $text): array {
    preg_match_all('#(?<!\w)\#(?<tag>[a-z][\w-]{1,30})#i', $text, $m);
    return $m['tag'];
}
