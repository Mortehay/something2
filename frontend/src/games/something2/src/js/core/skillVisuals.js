// frontend/src/games/something2/src/js/core/skillVisuals.js
// Specialized visual effects and projectile animations for active combat skills.
// Provides distinct rendering for Fireball, Lightning, Frost, Holy, Shadow, and Melee skills.

import { elementColor } from './blasts.js';

export const SKILL_VISUAL_MAX_LIFETIME = 1500;

/**
 * Generates jagged branching segments for a realistic lightning strike.
 */
export function generateLightningBranches(fromX, fromY, toX, toY, branchDepth = 1) {
  const segments = [];
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(4, Math.floor(dist / 22));

  let prevX = fromX;
  let prevY = fromY;

  // Perpendicular vector for jagged offset
  const nx = -dy / (dist || 1);
  const ny = dx / (dist || 1);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const isEnd = i === steps;
    const perpOffset = isEnd ? 0 : (Math.sin(i * 997.13 + t * 47) * 0.5 + (i % 2 === 0 ? 1 : -1) * 0.5) * Math.min(24, dist * 0.25);
    const currX = isEnd ? toX : (fromX + dx * t + nx * perpOffset);
    const currY = isEnd ? toY : (fromY + dy * t + ny * perpOffset);

    segments.push({ x1: prevX, y1: prevY, x2: currX, y2: currY, main: true });

    // Occasional smaller side fork/branch
    if (branchDepth > 0 && i % 2 === 1 && i < steps - 1) {
      const forkAngle = (Math.PI / 4) * (i % 4 === 1 ? 1 : -1);
      const forkLen = 18 + (i * 7) % 15;
      const fCos = Math.cos(forkAngle);
      const fSin = Math.sin(forkAngle);
      const forkDx = (dx / dist) * fCos - (dy / dist) * fSin;
      const forkDy = (dx / dist) * fSin + (dy / dist) * fCos;
      segments.push({
        x1: currX,
        y1: currY,
        x2: currX + forkDx * forkLen,
        y2: currY + forkDy * forkLen,
        main: false,
      });
    }

    prevX = currX;
    prevY = currY;
  }

  return segments;
}

