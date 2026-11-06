// Boss AI controller (Diablo-style): an attack selector built as a small
// behaviour tree, a finite state machine for the fight's tempo, and HP-threshold
// phases. Pure -- no sockets, no DB, no clock of its own (the sim passes `now`),
// so every rule is testable without a world.
//
// WHERE IT PLUGS IN. CreatureSim.tick already owns movement, targeting, the
// telegraph -> wait -> resolve pipeline for skills, and the telegraph wire
// format the client draws as red ground indicators. This controller does not
// re-implement any of that. It decides WHAT the boss does and WHEN:
//
//   tick(c, ctx)         once per sim tick, before the boss acts. Runs the phase
//                        FSM. Returns true while the boss is mid-transition (the
//                        sim then keeps it still: it is invulnerable and busy).
//   pick(c, dist, now)   when the boss has a target. Returns a skill object in the
//                        exact shape the sim's own skills use (kind, range,
//                        radius, telegraphMs, cooldownMs, damageMult, slot), or
//                        null to fall through to the ordinary chase / melee.
//
// STATES (FSM)             IDLE -> ENGAGED <-> TRANSITION
//   IDLE        no fight yet; the first pick() or damage starts it.
//   ENGAGED     picking attacks. Between attacks there is a recovery gap, during
//               which pick() returns null and the boss chases/auto-attacks.
//   TRANSITION  a phase change: invulnerable, stationary, pending skill
//               cancelled; adds spawn and the arena changes. Ends on a timer.
//
// PHASE GATE. The boss's hp is floored at the next threshold (c._hpFloor, honoured
// by damage.js) until that transition has run, so a single burst can neither skip
// a phase nor kill the boss from above a threshold without it being seen.

const STATE = Object.freeze({ IDLE: 'idle', ENGAGED: 'engaged', TRANSITION: 'transition' });

// Telegraph floors. A late phase tightens wind-ups, but a player must always get
// enough time to read the ground and step out; an ultimate gets more.
const MIN_TELEGRAPH_MS = 800;
const MIN_ULTIMATE_TELEGRAPH_MS = 1500;
// Slots for the controller's skills. The sim keys _skillCd by slot; ordinary
// behaviour skills use small slot numbers, so stay well clear of them.
const SLOT_BASE = 100;
// Distance bands, in pixels centre-to-centre.
const CLOSE_RANGE = 170;
const MID_RANGE = 420;

// ---- behaviour tree --------------------------------------------------------
// A node is (ctx) => skill | null. `selector` returns the first child that
// yields something; `when` guards a node behind a condition (a sequence of
// condition-then-action). Deliberately tiny: the tree is the readable list of
// priorities, not a framework.
const selector = (...nodes) => (ctx) => {
  for (const n of nodes) {
    const r = n(ctx);
    if (r) return r;
  }
  return null;
};
const when = (cond, node) => (ctx) => (cond(ctx) ? node(ctx) : null);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---- profiles --------------------------------------------------------------
// Attack templates. `band` is where the attack makes sense: the selector offers
// 'close' attacks to a boss next to its target, 'far' ones (gap closers and
// ranged volleys) to a boss with distance to cover, 'mid' ones in between, and
// 'any' to every band. `minPhase` is the phase that adds it to the pool.
function attackPool(size = 96) {
  const k = size / 96; // bigger bosses reach further
  return [
    { id: 'flurry', kind: 'nova', band: 'close', range: CLOSE_RANGE * k, radius: 135 * k, telegraphMs: 800, cooldownMs: 4000, damageMult: 0.65, hits: 3, weight: 4, minPhase: 1 },
    { id: 'quake', kind: 'nova', band: 'close', range: CLOSE_RANGE * k, radius: 190 * k, telegraphMs: 1300, cooldownMs: 8000, damageMult: 1.5, hits: 1, weight: 2, minPhase: 1 },
    { id: 'slam', kind: 'slam', band: 'mid', range: MID_RANGE * k, radius: 150 * k, telegraphMs: 1200, cooldownMs: 6000, damageMult: 1.6, hits: 1, weight: 4, minPhase: 1 },
    { id: 'bolt', kind: 'projectile', band: 'far', range: 720, radius: 16, telegraphMs: 800, cooldownMs: 4500, damageMult: 0.9, hits: 1, weight: 3, minPhase: 1 },
    { id: 'charge', kind: 'charge', band: 'far', minRange: 260, range: 650, radius: 70 * k, dashDistance: 520, telegraphMs: 1100, cooldownMs: 9000, damageMult: 1.4, hits: 1, weight: 3, minPhase: 2 },
    { id: 'blink', kind: 'blink', band: 'far', minRange: 360, range: 760, radius: 150 * k, telegraphMs: 900, cooldownMs: 11000, damageMult: 1.0, hits: 1, weight: 2, minPhase: 2 },
    { id: 'rain', kind: 'rain', band: 'any', range: 640, radius: 115, zones: 5, spread: 380, telegraphMs: 1600, cooldownMs: 13000, damageMult: 1.0, hits: 1, weight: 3, minPhase: 3 },
    { id: 'cataclysm', kind: 'nova', band: 'any', ultimate: true, range: 900, radius: 430, telegraphMs: 2200, cooldownMs: 26000, damageMult: 3.0, hits: 1, weight: 1, minPhase: 3 },
  ];
}

