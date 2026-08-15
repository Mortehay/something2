// SOMET-329 slice B. Loads the four weapon-option catalogs.
//
// These are small, admin-authored, change-rarely tables read once when a world
// is built -- the same lifetime as the item catalog itself (items.js's
// loadItemTypes), and loaded alongside it rather than per request.
//
// Only ONE of the four reaches the client: `elements`, because the client
// genuinely needs the colours to draw with. The other three are resolved
// server-side into concrete numbers before anything goes on the wire, which
// keeps the standing rule that the client never needs the weapon catalog.

// Row -> plain object, with numbers coerced once here rather than at each read.
function elementRow(r) {
  return {
    name: r.name,
    color: r.color,
    // null is meaningful: `physical` has no tint, so an effect's own colour
    // wins. Coercing it to a string would tint every physical impact.
    tintColor: r.tint_color ?? null,
    damageType: r.damage_type,
    onHitEffect: r.on_hit_effect ?? null,
  };
}

async function loadCatalogs(pool) {
  const [origins, elements, shapes, behaviors] = await Promise.all([
    pool.query('SELECT name, height_fraction, label, sort_order FROM attack_origins ORDER BY sort_order ASC, name ASC'),
    pool.query('SELECT name, color, tint_color, damage_type, on_hit_effect, sort_order FROM elements ORDER BY sort_order ASC, name ASC'),
    pool.query('SELECT id, name, radius, vfx_effect, sort_order FROM projectile_shapes ORDER BY sort_order ASC, name ASC'),
    pool.query('SELECT id, name, detonates, detonate_at, pierce_default, sort_order FROM impact_behaviors ORDER BY sort_order ASC, name ASC'),
  ]);

  return {
    // name -> fraction. Consumed by attackOrigin.js's configureAttackOrigins.
    attackOrigins: new Map(origins.rows.map((r) => [r.name, Number(r.height_fraction)])),
    // name -> element. Ordered array form is what goes on the wire.
    elements: new Map(elements.rows.map((r) => [r.name, elementRow(r)])),
    elementList: elements.rows.map(elementRow),
    projectileShapes: new Map(shapes.rows.map((r) => [r.id, {
      id: r.id, name: r.name, radius: Number(r.radius), vfxEffect: r.vfx_effect ?? null,
    }])),
    impactBehaviors: new Map(behaviors.rows.map((r) => [r.id, {
      id: r.id,
      name: r.name,
      detonates: r.detonates === true,
      detonateAt: r.detonate_at ?? null,
      // null, not 0: `pierce` NULL on item_types already means "engine
      // default", and 0 would mean a shot that despawns before hitting
      // anything.
      pierceDefault: r.pierce_default == null ? null : Number(r.pierce_default),
    }])),
  };
}

// What the client is sent on `joined`. Deliberately a projection, not the raw
// rows: the client has no use for sort_order or on_hit_effect, and every field
// that crosses the wire is one more thing a later schema change can break.
function elementsForWire(catalogs) {
  if (!catalogs || !Array.isArray(catalogs.elementList)) return [];
  return catalogs.elementList.map((e) => ({
    name: e.name,
    color: e.color,
    tint: e.tintColor,
  }));
}

module.exports = { loadCatalogs, elementsForWire };
