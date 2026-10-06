export function appearanceImageKey(className, variant = 1) {
  const slug = String(className || 'unknown').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `player:${slug}:${Number(variant) || 1}`;
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
