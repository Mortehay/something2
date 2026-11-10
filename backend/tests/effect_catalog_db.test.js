const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { loadEffectCatalog, findEffectSubject, subjectPrompt, PLAYER_SKILL_EFFECTS, GROUP_ORDER } = require('../src/services/effectCatalog.js');
const { VISUAL_BUFF_IDS } = require('../src/services/buffVisuals.js');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to write to a real database' : false;

let pool;
test.before(() => { if (!skip) pool = new Pool({ connectionString: url }); });
test.after(async () => { if (!skip) await pool.end(); });

// Every fixture row lives in one transaction that is rolled back: the DB is left as found.
async function inFixture(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const fx = (name, shape) => c.query(
      `INSERT INTO vfx_effects (name, shape, color) VALUES ($1, $2, '#ffffff')
       ON CONFLICT (name) DO UPDATE SET shape = EXCLUDED.shape, color = EXCLUDED.color`, [name, shape]);
    await fx('a_weapon', 'arc');
    await fx('a_skill', 'line');
    await fx('a_creature_attack', 'arc');
    await fx('whirlwind', 'ring');
    await fx('generic_whiff', 'arc');
    await fx('spark_fire', 'burst');
    await fx('orphan', 'burst');
    await c.query(`INSERT INTO aura_effects (name, radius, color) VALUES ('a_aura', 100, '#ffffff')`);
    await c.query(`INSERT INTO item_types (name, damage, cooldown, category, vfx)
                   VALUES ('cat_fx_item', 1, 1, 'currency', '{"attack":"a_weapon","miss":"generic_whiff"}')`);
    await c.query(`INSERT INTO creature_skills (name, kind, cooldown_ms, vfx) VALUES ('cat_fx_skill', 'slam', 1000, '{"cast":"a_skill"}')`);
    // A creature's basic attack (entity_types.vfx) is a creature skill, not a weapon attack.
    await c.query(`INSERT INTO entity_types (name, color, is_creature, vfx)
                   VALUES ('cat_fx_creature', '#000000', true, '{"attack":"a_creature_attack"}')`);
    // A non-object binding references nothing (and must not break the query).
    await c.query(`INSERT INTO creature_skills (name, kind, cooldown_ms, vfx) VALUES ('cat_fx_skill_str', 'slam', 1000, '"orphan"')`);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

test('loadEffectCatalog lists every row once, grouped by what uses it, in group order', { skip }, async () => {
  await inFixture(async (db) => {
    const list = await loadEffectCatalog(db);
    const { rows: [n] } = await db.query('SELECT (SELECT count(*) FROM vfx_effects)::int AS v, (SELECT count(*) FROM aura_effects)::int AS a');
    // Every visual buff is listed too, row or no row (Buff auras), and the ten amber status rows.
    assert.equal(list.length, n.v + n.a + VISUAL_BUFF_IDS.length + 10);
    assert.equal(new Set(list.map((s) => `${s.subject_kind}|${s.name}`)).size, list.length);

    const by = (kind, name) => list.find((s) => s.subject_kind === kind && s.name === name);
    assert.equal(by('vfx', 'a_weapon').group, 'Weapon attacks');
    assert.equal(by('vfx', 'generic_whiff').group, 'Weapon attacks');
    assert.equal(by('vfx', 'a_skill').group, 'Creature & boss skills');
    assert.equal(by('vfx', 'a_creature_attack').group, 'Creature & boss skills');
    assert.ok(PLAYER_SKILL_EFFECTS.has('whirlwind'));
    assert.equal(by('vfx', 'whirlwind').group, 'Player skills');
    assert.equal(by('vfx', 'orphan').group, 'Not used yet');
    assert.equal(by('vfx', 'spark_fire').group, 'Not used yet');
    assert.equal(by('aura', 'a_aura').group, 'Auras');
    assert.equal(by('vfx', 'spark_fire').retired, true);
    assert.equal(by('vfx', 'orphan').retired, false);

    // Shape-derived settings ride along: whirlwind is a ring, so a top-down burst.
    const w = by('vfx', 'whirlwind');
    assert.deepEqual({ kind: w.kind, frames: w.frames, size: w.size, loop: w.loop, topDown: w.topDown, shape: w.shape, color: w.color },
      { kind: 'burst', frames: 6, size: 128, loop: false, topDown: true, shape: 'ring', color: '#ffffff' });

    const rank = list.map((s) => GROUP_ORDER.indexOf(s.group));
    assert.ok(rank.every((r) => r >= 0));
    assert.deepEqual(rank, [...rank].sort((a, b) => a - b));
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].group === list[i - 1].group) assert.ok(list[i - 1].name <= list[i].name, `${list[i - 1].name} before ${list[i].name}`);
    }
  });
});

