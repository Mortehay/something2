// The single ammo spend path. Write-through: Postgres is the only source of
// truth for how much ammo a player has, so a crash can neither lose nor
// refund a shot. Deliberately NOT cached in memory — see the "Why not Redis"
// section of the 3b-3b spec.
//
// F-022 / SOMET-202 evaluated this file's del/upd split (a single row's
// `quantity` going above 1 and being decremented in place) as unused
// generality: grep across the whole tree shows no production writer ever
// grants a player_items row with quantity > 1 — every grant hardcodes 1 or
// takes the column default. That's real, and it's why sellItem (trade.js)
// was tightened to refuse a stacked row instead of silently mispricing it.
// This file's decrement path was deliberately LEFT AS IS rather than
// collapsed to a single-row delete: authority_ammo_db.test.js exercises the
// quantity > 1 case on purpose, as a regression test for a P0 bug that
// shipped here once already (a decrement expressed as UPDATE ... quantity =
// quantity - 1 hit the 1 -> 0 CHECK violation and permanently stuck every
// ammo stack at 1). Removing this machinery would mean deleting that
// protection for a P3 cleanup with no functional bug behind it in THIS
// file — a bad trade. If a future change actually needs multi-unit stacks,
// this is already correct for them; if the answer instead becomes "quantity
// is permanently 1," delete this comment and the del/upd split together.

// Spend one unit of `ammoTypeId` from `characterId`. Returns whether a unit was
// actually spent; the caller must treat false as "out of ammo" and refuse the
// attack WITHOUT consuming the cooldown.
//
// The `pick` CTE is load-bearing. A player may hold more than one stack of
// the same ammo type (stacks are never merged — see the spec), and the
// obvious form `WHERE character_id = $1 AND item_type_id = $2` would decrement
// EVERY one of them on a single shot. Picking one id first makes the
// statement correct for any number of stacks; ORDER BY created_at drains the
// oldest first. FOR UPDATE locks that one row so two concurrent spends
// serialize on it instead of both reading the same pre-spend quantity.
//
// The del/upd split is NOT a style choice — it is the whole fix for the
// defect that shipped here. `player_items` carries CHECK (quantity > 0), and
// that constraint is correct: a zero-quantity stack is a meaningless row.
// Taking the last unit therefore CANNOT be expressed as a decrement followed
// by a cleanup DELETE: the 1 -> 0 UPDATE violates the check *inside the
// UPDATE itself*, Postgres evaluates it at statement end, and it is not
// DEFERRABLE — so the statement throws and any DELETE written after it is
// unreachable dead code. That is exactly what happened: every ammo stack got
// permanently stuck at 1, the last arrow could never be fired, and the
// caller's catch swallowed the rejection so the client was told nothing at
// all. Branching *within one statement* — DELETE the row when it holds its
// last unit, decrement otherwise — never constructs an illegal row, so the
// constraint stays and the spend still succeeds.
//
// The returned count IS the has-ammo check: there is no separate SELECT that
// could drift out of sync with the write, the same reasoning as the loot
// claim CTE. Exactly one of del/upd can fire (their predicates partition
// pick's single row), so `spent` is 1 on a successful spend and 0 when the
// player holds no stack with anything left.
async function consumeAmmo(pool, characterId, ammoTypeId) {
  const r = await pool.query(
    `WITH pick AS (
       SELECT id, quantity FROM player_items
        WHERE character_id = $1 AND item_type_id = $2 AND quantity > 0
        ORDER BY created_at ASC, id ASC LIMIT 1
        FOR UPDATE
     ), del AS (
       DELETE FROM player_items
        WHERE id IN (SELECT id FROM pick WHERE quantity = 1)
        RETURNING id
     ), upd AS (
       UPDATE player_items SET quantity = quantity - 1
        WHERE id IN (SELECT id FROM pick WHERE quantity > 1)
        RETURNING id
     )
     SELECT (SELECT count(*) FROM del) + (SELECT count(*) FROM upd) AS spent`,
    [characterId, ammoTypeId],
  );
  return Number(r.rows[0] && r.rows[0].spent) === 1;
}

// Total units of `ammoTypeId` the player holds, summed across every stack.
//
// Same reasoning as the subquery above: stacks are deliberately never
// merged, so a player can hold two arrow stacks at once, and reading a
// single row (or a single stack's quantity) would report a wrong number to
// the HUD. This is a read-only second query — an accepted second round trip
// per successful shot, not merged into consumeAmmo's UPDATE, so a failure
// here can never affect whether the shot itself succeeded.
async function ammoCount(pool, characterId, ammoTypeId) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS n
       FROM player_items
      WHERE character_id = $1 AND item_type_id = $2`,
    [characterId, ammoTypeId],
  );
  return Number(r.rows[0].n);
}

module.exports = { consumeAmmo, ammoCount };
