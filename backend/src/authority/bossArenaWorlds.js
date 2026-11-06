// The dedicated arena WORLDS of the world bosses: one small map per boss
// (backend/seeds/maps/boss-arenas.map.json), reached from the Vale Crossing hub by ONE
// universal portal that is always open (see universalGate).
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

// The UNIVERSAL arena portal, as a pure decision the server's portal tick applies. The
// hub has ONE portal into the arenas and it is ALWAYS open; it carries a placeholder
// destination (any arena), and which arena it really leads to is decided when a player
// steps through: the active boss's, else the next boss's, else the table's first. Every
// other portal -- including the way OUT of an arena, which leads to the hub -- is
// untouched ({ universal: false }). `link` is the portal's row ({ toName }), `fromWorldName`
// the world the player stands in, `manager` the WorldBossManager.
function universalGate(manager, link, fromWorldName, now = Date.now()) {
  if (!link || !isArenaWorldName(link.toName) || isArenaWorldName(fromWorldName)) return { universal: false };
  const { def, bossName, mode } = manager.arenaDestination(now);
  let message = `Entering Boss Arena: ${def.short}`;
  if (mode === 'active') message += ` (${bossName} is fighting there).`;
  else if (mode === 'next') message += `. No boss is active right now; ${bossName} is next.`;
  else message += '. No boss is active right now and none is planned yet.';
  return { universal: true, worldName: def.worldName, bossName, mode, message };
}

module.exports = {
  ARENA_WORLDS, HUB_WORLD_NAME, SEED_COMMAND, arenaForBoss, arenaForWorldName, isArenaWorldName, universalGate,
};