test('findEffectSubject returns the same subject the list gives, or null', { skip }, async () => {
  await inFixture(async (db) => {
    const list = await loadEffectCatalog(db);
    assert.deepEqual(await findEffectSubject(db, 'vfx', 'a_weapon'), list.find((s) => s.name === 'a_weapon'));
    assert.deepEqual(await findEffectSubject(db, 'aura', 'a_aura'), list.find((s) => s.name === 'a_aura'));
    assert.equal(await findEffectSubject(db, 'vfx', 'nope'), null);
    assert.equal(await findEffectSubject(db, 'aura', 'a_weapon'), null);
  });
});

test('the 55 visual buffs are listed in Buff auras, after Auras and before Not used yet', { skip }, async () => {
  await inFixture(async (db) => {
    const list = await loadEffectCatalog(db);
    const buffs = list.filter((s) => s.subject_kind === 'buff');
    assert.equal(buffs.length, 55);
    assert.deepEqual(buffs.map((s) => s.name).sort(), [...VISUAL_BUFF_IDS].sort());
    assert.ok(buffs.every((s) => s.group === 'Buff auras'));
    assert.ok(GROUP_ORDER.indexOf('Auras') < GROUP_ORDER.indexOf('Buff auras'));
    assert.ok(GROUP_ORDER.indexOf('Buff auras') < GROUP_ORDER.indexOf('Not used yet'));
    const first = list.findIndex((s) => s.group === 'Buff auras');
    assert.ok(list.slice(0, first).every((s) => s.group !== 'Not used yet'));
    // Status visuals sit between the buffs and the unused effects.
    assert.ok(list.slice(first + 55, first + 65).every((s) => s.group === 'Status visuals'));
    assert.ok(list.slice(first + 65).every((s) => s.group === 'Not used yet'));

    const sw = buffs.find((s) => s.name === 'war_shield_wall');
    assert.deepEqual(
      { kind: sw.kind, frames: sw.frames, size: sw.size, loop: sw.loop, blend: sw.blend, placement: sw.placement, retired: sw.retired, nameEn: sw.nameEn },
      { kind: 'aura', frames: 8, size: 128, loop: true, blend: 'additive', placement: 'body', retired: false, nameEn: 'Shield Wall' });
    // A dark colour draws with alpha, like every other effect.
    assert.equal(buffs.find((s) => s.name === 'dru_barkskin').blend, 'alpha');
    assert.match(subjectPrompt(sw), /, shell around a figure$/);
    assert.match(subjectPrompt(buffs.find((s) => s.name === 'mag_immolation_aura')), /, seen from above$/);
  });
});

test('a visual buff with no buff_visuals row is still listed, from its defaults; findEffectSubject agrees', { skip }, async () => {
  await inFixture(async (db) => {
    await db.query("DELETE FROM buff_visuals WHERE skill_id = 'mag_haste'");
    const list = await loadEffectCatalog(db);
    const h = list.find((s) => s.subject_kind === 'buff' && s.name === 'mag_haste');
    assert.ok(h);
    assert.equal(h.placement, 'body');
    assert.deepEqual(await findEffectSubject(db, 'buff', 'mag_haste'), h);
    assert.deepEqual(await findEffectSubject(db, 'buff', 'war_shield_wall'), list.find((s) => s.subject_kind === 'buff' && s.name === 'war_shield_wall'));
    // A form, a trap, a non-buff and an unknown kind are not buff subjects.
    assert.equal(await findEffectSubject(db, 'buff', 'dru_bear_form'), null);
    assert.equal(await findEffectSubject(db, 'buff', 'arc_bear_trap'), null);
    assert.equal(await findEffectSubject(db, 'buff', 'pack_leader'), null);
    assert.equal(await findEffectSubject(db, 'nope', 'war_shield_wall'), null);
  });
});
