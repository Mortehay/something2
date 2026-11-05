// SOMET-720. Play statistics for the Orange Pi tab. Counters move in memory on the
// game's hot paths (a Map lookup and an increment, never a query) and reach
// player_game_stats as deltas in one batched statement: every 60 s, on a
// disconnect and on shutdown. A failed flush logs and keeps the deltas for the next
// one; nothing here can throw into the game.
//
// A session belongs to a character, not to a socket. Changing world is a reconnect
// (the client opens a new socket and joins again), so a join within RESUME_MS of the
// last one continues the session instead of counting a new one.
//
// `owner` is the socket. A kicked or stale socket's close arrives after the new
// socket's join; only the socket that holds the session may end it.
const FLUSH_MS = 60_000;
const RESUME_MS = 60_000;
const BATCH_SIZE = 200;

const UPSERT = `
  INSERT INTO player_game_stats
    (character_id, user_id, mob_kills, pvp_kills, deaths, boss_kills, play_seconds, sessions, last_seen_at)
  SELECT c.id, c.user_id, d.mob, d.pvp, d.deaths, d.boss, d.play, d.sessions, d.seen
    FROM unnest($1::int[], $2::bigint[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[], $7::int[], $8::timestamptz[])
         AS d(character_id, mob, pvp, deaths, boss, play, sessions, seen)
    JOIN characters c ON c.id = d.character_id
  ON CONFLICT (character_id) DO UPDATE SET
    mob_kills = player_game_stats.mob_kills + EXCLUDED.mob_kills,
    pvp_kills = player_game_stats.pvp_kills + EXCLUDED.pvp_kills,
    deaths = player_game_stats.deaths + EXCLUDED.deaths,
    boss_kills = player_game_stats.boss_kills + EXCLUDED.boss_kills,
    play_seconds = player_game_stats.play_seconds + EXCLUDED.play_seconds,
    sessions = player_game_stats.sessions + EXCLUDED.sessions,
    last_seen_at = GREATEST(player_game_stats.last_seen_at, EXCLUDED.last_seen_at)`;
// The JOIN: a character deleted while it had unflushed deltas must not fail the
// foreign key and take every other character's deltas with it on every retry.

const emptyDelta = () => ({ mob: 0, pvp: 0, deaths: 0, boss: 0, playSeconds: 0, sessions: 0, seenAt: 0 });
const isEmptyDelta = (d) => !(d.mob || d.pvp || d.deaths || d.boss || d.playSeconds || d.sessions);
const emptyLifetime = () => ({ mobKills: 0, pvpKills: 0, deaths: 0, bossKills: 0, playSeconds: 0, sessions: 0 });

