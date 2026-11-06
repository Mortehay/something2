// What a damaging skill does BESIDES its damage, applied by World.castSkill.
//
// The effects themselves are data (seeds/data/skillEffects.js -- stun, root, slow,
// bleed, dash, summon, ...). This module is the one place that turns them into
// state changes, so castSkill only has to say WHEN: `begin` before the geometry,
// `damageMult`/`pierce` while hitting, `onCreature`/`onPlayer` for each target that
// survives, `finish` once for the cast.
//
// Rules every effect follows:
//   * unknown kinds are ignored, never thrown on (a table edit must not crash a cast);
//   * everything is bounded (chain <= MAX_CHAIN, echoes per owner and per world,
//     zones through _spawnWave's per-owner cap);
//   * hard crowd control (stun, root, fear, silence) never lands on a boss
//     (effects.isCcImmune), and a rider on a PLAYER only lands because the caller
//     already passed canHurtPlayer + pvpBlocked (party-mates and villages are never
//     reached by any effect of this file).

const { effectsOf, DOT_SHARE } = require('../../seeds/data/skillEffects.js');
const E = require('./effects.js');
const { shoveCreature, effectiveMit } = require('./creatures.js');
const { shoveAwayFrom } = require('./knockback.js');
const { normalizeAim } = require('./weapons.js');
const { playerKey, applyDamageWithEffects } = require('./damage.js');
const skillBalance = require('./skillBalance.js');

const MAX_CHAIN = 6;
const CHAIN_RADIUS = 220;
const MAX_ECHOES_PER_OWNER = 6;
const MAX_ECHOES_TOTAL = 64;
const TAUNT_MIN_RADIUS = 160;
const SIZE = 64; // creature box, for centres (creatures.js CREATURE_SIZE)

const centre = (o) => ({ x: o.x + (o.width || SIZE) / 2, y: o.y + (o.height || SIZE) / 2 });
const isPlayer = (o) => o.userId !== undefined;

class CastFx {
  constructor(world, p, skill, ctx) {
    this.world = world;
    this.p = p;
    this.skill = skill;
    this.list = effectsOf(skill.id);
    this.ctx = ctx; // { damage, hits, element, userId, px, py, targetX, targetY, ax, ay, manaFractionBefore }
    this.now = world.now;
    this.playersHit = [];
    this.pierce = Math.min(1, this.list.filter((e) => e.k === 'pierce')
      .reduce((s, e) => s + (Number(e.pct) || 0) / 100, 0));
    // Does damage depend on WHO is hit (execute / conditional)? Then a plain arc
    // cannot be used for the melee path.
    this.perTarget = this.list.some((e) => e.k === 'execute' || e.k === 'cond');
    this.hasAny = this.list.length > 0;
  }

  has(kind) { return this.list.some((e) => e.k === kind); }
  get(kind) { return this.list.find((e) => e.k === kind) || null; }

  // ---- before the geometry ---------------------------------------------------
  // Dash is the caster's own movement. It replaces the old id-substring blink code:
  // the table is the one source for "this skill moves you".
  begin() {
    const dash = this.get('dash');
    if (dash) this._dash(dash);
    if (this.has('cleanse') && this.p.effects) this.p.effects.delete(E.CHILL);
  }

  _dash(e) {
    const { p, world } = this;
    const { nx, ny } = normalizeAim(this.ctx.ax, this.ctx.ay, p.facing);
    const dir = e.dir === 'back' ? -1 : 1;
    const map = world.map;
    for (const f of [1, 0.75, 0.5, 0.25]) {
      const x = Math.max(0, p.x + nx * e.px * dir * f);
      const y = Math.max(0, p.y + ny * e.px * dir * f);
      if (!map.isWalkable || map.isWalkable(x + p.width / 2, y + p.height / 2)) {
        p.x = x; p.y = y;
        return;
      }
    }
  }

  // ---- while hitting ----------------------------------------------------------
  // The multiplier on one blow against `target` (execute and conditional bonuses).
  damageMult(target) {
    if (!this.perTarget) return 1;
    const { p, ctx, now } = this;
    let m = 1;
    for (const e of this.list) {
      if (e.k === 'execute') {
        const max = target.maxHp || target.hp || 1;
        if ((target.hp / max) * 100 < e.below) m *= 1 + e.bonus / 100;
      } else if (e.k === 'cond') {
        const bonus = e.bonus / 100;
        if (e.when === 'far') {
          const c = centre(target);
          const reach = Number(this.skill.range) || 400;
          m *= 1 + bonus * Math.min(1, Math.hypot(c.x - ctx.px, c.y - ctx.py) / reach);
        } else if (e.when === 'self_low_hp') {
          m *= 1 + bonus * Math.max(0, 1 - p.hp / (p.maxHp || 100));
        } else if (e.when === 'full_mana') {
          if (ctx.manaFractionBefore >= 0.9) m *= 1 + bonus;
        } else if (e.when === 'bleeding') {
          if (E.hasEffect(target, E.BLEED, now)) m *= 1 + bonus;
        }
      }
    }
    return m;
  }

