// Removes the flat black background from the infinity-logo source photo via
// flood fill (not a global color threshold) seeded from the four corners
// plus the two loop-hole interiors. A global threshold would also eat into
// the ribbon's own near-black metallic shadow areas (sampled as dark as
// [9,11,10]) since they're nearly as dark as the true background — flood
// fill only clears pixels reachable from a known-background seed without
// crossing the white outline stroke that borders every ribbon segment, so
// the ribbon's dark shading survives untouched.
const sharp = require('sharp');
const path = require('path');

const SRC = process.argv[2];
const OUT = process.argv[3];
const THRESHOLD = 26; // max(R,G,B) <= this joins the flood

async function main() {
  const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < data.length; i += channels, j += 4) {
    rgba[j] = data[i];
    rgba[j + 1] = data[i + 1];
    rgba[j + 2] = data[i + 2];
    rgba[j + 3] = 255;
  }

  const visited = new Uint8Array(width * height);
  const isBg = (x, y) => {
    const idx = (y * width + x) * 4;
    return Math.max(rgba[idx], rgba[idx + 1], rgba[idx + 2]) <= THRESHOLD;
  };

  const stack = [];
  const seed = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (!visited[p] && isBg(x, y)) { visited[p] = 1; stack.push(p); }
  };

  for (let x = 0; x < width; x++) { seed(x, 0); seed(x, height - 1); }
  for (let y = 0; y < height; y++) { seed(0, y); seed(width - 1, y); }
  // Loop-hole interiors, confirmed by visual inspection of cropped regions.
  seed(560, 190);
  seed(220, 560);

  while (stack.length) {
    const p = stack.pop();
    const x = p % width, y = (p / width) | 0;
    const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const np = ny * width + nx;
      if (!visited[np] && isBg(nx, ny)) { visited[np] = 1; stack.push(np); }
    }
  }

  // The flood-filled boundary still has a thin ring of JPEG anti-aliasing
  // noise just outside it (too bright to join the flood, too dark to look
  // clean against a light theme) — dilate the background mask by a couple
  // pixels so that ring gets swallowed too, at the cost of a couple pixels
  // of the ribbon's own edge (imperceptible at this resolution).
  let mask = visited;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(mask);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (mask[p]) continue;
        if ((x > 0 && mask[p - 1]) || (x < width - 1 && mask[p + 1]) ||
            (y > 0 && mask[p - width]) || (y < height - 1 && mask[p + width])) {
          next[p] = 1;
        }
      }
    }
    mask = next;
  }

  let cleared = 0;
  for (let p = 0; p < width * height; p++) {
    if (mask[p]) { rgba[p * 4 + 3] = 0; cleared++; }
  }
  console.log('cleared', cleared, '/', width * height, 'pixels');

  await sharp(rgba, { raw: { width, height, channels: 4 } })
    // Soften the cutout edge slightly — the flood-fill boundary is a hard
    // 1-bit mask, a touch of blur on just the alpha channel avoids jaggies.
    .png()
    .toFile(OUT);
  console.log('wrote', OUT);
}

main().catch(e => { console.error(e); process.exit(1); });
