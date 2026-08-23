// PURE generator for the base gear ladder (SOMET-479, progression epic T11).
// Same spec in, byte-identical rows out: no Math.random, no Date.now, no
// database. The upsert at the bottom is the ONLY impure thing in this file and
// is shared by the migration and the re-seed script so the two can never
// disagree about what a ladder row is.

const REQ_STATS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];

// One decimal place. Postgres `real` would round anyway; doing it here means
// the generator's output and the stored row are the same number, so a test may
// compare either.
function round1(n) { return Math.round(n * 10) / 10; }

function generateGearLadder({ tiers, families }) {
  const rows = [];
  for (const f of families) {
    for (const t of tiers) {
      const req = Object.fromEntries(REQ_STATS.map((s) => [`req_${s}`, 0]));
      req[`req_${f.req_stat}`] = t.stat_req;
      const isWeapon = f.category === 'weapon';
      rows.push({
        name: `${t.prefix}-${f.key}`,
        category: f.category,
        slot: f.slot,
        two_handed: f.two_handed === true,
        // NULL for armor, never '' or 'none': weapon_types_kind_check admits
        // only 'melee' and 'projectile', and item_types_weapon_fields_check
        // requires a kind on weapons only.
        kind: isWeapon ? f.kind : null,
        damage: isWeapon ? round1(f.damage * t.power) : 0,
        cooldown: isWeapon ? f.cooldown : 0,
        reach: f.reach != null ? f.reach : null,
        arc_width: f.arc_width != null ? f.arc_width : null,
        range: f.range != null ? f.range : null,
        projectile_speed: f.projectile_speed != null ? f.projectile_speed : null,
        projectile_radius: f.projectile_radius != null ? f.projectile_radius : null,
        // item_types_armor_fields_check demands a non-null defense on armor;
        // a weapon's defense stays NULL rather than 0 so mitigation() keeps
        // reading armor-only, exactly as it does for the 22 weapons already in
        // the catalog.
        defense: isWeapon ? null : round1(f.defense * t.power),
        value: t.value,
        tier: t.tier,
        item_level: t.item_level,
        req_level: t.req_level,
        ...req,
      });
    }
  }
  return rows;
}

// UPSERT BY NAME, NEVER DELETE -- the same rule scripts/seed-catalogs.js states
// in its header. A ladder row an admin has since retuned in the Items admin
// must survive a re-seed, so an existing name is SKIPPED rather than
// overwritten. Adding a family or a tier is what this is for; changing an
// existing row's numbers is an admin-UI action or a new migration.
async function upsertGearLadder(db, rows) {
  let inserted = 0;
  let skipped = 0;
  for (const r of rows) {
    const res = await db.query(
      `INSERT INTO item_types
         (name, category, slot, two_handed, kind, damage, cooldown, reach, arc_width,
          range, projectile_speed, projectile_radius, defense, value,
          tier, item_level, req_level,
          req_strength, req_dexterity, req_constitution, req_intelligence, req_wisdom, req_charisma)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT (name) DO NOTHING
       RETURNING id`,
      [r.name, r.category, r.slot, r.two_handed, r.kind, r.damage, r.cooldown, r.reach, r.arc_width,
        r.range, r.projectile_speed, r.projectile_radius, r.defense, r.value,
        r.tier, r.item_level, r.req_level,
        r.req_strength, r.req_dexterity, r.req_constitution,
        r.req_intelligence, r.req_wisdom, r.req_charisma],
    );
    if (res.rowCount === 1) inserted += 1; else skipped += 1;
  }
  return { inserted, skipped };
}

module.exports = { generateGearLadder, upsertGearLadder };
