// Compose a biome's art context into a generation prompt.
//
// The sprite-gen service appends its own per-kind styling (seamless tile /
// isolated object / directional sprite) to whatever `base_prompt` it receives
// -- see sprite-gen/app/prompts.py. Biome context therefore belongs HERE, in
// the base prompt, and the Python service stays untouched.
//
// Tiles are shared across biomes and have one image each (spec S5): the admin
// picks which biome's context to compose at generation time.
function composeBiomePrompt(basePrompt, biome) {
  const base = String(basePrompt || '').trim();
  if (!biome) return base;

  const parts = [];
  const palette = (Array.isArray(biome.palette) ? biome.palette : [])
    .filter((c) => typeof c === 'string' && c.trim())
    .map((c) => c.trim());
  if (palette.length) parts.push(`${palette.join(', ')} palette`);
  const style = String(biome.art_style || '').trim();
  if (style) parts.push(style);

  const head = [base, ...parts].filter(Boolean).join(', ');
  const excl = String(biome.exclusions || '').trim();
  if (!excl) return head;
  return head ? `${head}. Avoid: ${excl}` : `Avoid: ${excl}`;
}

// SOMET-682. A tile prompt is SUBJECT then FRAMING: "dark packed dirt ground,
// seen from directly above, extreme close-up, fills the entire frame, ...".
// Ground tiles use the top-down framing, walls/doors/gates the straight-on one.
// A written description replaces only the subject; the framing is what makes
// it a seamless texture and stays with the row.
const TILE_FRAMING = /,\s*(?:seen from directly above|flat material surface)\b.*$/i;

function splitTilePrompt(prompt) {
  const text = String(prompt || '').trim();
  const m = text.match(TILE_FRAMING);
  return m
    ? { subject: text.slice(0, m.index).trim(), framing: m[0] }
    : { subject: text, framing: '' };
}

module.exports = { composeBiomePrompt, splitTilePrompt, TILE_FRAMING };
