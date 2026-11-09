// Text for the extra Warrior builds. Every string is { en, uk }.
//   * {skill_id} is replaced by the skill's catalog name in the guide's language, so a name in the text can
//     never differ from the one the game shows.
//   * Numbers about costs and cooldowns are left out on purpose: the guide freshness tests compare those with
//     the skill catalog, and the skill tooltip already shows them.
const T = (en, uk) => ({ en, uk });

export default [
  {
    id: 'warrior_bulwark',
    className: 'Warrior',
    name: T('Iron Bulwark', 'Залізний бастіон'),
    summary: T(
      'A tank that wins by outlasting the fight: high STR and CON, resistances and life regeneration from the tree, stuns and armor shred to control the pack, and a defensive cooldown on almost every slot.',
      'Танк, що перемагає витривалістю: висока СИЛ і СТА, опір шкоді та відновлення життя з дерева, оглушення й зниження броні для контролю групи та захисне вміння майже на кожному слоті.',
    ),
    playstyle: T(
      'Open on the pack with {war_shield_slam}, cut armor with {war_wave_cleaver} and pull everyone onto you with {war_taunt}. Keep {war_steel_tempering} up, press {war_shield_wall} before a big hit, use {war_iron_will} against stuns and slows, and keep {war_last_stand} as the panic button. {war_unstoppable} is an extra heal between pulls.',
      'Починайте бій із «{war_shield_slam}», знижуйте броню через «{war_wave_cleaver}» і збирайте всіх на себе «{war_taunt}». Тримайте «{war_steel_tempering}», вмикайте «{war_shield_wall}» перед сильним ударом, «{war_iron_will}» проти оглушень і сповільнень, а «{war_last_stand}» лишайте як кнопку паніки. «{war_unstoppable}» — додаткове лікування між боями.',
    ),
    stats: [
      { stat: 'STR', why: T('Multiplies every weapon hit and every Warrior skill and gates weapon tiers. A tank still has to hurt something.', 'Множить кожен удар зброєю й кожну навичку Воїна та відкриває тири зброї. Танк теж має завдавати шкоди.') },
      { stat: 'CON', why: T('+10 HP per point and a gem requirement: the main defensive stat of this build. The route takes CON and STR in equal measure.', '+10 ЗДР за очко та вимога самоцвітів: головна захисна характеристика цього білду. Маршрут бере СТА й СИЛ порівну.') },
      { stat: 'DEX', why: T('Only what gem requirements and attack speed ask for. This build does not chase the cooldown floor.', 'Лише те, чого вимагають самоцвіти й швидкість атаки. Цей білд не женеться за мінімумом перезарядки.') },
    ],
    hotbar: [
      { skillId: 'war_shield_slam', why: T('The opener: a heavy hit and a stun on the strongest enemy (bosses are immune to the stun).', 'Відкриття бою: важкий удар і оглушення найсильнішого ворога (боси стійкі до оглушення).') },
      { skillId: 'war_crushing_blow', why: T('Cheap filler that ignores part of the armor; use it between cooldowns.', 'Дешевий наповнювач, що ігнорує частину броні; бийте ним між перезарядками.') },
      { skillId: 'war_wave_cleaver', why: T('Damage plus an armor cut that makes the rest of your hits land harder.', 'Шкода плюс зниження броні, через яке решта ударів б\'є сильніше.') },
      { skillId: 'war_taunt', why: T('Forces nearby enemies to attack you and cuts their armor: the core tool of a tank in a group.', 'Змушує ворогів поруч атакувати вас і знижує їхню броню: основний інструмент танка в групі.') },
      { skillId: 'war_shield_wall', why: T('Cuts damage taken by 30% for a few seconds: press it right before a heavy hit.', 'Зменшує отриману шкоду на 30% на кілька секунд: вмикайте перед важким ударом.') },
      { skillId: 'war_steel_tempering', why: T('A long, nearly permanent damage cut: keep it running before every hard fight.', 'Довге, майже постійне зменшення шкоди: тримайте його перед кожним важким боєм.') },
      { skillId: 'war_iron_will', why: T('Immunity to stuns and slows for a short window: the answer to crowd control.', 'Імунітет до оглушень і сповільнень на короткий час: відповідь на контроль.') },
      { skillId: 'war_unstoppable', why: T('An instant heal of a quarter of your life: drink it between pulls.', 'Миттєве лікування чверті здоров\'я: використовуйте між боями.') },
      { skillId: 'war_last_stand', why: T('Your life cannot fall below 1 for a moment: the panic button, on a long timer.', 'Ваше життя не може впасти нижче 1 на мить: кнопка паніки з довгою перезарядкою.') },
    ],
    earlySkills: [
      { skillId: 'war_whirlwind', note: T('Channeled area damage for clearing packs before the stuns and taunts unlock.', 'Канальна шкода по площі для зачистки груп, поки не відкрилися оглушення та виклики.') },
      { skillId: 'war_hamstring_slash', note: T('Slows the target so you can keep it in front of you.', 'Сповільнює ціль, щоб ви могли тримати її перед собою.') },
    ],
    gear: [
      T('Weapon: a one-handed STR weapon (sword, axe or mace). Stay on the highest tier your STR allows; a buckler off-hand adds armor.', 'Зброя: одноручна зброя на СИЛ (меч, сокира чи булава). Тримайтеся найвищого тиру, який дозволяє СИЛ; щит у другій руці додає броню.'),
      T('Armour: STR plate (helm, plate, gauntlets) plus CON greaves. Armor cuts every hit by a flat amount, which is exactly what a tank wants.', 'Броня: пластини на СИЛ (шолом, нагрудник, рукавиці) і наголінники на СТА. Броня зменшує кожен удар на фіксоване значення, а танку саме це й потрібно.'),
      T('Good affixes: of_the_bear (+HP), of_vigor (+CON) and any resistance roll.', 'Хороші афікси: of_the_bear (+ЗДР), of_vigor (+СТА) і будь-який опір.'),
    ],
    weaknesses: [
      T('Damage is low next to the main Warrior build: you win slowly, so timed content and bosses with an enrage are hard.', 'Шкода низька порівняно з основним білдом Воїна: ви перемагаєте повільно, тож бої на час і боси з люттю складні.'),
      T('Almost everything on the bar is a stamina skill: keep the stamina regeneration nodes and do not run long channels.', 'Майже все на панелі живиться витривалістю: беріть вузли відновлення витривалості й не тримайте довгі канали.'),
      T('Magic damage ignores armor: take the resistance nodes of the route seriously.', 'Магічна шкода ігнорує броню: серйозно ставтеся до вузлів опору на маршруті.'),
    ],
  },

  {
    id: 'warrior_executioner',
    className: 'Warrior',
    name: T('Executioner', 'Кат'),
    summary: T(
      'A single-target duelist built on big hits: crit chance and crit damage, STR attribute damage and execute skills that finish anything that is nearly dead.',
      'Дуелянт для однієї цілі, побудований на великих ударах: шанс і шкода критів, шкода від СИЛ та добивальні навички для майже мертвих цілей.',
    ),
    playstyle: T(
      'Open with {war_duelist_focus} and {war_battle_shout}, then rotate {war_berzerker_rampage}, {war_titanic_impact} and {war_overpowering_smash} on cooldown. Use {war_decapitate} to finish anything under a quarter of its life. {war_bloodlust_stance} stacks attack speed in long fights and {war_blood_harvest} keeps you alive on the way.',
      'Починайте з «{war_duelist_focus}» та «{war_battle_shout}», далі по черзі «{war_berzerker_rampage}», «{war_titanic_impact}» і «{war_overpowering_smash}». «{war_decapitate}» добиває все, що має менше чверті життя. «{war_bloodlust_stance}» накопичує швидкість атаки в довгих боях, а «{war_blood_harvest}» підтримує вас дорогою.',
    ),
    stats: [
      { stat: 'STR', why: T('Multiplies every weapon hit and every Warrior skill: this build wants as much as the route can give.', 'Множить кожен удар зброєю й кожну навичку Воїна: цей білд хоче якомога більше СИЛ.') },
      { stat: 'DEX', why: T('Attack and cooldown speed. The route also passes the crit keystones that live in the Dexterity sector.', 'Швидкість атаки та перезарядки. Маршрут також проходить крит-ключові вузли із сектору Спритності.') },
      { stat: 'CON', why: T('Some life: the route takes keystones with a life penalty, so a little CON keeps you standing.', 'Трохи життя: маршрут бере ключові вузли зі штрафом до здоров\'я, тож трохи СТА тримає вас на ногах.') },
    ],
    hotbar: [
      { skillId: 'war_decapitate', why: T('Execute: +150% damage below 25% life. The finisher of the build.', 'Добивання: +150% шкоди по цілях із життям нижче 25%. Фінішер цього білду.') },
      { skillId: 'war_berzerker_rampage', why: T('Three heavy hits for a big total: your main burst on a single target.', 'Три важкі удари з великою сумою: основний вибух шкоди по одній цілі.') },
      { skillId: 'war_overpowering_smash', why: T('Ignores half of the target\'s armor: best against armored bosses.', 'Ігнорує половину броні цілі: найкращий проти броньованих босів.') },
      { skillId: 'war_titanic_impact', why: T('The heaviest hit on the bar; it also leaves a damaging zone on the ground.', 'Найважчий удар на панелі; ще й лишає на землі зону, що завдає шкоди.') },
      { skillId: 'war_blood_harvest', why: T('A heavy hit that heals you for a quarter of the damage dealt: your sustain.', 'Важкий удар, що лікує вас на чверть завданої шкоди: ваше підтримання.') },
      { skillId: 'war_duelist_focus', why: T('More crit chance and crit damage plus parries for a while: open every fight with it.', 'Більше шансу й шкоди критів та парирування на деякий час: відкривайте ним кожен бій.') },
      { skillId: 'war_battle_shout', why: T('The damage buff: +20% damage dealt for 20 s.', 'Підсилення шкоди: +20% завданої шкоди на 20 с.') },
      { skillId: 'war_bloodlust_stance', why: T('Attack speed stacks with every swing during a long fight.', 'Швидкість атаки зростає з кожним ударом у довгому бою.') },
      { skillId: 'war_unstoppable', why: T('An instant heal: use it when a fight goes wrong.', 'Миттєве лікування: використовуйте, коли бій іде не за планом.') },
    ],
    earlySkills: [
      { skillId: 'war_crushing_blow', note: T('Cheap heavy hit that ignores part of the armor; it carries you until the better skills unlock.', 'Дешевий важкий удар, що ігнорує частину броні; веде вас, доки не відкриються кращі навички.') },
      { skillId: 'war_skull_splitter', note: T('A big hit with a chance to stun: a good early burst.', 'Великий удар із шансом оглушення: добрий ранній вибух шкоди.') },
    ],
    gear: [
      T('Weapon: a one-handed STR weapon with the highest damage per hit (axe or blade). Crit affixes are worth more here than anywhere else.', 'Зброя: одноручна зброя на СИЛ із найбільшою шкодою за удар (сокира чи клинок). Крит-афікси тут цінніші, ніж будь-де.'),
      T('Armour: STR plate, accepting less defence than the tank build and putting the gain into damage.', 'Броня: пластини на СИЛ; ви погоджуєтеся на слабший захист, ніж у танка, заради шкоди.'),
      T('Good affixes: of_might and any crit chance or crit damage roll.', 'Хороші афікси: of_might і будь-який шанс чи шкода крита.'),
    ],
    weaknesses: [
      T('Low life: the route takes keystones with a life penalty, so one mistake is expensive.', 'Мало здоров\'я: маршрут бере ключові вузли зі штрафом до життя, тож одна помилка коштує дорого.'),
      T('Stamina hungry: heavy skills cost a lot, so do not fire everything at once.', 'Витрачає багато витривалості: важкі навички коштують дорого, тож не запускайте все разом.'),
      T('Few defensive tools: {war_unstoppable} and {war_blood_harvest} are the only healing you have.', 'Мало захисних інструментів: єдине ваше лікування — це «{war_unstoppable}» і «{war_blood_harvest}».'),
    ],
  },
];
