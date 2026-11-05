// The socket side of the party system: message handlers, the roster/vitals frame
// that drives the client's Party Frames and minimap markers, and the XP/loot
// policy glue. party.js is the pure rules; this file is the only place that
// knows about sockets and worlds.
//
// WIRE (client -> server)
//   partyInvite {targetId}   partyAccept   partyDecline   partyLeave
//   partyKick {targetId}     partyLeader {targetId}       partyLoot {mode}
// WIRE (server -> client)
//   party {party: null | {id, leaderId, lootMode, maxSize, members:[...]}}
//   partyInvite {fromId, fromName}
//   partyError {reason}
// A member row: {id, name, cls, hp, maxHp, mana, maxMana, x, y, w, buffs:[...]}.
// `w` is the member's world id: a client draws a marker on its minimap only for
// members in ITS world, but still shows the frame for one who is elsewhere.

const { PartyManager, SHARE_RANGE, LOOT_RESERVE_MS } = require('./party');

// Roster + vitals are re-sent this often (ticks). 5 ticks at 20 Hz = 4 Hz, which
// keeps a health bar smooth without a frame per tick per member.
const PARTY_FRAME_EVERY = 5;
const PARTY_BUFF_CAP = 12;

// A disconnected member keeps their seat this long, so a doorway transition or a
// dropped connection (the client reconnects) does not dissolve the group.
const DISCONNECT_GRACE_MS = 30 * 1000;

