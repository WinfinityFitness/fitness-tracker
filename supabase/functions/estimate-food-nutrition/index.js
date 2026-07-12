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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  let foodName, servingDescription, imageBase64, imageMimeType;
  try {
    const body = await req.json();
    foodName = body.foodName;
    servingDescription = body.servingDescription;
    imageBase64 = body.imageBase64;
    imageMimeType = body.imageMimeType;
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const hasImage = imageBase64 && typeof imageBase64 === 'string';
  if (!hasImage && (!foodName || typeof foodName !== 'string')) {
    return jsonResponse({ error: 'foodName or imageBase64 is required' }, 400);
  }

  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) {
    return jsonResponse({ error: 'AI estimation is not configured yet — ask the app owner to set GEMINI_API_KEY.' }, 500);
  }

  // Photo-based estimate also asks Gemini to name the dish (so the client
  // can pre-fill the food name field) — text-only requests already know
  // the name from what the user typed, so that field is just echoed back.
  const parts = [];
  if (hasImage) {
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

  return jsonResponse({
    name: hasImage ? (parsed.name || null) : undefined,
    calories: Number(parsed.calories) || 0,
    protein: Number(parsed.protein) || 0,
    carbs: Number(parsed.carbs) || 0,
    fat: Number(parsed.fat) || 0,
    fiber: Number(parsed.fiber) || 0,
    sodium: Number(parsed.sodium) || 0,
  });
});