export function resolveProjectileType(skill) {
  if (!skill) return 'arcane_missile';
  const id = (skill.id || '').toLowerCase();
  const nameEn = (skill.nameEn || '').toLowerCase();
  const elem = (skill.element || '').toLowerCase();

  // 1. Arrows (Archer bow skills)
  if (skill.class === 'Archer' || skill.class === 'Ranger' || id.startsWith('arc_') || id.startsWith('ran_') || id.includes('arrow') || id.includes('shot') || id.includes('snipe') || id.includes('barrage') || nameEn.includes('arrow') || nameEn.includes('shot')) {
    return 'arrow';
  }

  // 2. Fireball — STRICTLY ONLY mag_fireball keeps this sphere model!
  if (id === 'mag_fireball') {
    return 'fireball';
  }

  // 3. Ice Shards / Icicles / Frostbolt
  if (id.includes('frostbolt') || id.includes('ice_shard') || id.includes('icicle') || id.includes('frost_bolt') || id.includes('glacial_spike') || id.includes('chill') || nameEn.includes('frost') || nameEn.includes('ice')) {
    return 'ice_shard';
  }

  // 4. Arcane Missiles / Darts / Runes
  if (id.includes('magic_missiles') || id.includes('arcane_bolt') || id.includes('spark') || id.includes('mana_burn') || id.includes('mana_tap') || nameEn.includes('arcane') || nameEn.includes('missile')) {
    return 'arcane_missile';
  }

  // 5. Prismatic Crystal
  if (id.includes('prismatic') || id.includes('rainbow') || nameEn.includes('prismatic')) {
    return 'prismatic_crystal';
  }

  // 6. Polymorph Magic Star
  if (id.includes('polymorph') || id.includes('sheep') || id.includes('hex')) {
    return 'polymorph_star';
  }

  // 7. Lightning Orbs / Ball Lightning / Static
  if (id.includes('ball_lightning') || id.includes('static') || id.includes('plasma') || id.includes('discharge') || elem === 'lightning') {
    return 'lightning_orb';
  }

  // 8. Daggers / Throwing Knives
  if (id.includes('knife') || id.includes('dagger') || id.includes('fan_of_knives') || nameEn.includes('knife') || nameEn.includes('dagger')) {
    return 'dagger';
  }
  // 9. Ninja Shuriken / Kunai
  if (id.includes('shuriken') || id.includes('star') || id.includes('kunai') || nameEn.includes('shuriken') || nameEn.includes('kunai')) {
    return 'shuriken';
  }
  // 10. Poison Darts / Needles
  if (id.includes('poison') || id.includes('toxic') || id.includes('dart') || id.includes('venom') || id.includes('needle')) {
    return 'poison_dart';
  }
  // 11. Throwing Axes / Hatchets
  if (id.includes('axe') || nameEn.includes('axe') || id.includes('hatchet')) {
    return 'axe';
  }
  // 12. Shields
  if (id.includes('shield') && (id.includes('throw') || id.includes('avenger') || id.includes('toss') || id.includes('slam'))) {
    return 'shield';
  }
  // 13. Boulders / Rocks
  if (id.includes('boulder') || id.includes('rock') || id.includes('earth_spike') || id.includes('stone') || nameEn.includes('boulder') || nameEn.includes('rock')) {
    return 'boulder';
  }
  // 14. Shadow Skulls / Death Coils
  if (id.includes('skull') || id.includes('death_coil') || id.includes('shadow_bolt') || id.includes('soul') || id.includes('shadow_orb') || nameEn.includes('skull') || nameEn.includes('shadow bolt') || nameEn.includes('death coil')) {
    return 'skull';
  }
  // 15. Holy Hammers
  if (id.includes('hammer') || nameEn.includes('hammer')) {
    return 'holy_hammer';
  }
  // 16. Holy Cross / Relic
  if (id.includes('cross') || id.includes('crucifix') || id.includes('sanctuary') || nameEn.includes('cross')) {
    return 'holy_cross';
  }
  // 17. Scythe Blades / Void Crescents
  if (id.includes('scythe') || id.includes('reaper') || id.includes('crescent') || nameEn.includes('crescent') || nameEn.includes('scythe')) {
    return 'scythe_blade';
  }
  // 18. Blood Orbs / Crimson Drops
  if (id.includes('blood') || id.includes('siphon') || id.includes('crimson') || nameEn.includes('blood')) {
    return 'blood_orb';
  }
  // 19. Tornadoes / Whirlwinds
  if (id.includes('tornado') || id.includes('cyclone') || id.includes('gust') || nameEn.includes('tornado') || nameEn.includes('cyclone')) {
    return 'tornado_vortex';
  }
  // 20. Throwing Spears / Javelins
  if (id.includes('spear') || id.includes('javelin') || id.includes('lance') || nameEn.includes('spear') || nameEn.includes('javelin')) {
    return 'spear';
  }
  // 21. Caltrops / Spikes
  if (id.includes('caltrop') || id.includes('trap') || nameEn.includes('caltrop')) {
    return 'caltrop';
  }
  // 22. Bombs / Grenades
  if (id.includes('bomb') || id.includes('grenade') || id.includes('explosive') || nameEn.includes('bomb')) {
    return 'bomb';
  }
  // 23. Nature Seeds / Thorns / Spores
  if (id.includes('seed') || id.includes('spore') || id.includes('thorn') || id.includes('vine') || id.includes('entangling') || nameEn.includes('thorn') || nameEn.includes('seed')) {
    return 'nature_seed';
  }
  // 24. Meteors / Comets
  if (id.includes('meteor') || id.includes('comet') || nameEn.includes('meteor')) {
    return 'meteor';
  }

  // Fallback defaults to arcane diamond crystal rather than generic red sphere
  return 'arcane_missile';
}