// Phase table. index 0 is phase 1 (the fight's start, no transition). `at` is the
// hp ratio that triggers the phase. Scales are multipliers applied to the pool's
// cooldowns / telegraphs / damage for every attack in that phase.
function phaseTable(tier) {
  if (tier === 'dungeon_elite') {
    return [
      { at: 1, name: 'Guarded' },
      { at: 0.6, name: 'Awakened', invulnMs: 1800, adds: 1, cooldownScale: 0.85, telegraphScale: 0.95, damageMult: 1.0, announce: 'awakens' },
      { at: 0.3, name: 'Desperate', invulnMs: 2200, adds: 2, cooldownScale: 0.7, telegraphScale: 0.85, damageMult: 1.2, announce: 'enrages' },
    ];
  }
  return [
    { at: 1, name: 'Guarded' },
    { at: 0.75, name: 'Awakened', invulnMs: 2000, adds: 2, cooldownScale: 0.9, telegraphScale: 0.95, damageMult: 1.0, announce: 'awakens' },
    { at: 0.5, name: 'Unleashed', invulnMs: 2500, adds: 2, arena: 'hazards', cooldownScale: 0.8, telegraphScale: 0.9, damageMult: 1.1, announce: 'unleashes the arena' },
    { at: 0.25, name: 'Enraged', invulnMs: 2500, adds: 3, cooldownScale: 0.65, telegraphScale: 0.8, damageMult: 1.25, announce: 'is enraged' },
  ];
}

// A profile for a boss catalog row. Per-boss tuning can override any key via
// BOSS_OVERRIDES; absent that, tier + element + size give a sensible kit.
const BOSS_OVERRIDES = Object.freeze({});

function profileFor(row = {}) {
  const tier = row.boss_tier || 'dungeon_end';
  const size = Number(row.hitbox_size ?? row.size) || 96;
  let attacks = attackPool(size);
  // Elites are the lighter fight: no ultimate, no arena hazards.
  if (tier === 'dungeon_elite') attacks = attacks.filter((a) => !a.ultimate && a.id !== 'rain');
  const base = {
    tier, element: row.element || null, attacks, phases: phaseTable(tier),
    // Recovery between attacks, scaled by the phase's cooldownScale.
    gapMs: 1600,
  };
  return { ...base, ...(BOSS_OVERRIDES[row.name] || {}) };
}

