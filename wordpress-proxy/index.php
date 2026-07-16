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

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/' || $path === '' || $path === null) {
    $path = '/index.html';
}
$query = parse_url($_SERVER['REQUEST_URI'], PHP_URL_QUERY);
$upstreamUrl = $upstreamBase . $path . ($query ? '?' . $query : '');

$ch = curl_init($upstreamUrl);
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
    http_response_code(502);
    header('Content-Type: text/plain');
    echo 'Upstream fetch failed: ' . curl_error($ch);
    curl_close($ch);
    exit;
}

$headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
curl_close($ch);

$rawHeaders = substr($response, 0, $headerSize);
$body = substr($response, $headerSize);

http_response_code($httpCode);
if ($contentType) {
    header('Content-Type: ' . $contentType);
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
foreach (preg_split('/\r\n/', $rawHeaders) as $line) {
    if (stripos($line, 'ETag:') === 0 || stripos($line, 'Last-Modified:') === 0) {
        header($line);
    }
}
header('Cache-Control: no-store, must-revalidate');

echo $body;
