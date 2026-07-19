// The single ammo spend path. Write-through: Postgres is the only source of
// truth for how much ammo a player has, so a crash can neither lose nor
// refund a shot. Deliberately NOT cached in memory — see the "Why not Redis"
// section of the 3b-3b spec.

// Spend one unit of `ammoTypeId` from `userId`. Returns whether a unit was
// actually spent; the caller must treat false as "out of ammo" and refuse the
// attack WITHOUT consuming the cooldown.
//
// The subquery is load-bearing. A player may hold more than one stack of the
// same ammo type (stacks are never merged — see the spec), and the obvious
// form `WHERE user_id = $1 AND item_type_id = $2` would decrement EVERY one
// of them on a single shot. Selecting one id first makes the statement
// correct for any number of stacks; ORDER BY created_at drains oldest first.
//
// rowCount IS the has-ammo check: there is no separate SELECT that could
// drift out of sync with the write, the same reasoning as the loot claim CTE.
async function consumeAmmo(pool, userId, ammoTypeId) {
  const r = await pool.query(
    `UPDATE player_items SET quantity = quantity - 1
      WHERE id = (
        SELECT id FROM player_items
         WHERE user_id = $1 AND item_type_id = $2 AND quantity > 0
         ORDER BY created_at ASC, id ASC LIMIT 1
      )
      RETURNING id, quantity`,
    [userId, ammoTypeId],
  );
  if (r.rowCount !== 1) return false;
  // quantity > 0 is a CHECK constraint, so an emptied stack must be removed
  // rather than left at 0 — the next shot's `quantity > 0` predicate would
  // skip it anyway, but leaving zero-rows around would grow the inventory.
  if (Number(r.rows[0].quantity) === 0) {
    await pool.query('DELETE FROM player_items WHERE id = $1', [r.rows[0].id]);
  }
  return true;
}

// Total units of `ammoTypeId` the player holds, summed across every stack.
//
// Same reasoning as the subquery above: stacks are deliberately never
// merged, so a player can hold two arrow stacks at once, and reading a
// single row (or a single stack's quantity) would report a wrong number to
// the HUD. This is a read-only second query — an accepted second round trip
// per successful shot, not merged into consumeAmmo's UPDATE, so a failure
// here can never affect whether the shot itself succeeded.
async function ammoCount(pool, userId, ammoTypeId) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS n
       FROM player_items
      WHERE user_id = $1 AND item_type_id = $2`,
    [userId, ammoTypeId],
  );
  return Number(r.rows[0].n);
}

module.exports = { consumeAmmo, ammoCount };