// ---- controller ------------------------------------------------------------
class BossController {
  constructor(profile, { seed = 1 } = {}) {
    this.profile = profile;
    this.rng = mulberry32(typeof seed === 'number' ? seed : hashSeed(seed));
    this.state = STATE.IDLE;
    this.phase = 1;
    this.transitionEndsAt = 0;
    this.nextAttackAt = 0;
    this.lastAttackId = null;
    this.onEvent = null; // set by the owner: phase / adds / arena notifications
    // The pool with stable slots, so the sim's per-slot cooldowns line up.
    this.attacks = profile.attacks.map((a, i) => ({ ...a, slot: SLOT_BASE + i }));
    this._tree = this._buildTree();
  }

  get phaseDef() { return this.profile.phases[this.phase - 1] || this.profile.phases[0]; }
  get nextPhaseDef() { return this.profile.phases[this.phase] || null; }

  // Hp at which the NEXT phase triggers, or null when this is the last.
  _nextThresholdHp(c) {
    const n = this.nextPhaseDef;
    return n ? n.at * (c.maxHp || c.hp) : null;
  }

  _emit(evt) { if (this.onEvent) this.onEvent(evt); }

  // ---- FSM: phases ----
  // Called every sim tick before the boss acts. Returns true while the boss is
  // mid-transition (the sim holds it still).
  tick(c, { now }) {
    if (c._hpFloor === undefined) c._hpFloor = this._nextThresholdHp(c); // arm the first gate lazily
    if (this.state === STATE.TRANSITION) {
      if (now < this.transitionEndsAt) return true;
      this.state = STATE.ENGAGED;
      c._invulnerableUntil = 0;
      this._emit({ type: 'phase_end', phase: this.phase });
    }
    const next = this.nextPhaseDef;
    if (next && c.hp > 0 && c.hp <= next.at * (c.maxHp || c.hp) + 1e-6) {
      this._beginPhase(c, now, next);
      return true;
    }
    return false;
  }

  _beginPhase(c, now, def) {
    this.phase += 1;
    this.state = STATE.TRANSITION;
    const ms = def.invulnMs || 0;
    this.transitionEndsAt = now + ms;
    c._invulnerableUntil = now + ms;
    c._pendingSkill = null; // a wind-up in flight is cancelled, not resolved
    // The gate for the phase AFTER this one (null on the last).
    c._hpFloor = this._nextThresholdHp(c);
    // Recovery before the first attack of the new phase.
    this.nextAttackAt = this.transitionEndsAt + 900;
    this._emit({
      type: 'phase', phase: this.phase, name: def.name, invulnMs: ms,
      adds: def.adds || 0, arena: def.arena || null, announce: def.announce || null,
      x: c.x + (c.width || 0) / 2, y: c.y + (c.height || 0) / 2,
    });
  }

  // ---- attack selector ----
  _ready(c, a, dist, now) {
    if (a.minPhase > this.phase) return false;
    if ((c._skillCd && c._skillCd.get(a.slot)) > 0) return false;
    if (dist > a.range) return false;
    if (a.minRange != null && dist < a.minRange) return false;
    return true;
  }

  _bandOf(dist) {
    if (dist <= CLOSE_RANGE) return 'close';
    if (dist <= MID_RANGE) return 'mid';
    return 'far';
  }

  // Weighted choice among ready attacks of the wanted bands, never repeating the
  // previous attack while there is any alternative (that is what stops spam).
  _choose(ctx, bands, extra = () => true) {
    const pool = this.attacks.filter((a) => (bands.includes(a.band) || a.band === 'any')
      && !a.ultimate && this._ready(ctx.c, a, ctx.dist, ctx.now) && extra(a));
    if (pool.length === 0) return null;
    const fresh = pool.filter((a) => a.id !== this.lastAttackId);
    const from = fresh.length > 0 ? fresh : pool;
    const total = from.reduce((s, a) => s + a.weight, 0);
    let roll = this.rng() * total;
    for (const a of from) { roll -= a.weight; if (roll < 0) return a; }
    return from[from.length - 1];
  }

