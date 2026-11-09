// Extra Archer builds. See warrior.mjs for the conventions ({skill_id} placeholders, no cost/cooldown numbers).
const T = (en, uk) => ({ en, uk });

export default [
  {
    id: 'archer_sniper',
    className: 'Archer',
    name: T('Marksman', 'Влучний стрілець'),
    summary: T(
      'A long-range single-target shooter: crit chance and crit damage, piercing arrows and long-range bonuses, with marks and stances that stack the damage you take from standing still.',
      'Далекобійний стрілець по одній цілі: шанс і шкода критів, пробивні стріли та бонуси на дальність, а мітки й стійки накопичують шкоду від того, що ви стоїте на місці.',
    ),
    playstyle: T(
      'Stand at range, switch on {arc_eagle_eye} and {arc_sniper_stance}, mark the target with {arc_marker_arrow} and {arc_hunters_instinct}, then fire {arc_heartseeker}, {arc_aimed_shot} and {arc_piercing_shot} on cooldown. {arc_camouflage} gives you a guaranteed critical opener, and {arc_tailwind_aura} keeps you moving when something gets close.',
      'Станьте здалеку, увімкніть «{arc_eagle_eye}» та «{arc_sniper_stance}», позначте ціль «{arc_marker_arrow}» і «{arc_hunters_instinct}», далі пускайте «{arc_heartseeker}», «{arc_aimed_shot}» та «{arc_piercing_shot}», щойно вони готові. «{arc_camouflage}» дає гарантований критичний початок, а «{arc_tailwind_aura}» тримає вас у русі, коли хтось наближається.',
    ),
    stats: [
      { stat: 'DEX', why: T('Attribute of nearly every Archer skill (+5% per point) and speed. The route pours almost everything into it.', 'Атрибут майже всіх навичок Лучника (+5% за очко) і швидкість. Маршрут вкладає в неї майже все.') },
      { stat: 'STR', why: T('Elementless bows scale their hits with STR, so a little keeps your auto-attack honest.', 'Луки без стихії масштабують удари від СИЛ, тож трохи її тримає звичайну атаку гідною.') },
      { stat: 'CON', why: T('Only what the gem requirements ask for; your defence is distance.', 'Лише те, чого вимагають самоцвіти; ваш захист — це відстань.') },
    ],
    hotbar: [
      { skillId: 'arc_aimed_shot', why: T('+40% damage at long range: your cheap, steady opener.', '+40% шкоди на великій відстані: ваш дешевий і стабільний початок.') },
      { skillId: 'arc_heartseeker', why: T('+100% damage at long range: the best hit of the build when you keep your distance.', '+100% шкоди на великій відстані: найкращий удар білду, коли ви тримаєте дистанцію.') },
      { skillId: 'arc_piercing_shot', why: T('Ignores 30% of armor and goes through targets: good against armored enemies.', 'Ігнорує 30% броні й пробиває цілі навиліт: добрий проти броньованих ворогів.') },
      { skillId: 'arc_marker_arrow', why: T('The target takes 30% more damage for 5 s: fire it first on a boss.', 'Ціль отримує на 30% більше шкоди 5 с: пускайте першою на босі.') },
      { skillId: 'arc_eagle_eye', why: T('+20% crit chance and extra attack range for 20 s.', '+20% шансу крита та більша дальність атаки на 20 с.') },
      { skillId: 'arc_sniper_stance', why: T('+10% damage for every second you stand still, up to +50%. Requires a bow.', '+10% шкоди за кожну секунду на місці, до +50%. Потрібен лук.') },
      { skillId: 'arc_hunters_instinct', why: T('Marks every enemy in range so they take 15% more damage for 20 s.', 'Позначає кожного ворога в радіусі: вони отримують на 15% більше шкоди 20 с.') },
      { skillId: 'arc_camouflage', why: T('Monsters do not notice you and your first attack out of it is a critical hit.', 'Монстри вас не помічають, а перша атака з маскування — критична.') },
      { skillId: 'arc_tailwind_aura', why: T('+15% movement speed and 15% chance to dodge for 60 s: keep it on.', '+15% швидкості руху та 15% шансу ухилитися на 60 с: тримайте увімкненою.') },
    ],
    earlySkills: [
      { skillId: 'arc_fan_of_knives', note: T('A burst of six hits: your damage with the dagger before the bow skills.', 'Вибух із шести ударів: ваша шкода з кинджалом до навичок лука.') },
      { skillId: 'arc_vault', note: T('Leaps back to open distance: the first lesson of a ranged build.', 'Стрибок назад для відстані: перший урок білду зі стрільбою.') },
    ],
    gear: [
      T('Weapon: a dagger until the bow skills unlock, then a bow (it has crit built in) or a crossbow; Sniper Stance requires a bow. There is no ammunition.', 'Зброя: кинджал, доки не відкриються навички лука, далі лук (має вбудований крит) чи арбалет; «{arc_sniper_stance}» потребує лука. Боєприпасів немає.'),
      T('Armour: hood, boots and gloves (DEX), all light. A two-handed bow leaves no off-hand.', 'Броня: каптур, чоботи й рукавиці (СПР), усе легке. Дворучний лук не лишає місця для другої руки.'),
      T('Good affixes: of_grace (+DEX), crit chance and crit damage.', 'Хороші афікси: of_grace (+СПР), шанс і шкода крита.'),
    ],
    weaknesses: [
      T('Almost no life: if an enemy reaches you the build is in trouble, so use {arc_tailwind_aura} and keep your distance.', 'Майже немає здоров\'я: якщо ворог дістався до вас, білд у біді, тож використовуйте «{arc_tailwind_aura}» і тримайте дистанцію.'),
      T('Standing still is the point of the build: fast, hard-hitting enemies punish it.', 'Стояти на місці — суть білду: швидкі й сильні вороги це карають.'),
      T('Two weapons in the early levels (dagger, then bow): keep both in your slots.', 'Дві зброї на ранніх рівнях (кинджал, потім лук): тримайте обидві у слотах.'),
    ],
  },

  {
    id: 'archer_venom',
    className: 'Archer',
    name: T('Venom Trapper', 'Отруйний мисливець'),
    summary: T(
      'A control archer that wins before the fight starts: poison, traps and slows, cooldown and stamina nodes for a fast rotation, and dodge and regeneration for the moments when something reaches you.',
      'Лучник-контролер, що перемагає ще до початку бою: отрута, пастки й сповільнення, вузли перезарядки та витривалості для швидкої ротації, а ухиляння й відновлення — на випадок, коли ворог добереться до вас.',
    ),
    playstyle: T(
      'Lay {arc_bear_trap}, {arc_explosive_trap} and {arc_tar_trap} where the enemies will walk, mark the pack with {arc_hunters_instinct} and then poison it with {arc_venom_arrow} and {arc_neurotoxin}. {arc_scattershot} thins out what gets close, {arc_rapid_fire} speeds up a long fight and {arc_cheetah_stride} lets you reset the field.',
      'Розставте «{arc_bear_trap}», «{arc_explosive_trap}» і «{arc_tar_trap}» там, де пройдуть вороги, позначте групу «{arc_hunters_instinct}», а потім отруїть її «{arc_venom_arrow}» та «{arc_neurotoxin}». «{arc_scattershot}» проріджує тих, хто підійшов, «{arc_rapid_fire}» прискорює довгий бій, а «{arc_cheetah_stride}» дає змогу перебудувати поле.',
    ),
    stats: [
      { stat: 'DEX', why: T('Attribute of nearly every Archer skill (+5% per point), speed and the dodge nodes.', 'Атрибут майже всіх навичок Лучника (+5% за очко), швидкість і вузли ухиляння.') },
      { stat: 'CON', why: T('More life than the Marksman: this build takes the occasional hit while the traps work.', 'Більше життя, ніж у Влучного стрільця: цей білд час від часу приймає удар, поки працюють пастки.') },
      { stat: 'INT', why: T('A small amount for a few gem requirements.', 'Невелика кількість для кількох вимог самоцвітів.') },
    ],
    hotbar: [
      { skillId: 'arc_venom_arrow', why: T('A cheap arrow that poisons: your damage-over-time filler.', 'Дешева стріла з отрутою: ваш наповнювач шкоди з часом.') },
      { skillId: 'arc_scattershot', why: T('Five arrows in a fan: punishes enemies that run in close.', 'П\'ять стріл віялом: карає ворогів, що підбігли впритул.') },
      { skillId: 'arc_neurotoxin', why: T('Slows by 40% and poisons: stops a single big enemy from reaching you.', 'Сповільнює на 40% й отруює: не дає одному великому ворогові дістатися до вас.') },
      { skillId: 'arc_bear_trap', why: T('Lays a trap that stuns and damages whoever steps on it.', 'Ставить пастку, що оглушує й завдає шкоди тому, хто на неї наступить.') },
      { skillId: 'arc_explosive_trap', why: T('Lays a mine that explodes when an enemy comes near.', 'Ставить міну, що вибухає, коли ворог підходить.') },
      { skillId: 'arc_tar_trap', why: T('Lays a tar pool that slows everything standing in it.', 'Ставить калюжу смоли, що сповільнює всіх, хто в ній стоїть.') },
      { skillId: 'arc_hunters_instinct', why: T('Marks every enemy in range so they take 15% more damage for 20 s.', 'Позначає кожного ворога в радіусі: вони отримують на 15% більше шкоди 20 с.') },
      { skillId: 'arc_rapid_fire', why: T('+70% attack speed for 8 s: use it when the traps have done their work.', '+70% швидкості атаки на 8 с: вмикайте, коли пастки відпрацювали.') },
      { skillId: 'arc_cheetah_stride', why: T('+45% movement speed for 12 s: to leave the field and lay the next traps.', '+45% швидкості руху на 12 с: щоб покинути поле й поставити наступні пастки.') },
    ],
    earlySkills: [
      { skillId: 'arc_poison_shiv', note: T('A cheap poisoned stab: your first damage over time, with the dagger.', 'Дешевий отруєний випад: ваша перша шкода з часом, з кинджалом.') },
      { skillId: 'arc_vault', note: T('Leaps back to open distance: the first lesson of a ranged build.', 'Стрибок назад для відстані: перший урок білду зі стрільбою.') },
    ],
    gear: [
      T('Weapon: a dagger until the bow skills unlock, then a bow or crossbow. A crossbow hits harder per shot, which suits a slower trap rotation.', 'Зброя: кинджал, доки не відкриються навички лука, далі лук чи арбалет. Арбалет б\'є сильніше за постріл, що пасує повільнішій ротації пасток.'),
      T('Armour: hood, boots and gloves (DEX), plus whatever gives life or stamina regeneration.', 'Броня: каптур, чоботи й рукавиці (СПР) і все, що дає життя чи відновлення витривалості.'),
      T('Good affixes: of_grace (+DEX), stamina regeneration and dodge rolls.', 'Хороші афікси: of_grace (+СПР), відновлення витривалості й ухиляння.'),
    ],
    weaknesses: [
      T('Traps need preparation: in a sudden fight you have only {arc_venom_arrow} and {arc_scattershot}.', 'Пасткам потрібна підготовка: у раптовому бою у вас лише «{arc_venom_arrow}» і «{arc_scattershot}».'),
      T('Low burst damage: you win through poison and marks, which takes a few seconds.', 'Невисока шкода вибухом: ви перемагаєте отрутою й мітками, а це потребує кількох секунд.'),
      T('Everything on the bar is a stamina skill: keep the regeneration nodes and do not lay all three traps at once.', 'Усе на панелі живиться витривалістю: беріть вузли відновлення й не ставте всі три пастки одразу.'),
    ],
  },
];
