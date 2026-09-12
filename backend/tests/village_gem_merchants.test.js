const test = require('node:test');
const assert = require('node:assert/strict');
const { villageSkillMerchantPost, villageMerchantPost, villageBankPost, villageSkillHouse } = require('../src/services/mapService.js');
const { SKILLS, getSkillById, checkGemRequirements } = require('../seeds/data/skills.js');

test('villageSkillMerchantPost derives valid coordinates in skill house interior', () => {
  for (const gateEdge of ['N', 'S', 'E', 'W']) {
    const v = { minRow: 4, minCol: 7, width: 6, height: 6, gateEdge };
    const merchant = villageMerchantPost(v);
    const bank = villageBankPost(v, merchant);
    const skillMerchant = villageSkillMerchantPost(v);
    const skHouse = villageSkillHouse(v);

    const row = Math.floor(skillMerchant.y / 100);
    const col = Math.floor(skillMerchant.x / 100);
    assert.ok(row >= skHouse.minRow + 1 && row <= skHouse.minRow + skHouse.height - 2);
    assert.ok(col >= skHouse.minCol + 1 && col <= skHouse.minCol + skHouse.width - 2);
    assert.notDeepEqual(skillMerchant, merchant, `gate ${gateEdge}: skill merchant stacked on merchant`);
    assert.notDeepEqual(skillMerchant, bank, `gate ${gateEdge}: skill merchant stacked on bank`);
  }
});

test('SKILLS seed data enriched as PoE Skill Gems with 6 attribute & level requirements', () => {
  assert.equal(SKILLS.length, 300);
  const classCounters = {};
  for (const s of SKILLS) {
    classCounters[s.class] = (classCounters[s.class] || 0) + 1;
    const idx = classCounters[s.class];

    assert.equal(s.isGem, true);
    assert.ok(['red', 'green', 'blue', 'purple', 'orange', 'hybrid'].includes(s.gemColor));
    assert.ok(s.reqLvl >= 1);
    assert.ok(typeof s.reqStr === 'number');
    assert.ok(typeof s.reqDex === 'number');
    assert.ok(typeof s.reqCon === 'number');
    assert.ok(typeof s.reqInt === 'number');
    assert.ok(typeof s.reqWis === 'number');
    assert.ok(typeof s.reqCha === 'number');
    if (idx === 1) {
      assert.equal(s.gemPrice, 100);
    } else {
      assert.ok(s.gemPrice >= 250);
    }
    assert.ok(s.reqWeapon);
  }
});

test('checkGemRequirements validates weapon restrictions and stats authoritatively', () => {
  const fireball = getSkillById('mag_fireball');
  assert.ok(fireball);

  // 1. Incompatible weapon (bow with projectile wand/staff requirement)
  const bow = { name: 'Longbow', category: 'weapon', kind: 'projectile', ammo_type_id: 101 };
  const check1 = checkGemRequirements(fireball, { level: 20, int: 50, str: 10, dex: 10 }, bow);
  assert.equal(check1.weaponOk, false);

  // 2. Compatible wand weapon
  const wand = { name: 'Apprentice Wand', category: 'weapon', kind: 'projectile' };
  const check2 = checkGemRequirements(fireball, { level: 20, int: 50, str: 10, dex: 10 }, wand);
  assert.equal(check2.weaponOk, true);
});
