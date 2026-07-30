<?php
// Same transparent reverse-proxy technique as wordpress-proxy/index.php
// (see that file's comment for the full rationale), but for the Coach
// Portal specifically: winfinityfitness.com/coach-portal serves
// coach-portal.html from GitHub Pages, fetched server-side, so it stays on
// this domain instead of a redirect that would put it on a different
// origin. Upload this folder's contents to a "coach-portal" subfolder in
// the SAME Hostinger document root that already serves winfinityfitness.com
// (a real physical folder there takes precedence over WordPress's own
// rewrite rules, so no WordPress-side config changes are needed).

// coach-portal.html loads sibling assets (config.js, etc.) via relative
// paths, which only resolve correctly when the browser's address bar ends
// in a slash -- without this, a bare "/coach-portal" request would resolve
// "config.js" against the site ROOT (winfinityfitness.com/config.js, the
// WordPress site, not this proxy) instead of staying under /coach-portal/.
if (rtrim(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH), '/') === '/coach-portal'
    && substr($_SERVER['REQUEST_URI'], -1) !== '/') {
    header('Location: /coach-portal/', true, 301);
    exit;
}

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
    curl_setopt($ch, CURLOPT_USERAGENT, isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : 'coach-portal-proxy/1.0');
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

// This script lives at /coach-portal/index.php, so REQUEST_URI for the
// bare page is "/coach-portal" or "/coach-portal/" -- both map to
// coach-portal.html upstream. Anything past that (e.g. a future
// /coach-portal/config.js reference) is forwarded as-is, same as the main
// proxy does for the mobile app's own asset tree.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$path = preg_replace('#^/coach-portal/?#', '/', $path);
if ($path === '/' || $path === '') {
    $path = '/coach-portal.html';
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

http_response_code($result['httpCode']);
if ($result['contentType']) {
    header('Content-Type: ' . $result['contentType']);
}
foreach (preg_split('/\r\n/', $result['rawHeaders']) as $line) {
    if (stripos($line, 'ETag:') === 0 || stripos($line, 'Last-Modified:') === 0) {
        header($line);
    }
}
// Same reasoning as the main proxy: don't let Hostinger's edge CDN cache
// this independently of GitHub Pages' own freshness, since this is a
// low-traffic, actively-changing internal tool.
header('Cache-Control: no-store, must-revalidate');

echo $result['body'];
