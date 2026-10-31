// How far a character has got in the Spire of Trials, for the quest log.
//
// One query over the Spire's floors, then a pure reduction (spireFromRows), so
// the rule is testable without a database.
//   highestFloor  the highest floor the character has ever entered
//   maxFloor      the top floor that exists
//   nextBossFloor the lowest gate-boss floor whose boss they have not beaten
//                 (null when every gate boss is down or the tower has none)
const FLOOR_NAME = /^Spire of Trials: Floor (\d+)$/;

function floorOf(name) {
  const m = FLOOR_NAME.exec(String(name || ''));
  return m ? Number(m[1]) : null;
}

// rows: { name, boss: bool, seen: bool, cleared: bool }
function spireFromRows(rows) {
  let highestFloor = 0;
  let maxFloor = 0;
  let nextBossFloor = null;
  for (const r of rows || []) {
    const f = floorOf(r.name);
    if (f == null) continue;
    if (f > maxFloor) maxFloor = f;
    if (r.seen && f > highestFloor) highestFloor = f;
    if (r.boss && !r.cleared && (nextBossFloor == null || f < nextBossFloor)) nextBossFloor = f;
  }
  return { highestFloor, maxFloor, nextBossFloor };
}

async function spireProgress(pool, characterId) {
  const r = await pool.query(
    `SELECT w.name,
            (w.dungeon_boss IS NOT NULL) AS boss,
            EXISTS (SELECT 1 FROM character_visited_worlds v
                     WHERE v.character_id = $1 AND v.world_id = w.id) AS seen,
            EXISTS (SELECT 1 FROM character_boss_clears c
                     WHERE c.character_id = $1 AND c.world_id = w.id) AS cleared
       FROM worlds w WHERE w.name LIKE 'Spire of Trials: Floor %'`,
    [characterId],
  );
  return spireFromRows(r.rows);
}

module.exports = { spireProgress, spireFromRows, floorOf };