function createPartyService({ worlds, sessionsByUser, send, now = Date.now, setTimer = setTimeout }) {
  const graceTimers = new Map(); // userId -> timer

  // userIds arrive off the wire as JSON, so compare as strings but always hand
  // the manager the id the server itself uses (the ws.userId value).
  function resolve(candidates, raw) {
    if (raw == null) return null;
    const want = String(raw);
    for (const c of candidates) if (String(c) === want) return c;
    return null;
  }

  function locate(userId) {
    for (const entry of worlds.values()) {
      const p = entry.world.getPlayer(userId);
      if (p) return { entry, p };
    }
    return null;
  }

  function nameOf(userId) {
    const ws = sessionsByUser.get(userId);
    const loc = locate(userId);
    return (ws && ws.characterName) || (loc && loc.p.className) || 'Player';
  }

  function memberRow(userId) {
    const loc = locate(userId);
    const row = { id: userId, name: nameOf(userId), cls: (loc && loc.p.className) || null, online: !!loc };
    if (!loc) return row; // offline within the grace window: name only
    const { entry, p } = loc;
    row.hp = p.hp; row.maxHp = p.maxHp; row.mana = p.mana; row.maxMana = p.maxMana;
    row.x = p.x + p.width / 2; row.y = p.y + p.height / 2;
    row.w = entry.worldId;
    row.buffs = [];
    if (p.buffs && p.buffs.size) {
      for (const b of p.buffs.values()) {
        if (row.buffs.length >= PARTY_BUFF_CAP) break;
        row.buffs.push({
          id: b.id, icon: b.icon, color: b.iconColor,
          ms: Math.max(0, Math.round(b.expiresAt - entry.world.now)),
        });
      }
    }
    return row;
  }

  function viewFor(userId) {
    const roster = parties.rosterFor(userId);
    if (!roster) return null;
    return { ...roster, members: roster.members.map(memberRow) };
  }

  function pushView(userId) {
    const ws = sessionsByUser.get(userId);
    if (ws) send(ws, { type: 'party', party: viewFor(userId) });
  }

  const parties = new PartyManager({
    now,
    onChange: (userIds, ev) => {
      for (const u of userIds) pushView(u);
      if (ev.kind === 'invited') {
        const ws = sessionsByUser.get(ev.to);
        if (ws) send(ws, { type: 'partyInvite', fromId: ev.from, fromName: nameOf(ev.from) });
      }
    },
  });

  function fail(ws, reason) { send(ws, { type: 'partyError', reason }); }
  function report(ws, r) { if (!r.ok) fail(ws, r.reason); return r.ok; }

  const handlers = {
    partyInvite(ws, msg) {
      const here = worlds.get(ws.worldId);
      if (!here) return;
      // Only someone standing in the same world can be invited: you invite who
      // you can see, and it keeps ids from being probed across the server.
      const target = resolve([...here.world.players.keys()], msg.targetId);
      if (target == null || !sessionsByUser.has(target)) return fail(ws, 'not_found');
      report(ws, parties.invite(ws.userId, target));
    },
    partyAccept(ws) { report(ws, parties.accept(ws.userId)); },
    partyDecline(ws) { report(ws, parties.decline(ws.userId)); },
    partyLeave(ws) { report(ws, parties.leave(ws.userId)); },
    partyKick(ws, msg) {
      const target = resolve(parties.membersOf(ws.userId), msg.targetId);
      if (target == null) return fail(ws, 'not_member');
      report(ws, parties.kick(ws.userId, target));
    },
    partyLeader(ws, msg) {
      const target = resolve(parties.membersOf(ws.userId), msg.targetId);
      if (target == null) return fail(ws, 'not_member');
      report(ws, parties.transferLeader(ws.userId, target));
    },
    partyLoot(ws, msg) { report(ws, parties.setLootMode(ws.userId, msg.mode)); },
  };

  // Called from the tick loop. Cheap when nobody is partied.
  function tick(tickNo) {
    if (parties.parties.size === 0 || tickNo % PARTY_FRAME_EVERY !== 0) return;
    for (const party of parties.parties.values()) {
      const members = party.members.map(memberRow);
      const frame = {
        type: 'party',
        party: {
          id: party.id, leaderId: party.leaderId, lootMode: party.lootMode,
          maxSize: parties.maxSize, members,
        },
      };
      for (const m of party.members) {
        const ws = sessionsByUser.get(m);
        if (ws) send(ws, frame);
      }
    }
  }

  // Socket closed. The seat is held for a grace period; a reconnect (a doorway
  // transition reopens the socket) cancels the removal.
  function onDisconnect(userId) {
    if (!parties.partyOf(userId) && !parties.invites.has(userId)) return;
    const prev = graceTimers.get(userId);
    if (prev) clearTimeout(prev);
    const timer = setTimer(() => {
      graceTimers.delete(userId);
      if (!sessionsByUser.has(userId)) parties.removePlayer(userId);
    }, DISCONNECT_GRACE_MS);
    if (timer && timer.unref) timer.unref();
    graceTimers.set(userId, timer);
  }

  function onConnect(userId) {
    const t = graceTimers.get(userId);
    if (t) { clearTimeout(t); graceTimers.delete(userId); }
    pushView(userId); // a reconnecting member gets their frames back at once
  }

  // Members who share a kill at (x, y) in `entry`: same world, alive, in range.
  // Includes the killer. Returns [] when the killer is not in a party, so the
  // caller's solo path is untouched.
  function sharers(entry, killerId, x, y) {
    const members = parties.membersOf(killerId);
    if (members.length < 2) return [];
    const out = [];
    for (const id of members) {
      const p = entry.world.getPlayer(id);
      if (!p || p.hp <= 0) continue;
      if (id !== killerId && Math.hypot(p.x - x, p.y - y) > SHARE_RANGE) continue;
      out.push(id);
    }
    return out.length > 1 ? out : [];
  }

  // The per-drop reservation callback for one kill. null when the killer's party
  // is free-for-all (or there is none): drops stay open to everyone.
  function lootReserver(killerId, eligible) {
    const party = parties.partyOf(killerId);
    if (!party || party.lootMode === 'free_for_all') return null;
    return () => {
      const who = parties.lootReservation(killerId, eligible);
      return who == null ? null : { userId: who, until: now() + LOOT_RESERVE_MS };
    };
  }

  return { parties, handlers, tick, onDisconnect, onConnect, sharers, lootReserver, viewFor };
}

module.exports = { createPartyService, PARTY_FRAME_EVERY, DISCONNECT_GRACE_MS };
