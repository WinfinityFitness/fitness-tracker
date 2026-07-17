<?php
// Transparent reverse proxy: wellness.winfinityfitness.com serves the same
// content as https://winfinityfitness.github.io/fitness-tracker/, fetched
// server-side, so the browser's address bar (and the app's own origin, for
// localStorage/service-worker scope) stays on THIS domain instead of a
// redirect to GitHub Pages — a redirect would put the app on a different
// origin, silently orphaning any locally-stored data (training logs,
// Digital ID, settings) from anyone who already has the app installed
// pointed at the original GitHub Pages URL.
//
// Deliberately not using Apache's mod_proxy ([P] RewriteRule flag) since
// that's not guaranteed to be enabled on shared hosting — plain PHP + cURL
// works on effectively any PHP host, including Hostinger, with nothing
// special required.

$upstreamBase = 'https://winfinityfitness.github.io/fitness-tracker';

function fetchUpstream($url) {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HEADER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_MAXREDIRS, 3);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 8);
    curl_setopt($ch, CURLOPT_TIMEOUT, 15);
    curl_setopt($ch, CURLOPT_USERAGENT, isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : 'wellness-proxy/1.0');
    if (!empty($_SERVER['HTTP_IF_NONE_MATCH'])) {
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['If-None-Match: ' . $_SERVER['HTTP_IF_NONE_MATCH']]);
    }
    $response = curl_exec($ch);
    if ($response === false) {
        $error = curl_error($ch);
        curl_close($ch);
        return ['error' => $error];
    }
    $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    curl_close($ch);
    return [
        'httpCode' => $httpCode,
        'contentType' => $contentType,
        'rawHeaders' => substr($response, 0, $headerSize),
        'body' => substr($response, $headerSize),
    ];
}

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/' || $path === '' || $path === null) {
    $path = '/index.html';
}
$query = parse_url($_SERVER['REQUEST_URI'], PHP_URL_QUERY);
$upstreamUrl = $upstreamBase . $path . ($query ? '?' . $query : '');

$result = fetchUpstream($upstreamUrl);
if (isset($result['error'])) {
    http_response_code(502);
    header('Content-Type: text/plain');
    echo 'Upstream fetch failed: ' . $result['error'];
    exit;
}

// SPA fallback: this is a static single-page app with its own client-side
// routing (the Profile Page's shareable /<DigitalID> URL — see the
// popstate handling in app.js). A path like that isn't a real file on
// GitHub Pages, so it 404s upstream. Retry against index.html itself so
// the app boots and its own JS picks the path back up from
// location.pathname, instead of a bookmarked/refreshed profile link just
// showing a bare 404. Only for extensionless paths — real missing assets
// (a renamed icon, a typo'd script src) should still 404 normally.
if ($result['httpCode'] === 404 && $path !== '/index.html' && !preg_match('/\.[a-zA-Z0-9]+$/', $path)) {
    $fallback = fetchUpstream($upstreamBase . '/index.html');
    if (!isset($fallback['error'])) {
        $result = $fallback;
    }
}

http_response_code($result['httpCode']);
if ($result['contentType']) {
    header('Content-Type: ' . $result['contentType']);
}
// Forward ETag/Last-Modified from upstream (harmless, and lets a future
// conditional-GET optimization reuse them) but deliberately do NOT forward
// upstream's own Cache-Control. GitHub Pages sends max-age=600 on static
// assets, and Hostinger's own edge CDN (hCDN) sitting in front of this
// script was honoring that and caching responses independently per edge
// node for up to 10 minutes — so a fresh deploy could take 10+ minutes to
// reach a given visitor depending on which edge routed their request, long
// after GitHub Pages itself already had the new file. Overriding with
// no-store here tells hCDN never to cache this response at all, so every
// request re-runs this script (and its upstream fetch) fresh — the right
// tradeoff for an app that's actively changing and has very low traffic.
foreach (preg_split('/\r\n/', $result['rawHeaders']) as $line) {
    if (stripos($line, 'ETag:') === 0 || stripos($line, 'Last-Modified:') === 0) {
        header($line);
    }
}
header('Cache-Control: no-store, must-revalidate');

echo $result['body'];
