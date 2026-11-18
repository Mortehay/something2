// Loot filter, client side: decides how a ground item is DRAWN. The server owns the rules of the
// game (auto-loot never takes a hidden item, backend authority/lootFilter.js); this mirrors its
// evaluator so the picture and the pickup agree. core/__tests__/lootFilterParity.test.js runs both
// over the same cases, so the two cannot drift apart unnoticed.
//
// The TOP enabled rule that matches wins. An item no rule matches is drawn as before.

export const RARITIES = ['white', 'blue', 'yellow', 'foxy'];
export const ACTIONS = ['hide', 'show', 'emphasize'];

export function defaultFilterConfig() {
  return { activeId: 'default', presets: [{ id: 'default', name: 'Default', autolootSkipHidden: true, rules: [] }] };
}

export function activePreset(config) {
  if (!config || !Array.isArray(config.presets)) return null;
  return config.presets.find((p) => p.id === config.activeId) || config.presets[0] || null;
}

// item = { typeId, rarity, itemLevel, affixIds: [] }; typeOf(typeId) -> { category } | null.
export function ruleMatches(rule, item, typeOf) {
  const c = rule.conditions || {};
  // Gold piles are not gear (mirrors the server): only a rule that names the currency category
  // can match them, so "hide every white item" never hides gold.
  const type = typeOf ? typeOf(item.typeId) : null;
  if (type && type.category === 'currency' && !(c.categories && c.categories.includes('currency'))) return false;
  if (c.rarities && c.rarities.length && !c.rarities.includes(item.rarity || 'white')) return false;
  if (c.typeIds && c.typeIds.length && !c.typeIds.includes(item.typeId)) return false;
  if (c.categories && c.categories.length) {
    if (!type || !c.categories.includes(type.category)) return false;
  }
  const lvl = Number.isFinite(Number(item.itemLevel)) ? Number(item.itemLevel) : 1;
  if (c.minLevel !== null && c.minLevel !== undefined && lvl < c.minLevel) return false;
  if (c.maxLevel !== null && c.maxLevel !== undefined && lvl > c.maxLevel) return false;
  if (c.affixIds && c.affixIds.length) {
    const has = Array.isArray(item.affixIds) ? item.affixIds : [];
    const test = (id) => has.includes(id);
    if (c.affixMode === 'all' ? !c.affixIds.every(test) : !c.affixIds.some(test)) return false;
  }
  return true;
}

// { rule, action, style } from the first enabled matching rule, or null.
export function evaluate(rules, item, typeOf) {
  if (!Array.isArray(rules)) return null;
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue;
    if (ruleMatches(rule, item, typeOf)) return { rule, action: rule.action, style: rule.style || null };
  }
  return null;
}

// A ground item as the manager stores it (`lv` / `ax` on the wire) -> the evaluator's shape.
export function filterItemOf(g) {
  return { typeId: g.typeId, rarity: g.rarity, itemLevel: g.itemLevel || 1, affixIds: g.affixIds || [] };
}

// What the renderer does with one ground item:
//   { hidden, emphasized, style }
// hidden       the item is not drawn at all (unless the show-all key is held).
// emphasized   (action Emphasize) the name plate is always drawn, not only when the player is near.
//              Show keeps the normal visibility but still applies the rule's style.
// style        the matching rule's colours / size / beam, or null.
// The verdict is cached on the item against the filter's `version` (bumped whenever the config or
// the catalog changes) so a frame costs one comparison per item, not a rule walk.
export function verdictFor(g, filterState, typeOf) {
  if (g._lfVersion === filterState.version && g._lf) return g._lf;
  const preset = activePreset(filterState.config);
  const v = preset ? evaluate(preset.rules, filterItemOf(g), typeOf) : null;
  const out = {
    hidden: !!v && v.action === 'hide',
    emphasized: !!v && v.action === 'emphasize',
    style: v && v.action !== 'hide' ? v.style : null,
  };
  g._lfVersion = filterState.version;
  g._lf = out;
  return out;
}
