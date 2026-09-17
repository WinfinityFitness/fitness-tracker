<?php
// Transparent reverse proxy: wftutorial.winfinityfitness.com serves the
// setup/walkthrough page and its videos from
// https://winfinityfitness.github.io/fitness-tracker/tutorials/, fetched
// server-side, so the browser's address bar stays on THIS domain instead
// of a redirect to GitHub Pages. Same approach as wordpress-proxy/ (used by
// wellness./messenger.) — see that file for the fuller rationale. This one
// is simpler: no per-host branding swap, just a fixed upstream subfolder.
//
// Plain PHP + cURL (not Apache mod_proxy) since that's not guaranteed to be
// enabled on shared hosting, and works on effectively any PHP host,
// including Hostinger.

$upstreamBase = 'https://winfinityfitness.github.io/fitness-tracker/tutorials';

function fetchUpstream($url) {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_MAXREDIRS, 3);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 8);
    // Videos are tens of MB — the wellness proxy's 15s timeout is too tight
    // for a slow client connection pulling one through this script.
    curl_setopt($ch, CURLOPT_TIMEOUT, 60);
    curl_setopt($ch, CURLOPT_USERAGENT, isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : 'wftutorial-proxy/1.0');
    if (!empty($_SERVER['HTTP_IF_NONE_MATCH'])) {
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['If-None-Match: ' . $_SERVER['HTTP_IF_NONE_MATCH']]);
    }
    // Videos are large enough that buffering the whole thing in
    // CURLOPT_RETURNTRANSFER before echoing risks PHP's memory limit on
    // shared hosting. Stream straight through instead.
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
    // Response code and headers must reach the browser BEFORE any body
    // bytes stream out below, so they're applied here as they arrive
    // rather than after curl_exec() returns (by which point the whole
    // body has already been echoed and PHP's headers are long closed).
    curl_setopt($ch, CURLOPT_HEADERFUNCTION, function($curl, $headerLine) {
        $trimmed = rtrim($headerLine, "\r\n");
        if ($trimmed === '') return strlen($headerLine);
        if (stripos($trimmed, 'HTTP/') === 0) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $trimmed, $m)) {
                http_response_code((int)$m[1]);
            }
            return strlen($headerLine);
        }
        if (stripos($trimmed, 'Content-Type:') === 0
            || stripos($trimmed, 'Content-Length:') === 0
            || stripos($trimmed, 'ETag:') === 0
            || stripos($trimmed, 'Last-Modified:') === 0) {
            header($trimmed);
        }
        return strlen($headerLine);
    });
    $ok = curl_exec($ch);
    if ($ok === false) {
        $error = curl_error($ch);
        curl_close($ch);
        return ['error' => $error];
    }
    curl_close($ch);
    return ['ok' => true];
}

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/' || $path === '' || $path === null) {
    $path = '/index.html';
}
$query = parse_url($_SERVER['REQUEST_URI'], PHP_URL_QUERY);
$upstreamUrl = $upstreamBase . $path . ($query ? '?' . $query : '');

header('Cache-Control: no-store, must-revalidate');
$result = fetchUpstream($upstreamUrl);
if (isset($result['error'])) {
    http_response_code(502);
    header('Content-Type: text/plain');
    echo 'Upstream fetch failed: ' . $result['error'];
    exit;
}