  _buildTree() {
    const asSkill = (pick) => (ctx) => { const a = pick(ctx); return a ? this._skill(a, ctx) : null; };
    // 1. The ultimate, whenever it is ready and unlocked: it owns the top of the
    //    tree so the fight's biggest moment is not crowded out by smaller picks.
    const ultimate = asSkill((ctx) => this.attacks.find((a) => a.ultimate && this._ready(ctx.c, a, ctx.dist, ctx.now)) || null);
    // 2. Target far away: close the gap (charge / blink) or shoot (bolt).
    const far = when((ctx) => ctx.band === 'far', asSkill((ctx) => this._choose(ctx, ['far'])));
    // 3. Target in the boss's face: a flurry or a quake around itself.
    const close = when((ctx) => ctx.band === 'close', asSkill((ctx) => this._choose(ctx, ['close'])));
    // 4. Mid range: a ground slam on the target, or a hazard rain.
    const mid = when((ctx) => ctx.band === 'mid', asSkill((ctx) => this._choose(ctx, ['mid'])));
    // 5. Anything else that fits where the target is.
    const any = asSkill((ctx) => this._choose(ctx, ['close', 'mid', 'far']));
    return selector(ultimate, far, close, mid, any);
  }

  // The skill object the sim understands, with this phase's scaling applied.
  _skill(a, ctx) {
    const ph = this.phaseDef;
    const cdScale = ph.cooldownScale || 1;
    const tgScale = ph.telegraphScale || 1;
    const floor = a.ultimate ? MIN_ULTIMATE_TELEGRAPH_MS : MIN_TELEGRAPH_MS;
    const skill = {
      id: `boss:${a.id}`, slot: a.slot, name: a.id, kind: a.kind,
      range: a.range, radius: a.radius,
      telegraphMs: Math.max(floor, Math.round(a.telegraphMs * tgScale)),
      cooldownMs: Math.round(a.cooldownMs * cdScale),
      damageMult: a.damageMult * (ph.damageMult || 1),
      hits: a.hits || 1,
      element: this.profile.element || null,
      vfx: {}, summonEntity: null, summonCount: 0,
      bossAttack: true, ultimate: !!a.ultimate,
    };
    if (a.dashDistance) skill.dashDistance = a.dashDistance;
    if (a.kind === 'rain') skill.zones = this._zones(a);
    return skill;
  }

  // Hazard positions relative to the target: the first on the target itself (a
  // player cannot just stand still), the rest scattered around.
  _zones(a) {
    const out = [{ dx: 0, dy: 0 }];
    for (let i = 1; i < a.zones; i += 1) {
      const ang = this.rng() * Math.PI * 2;
      const r = Math.sqrt(this.rng()) * a.spread;
      out.push({ dx: Math.cos(ang) * r, dy: Math.sin(ang) * r });
    }
    return out;
  }

  // The sim asks this when the boss has a target. `dist` is centre-to-centre.
  pick(c, dist, now) {
    if (this.state === STATE.TRANSITION) return null;
    if (this.state === STATE.IDLE) this.state = STATE.ENGAGED;
    if (now < this.nextAttackAt) return null; // recovery gap
    const ctx = { c, dist, now, band: this._bandOf(dist) };
    const skill = this._tree(ctx);
    if (!skill) return null;
    const a = this.attacks.find((x) => x.slot === skill.slot);
    this.lastAttackId = a.id;
    const cdScale = this.phaseDef.cooldownScale || 1;
    this.nextAttackAt = now + skill.telegraphMs + Math.round(this.profile.gapMs * cdScale);
    return skill;
  }

  snapshotFields() {
    return { bp: this.phase, inv: this.state === STATE.TRANSITION };
  }
}

function createBossController(row, opts = {}) {
  return new BossController(profileFor(row), { seed: opts.seed ?? hashSeed(row.name || 'boss'), ...opts });
}

module.exports = {
  BossController, createBossController, profileFor, attackPool, phaseTable,
  STATE, selector, when, MIN_TELEGRAPH_MS, MIN_ULTIMATE_TELEGRAPH_MS, CLOSE_RANGE, MID_RANGE, SLOT_BASE,
};