  // ---- on each target that survived the blow ---------------------------------------
  // `origin` is where knockback pushes from and pull drags toward: the blast centre
  // for an area at the aim point, the caster otherwise.
  onCreature(c, origin) { this._status(c, origin); }
  onPlayer(o, origin) { this.playersHit.push(o); this._status(o, origin); }

  _dot(target, key, seconds) {
    const per = DOT_SHARE * this.ctx.damage / Math.max(1, seconds);
    if (key === E.BURN && skillBalance.hasBuffFlag(target, 'curseImmune')) return;
    E.applyStrongest(target, key, {
      durationMs: seconds * 1000, magnitude: per, sourceId: this.ctx.userId, now: this.now,
    });
  }

  _status(t, origin) {
    const { now, ctx, world } = this;
    const player = isPlayer(t);
    for (const e of this.list) {
      switch (e.k) {
        case 'stun':
          if (e.chance && skillBalance.roll() * 100 >= e.chance) break;
          E.applyStun(t, e.s * 1000, now);
          break;
        case 'root': E.applyRoot(t, e.s * 1000, now, ctx.userId); break;
        case 'slow': E.applySlow(t, e.pct, e.s * 1000, now, ctx.userId); break;
        case 'silence': E.applySilence(t, e.s * 1000, now); break;
        case 'weaken':
          E.applyStrongest(t, E.WEAKEN, { durationMs: e.s * 1000, magnitude: e.pct / 100, sourceId: ctx.userId, now });
          break;
        case 'vuln':
          E.applyStrongest(t, E.MARKED, { durationMs: e.s * 1000, magnitude: e.pct / 100, sourceId: ctx.userId, now });
          break;
        case 'sunder':
          if (!player) E.applyStrongest(t, E.SUNDER, { durationMs: e.s * 1000, magnitude: e.pct / 100, sourceId: ctx.userId, now });
          break;
        case 'bleed': this._dot(t, E.BLEED, e.s); break;
        case 'poison': this._dot(t, E.POISON, e.s); break;
        case 'burn': this._dot(t, E.BURN, e.s); break;
        case 'shock': E.applyHitStatuses(t, ['shock'], now, ctx.userId); break;
        case 'fear': E.applyFear(t, e.s * 1000, now); break;
        case 'knockback':
          if (player) shoveAwayFrom(world.map, origin.x, origin.y, t, e.px);
          else shoveCreature(world.map, origin.x, origin.y, t, e.px);
          break;
        case 'pull': this._pull(t, origin, e.px); break;
        default: break; // damage-shaping and caster-side kinds are handled elsewhere
      }
    }
  }

  _pull(t, origin, px) {
    if (t.isDummy) return;
    const c = centre(t);
    const d = Math.hypot(origin.x - c.x, origin.y - c.y);
    if (d <= 10) return;
    const step = Math.min(px, d - 10);
    const x = t.x + ((origin.x - c.x) / d) * step;
    const y = t.y + ((origin.y - c.y) / d) * step;
    const map = this.world.map;
    if (!map.isWalkable || map.isWalkable(x + (t.width || SIZE) / 2, y + (t.height || SIZE) / 2)) {
      t.x = x; t.y = y;
      t.dirty = true;
    }
  }

  // ---- once per cast ------------------------------------------------------------------
  // `struck`: the creatures the cast reached ({id, x, y}); `kills` is appended to.
  // `shape` ({ x, y, radius }) is the area the cast covered, for zone and echo.
  finish({ struck, kills, shape, dealtTotal }) {
    const { world, p, ctx, now } = this;
    const hitSomething = struck.length > 0 || this.playersHit.length > 0;

    const chain = this.get('chain');
    if (chain) this._chain(Math.min(MAX_CHAIN, chain.n), struck, kills, shape);

    const taunt = this.get('taunt');
    if (taunt) this._taunt(taunt);

    const zone = this.get('zone');
    if (zone && shape) {
      world._spawnWave(p, shape.x, shape.y, 0, 1, shape.radius, Math.PI * 2, null, {
        damage: (ctx.damage * ctx.hits) / Math.max(1, zone.s), element: ctx.element, ms: zone.s * 1000,
      });
    }

    const echo = this.get('echo');
    if (echo && shape) this._echo(echo, shape);

    const life = this.get('lifesteal');
    if (life && hitSomething) {
      // The per-cast cap of leechHeal, widened with the skill's own share: a 100%
      // siphon must be able to heal more than a 10% one.
      const cap = Math.max(3, Math.round((p.maxHp || 100) * skillBalance.LEECH_CAP_FRACTION * (1 + life.pct / 25)));
      const heal = Math.min(cap, Math.max(1, Math.round(dealtTotal * life.pct / 100)));
      p.hp = Math.min(p.maxHp || 100, p.hp + heal);
    }
    const sh = this.get('selfheal');
    if (sh) p.hp = Math.min(p.maxHp || 100, p.hp + (p.maxHp || 100) * sh.pct / 100);
    const mana = this.get('mana');
    if (mana && hitSomething) p.mana = Math.min(p.maxMana || 100, (p.mana || 0) + (p.maxMana || 100) * mana.pct / 100);

    const summon = this.get('summon');
    if (summon) world._applySummon(p, summon, this.skill, { x: ctx.px, y: ctx.py, now });
  }

