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

// Resolves a coach subdomain slug to their brand config via Supabase,
// with a short-lived on-disk cache. Never throws -- any failure (network,
// bad response, unknown slug) returns null and the caller falls back to
// default Winfinity branding, since a branding lookup failing is not a
// reason to break the page load.
function fetchCoachBranding($slug) {
    $cacheFile = sys_get_temp_dir() . '/wf_coach_brand_' . preg_replace('/[^a-z0-9-]/', '', $slug) . '.json';
    $cacheTtlSeconds = 300;
    if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < $cacheTtlSeconds) {
        $cached = json_decode(file_get_contents($cacheFile), true);
        return $cached === null ? null : ($cached ?: null); // cached {} means "looked up, no match"
    }

    $supabaseUrl = 'https://mzkjboplfalauivwcnni.supabase.co';
    $supabaseAnonKey = 'sb_publishable_YwHBnvbBjd8Oj8hgPXb_JA_buurC92v';

    $ch = curl_init($supabaseUrl . '/rest/v1/rpc/get_coach_branding_by_slug');
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(['p_slug' => $slug]));
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'apikey: ' . $supabaseAnonKey,
        'Content-Type: application/json',
    ]);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 4);
    curl_setopt($ch, CURLOPT_TIMEOUT, 6);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($response === false || $httpCode !== 200) {
        // Don't cache a failure -- retry on the very next request rather
        // than pinning "no branding" for the full TTL on a transient error.
        return null;
    }
    $rows = json_decode($response, true);
    $brand = (is_array($rows) && count($rows) > 0) ? $rows[0] : [];
    // Cache even the empty-result case (unknown slug) so a bad/typo'd
    // subdomain doesn't hammer Supabase on every request either.
    @file_put_contents($cacheFile, json_encode($brand));
    return $brand ?: null;
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

$body = $result['body'];
// Swap in per-subdomain branding for HTML responses only, so "Add to Home
// Screen"/"Install" on each domain installs as its own distinctly-named app
// instead of all three reusing the mobile app's own name/manifest —
// installing more than one would otherwise put identically-named/-iconed
// shortcuts on the same home screen with no way to tell them apart. The
// title tag and apple-mobile-web-app-title cover Android/desktop and iOS
// Safari's home screen naming respectively; the manifest link covers the
// rest. This same script/upstream is now reused by THREE hostnames
// (wellness.*, messenger.*, and whatever else points here later), so the
// branding to apply is chosen by $_SERVER['HTTP_HOST'] rather than assumed.
$host = isset($_SERVER['HTTP_HOST']) ? strtolower($_SERVER['HTTP_HOST']) : '';
$brand = null;
if ($host === 'wellness.winfinityfitness.com') {
    $brand = [
        'manifest' => 'manifest-wellness.webmanifest',
        'title' => 'Winfinity Nexus',
        'icon' => 'icons/icon-nexus-192.png',
    ];
} elseif ($host === 'messenger.winfinityfitness.com') {
    $brand = [
        'manifest' => 'manifest-messenger.webmanifest',
        'title' => 'Winfinity Messenger',
        'icon' => 'icons/icon-192.png',
    ];
} else {
    // Coach white-label subdomains: <slug>.winfinityfitness.com. Looked up
    // against Supabase (get_coach_branding_by_slug — a public RPC, coaches
    // itself has zero anon table-read policies so a raw REST select would
    // always return empty) rather than hardcoded, since this needs to
    // scale to any number of coaches without editing this file per coach.
    // Cached briefly on disk so this doesn't add a network round-trip to
    // every single request on an actively-loading page.
    $reserved = ['wellness', 'messenger', 'app', 'www'];
    if (preg_match('/^([a-z0-9-]+)\.winfinityfitness\.com$/', $host, $m) && !in_array($m[1], $reserved, true)) {
        $slug = $m[1];
        $coachBrand = fetchCoachBranding($slug);
        if ($coachBrand) {
            $brand = [
                // No per-coach manifest file exists (that would need a
                // dynamically-generated manifest endpoint, not just a
                // string swap to a static file like wellness/messenger
                // use) -- left pointing at the default manifest for now.
                // Title/icon still correctly reflect the coach's brand.
                'manifest' => 'manifest.webmanifest',
                'title' => $coachBrand['brand_name'],
                'icon' => $coachBrand['brand_logo_url'] ?: 'icons/icon-192.png',
            ];
        }
    }
}
if ($brand && $result['contentType'] && stripos($result['contentType'], 'text/html') !== false) {
    $body = str_replace(
        '<link rel="manifest" href="manifest.webmanifest">',
        '<link rel="manifest" href="' . $brand['manifest'] . '">',
        $body
    );
    $body = str_replace(
        '<title>Winfinity Tracker</title>',
        '<title>' . htmlspecialchars($brand['title'], ENT_QUOTES) . '</title>',
        $body
    );
    $body = str_replace(
        '<meta name="apple-mobile-web-app-title" content="Winfinity">',
        '<meta name="apple-mobile-web-app-title" content="' . htmlspecialchars($brand['title'], ENT_QUOTES) . '">',
        $body
    );
    // iOS Safari's "Add to Home Screen" reads this tag directly rather than
    // the manifest's icons array (which iOS ignores) — without this swap
    // too, an iPhone install would still pick up the mobile app's icon
    // despite everything else above already being re-branded.
    $body = str_replace(
        '<link rel="apple-touch-icon" href="icons/icon-192.png">',
        '<link rel="apple-touch-icon" href="' . htmlspecialchars($brand['icon'], ENT_QUOTES) . '">',
        $body
    );
}
echo $body;
