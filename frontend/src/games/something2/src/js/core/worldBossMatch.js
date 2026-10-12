// SOMET-603: which rendered creature is the active world boss. By the
// server's creature id first, then by tier -- never by name: an admin can
// rename the catalog row, and an ordinary creature can share a word with it.
export function findWorldBossCreature(creatures, status) {
  if (!status || !Array.isArray(creatures)) return null;
  if (status.bossCreatureId) {
    const byId = creatures.find((c) => c.id === status.bossCreatureId);
    if (byId) return byId;
  }
  return creatures.find((c) => c.bossTier === "world") || null;
}