export function resolveSlashStyle(skill) {
  if (!skill) return 'greatsword_cleave';
  const id = (skill.id || '').toLowerCase();
  const nameEn = (skill.nameEn || '').toLowerCase();

  // Beast Claws (Druid Bear / Wolf / Hawk)
  if (id.includes('claw') || id.includes('maul') || id.includes('shred') || id.includes('bite') || id.includes('rend') || id.includes('talon') || id.includes('swipe')) {
    return 'beast_claw';
  }
  // Ground Fissure / Earthquakes
  if (id.includes('fissure') || id.includes('ground_breaker') || id.includes('earthquake') || id.includes('rupture') || id.includes('shockwave')) {
    return 'ground_fissure';
  }
  // Heavy Overhead Hammer Crush
  if (id.includes('crush') || id.includes('slam') || id.includes('smash') || id.includes('hammer') || id.includes('stomp')) {
    return 'crush_hammer';
  }
  // Piercing Spear Thrust
  if (id.includes('thrust') || id.includes('pierce') || id.includes('lunge') || id.includes('stab') || id.includes('impale')) {
    return 'thrust_spear';
  }
  // Dual Dagger Scissor Slash
  if (id.includes('twin') || id.includes('flurry') || id.includes('dual') || id.includes('slice')) {
    return 'dual_daggers';
  }
  // Shield Bash
  if (id.includes('shield') || id.includes('bash') || id.includes('block') || id.includes('deflect')) {
    return 'shield_bash';
  }
  // Whirlwind / 360 Spin
  if (id.includes('whirlwind') || id.includes('cyclone') || id.includes('spin') || id.includes('blade_storm')) {
    return 'whirlwind_ring';
  }
  // Shadow / Stealth Ambush Strike
  if (id.includes('shadow') || id.includes('backstab') || id.includes('assassin') || id.includes('ambush')) {
    return 'shadow_strike';
  }
  // Holy Smite / Divine Radiant Blade
  if (id.includes('smite') || id.includes('divine') || id.includes('radiant') || id.includes('judgment')) {
    return 'holy_smite';
  }

  return 'greatsword_cleave';
}

/**
 * Creates an animated visual effect matching the skill's identity and element.
 */
