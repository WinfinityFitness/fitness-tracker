<?php
// Same transparent reverse-proxy technique as wordpress-proxy/index.php
// (see that file's comment for the full rationale): coach.winfinityfitness.com
// serves coach-dashboard.html from GitHub Pages, fetched server-side, so it
// stays on this domain instead of a redirect to a different origin.
//
// Unlike wordpress-proxy-coach/index.php (a SUBPATH under the main
// winfinityfitness.com WordPress site), this is a full subdomain with its
// own document root -- no WordPress rewrite rules to interfere with sibling
// asset requests (config.js etc.), so no trailing-slash redirect trick is
// needed here.
//
// Upload this file as the document root for a NEW "coach" subdomain
// created in Hostinger hPanel for winfinityfitness.com.

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
    curl_setopt($ch, CURLOPT_USERAGENT, isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : 'coach-dashboard-proxy/1.0');
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
    $path = '/coach-dashboard.html';
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
// Same reasoning as the other proxies: don't let Hostinger's edge CDN
// cache this independently of GitHub Pages' own freshness.
header('Cache-Control: no-store, must-revalidate');

echo $result['body'];
