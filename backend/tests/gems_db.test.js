// Skill gems owned on the server: buying, the one-time legacy import, and the places
// ownership is enforced (casting and levelling). The purchase tests run against a real
// database -- the gold debit and the ownership row must commit or fail together.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { World } = require('../src/authority/world.js');
const { loadItemTypes, loadInventory } = require('../src/authority/items.js');
const { buyGem, importLegacyGems, loadOwnedGems, loadGemsImported, MAX_IMPORT } = require('../src/authority/gems.js');
const { upgradeSkill } = require('../src/authority/enchantOps.js');
const { SKILLS, getSkillById } = require('../seeds/data/skills.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

async function openPool() {
  if (!DB_URL) return { unreachable: 'no TEST_DATABASE_URL / DATABASE_URL' };
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: `NO DATABASE at ${DB_URL} (${err.message})` };
  }
  return pool;
}

const uniq = (tag) => `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function fixture(pool, tag, gold = 100000) {
  const u = await pool.query(
    `INSERT INTO users (username, password_hash, role, gold) VALUES ($1, 'x', 'player', $2) RETURNING id`,
    [uniq(`gem-${tag}`), gold],
  );
  const userId = u.rows[0].id;
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.is_playable = true ORDER BY e.id LIMIT 1 RETURNING id`,
    [userId, uniq(`gem-char-${tag}`)],
  );
  return { userId, characterId: c.rows[0].id };
}

