// Extra Mage builds. See warrior.mjs for the conventions ({skill_id} placeholders, no cost/cooldown numbers).
const T = (en, uk) => ({ en, uk });

export default [
  {
    id: 'mage_missiles',
    className: 'Mage',
    name: T('Arcane Battery', 'Чародійна батарея'),
    summary: T(
      'A mana-engine caster: arcane damage, extra projectiles and cast speed from the tree, every damage buff stacked before the fight, and a mana pool that doubles as your armor.',
      'Чарівник-«двигун мани»: чародійна шкода, додаткові снаряди й швидкість чаклування з дерева, усі підсилення шкоди перед боєм і запас мани, що водночас править за броню.',
    ),
    playstyle: T(
      'Tag the target with {mag_arcane_vulnerability}, switch on {mag_arcane_brilliance} and {mag_empower_elements}, then fire {mag_magic_missiles} on cooldown and hold {mag_arcane_beam} as the filler. {mag_disintegrate} finishes weak targets. Keep {mag_mana_shield} up all the time, use {mag_blink} to leave danger and {mag_mana_surge} to refill the pool in the middle of a fight.',
      'Позначте ціль «{mag_arcane_vulnerability}», увімкніть «{mag_arcane_brilliance}» та «{mag_empower_elements}», далі стріляйте «{mag_magic_missiles}» щоразу, як вона готова, а «{mag_arcane_beam}» тримайте як наповнювач. «{mag_disintegrate}» добиває слабких. «{mag_mana_shield}» тримайте постійно, «{mag_blink}» рятує від небезпеки, а «{mag_mana_surge}» наповнює запас мани посеред бою.',
    ),
    stats: [
      { stat: 'INT', why: T('Multiplies every Mage skill (+5% per point) and adds mana and mana regeneration. The route puts nearly everything into it.', 'Множить кожну навичку Мага (+5% за очко) і додає ману та її відновлення. Маршрут вкладає в неї майже все.') },
      { stat: 'WIS', why: T('Mana regeneration and part of the gem requirements; the route takes it from Transcendence-style nodes on the way.', 'Відновлення мани та частина вимог самоцвітів; маршрут бере її з вузлів на кшталт «Трансцендентності» дорогою.') },
      { stat: 'DEX', why: T('The route passes the extra-projectile nodes in the Dexterity sector, and DEX also speeds up your attacks.', 'Маршрут проходить вузли додаткових снарядів у секторі Спритності, а СПР ще й прискорює атаки.') },
      { stat: 'CON', why: T('Only enough for gem requirements: the mana shield is your health bar.', 'Лише стільки, щоб вистачило для вимог самоцвітів: щит мани — це ваша смужка здоров\'я.') },
    ],
    hotbar: [
      { skillId: 'mag_magic_missiles', why: T('Five missiles per cast: the main hit of the build, boosted by the extra-projectile nodes on the route.', 'П\'ять снарядів за каст: основний удар білду, посилений вузлами додаткових снарядів на маршруті.') },
      { skillId: 'mag_arcane_beam', why: T('A cheap channeled filler for the gaps: stand still and hold it for steady damage.', 'Дешевий канальний наповнювач для пауз: стійте на місці й тримайте для стабільної шкоди.') },
      { skillId: 'mag_disintegrate', why: T('Execute: +100% damage on targets below 30% life.', 'Добивання: +100% шкоди по цілях із життям нижче 30%.') },
      { skillId: 'mag_arcane_vulnerability', why: T('The target takes 30% more damage for 10 s: cast it first, especially on bosses.', 'Ціль отримує на 30% більше шкоди 10 с: кастуйте першою, особливо на босах.') },
      { skillId: 'mag_empower_elements', why: T('+30% damage dealt for a short window: pair it with {mag_arcane_brilliance}.', '+30% завданої шкоди на коротке вікно: поєднуйте з «{mag_arcane_brilliance}».') },
      { skillId: 'mag_arcane_brilliance', why: T('+25% damage dealt for 30 s: keep it up through the whole fight.', '+25% завданої шкоди на 30 с: тримайте протягом усього бою.') },
      { skillId: 'mag_mana_surge', why: T('Instantly restores 40% of your mana: the refill when the pool runs low.', 'Миттєво відновлює 40% мани: поповнення, коли запас вичерпується.') },
      { skillId: 'mag_mana_shield', why: T('Most of the damage you take is paid from mana: keep it on all the time.', 'Більшу частину отриманої шкоди сплачує мана: тримайте його постійно.') },
      { skillId: 'mag_blink', why: T('A dash out of danger; it also deals damage where you arrive.', 'Ривок із небезпеки; ще й завдає шкоди там, куди ви прибули.') },
    ],
    earlySkills: [
      { skillId: 'mag_arcane_dagger', note: T('A cheap single hit: your damage before the spells unlock.', 'Дешевий одиночний удар: ваша шкода, доки не відкрилися закляття.') },
      { skillId: 'mag_mana_blades', note: T('Two hits that give mana back: early sustain.', 'Два удари, що повертають ману: підтримання на старті.') },
    ],
    gear: [
      T('Weapon: a wand (one hand) or staff (two hands) from the INT line. Plain tiered staves have no element and scale with STR, so fit a replace-stone if you want the attack to scale with INT.', 'Зброя: чарівна паличка (одна рука) або посох (дві руки) з лінійки на ІНТ. Звичайні посохи не мають стихії й масштабуються від СИЛ, тож вставте камінь-заміну, якщо хочете, щоб атака залежала від ІНТ.'),
      T('Armour: robes (INT), hoods (DEX) and a focus off-hand (WIS). Robes give about half the defence of plate.', 'Броня: мантії (ІНТ), каптури (СПР) і фокус у другій руці (МУД). Мантії дають приблизно половину захисту пластин.'),
      T('Good affixes: of_the_well, of_insight.', 'Хороші афікси: of_the_well, of_insight.'),
    ],
    weaknesses: [
      T('Low life: mana is your shield, so never fight with an empty pool, for example right after a respawn.', 'Мало здоров\'я: мана — ваш щит, тож ніколи не б\'йтеся з порожнім запасом, наприклад одразу після відродження.'),
      T('Single-target oriented: missiles hit one target at a time, so big packs go slowly.', 'Орієнтований на одну ціль: снаряди б\'ють по одній цілі, тож великі групи б\'ються повільно.'),
      T('Every skill from level 16 sits behind act quest gates: plan your quests with the gem list in mind.', 'Кожна навичка від 16 рівня стоїть за завданнями актів: плануйте завдання з огляду на список самоцвітів.'),
    ],
  },

  {
    id: 'mage_storm',
    className: 'Mage',
    name: T('Storm Caller', 'Грозовий чародій'),
    summary: T(
      'A lightning caster that shocks everything it touches: chain and area spells, lightning damage and the Storm Caller keystone from the tree, and crits and haste from your buffs.',
      'Чарівник блискавок, що вражає струмом усе довкола: ланцюгові та площинні закляття, шкода блискавками й ключовий вузол «Грозовий поклик» з дерева, а крити й прудкість — від ваших підсилень.',
    ),
    playstyle: T(
      'Start with {mag_elemental_focus} so the next three spells crit, then chain {mag_chain_lightning} through the pack and drop {mag_thunderstorm} on the group. Use {mag_ball_lightning} and {mag_overload_discharge} to keep enemies shocked and interrupted. {mag_haste} speeds you up, {mag_spell_ward} absorbs the next magic hits and {mag_blink} gets you out.',
      'Почніть із «{mag_elemental_focus}», щоб наступні три закляття були критами, далі пускайте «{mag_chain_lightning}» крізь групу й скидайте «{mag_thunderstorm}» на натовп. «{mag_ball_lightning}» і «{mag_overload_discharge}» тримають ворогів у шоці й перебивають їхні дії. «{mag_haste}» прискорює вас, «{mag_spell_ward}» поглинає наступні магічні удари, а «{mag_blink}» виводить із бою.',
    ),
    stats: [
      { stat: 'INT', why: T('Multiplies every Mage skill (+5% per point) and adds mana. The route takes it with the lightning and Storm Caller nodes.', 'Множить кожну навичку Мага (+5% за очко) і додає ману. Маршрут бере її разом з вузлами блискавок і «Грозового поклику».') },
      { stat: 'WIS', why: T('Mana regeneration for a spell-heavy rotation, and part of the gem requirements.', 'Відновлення мани для насиченої закляттями ротації та частина вимог самоцвітів.') },
      { stat: 'DEX', why: T('Attack and cooldown speed, and the crit nodes of the Dexterity sector on the way.', 'Швидкість атаки й перезарядки та крит-вузли сектору Спритності дорогою.') },
      { stat: 'CON', why: T('Only what the gem requirements ask for.', 'Лише те, чого вимагають самоцвіти.') },
    ],
    hotbar: [
      { skillId: 'mag_chain_lightning', why: T('Chains to five more targets: your pack clearer and the spell you cast most.', 'Перескакує ще на п\'ять цілей: ваш зачищувач груп і закляття, яке ви кастуєте найчастіше.') },
      { skillId: 'mag_ball_lightning', why: T('A heavy hit that shocks: the target takes extra damage, loses mana and is interrupted.', 'Важкий удар із шоком: ціль отримує додаткову шкоду, втрачає ману й переривається.') },
      { skillId: 'mag_thunderstorm', why: T('The biggest single cast of the build; it shocks everything it hits.', 'Найбільший одиночний каст білду; вражає шоком усе, у що влучає.') },
      { skillId: 'mag_overload_discharge', why: T('A cheap shock cast that keeps the debuff rolling between the big spells.', 'Дешеве закляття з шоком, що підтримує дебаф між великими закляттями.') },
      { skillId: 'mag_static_charge', why: T('The debuff slot: damage plus shock at a low cost.', 'Слот дебафу: шкода плюс шок за невелику ціну.') },
      { skillId: 'mag_haste', why: T('+35% movement and attack speed for a short window: faster casting of your rotation.', '+35% швидкості руху та атаки на коротке вікно: швидша ротація заклять.') },
      { skillId: 'mag_elemental_focus', why: T('Your next three spells always crit: open fights with it.', 'Ваші наступні три закляття завжди критують: відкривайте ним бої.') },
      { skillId: 'mag_spell_ward', why: T('Negates the next two magic hits: the answer to casters and bosses.', 'Скасовує наступні два магічні удари: відповідь на чарівників і босів.') },
      { skillId: 'mag_blink', why: T('A dash out of danger; it also deals damage where you arrive.', 'Ривок із небезпеки; ще й завдає шкоди там, куди ви прибули.') },
    ],
    earlySkills: [
      { skillId: 'mag_arcane_dagger', note: T('A cheap single hit: your damage before the spells unlock.', 'Дешевий одиночний удар: ваша шкода, доки не відкрилися закляття.') },
      { skillId: 'mag_staff_shock', note: T('A heavy hit that silences for a moment: a safe early opener.', 'Важкий удар, що на мить змушує мовчати: безпечне раннє відкриття.') },
    ],
    gear: [
      T('Weapon: a wand or staff from the INT line; fit a replace-stone with a lightning element if the staff has none, so the attack scales with INT.', 'Зброя: паличка або посох з лінійки на ІНТ; вставте камінь-заміну зі стихією блискавки, якщо в посоха її немає, щоб атака залежала від ІНТ.'),
      T('Armour: robes (INT), hoods (DEX) and a focus off-hand (WIS). Look for lightning resistance and spell-damage rolls.', 'Броня: мантії (ІНТ), каптури (СПР) і фокус у другій руці (МУД). Шукайте опір блискавкам і шкоду заклять.'),
      T('Good affixes: of_the_well, of_insight.', 'Хороші афікси: of_the_well, of_insight.'),
    ],
    weaknesses: [
      T('Enemies that resist lightning take much less damage: keep a few skills from the other Mage builds for them.', 'Вороги з опором блискавкам отримують значно менше шкоди: тримайте кілька навичок з інших білдів Мага для них.'),
      T('A spell-heavy rotation drains mana quickly: keep the mana regeneration nodes and watch the pool.', 'Ротація з багатьма закляттями швидко виснажує ману: беріть вузли відновлення мани й стежте за запасом.'),
      T('Low life and little physical defence: keep your distance and use {mag_blink} and {mag_spell_ward} early.', 'Мало здоров\'я та слабкий фізичний захист: тримайте дистанцію й вмикайте «{mag_blink}» і «{mag_spell_ward}» завчасно.'),
    ],
  },
];
