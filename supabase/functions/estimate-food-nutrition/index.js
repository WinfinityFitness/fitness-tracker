// Deno Edge Function — proxies a food-name nutrition estimate to Gemini's free
// tier so the client never holds the AI API key (embedding it in a public
// GitHub Pages bundle would let anyone scrape and abuse it).
//
// Plain JavaScript (not TypeScript) on purpose — the Supabase Dashboard's
// "Via Editor" quick-create flow saves functions as .js, and a bundler
// parsing this as plain JS chokes on TS type annotations (`: unknown`,
// `: string`, etc.) with a cryptic "Expected ',', got ':'" error. Types are
// optional in Deno either way, so keep this file untyped to match reality.
//
// Deploy: paste this whole file into Dashboard -> Edge Functions -> the
// estimate-food-nutrition function -> replace contents -> Deploy.
//
// Before it works, set the secret (free key from https://aistudio.google.com/apikey):
// Dashboard -> Edge Functions -> Secrets -> GEMINI_API_KEY

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

// Used only by the admin Prep Meal "auto-fill from URL" path — strips tags
// server-side (Deno has no DOM) so the page's actual text, not its markup,
// is what fills the Gemini prompt's token budget. Truncated well below
// Gemini's context limit; recipe pages rarely need more than this to
// extract name/ingredients/procedure/macros.
async function fetchUrlAsText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WinfinityBot/1.0)' } });
  if (!res.ok) throw new Error('fetch failed: ' + res.status);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  let foodName, servingDescription, imageBase64, imageMimeType, barcodeImageBase64, barcodeImageMimeType, labelImageBase64, labelImageMimeType, mealMenuText, mealMenuUrl;
  try {
    const body = await req.json();
    foodName = body.foodName;
    servingDescription = body.servingDescription;
    imageBase64 = body.imageBase64;
    imageMimeType = body.imageMimeType;
    barcodeImageBase64 = body.barcodeImageBase64;
    barcodeImageMimeType = body.barcodeImageMimeType;
    labelImageBase64 = body.labelImageBase64;
    labelImageMimeType = body.labelImageMimeType;
    mealMenuText = body.mealMenuText;
    mealMenuUrl = body.mealMenuUrl;
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const hasImage = imageBase64 && typeof imageBase64 === 'string';
  // Fallback path for when the live BarcodeDetector camera scan can't read a
  // damaged/worn/curved barcode at all — the user takes two still photos
  // instead (barcode + nutrition facts label), which Gemini reads directly.
  const hasBarcodePair = barcodeImageBase64 && labelImageBase64;
  // Admin Prep Meal auto-fill: a pasted recipe/menu, or a URL to fetch one from.
  const hasMealMenu = (typeof mealMenuText === 'string' && mealMenuText.trim()) || (typeof mealMenuUrl === 'string' && mealMenuUrl.trim());
  if (!hasImage && !hasBarcodePair && !hasMealMenu && (!foodName || typeof foodName !== 'string')) {
    return jsonResponse({ error: 'foodName, imageBase64, a barcode/label photo pair, or a meal menu text/URL is required' }, 400);
  }

  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) {
    return jsonResponse({ error: 'AI estimation is not configured yet — ask the app owner to set GEMINI_API_KEY.' }, 500);
  }

  // Photo-based estimate also asks Gemini to name the dish (so the client
  // can pre-fill the food name field) — text-only requests already know
  // the name from what the user typed, so that field is just echoed back.
  const parts = [];
  if (hasMealMenu) {
    let sourceText = typeof mealMenuText === 'string' ? mealMenuText.trim() : '';
    if (!sourceText && mealMenuUrl) {
      try {
        sourceText = await fetchUrlAsText(mealMenuUrl.trim());
      } catch (e) {
        return jsonResponse({ error: 'Could not read that URL', detail: String(e) }, 502);
      }
    }
    if (!sourceText) return jsonResponse({ error: 'No meal menu text or URL content to read' }, 400);
    parts.push({
      text: `Read the following meal/recipe description (pasted text or webpage content) and extract structured prep-meal data for a fitness tracking app.
Respond with ONLY a JSON object, no markdown, no explanation, in exactly this shape:
{"name": string, "calories": number, "grams": number, "protein": number, "carbs": number, "fat": number, "ingredients": string, "procedure": string}
"calories"/"protein"/"carbs"/"fat" are your best nutrition estimate (kcal / grams) for the WHOLE prepared dish as described, not per-100g. "grams" is the total prepared weight in grams. "ingredients" is a newline-separated list of ingredients (with quantities if given). "procedure" is the numbered preparation steps as plain newline-separated text. If a field can't be determined, give your best reasonable estimate — never refuse.

SOURCE:
"""
${sourceText}
"""`,
    });
  } else if (hasBarcodePair) {
    parts.push({
      text: `Look at these two photos of a packaged food product. The FIRST photo shows the product's barcode, the SECOND shows its Nutrition Facts label.
From the first photo, read the barcode's printed numeric code (the digits printed below or beside the bars — digits only, no spaces or dashes). If you can also decode the bar pattern itself, use it to double-check the digits.
From the second photo, read the product name (if visible) and the nutrition facts.
Respond with ONLY a JSON object, no markdown, no explanation, in exactly this shape:
{"code": string, "name": string, "calories": number, "protein": number, "carbs": number, "fat": number, "fiber": number, "sodium": number}
Normalize all nutrition values to per 100 grams — the label may show per-serving, so convert using the serving size in grams if one is given. calories in kcal, protein/carbs/fat/fiber in grams, sodium in milligrams. If either photo is unclear, give your best reasonable reading — never refuse.`,
    });
    parts.push({ inlineData: { mimeType: barcodeImageMimeType || 'image/jpeg', data: barcodeImageBase64 } });
    parts.push({ inlineData: { mimeType: labelImageMimeType || 'image/jpeg', data: labelImageBase64 } });
  } else if (hasImage) {
    parts.push({
      text: `Identify the food shown in this photo and estimate its nutrition facts per 100 grams.
Respond with ONLY a JSON object, no markdown, no explanation, in exactly this shape:
{"name": string, "calories": number, "protein": number, "carbs": number, "fat": number, "fiber": number, "sodium": number}
All nutrition values are per 100g. calories in kcal, protein/carbs/fat/fiber in grams, sodium in milligrams. If multiple foods are visible, estimate for the combined plate as a whole. If unsure, give your best reasonable estimate — never refuse.`,
    });
    parts.push({ inlineData: { mimeType: imageMimeType || 'image/jpeg', data: imageBase64 } });
  } else {
    parts.push({
      text: `Estimate the nutrition facts per 100 grams for this food: "${foodName}"${servingDescription ? ` (${servingDescription})` : ''}.
Respond with ONLY a JSON object, no markdown, no explanation, in exactly this shape:
{"calories": number, "protein": number, "carbs": number, "fat": number, "fiber": number, "sodium": number}
All values are per 100g. calories in kcal, protein/carbs/fat/fiber in grams, sodium in milligrams. If unsure, give your best reasonable estimate for a typical serving — never refuse.`,
    });
  }

  let geminiRes;
  try {
    geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        }),
      }
    );
  } catch (e) {
    return jsonResponse({ error: 'Could not reach the AI service', detail: String(e) }, 502);
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    return jsonResponse({ error: 'AI request failed', detail: errText }, 502);
  }

  const geminiData = await geminiRes.json();
  const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'Could not parse AI response' }, 502);
  }

  if (hasMealMenu) {
    return jsonResponse({
      name: parsed.name || null,
      calories: Number(parsed.calories) || 0,
      grams: Number(parsed.grams) || 0,
      protein: Number(parsed.protein) || 0,
      carbs: Number(parsed.carbs) || 0,
      fat: Number(parsed.fat) || 0,
      ingredients: parsed.ingredients || '',
      procedure: parsed.procedure || '',
    });
  }

  return jsonResponse({
    name: (hasImage || hasBarcodePair) ? (parsed.name || null) : undefined,
    code: hasBarcodePair ? (parsed.code ? String(parsed.code).replace(/[^0-9]/g, '') : null) : undefined,
    calories: Number(parsed.calories) || 0,
    protein: Number(parsed.protein) || 0,
    carbs: Number(parsed.carbs) || 0,
    fat: Number(parsed.fat) || 0,
    fiber: Number(parsed.fiber) || 0,
    sodium: Number(parsed.sodium) || 0,
  });
});