export function createSkillVisual(skill, fromX, fromY, toX, toY, aimAngle, nowMs) {
  if (!skill) return null;

  const id = skill.id || '';
  const nameEn = (skill.nameEn || '').toLowerCase();
  const elem = skill.element || (skill.class === 'Mage' ? 'fire' : (skill.class === 'Druid' ? 'lightning' : (skill.class === 'Cultist' ? 'shadow' : 'physical')));
  const projType = resolveProjectileType(skill);
  const slashStyle = resolveSlashStyle(skill);

  // 1. Mirror Images (Mage illusion clones)
  if (id.includes('mirror_image') || id.includes('clone')) {
    return {
      kind: 'mirror_images',
      id: `${id}_${Math.random()}`,
      x: fromX,
      y: fromY,
      color: '#a855f7',
      startedAt: nowMs,
      durationMs: 4000,
    };
  }

  // 2. Temporal Warp (Chrono clock burst)
  if (id.includes('temporal_warp') || id.includes('time_warp')) {
    return {
      kind: 'temporal_warp',
      id: `${id}_${Math.random()}`,
      x: fromX,
      y: fromY,
      color: '#6366f1',
      startedAt: nowMs,
      durationMs: 900,
    };
  }

  // 3. Gravity Singularity / Black Hole
  if (id.includes('gravity') || id.includes('singularity') || id.includes('black_hole')) {
    return {
      kind: 'shadow_vortex',
      id: `${id}_${Math.random()}`,
      x: toX,
      y: toY,
      radius: 110,
      color: '#6b21a8',
      startedAt: nowMs,
      durationMs: 1200,
    };
  }

  // 4. Frost Nova (Instant freezing ring around the CASTER)
  if (id === 'mag_frost_nova' || id.includes('frost_nova') || id.includes('ice_nova')) {
    return {
      kind: 'frost_nova',
      id: `${id}_${Math.random()}`,
      x: fromX,
      y: fromY,
      radius: 125,
      element: 'ice',
      color: '#67e8f9',
      startedAt: nowMs,
      durationMs: 450,
    };
  }

  // 5. Meteor Shower / Deep Comet (4 massive meteors falling sequentially from sky)
  if (id.includes('meteor_shower') || id.includes('deep_comet')) {
    const meteorCount = 4;
    const radius = 95;
    const projectiles = [];
    for (let i = 0; i < meteorCount; i++) {
      const a = (i * Math.PI * 2) / meteorCount + (Math.random() - 0.5) * 0.4;
      const r = Math.random() * radius;
      const gx = toX + Math.cos(a) * r;
      const gy = toY + Math.sin(a) * r;
      const skyX = gx - 45;
      const skyY = gy - 320;
      const fallDist = Math.hypot(gx - skyX, gy - skyY);
      const speed = 880;
      const flightTime = (fallDist / speed) * 1000;
      const staggerMs = i * 180; // 4 falling meteors over 720ms

      projectiles.push({
        kind: 'projectile',
        projectileType: id.includes('deep_comet') ? 'ice_shard' : 'meteor',
        isSkyRain: true,
        id: `${id}_meteor_${i}_${Math.random()}`,
        fromX: skyX,
        fromY: skyY,
        toX: gx,
        toY: gy,
        x: skyX,
        y: skyY,
        aimAngle: Math.atan2(gy - skyY, gx - skyX),
        speed,
        flightTime,
        element: id.includes('deep_comet') ? 'ice' : 'fire',
        color: id.includes('deep_comet') ? '#38bdf8' : '#ea580c',
        radius: 22,
        startedAt: nowMs + staggerMs,
        durationMs: flightTime + staggerMs + 260,
        exploded: false,
        trail: [],
      });
    }
    return projectiles;
  }

  // 6. Disintegrate / Arcane Laser Beams
  if (id.includes('beam') || id.includes('disintegrate') || id.includes('laser')) {
    return {
      kind: 'arcane_beam',
      id: `${id}_${Math.random()}`,
      fromX,
      fromY,
      toX,
      toY,
      color: id.includes('disintegrate') ? '#ef4444' : '#a855f7',
      startedAt: nowMs,
      durationMs: 650,
    };
  }

  // 7. Wall of Fire
  if (id.includes('wall_of_fire') || id.includes('fire_wall')) {
    return {
      kind: 'fire_wall',
      id: `${id}_${Math.random()}`,
      fromX,
      fromY,
      toX,
      toY,
      color: '#f97316',
      startedAt: nowMs,
      durationMs: 650,
    };
  }

  // 8. Blast Wave
  if (id.includes('blast_wave') || id.includes('combustion')) {
    return {
      kind: 'blast_wave',
      id: `${id}_${Math.random()}`,
      x: fromX,
      y: fromY,
      radius: 120,
      color: '#ea580c',
      startedAt: nowMs,
      durationMs: 340,
    };
  }

  // 9. Blizzard sky bombardment
  if (id.includes('blizzard') || id.includes('ice_storm')) {
    const icicleCount = 12;
    const radius = 85;
    const projectiles = [];
    for (let i = 0; i < icicleCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const gx = toX + Math.cos(a) * r;
      const gy = toY + Math.sin(a) * r;
      const skyX = gx - 35;
      const skyY = gy - 280;
      const fallDist = Math.hypot(gx - skyX, gy - skyY);
      const speed = 920;
      const flightTime = (fallDist / speed) * 1000;
      const staggerMs = i * 40;

      projectiles.push({
        kind: 'projectile',
        projectileType: 'ice_shard',
        isSkyRain: true,
        id: `${id}_icicle_${i}_${Math.random()}`,
        fromX: skyX,
        fromY: skyY,
        toX: gx,
        toY: gy,
        x: skyX,
        y: skyY,
        aimAngle: Math.atan2(gy - skyY, gx - skyX),
        speed,
        flightTime,
        element: 'ice',
        color: '#38bdf8',
        startedAt: nowMs + staggerMs,
        durationMs: flightTime + staggerMs + 200,
        exploded: false,
        trail: [],
      });
    }
    return projectiles;
  }

  // 10. Ball Lightning (Slow-moving electrical plasma orb, not an instant branch)
  if (id.includes('ball_lightning')) {
    const dist = Math.hypot(toX - fromX, toY - fromY);
    const speed = 320; // slow moving orb
    const flightTime = Math.max(150, (dist / speed) * 1000);
    return {
      kind: 'projectile',
      projectileType: 'lightning_orb',
      id: `${id}_${Math.random()}`,
      fromX,
      fromY,
      toX,
      toY,
      x: fromX,
      y: fromY,
      aimAngle,
      speed,
      flightTime,
      element: 'lightning',
      color: '#38bdf8',
      radius: 16,
      startedAt: nowMs,
      durationMs: flightTime + 250,
      exploded: false,
      trail: [],
    };
  }

  // 11. Lightning Spells (Lightning Strike, Chain Lightning, Thunder Strike, Smite)
  if (elem === 'lightning' || id.includes('lightning') || id.includes('thunder') || nameEn.includes('lightning') || nameEn.includes('thunder') || id.includes('smite')) {
    // Top-down celestial strike or direct caster arc
    const isSkyStrike = id.includes('strike') || id.includes('smite') || id.includes('storm');
    const startX = isSkyStrike ? toX + 20 : fromX;
    const startY = isSkyStrike ? toY - 240 : fromY;
    const branches = generateLightningBranches(startX, startY, toX, toY, 2);

    return {
      kind: 'lightning',
      id: `${id}_${Math.random()}`,
      fromX: startX,
      fromY: startY,
      toX,
      toY,
      branches,
      color: '#38bdf8',
      element: 'lightning',
      startedAt: nowMs,
      durationMs: 280,
    };
  }

  // 2. Flying Projectiles (Arrows, Daggers, Ice Shards, Boulders, Skulls, Arcane Missiles, Holy Hammers, Fireballs, Spears, Shurikens, Bombs)
  const isArcher = projType === 'arrow';
  const isFireball = projType === 'fireball';
  const isProjectileSpell = projType !== 'orb' || skill.type === 'magic' || id.includes('bolt') || id.includes('spear') || id.includes('dart') || id.includes('orb');

  if (isProjectileSpell && skill.type !== 'buff') {
    const dist = Math.hypot(toX - fromX, toY - fromY);
    const speed = isArcher ? 850 : (projType === 'dagger' || projType === 'shuriken' ? 820 : (projType === 'boulder' ? 520 : 680));

    // Special: Rain of Arrows / Rain of Fire falling steeply from the sky above
    const isRainOfArrows = id.includes('rain_of_arrows') || id.includes('rain_') || nameEn.includes('rain of arrows') || nameEn.includes('rain of fire');
    if (isRainOfArrows) {
      const arrowCount = 14;
      const radius = 75;
      const skyHeight = 320;
      const projectiles = [];

      for (let i = 0; i < arrowCount; i++) {
        // Distribute within circular target area on ground
        const angle = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * radius;
        const groundX = toX + Math.cos(angle) * r;
        const groundY = toY + Math.sin(angle) * r;

        // Falling steep trajectory from sky above
        const skyX = groundX - 60 + (Math.random() - 0.5) * 20;
        const skyY = groundY - skyHeight + (Math.random() - 0.5) * 30;
        const fallDist = Math.hypot(groundX - skyX, groundY - skyY);
        const staggerMs = i * 45; // Staggered rain over 600ms
        const fallSpeed = 920;
        const flightTime = Math.max(120, (fallDist / fallSpeed) * 1000);

        projectiles.push({
          kind: 'projectile',
          projectileType: 'arrow',
          isSkyRain: true,
          id: `${id}_rain_${i}_${Math.random()}`,
          fromX: skyX,
          fromY: skyY,
          toX: groundX,
          toY: groundY,
          x: skyX,
          y: skyY,
          aimAngle: Math.atan2(groundY - skyY, groundX - skyX),
          speed: fallSpeed,
          flightTime,
          element: elem,
          color: elementColor(elem) || '#16a34a',
          radius: 10,
          startedAt: nowMs + staggerMs,
          durationMs: flightTime + staggerMs + 250,
          exploded: false,
          trail: [],
        });
      }
      return projectiles;
    }

    // Multi-projectile skills (Barrage, Fan of Knives, Magic Missiles, Multishot)
    let count = 1;
    let isRadial = false;
    let spreadAngle = 0.5;

    if (id.includes('barrage')) {
      count = 12; // 12 arrows as in description
      spreadAngle = 0.65;
    } else if (id.includes('fan_of_knives')) {
      count = 8;
      isRadial = true;
    } else if (id.includes('magic_missiles')) {
      count = 5;
      spreadAngle = 0.6;
    } else if (id.includes('multishot') || id.includes('triple') || id.includes('split_shot')) {
      count = 3;
      spreadAngle = 0.35;
    }

    if (count > 1) {
      const projectiles = [];
      for (let i = 0; i < count; i++) {
        const frac = count > 1 ? (i / (count - 1) - 0.5) : 0;
        const curAngle = isRadial ? (aimAngle + (Math.PI * 2 * i) / count) : (aimAngle + frac * spreadAngle + (Math.random() - 0.5) * 0.08);
        const curDist = dist * (0.85 + Math.random() * 0.25);
        const curToX = fromX + Math.cos(curAngle) * curDist;
        const curToY = fromY + Math.sin(curAngle) * curDist;
        const staggerMs = isRadial ? 0 : (i * 24);
        const flightTime = Math.max(80, Math.min(800, (curDist / speed) * 1000));

        projectiles.push({
          kind: 'projectile',
          projectileType: projType,
          id: `${id}_${i}_${Math.random()}`,
          fromX,
          fromY,
          toX: curToX,
          toY: curToY,
          x: fromX,
          y: fromY,
          aimAngle: curAngle,
          speed,
          flightTime,
          element: elem,
          color: elementColor(elem) || (isArcher ? '#22c55e' : (isFireball ? '#f97316' : '#60a5fa')),
          radius: isFireball ? 16 : 10,
          startedAt: nowMs + staggerMs,
          durationMs: flightTime + staggerMs + 220,
          exploded: false,
          trail: [],
        });
      }
      return projectiles;
    }

    const flightTime = Math.max(80, Math.min(800, (dist / speed) * 1000));

    return {
      kind: 'projectile',
      projectileType: projType,
      id: `${id}_${Math.random()}`,
      fromX,
      fromY,
      toX,
      toY,
      x: fromX,
      y: fromY,
      aimAngle,
      speed,
      flightTime,
      element: elem,
      color: elementColor(elem) || (isArcher ? '#22c55e' : (isFireball ? '#f97316' : '#60a5fa')),
      radius: isFireball ? 16 : 10,
      startedAt: nowMs,
      durationMs: flightTime + 220,
      exploded: false,
      trail: [],
    };
  }

  // 3. Frost / Ice Spells (Frost Nova, Blizzard, Ice Storm)
  if (elem === 'ice' || id.includes('frost') || id.includes('blizzard') || nameEn.includes('frost')) {
    return {
      kind: 'frost_nova',
      id: `${id}_${Math.random()}`,
      x: toX,
      y: toY,
      radius: (Number(skill.range) || 120) * 0.7,
      element: 'ice',
      color: '#67e8f9',
      startedAt: nowMs,
      durationMs: 420,
    };
  }

  // 4. Holy / Divine / Buff Spells
  if (skill.type === 'buff' || elem === 'holy' || id.includes('holy') || id.includes('heal') || id.includes('aura') || id.includes('blessing')) {
    return {
      kind: 'holy_pillar',
      id: `${id}_${Math.random()}`,
      x: fromX,
      y: fromY,
      radius: 65,
      height: 140,
      element: 'holy',
      color: '#fde047',
      startedAt: nowMs,
      durationMs: 480,
    };
  }

  // 5. Shadow / Debuffs
  if (skill.type === 'debuff' || elem === 'shadow' || id.includes('curse') || id.includes('shadow')) {
    return {
      kind: 'shadow_vortex',
      id: `${id}_${Math.random()}`,
      x: toX,
      y: toY,
      radius: 80,
      element: 'shadow',
      color: '#a855f7',
      startedAt: nowMs,
      durationMs: 450,
    };
  }

  // 6. Melee Slashes / Claws / Fissures / Hammers / Thrusts
  return {
    kind: 'melee_slash',
    slashStyle,
    id: `${id}_${Math.random()}`,
    x: fromX,
    y: fromY,
    targetX: toX,
    targetY: toY,
    angle: aimAngle,
    reach: Number(skill.range) || 90,
    spread: slashStyle === 'whirlwind_ring' ? Math.PI * 2 : (slashStyle === 'thrust_spear' ? Math.PI * 0.25 : Math.PI * 0.75),
    element: elem,
    color: elementColor(elem) || '#f59e0b',
    startedAt: nowMs,
    durationMs: 240,
  };
}

