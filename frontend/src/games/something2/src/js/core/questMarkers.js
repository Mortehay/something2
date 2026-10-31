// One rule for "what does this quest giver / village show", shared by the world
// markers above quest givers and the minimap dots, so the two can never
// disagree (they did: the minimap showed "!" for a quest still locked by level).
//
//   "?"  a quest of that village can be turned in (active and its count is met)
//   "!"  one is open to take at the player's current level
//   null nothing to do there
export function questMarkerFor(quests, level = 1) {
  const list = Array.isArray(quests) ? quests : [];
  const ready = list.some((q) => q.status === "active" && (q.progress_count || 0) >= (q.target_count || 1));
  if (ready) return "?";
  const open = list.some((q) => q.status === "available" && (q.required_level || 1) <= level);
  return open ? "!" : null;
}

// One entry per village that has something to show: [{ villageKey, marker }].
export function villageMarkers(allQuests, level = 1) {
  const byVillage = new Map();
  for (const q of Array.isArray(allQuests) ? allQuests : []) {
    if (!q.village_key) continue;
    if (!byVillage.has(q.village_key)) byVillage.set(q.village_key, []);
    byVillage.get(q.village_key).push(q);
  }
  const out = [];
  for (const [villageKey, quests] of byVillage) {
    const marker = questMarkerFor(quests, level);
    if (marker) out.push({ villageKey, marker });
  }
  return out;
}
