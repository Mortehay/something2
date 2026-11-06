// Party system. Pure (no DB, no sockets, no world state): the server owns ONE
// PartyManager for all worlds, because a party outlives a map change.
//
// What lives here, and what deliberately does not:
//   * membership (invite / accept / leave / kick / transfer leadership);
//   * the friendly-fire rule -- canDamagePlayer, the ONE predicate every
//     player-vs-player damage site asks;
//   * the loot/XP policy as pure functions (who is eligible is decided by the
//     caller, which knows positions; this file only knows parties).
//
// WHY ONE PREDICATE. Player damage reaches a target from five places: the weapon
// swing, a direct projectile hit, a projectile blast, a skill, and reflected
// damage. A friendly-fire check copied into each drifts the moment one is edited;
// they all call canDamagePlayer instead, and party.test.js drives every one.

const MAX_PARTY_SIZE = 4;
const INVITE_TTL_MS = 60 * 1000;

const LOOT_MODES = Object.freeze({
  FREE_FOR_ALL: 'free_for_all', // anyone may take any drop (the pre-party behaviour)
  INDIVIDUAL: 'individual',     // each drop is reserved for ONE member, rotating
  LEADER: 'leader',             // every drop is reserved for the party leader
});
const LOOT_MODE_SET = new Set(Object.values(LOOT_MODES));

// How long a reserved drop stays reserved. After that it is free for everyone,
// so a leader who went AFK cannot lock loot away until it despawns.
const LOOT_RESERVE_MS = 30 * 1000;

// Members must be this close (pixels) to the kill to share its XP/loot. Stops
// "stand in town, get XP" without punishing a member a screen away.
const SHARE_RANGE = 1200;

// Group XP is a little MORE than a solo kill in total (so grouping is never a
// penalty) and split evenly: 2 players -> 55% each, 3 -> 43%, 4 -> 35%.
function xpShareFactor(n) {
  if (!(n > 1)) return 1;
  return (1 + 0.1 * (n - 1)) / n;
}

class PartyManager {
  constructor({
    maxSize = MAX_PARTY_SIZE, inviteTtlMs = INVITE_TTL_MS, now = Date.now,
    pvpEnabled = true, onChange = null,
  } = {}) {
    this.maxSize = maxSize;
    this.inviteTtlMs = inviteTtlMs;
    this.now = now;
    // PvP is on everywhere (product decision). The flag exists so a map or a
    // test can switch it off; it is NOT a per-player toggle.
    this.pvpEnabled = pvpEnabled;
    this.onChange = onChange;
    this.parties = new Map(); // partyId -> { id, leaderId, members: [], lootMode, lootCursor }
    this.byUser = new Map();  // userId -> partyId
    this.invites = new Map(); // inviteeId -> { from, expiresAt }
    this._seq = 0;
  }

  _emit(userIds, event) {
    if (this.onChange) this.onChange([...new Set(userIds)], event);
  }

  partyOf(userId) {
    const id = this.byUser.get(userId);
    return id == null ? null : this.parties.get(id) || null;
  }

  membersOf(userId) {
    const p = this.partyOf(userId);
    return p ? [...p.members] : [];
  }

  sameParty(a, b) {
    if (a == null || b == null) return false;
    const pa = this.byUser.get(a);
    return pa != null && pa === this.byUser.get(b);
  }

  // THE friendly-fire rule. A player may damage another player only if they are
  // different players, not in the same party, and PvP is on. Anything unknown
  // (null ids) is refused: an unattributed hit on a player is never allowed to
  // slip through as "no party, therefore fair game".
  canDamagePlayer(attackerId, targetId) {
    if (attackerId == null || targetId == null) return false;
    if (attackerId === targetId) return false;
    if (this.sameParty(attackerId, targetId)) return false;
    return this.pvpEnabled;
  }

  _pruneInvites() {
    const t = this.now();
    for (const [to, inv] of this.invites) if (inv.expiresAt <= t) this.invites.delete(to);
  }

  invite(fromId, toId) {
    this._pruneInvites();
    if (fromId === toId) return { ok: false, reason: 'self' };
    const mine = this.partyOf(fromId);
    if (mine && mine.leaderId !== fromId) return { ok: false, reason: 'not_leader' };
    if (mine && mine.members.length >= this.maxSize) return { ok: false, reason: 'party_full' };
    if (this.byUser.has(toId)) return { ok: false, reason: 'already_in_party' };
    const pending = this.invites.get(toId);
    if (pending && pending.from !== fromId) return { ok: false, reason: 'invite_pending' };
    this.invites.set(toId, { from: fromId, expiresAt: this.now() + this.inviteTtlMs });
    this._emit([fromId, toId], { kind: 'invited', from: fromId, to: toId });
    return { ok: true };
  }

