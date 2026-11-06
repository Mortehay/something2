// The dedicated arena WORLDS of the world bosses: one small map per boss
// (backend/seeds/maps/boss-arenas.map.json), reached by a portal from the Vale
// Crossing hub, open only while that boss is active.
//
// ONE table maps a boss to its arena. The map spec, the world boss manager, the
// portal gate and the tests all read it, so a boss and its arena cannot drift.
//
// Matching is by the boss's NAME first (the catalog's exact name) and by ELEMENT as the
// fallback, so a boss added to the catalog later with an element that already has an
// arena uses that arena instead of silently falling back to a town region.

const ARENA_WORLDS = Object.freeze([
  { boss: 'Glacius, the Frost Leviathan', element: 'ice', key: 'arena_glacius', short: 'Glacius', worldName: 'Boss Arena: Glacius' },
  { boss: 'Ignis, the Magma Colossus', element: 'fire', key: 'arena_ignis', short: 'Ignis', worldName: 'Boss Arena: Ignis' },
  { boss: 'Abyssor, the Voidreaver', element: 'arcane', key: 'arena_abyssor', short: 'Abyssor', worldName: 'Boss Arena: Abyssor' },
  { boss: 'Gorgon, the Thunder Titan', element: 'lightning', key: 'arena_gorgon', short: 'Gorgon', worldName: 'Boss Arena: Gorgon' },
]);

// The world that hosts the portals into every arena, and the command that seeds them.
const HUB_WORLD_NAME = 'Vale Crossing';
const SEED_COMMAND = 'make seed-map SPEC=boss-arenas';

// Arena entry for a boss (a catalog row's name/element, or a bossFromRow result):
// by name, else by element, else null.
function arenaForBoss(boss) {
  if (!boss) return null;
  const name = boss.name || boss.boss;
  const byName = ARENA_WORLDS.find((a) => a.boss === name);
  if (byName) return byName;
  const element = boss.element || boss.bossElement;
  return element ? (ARENA_WORLDS.find((a) => a.element === element) || null) : null;
}

// Arena entry for a WORLD name ("Boss Arena: Glacius"), or null for any other world.
function arenaForWorldName(worldName) {
  return ARENA_WORLDS.find((a) => a.worldName === worldName) || null;
}

const isArenaWorldName = (worldName) => arenaForWorldName(worldName) !== null;

// The portal gate, as a pure decision the server's portal tick applies: a portal INTO a
// boss arena is sealed unless that boss is up there; every other portal -- including the
// way out of an arena, which leads to the hub -- is never touched. `link` is the
// portal's row ({ toName }), `manager` the WorldBossManager.
function portalGate(manager, link, toWorldId, now = Date.now()) {
  if (!link) return { sealed: false };
  const g = manager.arenaGate(link.toName, toWorldId, now);
  if (!g.arena || g.open) return { sealed: false };
  return { sealed: true, bossName: g.bossName, message: `The arena gate is sealed: ${g.bossName} has not risen.` };
}

module.exports = {
  ARENA_WORLDS, HUB_WORLD_NAME, SEED_COMMAND, arenaForBoss, arenaForWorldName, isArenaWorldName, portalGate,
};
