// Deno Edge Function — server-side URL unfurling for the Nexus Feed
// composer/posts (Facebook-style link previews). Runs server-side because
// the client can't fetch arbitrary third-party URLs directly (CORS), and
// Deno has no DOM here so meta tags are pulled by regex, same approach as
// fetchUrlAsSource() in estimate-food-nutrition/index.js.
//
// Plain JavaScript on purpose — matches this project's other Edge
// Functions (the Dashboard's "Via Editor" flow saves .js, and a TS
// annotation trips a cryptic parse error there).
//
// Deploy: Dashboard -> Edge Functions -> Create function -> name it
// exactly "link-preview" (the client calls this URL by name — a mismatch
// here is the single most common way this breaks, see the naming note in
// estimate-food-nutrition/index.js for the same gotcha) -> paste this file
// -> Deploy. No secrets needed.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .trim();
}

// Handles both attribute orders (property/content or content/property) and
// either quote style, for both `property=` (Open Graph) and `name=`
// (Twitter Card / plain meta) tags.
function extractMeta(html, key) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*\\scontent=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*\\s(?:property|name)=["']${key}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeHtmlEntities(m[1]);
  }
  return null;
}

function resolveUrl(maybeRelative, baseUrl) {
  if (!maybeRelative) return null;
  try { return new URL(maybeRelative, baseUrl).href; } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  let url;
  try {
    const body = await req.json();
    url = typeof body.url === 'string' ? body.url.trim() : '';
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }
  if (!url) return jsonResponse({ error: 'url is required' }, 400);
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  let res;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WinfinityBot/1.0; +https://winfinityfitness.com)' },
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (e) {
    return jsonResponse({ error: 'Could not reach that URL', detail: String(e) }, 502);
  }
  if (!res.ok) return jsonResponse({ error: 'That URL returned ' + res.status }, 502);

  const finalUrl = res.url || url;
  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  // A direct link to an image/video file — no unfurling needed, the client
  // renders the media itself.
  if (contentType.startsWith('image/')) {
    return jsonResponse({ type: 'image', url: finalUrl, image: finalUrl });
  }
  if (contentType.startsWith('video/')) {
    return jsonResponse({ type: 'video', url: finalUrl, video: finalUrl });
  }

  if (!contentType.startsWith('text/html')) {
    return jsonResponse({ type: 'website', url: finalUrl, title: finalUrl, description: null, image: null, siteName: null });
  }

  // Open Graph tags are almost always in <head>, near the top — reading
  // the first chunk instead of the full body keeps this fast and bounded
  // even against a page with a huge body.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  const MAX_BYTES = 200 * 1024;
  let bytesRead = 0;
  try {
    while (bytesRead < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.length;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }

  const title = extractMeta(html, 'og:title') || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || finalUrl;
  const description = extractMeta(html, 'og:description') || extractMeta(html, 'description');
  const ogImage = extractMeta(html, 'og:image');
  const siteName = extractMeta(html, 'og:site_name');

  return jsonResponse({
    type: 'website',
    url: finalUrl,
    title: decodeHtmlEntities(title).slice(0, 200),
    description: description ? decodeHtmlEntities(description).slice(0, 300) : null,
    image: resolveUrl(ogImage, finalUrl),
    siteName: siteName ? decodeHtmlEntities(siteName) : null,
  });
});