  _chain(n, struck, kills, shape) {
    const { world, ctx, now } = this;
    const seedPoint = struck.length > 0 ? struck[struck.length - 1] : { x: ctx.targetX, y: ctx.targetY };
    const seen = new Set(struck.map((s) => s.id));
    const near = world.creatures.all()
      .filter((c) => !seen.has(c.id) && !c.isDummy && c.hp > 0 && c.faction !== 'charmed')
      .map((c) => ({ c, d: Math.hypot(centre(c).x - seedPoint.x, centre(c).y - seedPoint.y) }))
      .filter((o) => o.d <= CHAIN_RADIUS)
      .sort((a, b) => a.d - b.d)
      .slice(0, n);
    for (const { c } of near) {
      const died = world.creatures.damageCreatureById(
        c.id, ctx.damage * this.damageMult(c), ctx.element, now, playerKey(ctx.userId),
        this.pierce ? { pierce: this.pierce } : null,
      );
      struck.push({ id: c.id, type: c.type, x: centre(c).x, y: centre(c).y });
      if (died) {
        if (!kills.some((k) => k.id === c.id)) kills.push({ id: c.id, killerUserId: ctx.userId });
      } else {
        this._status(c, { x: ctx.px, y: ctx.py });
      }
    }
  }

  _taunt(e) {
    const { world, p, ctx, now } = this;
    const r = Math.max(TAUNT_MIN_RADIUS, Number(this.skill.range) || 0);
    for (const c of world.creatures.all()) {
      if (c.faction === 'charmed' || E.isCcImmune(c) || c.isDummy) continue;
      const cc = centre(c);
      if (Math.hypot(cc.x - ctx.px, cc.y - ctx.py) > r) continue;
      c._tauntUntil = now + e.s * 1000;
      c._tauntedBy = p.userId;
    }
  }

  _echo(e, shape) {
    const { world, p, ctx, now } = this;
    if (!world.pendingEchoes) world.pendingEchoes = [];
    const mine = world.pendingEchoes.filter((x) => x.ownerId === p.userId);
    if (mine.length >= MAX_ECHOES_PER_OWNER) world.pendingEchoes.splice(world.pendingEchoes.indexOf(mine[0]), 1);
    if (world.pendingEchoes.length >= MAX_ECHOES_TOTAL) world.pendingEchoes.shift();
    world.pendingEchoes.push({
      at: now + e.s * 1000, ownerId: p.userId, x: shape.x, y: shape.y, radius: shape.radius,
      damage: ctx.damage * ctx.hits * e.pct / 100, element: ctx.element,
    });
  }
}

function begin(world, p, skill, ctx) {
  const fx = new CastFx(world, p, skill, ctx);
  fx.begin();
  return fx;
}

// Resolve the echoes that are due. Returns the creatures they killed.
function tickEchoes(world) {
  const list = world.pendingEchoes;
  if (!list || list.length === 0) return [];
  const kills = [];
  const keep = [];
  for (const ec of list) {
    if (world.now < ec.at) { keep.push(ec); continue; }
    const source = playerKey(ec.ownerId);
    for (const c of world.creatures.all()) {
      if (c.isDummy || c.faction === 'charmed') continue;
      const cc = centre(c);
      if (Math.hypot(cc.x - ec.x, cc.y - ec.y) > ec.radius) continue;
      if (world.creatures.damageCreatureById(c.id, ec.damage, ec.element, world.now, source)) {
        kills.push({ id: c.id, killerUserId: ec.ownerId });
      }
    }
    const owner = world.players.get(ec.ownerId);
    if (owner) {
      for (const o of world.players.values()) {
        if (o === owner || o.hp <= 0) continue;
        if (world.pvpBlocked(owner, o) || !world.canHurtPlayer(owner.userId, o.userId)) continue;
        const oc = centre(o);
        if (Math.hypot(oc.x - ec.x, oc.y - ec.y) > ec.radius) continue;
        applyDamageWithEffects(o, ec.damage, ec.element, effectiveMit(o), world.now, source);
      }
    }
  }
  world.pendingEchoes = keep;
  return kills;
}

module.exports = { begin, tickEchoes, CastFx, MAX_CHAIN, CHAIN_RADIUS, MAX_ECHOES_PER_OWNER, MAX_ECHOES_TOTAL };