function createGameStats({ pool, now = Date.now, log = console, flushMs = FLUSH_MS, resumeMs = RESUME_MS } = {}) {
  const sessions = new Map(); // characterId -> session
  const pending = new Map(); // characterId -> unflushed delta
  const totals = { mobKills: 0, pvpKills: 0 };
  let timer = null;
  let stopped = false;
  let inflight = null;
  let again = false;

  const deltaOf = (id) => {
    let d = pending.get(id);
    if (!d) { d = emptyDelta(); pending.set(id, d); }
    return d;
  };

  // Moves a live session's elapsed time into its delta, in whole seconds. The remainder stays on the
  // session: a delta only ever holds what is worth writing, and when the session goes the part of a
  // second goes with it, so a character who has left is never written again.
  function accrue(s, t) {
    if (!s.online) return;
    const ms = t - s.accruedAt;
    if (ms > 0) s.carryMs += ms;
    s.accruedAt = t;
    const whole = Math.floor(s.carryMs / 1000);
    s.carryMs -= whole * 1000;
    const d = deltaOf(s.characterId);
    d.playSeconds += whole;
    d.seenAt = t;
  }

  function join(characterId, owner = null) {
    if (characterId == null) return null;
    const t = now();
    let s = sessions.get(characterId);
    const resumable = s && (s.online || t - s.endedAt <= resumeMs);
    if (!resumable) {
      s = {
        characterId, owner, startedAt: t, accruedAt: t, online: true, endedAt: null,
        carryMs: 0, mobKills: 0, pvpKills: 0, deaths: 0, bossKills: 0,
      };
      sessions.set(characterId, s);
      deltaOf(characterId).sessions += 1;
    } else {
      accrue(s, t);
      s.owner = owner;
      if (!s.online) { s.online = true; s.accruedAt = t; s.endedAt = null; }
    }
    deltaOf(characterId).seenAt = t;
    return s;
  }

  // Returns true when this owner really ended the session.
  function leave(characterId, owner = null) {
    const s = characterId == null ? null : sessions.get(characterId);
    if (!s || !s.online || s.owner !== owner) return false;
    const t = now();
    accrue(s, t);
    s.online = false;
    s.endedAt = t;
    return true;
  }

  // The one way a kill moves a counter. `boss` also counts boss_kills, for this
  // killer only. A character with no live session still reaches the table: the
  // commit of a kill can finish after its killer has left.
  function recordKill(characterId, { boss = false } = {}) {
    if (characterId == null) return;
    const d = deltaOf(characterId);
    d.mob += 1;
    totals.mobKills += 1;
    const s = sessions.get(characterId);
    if (s) s.mobKills += 1;
    if (boss) {
      d.boss += 1;
      if (s) s.bossKills += 1;
    }
    d.seenAt = now();
  }

  // One resolved player death. killerCharacterId is null unless a player landed it.
  function recordDeath(characterId, killerCharacterId = null) {
    if (characterId != null) {
      const d = deltaOf(characterId);
      d.deaths += 1;
      d.seenAt = now();
      const s = sessions.get(characterId);
      if (s) s.deaths += 1;
    }
    if (killerCharacterId != null && killerCharacterId !== characterId) {
      const d = deltaOf(killerCharacterId);
      d.pvp += 1;
      d.seenAt = now();
      totals.pvpKills += 1;
      const s = sessions.get(killerCharacterId);
      if (s) s.pvpKills += 1;
    }
  }

  function restore(ids, taken) {
    ids.forEach((id, i) => {
      const d = deltaOf(id);
      const old = taken[i];
      d.mob += old.mob; d.pvp += old.pvp; d.deaths += old.deaths; d.boss += old.boss;
      d.playSeconds += old.playSeconds; d.sessions += old.sessions;
      d.seenAt = Math.max(d.seenAt, old.seenAt);
    });
  }

  async function writeAll() {
    const t = now();
    for (const s of sessions.values()) accrue(s, t);
    // A session that ended long ago cannot be resumed and has nothing left to say.
    for (const [id, s] of sessions) if (!s.online && t - s.endedAt > resumeMs) sessions.delete(id);
    // A delta with nothing to add (a join inside the second, say) is not worth a row or a new last_seen_at.
    for (const [id, d] of pending) if (isEmptyDelta(d)) pending.delete(id);
    const ids = [...pending.keys()];
    const taken = ids.map((id) => pending.get(id));
    pending.clear();
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batchIds = ids.slice(i, i + BATCH_SIZE);
      const batch = taken.slice(i, i + BATCH_SIZE);
      try {
        await pool.query(UPSERT, [
          batchIds, batch.map((d) => d.mob), batch.map((d) => d.pvp), batch.map((d) => d.deaths), batch.map((d) => d.boss),
          batch.map((d) => d.playSeconds), batch.map((d) => d.sessions), batch.map((d) => new Date(d.seenAt || t)),
        ]);
      } catch (err) {
        log.error(`game stats: flush failed, keeping ${ids.length - i} character(s) for the next one: ${err && err.message}`);
        restore(ids.slice(i), taken.slice(i));
        return false;
      }
    }
    return true;
  }

  // Never rejects. One write at a time: a call during a write runs once after it,
  // and resolves with it, so a disconnect flush cannot overlap the timer's.
  function flush() {
    if (inflight) { again = true; return inflight; }
    inflight = (async () => {
      let ok = true;
      try {
        do {
          again = false;
          ok = await writeAll();
        } while (again && ok);
      } catch (err) {
        ok = false;
        log.error(`game stats: flush failed: ${err && err.message}`);
      } finally {
        inflight = null;
      }
      return ok;
    })();
    return inflight;
  }

  function start() {
    if (timer || stopped) return;
    timer = setInterval(() => { flush(); }, flushMs);
    if (timer.unref) timer.unref();
  }

  // After stop() a disconnect no longer flushes (the pool may be ending); the owner
  // calls flush() itself first when it wants the last deltas written.
  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  // A disconnect: flush unless the process is on its way out.
  function flushOnDisconnect() {
    return stopped ? Promise.resolve(false) : flush();
  }

  // Lifetime = what the table holds plus what has not been written yet.
  async function lifetime(characterIds) {
    const out = new Map(characterIds.map((id) => [id, emptyLifetime()]));
    if (characterIds.length === 0) return out;
    const t = now();
    for (const id of characterIds) {
      const s = sessions.get(id);
      if (s) accrue(s, t);
    }
    const r = await pool.query(
      `SELECT character_id, mob_kills, pvp_kills, deaths, boss_kills, play_seconds, sessions
         FROM player_game_stats WHERE character_id = ANY($1::int[])`,
      [characterIds],
    );
    for (const row of r.rows) {
      out.set(row.character_id, {
        mobKills: Number(row.mob_kills), pvpKills: Number(row.pvp_kills), deaths: Number(row.deaths),
        bossKills: Number(row.boss_kills), playSeconds: Number(row.play_seconds), sessions: Number(row.sessions),
      });
    }
    for (const id of characterIds) {
      const d = pending.get(id);
      const l = out.get(id);
      if (!d) continue;
      l.mobKills += d.mob; l.pvpKills += d.pvp; l.deaths += d.deaths; l.bossKills += d.boss;
      l.playSeconds += d.playSeconds; l.sessions += d.sessions;
    }
    return out;
  }

  return {
    join, leave, recordKill, recordDeath, flush, flushOnDisconnect, start, stop, lifetime,
    session: (characterId) => sessions.get(characterId) || null,
    totals: () => ({ ...totals }),
    pendingCount: () => pending.size,
  };
}

module.exports = { createGameStats, FLUSH_MS, RESUME_MS, BATCH_SIZE };
