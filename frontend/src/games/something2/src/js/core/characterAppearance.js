export function appearanceImageKey(className, variant = 1) {
  const slug = String(className || 'unknown').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `player:${slug}:${Number(variant) || 1}`;
}

// How much larger than the 64x64 actor box a skin is DRAWN. Collision and the
// feet anchor are unchanged -- only the picture grows, upward from the feet.
//
// The sprite is fitted into the box keeping its aspect ratio, so a tall, narrow
// skin ends up small: Druid 2 is 545x958 (ratio 0.57) and draws only ~36x64 px,
// against ~47 for Druid 3 and ~56 for Druid 5, which made it hard to spot in a
// crowd. Add a skin here when its art reads too small for the same reason.
export const APPEARANCE_DRAW_SCALE = {
  'player:druid:2': 1.35,
};

export function appearanceDrawScale(imageKey) {
  const k = APPEARANCE_DRAW_SCALE[imageKey];
  return Number.isFinite(k) && k > 0 ? k : 1;
}

export function appearanceVisual(cls, variant = 1) {
  if (!cls) return null;
  const n = Number(variant) || 1;
  const choice = (cls.appearances || []).find((a) => Number(a.variant) === n) || {};
  return {
    className: cls.name,
    variant: n,
    image: choice.image || cls.image || null,
    sprite: choice.sprite || cls.sprite || null,
    renderMode: choice.renderMode || cls.renderMode || 'static',
  };
}

export function indexAppearanceVisuals(classes) {
  const out = new Map();
  for (const cls of classes || []) {
    for (const appearance of cls.appearances || []) {
      const visual = appearanceVisual(cls, appearance.variant);
      out.set(appearanceImageKey(cls.name, appearance.variant), visual);
    }
  }
  return out;
}