  accept(userId) {
    this._pruneInvites();
    const inv = this.invites.get(userId);
    if (!inv) return { ok: false, reason: 'no_invite' };
    this.invites.delete(userId);
    if (this.byUser.has(userId)) return { ok: false, reason: 'already_in_party' };
    let party = this.partyOf(inv.from);
    if (party && party.leaderId !== inv.from) return { ok: false, reason: 'inviter_not_leader' };
    if (party && party.members.length >= this.maxSize) return { ok: false, reason: 'party_full' };
    if (!party) {
      // Created on first accept, not on invite, so a declined or expired invite
      // never leaves a one-person party behind.
      party = {
        id: `party-${++this._seq}`, leaderId: inv.from, members: [inv.from],
        lootMode: LOOT_MODES.FREE_FOR_ALL, lootCursor: 0,
      };
      this.parties.set(party.id, party);
      this.byUser.set(inv.from, party.id);
    }
    party.members.push(userId);
    this.byUser.set(userId, party.id);
    this._emit(party.members, { kind: 'joined', userId });
    return { ok: true };
  }

  decline(userId) {
    const inv = this.invites.get(userId);
    if (!inv) return { ok: false, reason: 'no_invite' };
    this.invites.delete(userId);
    this._emit([inv.from, userId], { kind: 'declined', userId });
    return { ok: true };
  }

  // Removes `userId` and repairs the party: the leader leaving hands leadership
  // to the longest-standing member; a party of one is disbanded.
  _remove(userId, kind) {
    const party = this.partyOf(userId);
    if (!party) return false;
    party.members = party.members.filter((m) => m !== userId);
    this.byUser.delete(userId);
    // A lone survivor is not a party. The `left` event goes to both, so the
    // survivor's client clears its frames in the same message.
    if (party.members.length <= 1) {
      const rest = party.members;
      for (const m of rest) this.byUser.delete(m);
      this.parties.delete(party.id);
      this._emit([userId, ...rest], { kind: 'disbanded', userId });
      return true;
    }
    if (party.leaderId === userId) party.leaderId = party.members[0];
    this._emit([userId, ...party.members], { kind, userId });
    return true;
  }

  leave(userId) {
    return this._remove(userId, 'left')
      ? { ok: true } : { ok: false, reason: 'not_in_party' };
  }

  kick(leaderId, targetId) {
    const party = this.partyOf(leaderId);
    if (!party) return { ok: false, reason: 'not_in_party' };
    if (party.leaderId !== leaderId) return { ok: false, reason: 'not_leader' };
    if (leaderId === targetId) return { ok: false, reason: 'self' };
    if (!party.members.includes(targetId)) return { ok: false, reason: 'not_member' };
    this._remove(targetId, 'kicked');
    return { ok: true };
  }

  transferLeader(leaderId, targetId) {
    const party = this.partyOf(leaderId);
    if (!party) return { ok: false, reason: 'not_in_party' };
    if (party.leaderId !== leaderId) return { ok: false, reason: 'not_leader' };
    if (leaderId === targetId || !party.members.includes(targetId)) {
      return { ok: false, reason: 'not_member' };
    }
    party.leaderId = targetId;
    this._emit(party.members, { kind: 'leader', userId: targetId });
    return { ok: true };
  }

  setLootMode(leaderId, mode) {
    const party = this.partyOf(leaderId);
    if (!party) return { ok: false, reason: 'not_in_party' };
    if (party.leaderId !== leaderId) return { ok: false, reason: 'not_leader' };
    if (!LOOT_MODE_SET.has(mode)) return { ok: false, reason: 'bad_mode' };
    party.lootMode = mode;
    party.lootCursor = 0;
    this._emit(party.members, { kind: 'lootMode', mode });
    return { ok: true };
  }

  // A disconnect is a leave. (A reconnect within a grace window could keep the
  // seat; not built -- a dropped player simply gets re-invited.)
  removePlayer(userId) {
    this.invites.delete(userId);
    for (const [to, inv] of this.invites) if (inv.from === userId) this.invites.delete(to);
    this._remove(userId, 'left');
  }

  // Who may pick up the NEXT drop of a kill made by `killerId`, as a userId, or
  // null for "everyone". `eligible` is the members the caller found alive and in
  // range; a reserved member who is not eligible falls back to free-for-all
  // rather than locking the item away.
  lootReservation(killerId, eligible) {
    const party = this.partyOf(killerId);
    if (!party || party.lootMode === LOOT_MODES.FREE_FOR_ALL) return null;
    const ok = eligible.filter((id) => party.members.includes(id));
    if (ok.length === 0) return null;
    if (party.lootMode === LOOT_MODES.LEADER) {
      return ok.includes(party.leaderId) ? party.leaderId : null;
    }
    // Individual: rotate through the eligible members so each gets a turn.
    const pick = ok[party.lootCursor % ok.length];
    party.lootCursor += 1;
    return pick;
  }

  // The view one member needs. Positions/vitals are filled by the server, which
  // owns the worlds; this is just the roster.
  rosterFor(userId) {
    const party = this.partyOf(userId);
    if (!party) return null;
    return {
      id: party.id, leaderId: party.leaderId, lootMode: party.lootMode,
      members: [...party.members], maxSize: this.maxSize,
    };
  }
}

module.exports = {
  PartyManager, MAX_PARTY_SIZE, LOOT_MODES, LOOT_RESERVE_MS, SHARE_RANGE, xpShareFactor,
};