/**
 * Updates visual entity positions and lifetimes.
 */
export function updateSkillVisuals(visuals, dt, nowMs, onExplode) {
  if (!Array.isArray(visuals) || visuals.length === 0) return visuals;

  for (const v of visuals) {
    if (v.kind === 'projectile') {
      if (nowMs < v.startedAt) {
        v.x = v.fromX;
        v.y = v.fromY;
        continue;
      }
      const elapsed = nowMs - v.startedAt;
      const t = Math.min(1, elapsed / (v.flightTime || 200));

      // Update projectile position
      v.x = v.fromX + (v.toX - v.fromX) * t;
      v.y = v.fromY + (v.toY - v.fromY) * t;

      // Add point to trail
      if (v.trail) {
        v.trail.push({ x: v.x, y: v.y, t: nowMs });
        if (v.trail.length > 8) v.trail.shift();
      }

      // Check arrival explosion
      if (t >= 1 && !v.exploded) {
        v.exploded = true;
        if (typeof onExplode === 'function') {
          onExplode(v);
        }
      }
    }
  }

  return visuals;
}

/**
 * Prunes expired skill visual effects.
 */
export function pruneSkillVisuals(visuals, nowMs) {
  if (!Array.isArray(visuals) || visuals.length === 0) return [];
  return visuals.filter((v) => v && (nowMs - v.startedAt) < (v.durationMs || SKILL_VISUAL_MAX_LIFETIME));
}