async function cleanup(pool, fx) {
  if (!fx) return;
  await pool.query('DELETE FROM character_gems WHERE character_id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM character_skill_levels WHERE character_id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM characters WHERE id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [fx.userId]).catch(() => {});
}

// A strong character, so requirements are not what is being tested unless a test says so.
async function armEntry(pool, fx, { level = 99, completedQuests = null, ownedGems = null } = {}) {
  const itemTypes = await loadItemTypes(pool);
  const map = { chunkSize: 16, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  const world = new World(map, itemTypes, null, 16);
  const entry = { worldId: 'w', world };
  const inv = await loadInventory(pool, fx.characterId);
  const stats = {
    meleeMult: 1, spellMult: 1, level, strength: 99, dexterity: 99, constitution: 99,
    intelligence: 99, wisdom: 99, charisma: 99,
    damageMult: { physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1 }, resists: {}, rules: {}, sources: {},
  };
  world.addPlayer(String(fx.userId), { x: 100, y: 100 }, inv, { x: 100, y: 100 }, 0, stats, fx.characterId);
  const p = world.getPlayer(String(fx.userId));
  p.className = 'Warrior';
  p.gold = 100000;
  if (completedQuests) p._completedQuests = completedQuests;
  if (ownedGems) p.ownedGems = ownedGems;
  return { entry, p };
}

const uid = (fx) => String(fx.userId);
const free = SKILLS.find((s) => (s.reqQuests || []).length === 0 && s.reqLvl <= 5 && s.gemPrice > 0);
const gated = SKILLS.find((s) => (s.reqQuests || []).length > 0);
// The quest-free gem with the HIGHEST level requirement: a level-1 character cannot buy it
// (every gem from level 16 up is quest-gated, so this is the strongest "level only" gate).
const lateGame = SKILLS.filter((s) => (s.reqQuests || []).length === 0)
  .sort((a, b) => b.reqLvl - a.reqLvl)[0];

test('the catalog has the gems these tests need', () => {
  assert.ok(free && gated && lateGame);
  assert.ok(lateGame.reqLvl > 1, 'there is a gem a level-1 character cannot buy');
});

test('the migration landed: the gem table, its key and the import flag', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'character_gems' ORDER BY column_name`);
  assert.deepStrictEqual(cols.rows.map((r) => r.column_name), ['acquired_at', 'character_id', 'price_paid', 'skill_id']);
  const flag = await pool.query(
    `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'characters' AND column_name = 'gems_imported'`);
  assert.strictEqual(flag.rows[0].is_nullable, 'NO');
  assert.match(String(flag.rows[0].column_default), /false/);
  fx = await fixture(pool, 'schema');
  await pool.query(`INSERT INTO character_gems (character_id, skill_id) VALUES ($1, 'x')`, [fx.characterId]);
  await assert.rejects(() => pool.query(`INSERT INTO character_gems (character_id, skill_id) VALUES ($1, 'x')`, [fx.characterId]), /pkey|duplicate/);
  await assert.rejects(() => pool.query(`INSERT INTO character_gems (character_id, skill_id, price_paid) VALUES ($1, 'y', -1)`, [fx.characterId]), /price_check/);
  await pool.query('DELETE FROM characters WHERE id = $1', [fx.characterId]);
  const gone = await pool.query('SELECT 1 FROM character_gems WHERE character_id = $1', [fx.characterId]);
  assert.strictEqual(gone.rowCount, 0, 'the gems go with the character');
});

test('buying a gem debits exactly its price and records ownership in one step', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'buy');
  const { entry, p } = await armEntry(pool, fx);
  p.ownedGems = await loadOwnedGems(pool, fx.characterId);

  const r = await buyGem(pool, entry, uid(fx), fx.characterId, free.id);
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.price, free.gemPrice);
  const gold = Number((await pool.query('SELECT gold FROM users WHERE id = $1', [fx.userId])).rows[0].gold);
  assert.strictEqual(gold, 100000 - free.gemPrice);
  assert.strictEqual(r.gold, gold);
  assert.strictEqual(p.gold, gold);
  assert.ok(p.ownedGems.has(free.id));
  assert.deepStrictEqual([...(await loadOwnedGems(pool, fx.characterId))], [free.id], 'persisted');
  const paid = await pool.query('SELECT price_paid FROM character_gems WHERE character_id = $1', [fx.characterId]);
  assert.strictEqual(paid.rows[0].price_paid, free.gemPrice);
});

test('a gem cannot be bought twice, and the second attempt costs nothing', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'twice');
  const { entry, p } = await armEntry(pool, fx);
  assert.strictEqual((await buyGem(pool, entry, uid(fx), fx.characterId, free.id)).ok, true);
  const before = Number((await pool.query('SELECT gold FROM users WHERE id = $1', [fx.userId])).rows[0].gold);
  const again = await buyGem(pool, entry, uid(fx), fx.characterId, free.id);
  assert.strictEqual(again.ok, false);
  assert.match(again.reason, /already own/);
  // and with a STALE cache that forgot the purchase, the database key still refuses it
  p.ownedGems = new Set();
  const stale = await buyGem(pool, entry, uid(fx), fx.characterId, free.id);
  assert.strictEqual(stale.ok, false);
  assert.match(stale.reason, /already own/);
  const after = Number((await pool.query('SELECT gold FROM users WHERE id = $1', [fx.userId])).rows[0].gold);
  assert.strictEqual(after, before, 'no gold moved');
});

test('not enough gold buys nothing, even when the cache claims riches', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'poor', free.gemPrice - 1);
  const { entry, p } = await armEntry(pool, fx);
  p.gold = 1e9; // a forged / stale wallet must not matter: the database decides
  const r = await buyGem(pool, entry, uid(fx), fx.characterId, free.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not enough gold');
  assert.strictEqual((await pool.query('SELECT 1 FROM character_gems WHERE character_id = $1', [fx.characterId])).rowCount, 0,
    'the insert was rolled back with the failed debit');
  assert.strictEqual(Number((await pool.query('SELECT gold FROM users WHERE id = $1', [fx.userId])).rows[0].gold), free.gemPrice - 1);
});

test('requirements are enforced: level, and story quests', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'req');

  const weak = await armEntry(pool, fx, { level: 1 });
  const low = await buyGem(pool, weak.entry, uid(fx), fx.characterId, lateGame.id);
  assert.strictEqual(low.ok, false);
  assert.match(low.reason, /Level/);

  const noQuest = await armEntry(pool, fx, { level: 99, completedQuests: new Set() });
  const blocked = await buyGem(pool, noQuest.entry, uid(fx), fx.characterId, gated.id);
  assert.strictEqual(blocked.ok, false);
  assert.match(blocked.reason, /quest/i);

  noQuest.p._completedQuests = new Set(gated.reqQuests);
  const ok = await buyGem(pool, noQuest.entry, uid(fx), fx.characterId, gated.id);
  assert.strictEqual(ok.ok, true, ok.reason);

  assert.strictEqual((await buyGem(pool, noQuest.entry, uid(fx), fx.characterId, 'nope')).reason, 'unknown skill');
  assert.strictEqual((await buyGem(pool, noQuest.entry, uid(fx), fx.characterId, 42)).reason, 'unknown skill');
});

test('the weapon requirement does not stop a PURCHASE (it gates casting)', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'weapon');
  const bow = SKILLS.find((s) => s.reqWeapon === 'bow');
  assert.ok(bow, 'the catalog has a bow skill');
  const { entry } = await armEntry(pool, fx, { completedQuests: new Set(bow.reqQuests || []) });
  assert.strictEqual((await buyGem(pool, entry, uid(fx), fx.characterId, bow.id)).ok, true);
});

test('the legacy import is honoured once, only for gems the character qualifies for, at no cost', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'import');
  const { entry, p } = await armEntry(pool, fx, { level: 1, completedQuests: new Set() });
  assert.strictEqual(await loadGemsImported(pool, fx.characterId), false);

  const names = [free.id, lateGame.id, gated.id, free.id, 'bogus', 7, null];
  const r = await importLegacyGems(pool, entry, uid(fx), fx.characterId, names);
  assert.strictEqual(r.ok, true, r.reason);
  // the level-1 character qualifies for the starter gem only: no late-game gem, no quest gem
  assert.deepStrictEqual(r.granted, [free.id]);
  assert.ok(p.ownedGems.has(free.id));
  assert.strictEqual(Number((await pool.query('SELECT gold FROM users WHERE id = $1', [fx.userId])).rows[0].gold), 100000, 'free');
  const paid = await pool.query('SELECT price_paid FROM character_gems WHERE character_id = $1', [fx.characterId]);
  assert.strictEqual(paid.rows[0].price_paid, 0);
  assert.strictEqual(await loadGemsImported(pool, fx.characterId), true);

  // a replay (or a second socket) gets nothing
  const again = await importLegacyGems(pool, entry, uid(fx), fx.characterId, [lateGame.id]);
  assert.strictEqual(again.ok, false);
  assert.match(again.reason, /already imported/);
  assert.strictEqual((await pool.query('SELECT 1 FROM character_gems WHERE character_id = $1', [fx.characterId])).rowCount, 1);
});

test('an import with a junk list is refused without burning the one-time claim', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  fx = await fixture(pool, 'junk');
  const { entry } = await armEntry(pool, fx);
  assert.strictEqual((await importLegacyGems(pool, entry, uid(fx), fx.characterId, 'all of them')).ok, false);
  assert.strictEqual((await importLegacyGems(pool, entry, uid(fx), fx.characterId, null)).ok, false);
  assert.strictEqual(await loadGemsImported(pool, fx.characterId), false, 'the claim is still available');
  const huge = Array.from({ length: MAX_IMPORT + 500 }, () => free.id);
  const r = await importLegacyGems(pool, entry, uid(fx), fx.characterId, huge);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.granted, [free.id], 'a forged huge list is capped and deduplicated');
});

// -------------------------------------------------- ownership is enforced in play (no DB needed)

function playerWorld(ownedGems) {
  const map = { isWalkable: () => true, width: 4000, height: 4000, decorations: [] };
  const sword = { id: 9, name: 'sword', category: 'weapon', kind: 'melee', damage: 0, cooldown: 0.5, reach: 90 };
  const world = new World(map, new Map([[9, sword]]), 9);
  const stats = {
    meleeMult: 1, spellMult: 1, level: 100, strength: 99, dexterity: 99, constitution: 99,
    intelligence: 99, wisdom: 99, charisma: 99,
    damageMult: { physical: 1, arcane: 1, fire: 1, ice: 1, lightning: 1 }, resists: {}, rules: {}, sources: {},
  };
  world.addPlayer('u', { x: 1000, y: 1000 }, { items: [], equipment: {} }, { x: 1000, y: 1000 }, 0, stats);
  const p = world.getPlayer('u');
  p.className = 'Warrior'; p.stamina = 100; p.mana = 100; p.maxMana = 100; p.hp = 500; p.maxHp = 500;
  if (ownedGems) p.ownedGems = ownedGems;
  return { world, p };
}

test('casting an unlearned skill is refused once ownership is loaded', () => {
  const { world, p } = playerWorld(new Set());
  const refused = world.castSkill('u', 'war_crushing_blow', p.x + 40, p.y, 1, 0);
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'not_learned');
  assert.strictEqual(p.stamina, 100, 'a refused cast costs nothing');

  p.ownedGems.add('war_crushing_blow');
  assert.strictEqual(world.castSkill('u', 'war_crushing_blow', p.x + 40, p.y, 1, 0).ok, true);
});

test('a player whose gems failed to load is not locked out of every skill', () => {
  const { world, p } = playerWorld(null);
  assert.strictEqual(p.ownedGems, undefined);
  assert.strictEqual(world.castSkill('u', 'war_crushing_blow', p.x + 40, p.y, 1, 0).ok, true);
});

test('only a learned skill can be levelled', async () => {
  const { p } = playerWorld(new Set());
  const entry = { world: { getPlayer: () => p } };
  const pool = { connect: async () => { throw new Error('must not reach the database'); } };
  const r = await upgradeSkill(pool, entry, 'u', 5, 'war_crushing_blow');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /learn that skill first/);
});

// -------------------------------------------------------------------- wiring guards
test('the server registers the handlers, sends the gems on join, and checks for a merchant', () => {
  const server = fs.readFileSync(path.resolve(__dirname, '../src/authority/server.js'), 'utf8');
  assert.match(server, /^\s+buyGem\(ws, msg\) \{/m);
  assert.match(server, /^\s+importGems\(ws, msg\) \{/m);
  assert.match(server, /gems: joinedGems \? \[\.\.\.joinedGems\] : \[\]/);
  assert.match(server, /gemsImported: joinedGemsImported/);
  assert.match(server, /'gemMerchantX', 'gemMerchantY'/);
  assert.match(server, /type: 'gemBought'/);
  assert.match(server, /type: 'gemsImported'/);
});

test('the shop price is the catalog gem price', () => {
  for (const s of SKILLS) assert.ok(Number.isFinite(s.gemPrice) && s.gemPrice > 0, `${s.id}`);
  assert.strictEqual(getSkillById(free.id).gemPrice, free.gemPrice);
});
