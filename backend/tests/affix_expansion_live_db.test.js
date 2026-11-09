// The expanded affixes against the REAL authority: a character equips a weapon carrying rule, spell-level and trigger
// affixes from the live catalog, and the numbers reach the live simulation -- not just the wire frame. The lesson of
// gear_affix_composition_db.test.js applies: an affix that is stored, listed and drawn but inert in play passes
// every test that only reads rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const WebSocket = require('ws');

const { attachAuthority } = require('../src/authority/server.js');
const { createCharacter } = require('../src/services/characters.js');
const triggers = require('../src/authority/triggers.js');
const balance = require('../src/authority/skillBalance.js');
const { entryWorldForJoin } = require('./helpers/entryWorld.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'affix-expansion-test-secret';
const TAG = `afx_${process.pid}_${Date.now().toString(36)}`;
const uniq = (x) => `${TAG}_${x}_${Math.random().toString(36).slice(2, 8)}`;

function nextMsg(ws, type, ms = 15000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (m.type === 'error') { clearTimeout(to); ws.off('message', onMsg); reject(new Error(`server error: ${m.message}`)); }
      else if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

test('rule, spell-level and trigger affixes are live in play', { skip: !DB_URL ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000, max: 6 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    throw new Error(`database unreachable, so nothing here was verified: ${err.message}`);
  }
  const server = http.createServer();
  const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 50 });
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/authority`;
  const userIds = [];
  const typeIds = [];
  let ws = null;
  t.after(async () => {
    try { if (ws) ws.terminate(); } catch { /* gone */ }
    handle.close();
    if (server.listening) await new Promise((r) => server.close(r));
    if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]).catch(() => {});
    if (typeIds.length) await pool.query('DELETE FROM item_types WHERE id = ANY($1::int[])', [typeIds]).catch(() => {});
    await pool.end().catch(() => {});
  });

  // The migration has to have landed: this is what the whole feature stands on.
  const cat = await pool.query(
    `SELECT key, id, placement, group_key, effect FROM affix_types
      WHERE key = ANY($1::text[])`,
    [['of_celerity', 'sagacious', 'of_embers', 'of_the_harvest', 'of_the_turtle', 'of_the_gale']],
  );
  const id = Object.fromEntries(cat.rows.map((r) => [r.key, r.id]));
  for (const k of ['of_celerity', 'sagacious', 'of_embers', 'of_the_harvest', 'of_the_turtle', 'of_the_gale']) {
    assert.ok(id[k], `affix ${k} is missing: has migration 1714440876000/77 run?`);
  }
  assert.ok(cat.rows.every((r) => ['prefix', 'suffix'].includes(r.placement)));
  assert.ok(Array.isArray(cat.rows[0].effect.tiers), 'the tiers travel in the effect');

  const { id: worldId } = await entryWorldForJoin(pool);
  const warrior = (await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior' AND is_playable = true")).rows[0].id;
  const u = await pool.query("INSERT INTO users (username, password_hash, role) VALUES ($1,'x','player') RETURNING id", [uniq('user')]);
  const userId = u.rows[0].id;
  userIds.push(userId);
  const character = await createCharacter(pool, userId, `afx${process.pid % 100000}`, warrior);

  const type = await pool.query(
    `INSERT INTO item_types (name, category, slot, kind, damage, cooldown, defense, reach, arc_width, req_level, req_strength, item_level, tier)
     VALUES ($1,'weapon','main_hand','melee',5,500,0,40,1.2,1,0,1,1) RETURNING id`,
    [uniq('blade')],
  );
  typeIds.push(type.rows[0].id);
  const item = await pool.query(
    "INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level) VALUES ($1,$2,1,'yellow',1) RETURNING id",
    [character.id, type.rows[0].id],
  );
  const itemId = item.rows[0].id;
  const rolls = [['of_celerity', 12], ['sagacious', 2], ['of_embers', 10], ['of_the_harvest', 5], ['of_the_turtle', 20]];
  for (const [i, [key, value]] of rolls.entries()) {
    await pool.query('INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1,$2,$3,$4)', [itemId, i, id[key], value]);
  }

  ws = new WebSocket(`${url}?token=${encodeURIComponent(jwt.sign({ user_id: userId, tv: 1 }, SECRET, { algorithm: 'HS256' }))}`);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.send(JSON.stringify({ type: 'join', world_id: worldId, character_id: character.id }));
  const joined = await nextMsg(ws, 'joined');
  const carried = joined.items.find((i) => i.id === itemId);
  assert.ok(carried, 'the weapon is in the pack');

  await t.test('the join frame carries each affix with its effect text and tiers for the tooltip', () => {
    const a = carried.affixes.find((x) => x.key === 'of_celerity');
    assert.equal(a.value, 12);
    assert.equal(a.effect.text, '+{v}% Attack Speed');
    assert.ok(Array.isArray(a.effect.tiers) && a.effect.tiers.length === 5);
    assert.ok(carried.affixes.find((x) => x.key === 'of_the_turtle').effect.buff.fx.taken === 0.75);
  });

  ws.send(JSON.stringify({ type: 'equip', itemId, slot: 'main_hand' }));
  const equipped = await nextMsg(ws, 'progression');
  const live = handle.worlds.get(worldId).world.getPlayer(String(userId));

  await t.test('the wire bundle and the live player both carry the composed rules', () => {
    for (const stats of [equipped.stats, live.stats]) {
      assert.equal(stats.rules.attackSpeedMult, 1.12, '+12% attack speed');
      assert.equal(stats.rules.spellLevelBonus, 2, '+2 spell levels');
    }
  });

  await t.test('an on-hit rider is among the live player\'s hit statuses, and the event triggers are listed', () => {
    for (const stats of [equipped.stats, live.stats]) {
      assert.ok(stats.hitStatuses.some((s) => s && s.status === 'burn' && s.chance === 0.1), JSON.stringify(stats.hitStatuses));
      assert.deepEqual(stats.triggers.map((x) => x.key).sort(), ['of_the_harvest', 'of_the_turtle']);
    }
  });

  await t.test('a kill restores live mana; being hit may raise a ward that really cuts the damage', () => {
    live.mana = 10;
    live.hp = live.maxHp;
    const maxMana = live.maxMana;
    assert.deepEqual(triggers.fire(live, 'kill', 1000), ['of_the_harvest']);
    assert.equal(Math.round(live.mana), Math.round(10 + maxMana * 0.05));
    // The ward: roll the chance in our favour, then take a blow through the engine's own mitigation.
    balance.setRng(() => 0);
    try {
      assert.deepEqual(triggers.fire(live, 'hurt', 2000, () => 0), ['of_the_turtle']);
      assert.ok(live.buffs.has('trg_ward'));
      assert.equal(balance.mitigateIncoming(live, 100, 'physical', 'c:test'), 75);
    } finally { balance.setRng(); }
  });

  ws.send(JSON.stringify({ type: 'unequip', slot: 'main_hand' }));
  const removed = await nextMsg(ws, 'progression');

  await t.test('unequipping takes every one of them back', () => {
    for (const stats of [removed.stats, live.stats]) {
      assert.equal(stats.rules.attackSpeedMult, 1);
      assert.equal(stats.rules.spellLevelBonus, 0);
      assert.ok(!stats.hitStatuses.some((s) => s && typeof s === 'object'));
      assert.ok(!stats.triggers || stats.triggers.length === 0);
    }
  });
});
