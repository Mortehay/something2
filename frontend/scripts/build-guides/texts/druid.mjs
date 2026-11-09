// Extra Druid builds. See warrior.mjs for the conventions ({skill_id} placeholders, no cost/cooldown numbers).
const T = (en, uk) => ({ en, uk });

export default [
  {
    id: 'druid_wolf',
    className: 'Druid',
    name: T('Wolf Pack', 'Вовча зграя'),
    summary: T(
      'A Druid that never leaves Wolf Form: every fight is fought as the wolf with its attack speed and crit bonus, boosted by the form power, crit and attack-speed nodes of the tree, and carried by long buffs and a heal.',
      'Друїд, що ніколи не виходить із форми вовка: кожен бій відбувається у вовчій подобі з її швидкістю атаки та бонусом до крита, підсиленою вузлами сили форми, крита й швидкості атаки з дерева, а підтримують його довгі підсилення та лікування.',
    ),
    playstyle: T(
      'Enter {dru_wolf_form} and stay in it. Cast {dru_primal_metamorphosis} and {dru_mark_of_the_wild}, then rotate {dru_wolf_pack_strike}, {dru_feral_bite} and {dru_wolf_rend}; {dru_wolf_throat_rip} finishes anything weak. {dru_barkskin} cuts the damage you take and {dru_rejuvenation} heals you while you keep fighting. Every skill here is a wolf skill or a buff that works in the form, so you never pay the spell penalty.',
      'Увійдіть у «{dru_wolf_form}» і лишайтеся в ній. Накладіть «{dru_primal_metamorphosis}» та «{dru_mark_of_the_wild}», далі чергуйте «{dru_wolf_pack_strike}», «{dru_feral_bite}» і «{dru_wolf_rend}»; «{dru_wolf_throat_rip}» добиває слабких. «{dru_barkskin}» зменшує отриману шкоду, а «{dru_rejuvenation}» лікує вас, поки ви б\'єтеся. Усе тут — вовчі навички або підсилення, що працюють у формі, тож штрафу заклять ви не платите.',
    ),
    stats: [
      { stat: 'CHA', why: T('Attribute of every Druid skill (+5% per point): the main stat. The route also takes the form power nodes that make the wolf stronger.', 'Атрибут кожної навички Друїда (+5% за очко): головна характеристика. Маршрут також бере вузли сили форми, що підсилюють вовка.') },
      { stat: 'STR', why: T('Form auto-attacks use the weapon in hand with the STR multiplier, and a keystone on the route adds some.', 'Автоатаки форм використовують зброю в руці з множником СИЛ, а один із ключових вузлів маршруту трохи її додає.') },
      { stat: 'CON', why: T('Life: the wolf takes hits in melee, so the route keeps some CON.', 'Життя: вовк приймає удари в ближньому бою, тож маршрут тримає трохи СТА.') },
      { stat: 'DEX', why: T('Gem requirements, and an attack-speed keystone on the way.', 'Вимоги самоцвітів і ключовий вузол швидкості атаки дорогою.') },
    ],
    hotbar: [
      { skillId: 'dru_wolf_form', why: T('The form this build lives in: +25% attack speed and +15% crit chance. Recast it to leave the form.', 'Форма, у якій живе цей білд: +25% швидкості атаки та +15% шансу крита. Повторне застосування виводить із форми.') },
      { skillId: 'dru_wolf_rend', why: T('The cheapest wolf filler; it also cuts the target\'s armor by 20%.', 'Найдешевший вовчий наповнювач; ще й знижує броню цілі на 20%.') },
      { skillId: 'dru_wolf_pack_strike', why: T('A heavy hit that summons two spirit wolves for a few seconds.', 'Важкий удар, що на кілька секунд прикликає двох духів-вовків.') },
      { skillId: 'dru_feral_bite', why: T('The best wolf skill: a fast hit that also bleeds.', 'Найкраща вовча навичка: швидкий удар, що ще й викликає кровотечу.') },
      { skillId: 'dru_wolf_throat_rip', why: T('Execute: +200% damage on targets below 30% life.', 'Добивання: +200% шкоди по цілях із життям нижче 30%.') },
      { skillId: 'dru_primal_metamorphosis', why: T('Heals you, +30% damage and +35% movement speed for 20 s. Works only in a form.', 'Лікує, +30% шкоди й +35% швидкості руху на 20 с. Працює лише у формі.') },
      { skillId: 'dru_mark_of_the_wild', why: T('+10% damage and +10% max life for 1800 s: refresh it every half hour.', '+10% шкоди та +10% макс. здоров\'я на 1800 с: оновлюйте щопівгодини.') },
      { skillId: 'dru_barkskin', why: T('-30% damage taken for 10 s: press it before a hard hit.', '-30% отриманої шкоди на 10 с: вмикайте перед важким ударом.') },
      { skillId: 'dru_rejuvenation', why: T('Heals 3% of your max life per second for 12 s, in or out of a form.', 'Лікує 3% макс. здоров\'я за секунду протягом 12 с, у формі чи поза нею.') },
    ],
    earlySkills: [
      { skillId: 'dru_wolf_flurry', note: T('Four hits in a row: your damage before {dru_wolf_rend} and {dru_feral_bite}.', 'Чотири удари поспіль: ваша шкода до «{dru_wolf_rend}» і «{dru_feral_bite}».') },
      { skillId: 'dru_wolf_pounce', note: T('A heavy hit that stuns for a moment: a safe early opener.', 'Важкий удар, що на мить оглушує: безпечне раннє відкриття.') },
    ],
    gear: [
      T('Weapon: form auto-attacks use the weapon in hand with the STR multiplier, so a mace (CON) or dagger (DEX) works, and a scepter (CHA) fits the stats you already take.', 'Зброя: автоатаки форм використовують зброю в руці з множником СИЛ, тож підійдуть булава (СТА) чи кинджал (СПР), а скіпетр (ХАР) пасує до характеристик, які ви вже берете.'),
      T('Rings need CHA, the only gear matching your main stat. Otherwise: greaves (CON), hood, boots and gloves (DEX).', 'Персні потребують ХАР, єдиного спорядження для вашої головної характеристики. Решта: наголінники (СТА), каптур, чоботи й рукавиці (СПР).'),
      T('Good affixes: of_presence (+CHA), of_the_bear (+HP), crit and attack speed rolls.', 'Хороші афікси: of_presence (+ХАР), of_the_bear (+ЗДР), шанс крита й швидкість атаки.'),
    ],
    weaknesses: [
      T('No ranged attack and no way to cast at full power: a wolf cannot kite, so retreat means leaving the form.', 'Немає ні дальньої атаки, ні можливості кастувати на повну силу: вовк не може кітити, тож відступ означає вихід із форми.'),
      T('The big skills sit behind act quest gates from level 43: until then you play on {dru_wolf_rend} and {dru_wolf_flurry}.', 'Великі навички стоять за завданнями актів від 43 рівня: до того ви граєте на «{dru_wolf_rend}» і «{dru_wolf_flurry}».'),
      T('The wolf is melee only: bosses with area attacks need {dru_barkskin} and {dru_rejuvenation} on time.', 'Вовк б\'ється лише впритул: боси з атаками по площі потребують «{dru_barkskin}» та «{dru_rejuvenation}» вчасно.'),
    ],
  },

  {
    id: 'druid_moon',
    className: 'Druid',
    name: T('Moon Caster', 'Місячний чаклун'),
    summary: T(
      'A Druid that never shapeshifts: it fights in human form with nature spells at full power, boosted by mana, cast speed and cooldown nodes, and keeps itself alive with heals and a damage-reducing buff.',
      'Друїд, що ніколи не перевтілюється: б\'ється в людській подобі закляттями природи на повну силу, підсиленими вузлами мани, швидкості чаклування та перезарядки, а виживає завдяки лікуванню й підсиленню, що зменшує шкоду.',
    ),
    playstyle: T(
      'Stay in human form: spells cast in a form hit at 75% power. Pop {dru_natures_swiftness} and drop {dru_starfall} for a double-damage burst, keep {dru_moonfire} burning, hold {dru_solar_beam} between casts and use {dru_wrath} as the cheap filler. {dru_storm_lightning} shocks and interrupts, {dru_barkskin} and {dru_healing_touch} keep you standing, and {dru_mark_of_the_wild} lasts half an hour.',
      'Лишайтеся в людській подобі: закляття, застосовані у формі, б\'ють на 75% сили. Вмикайте «{dru_natures_swiftness}» й скидайте «{dru_starfall}» для подвійного вибуху шкоди, тримайте «{dru_moonfire}» палаючим, між кастами утримуйте «{dru_solar_beam}», а «{dru_wrath}» використовуйте як дешевий наповнювач. «{dru_storm_lightning}» вражає струмом і перериває, «{dru_barkskin}» та «{dru_healing_touch}» тримають вас на ногах, а «{dru_mark_of_the_wild}» діє пів години.',
    ),
    stats: [
      { stat: 'CHA', why: T('Attribute of every Druid skill, spells included (+5% per point): the main stat, and the route never stops taking it.', 'Атрибут кожної навички Друїда, закляття теж (+5% за очко): головна характеристика, і маршрут бере її без зупинок.') },
      { stat: 'INT', why: T('Raises your mana pool, which every cast spends.', 'Збільшує запас мани, який витрачає кожен каст.') },
      { stat: 'WIS', why: T('Mana regeneration and gem requirements: the route takes it for the sustained casting.', 'Відновлення мани та вимоги самоцвітів: маршрут бере її для тривалого чаклування.') },
    ],
    hotbar: [
      { skillId: 'dru_wrath', why: T('A very cheap spell with almost no wait: your filler.', 'Дуже дешеве закляття майже без перезарядки: ваш наповнювач.') },
      { skillId: 'dru_moonfire', why: T('A hit that burns for 12 s: keep it on the target.', 'Удар, що палить 12 с: тримайте його на цілі.') },
      { skillId: 'dru_starfall', why: T('The big spell: heavy damage and a damaging zone that stays for a few seconds.', 'Велике закляття: важка шкода й зона шкоди, що лишається на кілька секунд.') },
      { skillId: 'dru_solar_beam', why: T('A cheap channel that burns: stand and hold it between the big casts.', 'Дешевий канал, що палить: стійте й утримуйте його між великими кастами.') },
      { skillId: 'dru_storm_lightning', why: T('Shocks the target: extra damage taken, mana lost and the cast interrupted.', 'Вражає ціль струмом: додаткова шкода, втрата мани й переривання касту.') },
      { skillId: 'dru_natures_swiftness', why: T('Your next spell deals double damage: press it right before Starfall.', 'Ваше наступне закляття завдає подвійної шкоди: вмикайте безпосередньо перед «{dru_starfall}».') },
      { skillId: 'dru_healing_touch', why: T('Heals 30% of your max life at once: the emergency button.', 'Миттєво лікує 30% макс. здоров\'я: екстрена кнопка.') },
      { skillId: 'dru_barkskin', why: T('-30% damage taken for 10 s.', '-30% отриманої шкоди на 10 с.') },
      { skillId: 'dru_mark_of_the_wild', why: T('+10% damage and +10% max life for 1800 s: refresh it every half hour.', '+10% шкоди та +10% макс. здоров\'я на 1800 с: оновлюйте щопівгодини.') },
    ],
    earlySkills: [
      { skillId: 'dru_thorn_staff_strike', note: T('A cheap staff strike: your damage before the spells unlock at level 31.', 'Дешевий удар посохом: ваша шкода, доки не відкрилися закляття на 31 рівні.') },
      { skillId: 'dru_hawk_wind_slash', note: T('A ranged slash that lets you hit from a distance before you have spells.', 'Дальній розріз, що дає змогу бити здалеку, поки немає заклять.') },
    ],
    gear: [
      T('Weapon: a scepter (one hand, needs CHA) counts as a staff or wand, so your spells work at full strength in human form.', 'Зброя: скіпетр (одна рука, потребує ХАР) вважається посохом чи паличкою, тож закляття працюють на повну силу в людській подобі.'),
      T('Armour: robes (INT), hood, boots and gloves (DEX) and greaves (CON). Rings need CHA.', 'Броня: мантії (ІНТ), каптур, чоботи й рукавиці (СПР) та наголінники (СТА). Персні потребують ХАР.'),
      T('Good affixes: of_presence (+CHA), of_the_well and cast speed rolls.', 'Хороші афікси: of_presence (+ХАР), of_the_well і швидкість чаклування.'),
    ],
    weaknesses: [
      T('Low life: the route puts almost nothing into HP, so use {dru_barkskin} and {dru_healing_touch} early and keep your distance.', 'Мало здоров\'я: маршрут майже нічого не вкладає в ЗДР, тож вмикайте «{dru_barkskin}» і «{dru_healing_touch}» завчасно та тримайте дистанцію.'),
      T('Mana is the limit: the build spends it on every cast, so keep the regeneration nodes and watch the pool.', 'Мана — це межа: білд витрачає її на кожен каст, тож беріть вузли відновлення й стежте за запасом.'),
      T('The spells unlock from level 31 and the strongest from level 40, behind act quest gates.', 'Закляття відкриваються з 31 рівня, а найсильніші з 40, за завданнями актів.'),
    ],
  },
];
