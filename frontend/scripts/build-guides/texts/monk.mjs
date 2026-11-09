// Extra Monk builds. See warrior.mjs for the conventions ({skill_id} placeholders, no cost/cooldown numbers).
const T = (en, uk) => ({ en, uk });

export default [
  {
    id: 'monk_fist',
    className: 'Monk',
    name: T('Iron Fist', 'Залізний кулак'),
    summary: T(
      'A close-range striker that trades the main build\'s channels for combos: WIS-boosted strikes, fast attacks, dodges with counter-hits, and echo skills that hit a second time.',
      'Ударник ближнього бою, що міняє канали основного білду на комбо: удари з бонусом від МУД, швидкі атаки, ухиляння з контрударами та ехо-навички, що б\'ють удруге.',
    ),
    playstyle: T(
      'Keep {mnk_tiger_stance} and {mnk_drunken_brawler_stance} running, then chain {mnk_five_element_combo} with {mnk_exploding_palm} and {mnk_echo_palm} so the echoes land together. {mnk_iron_palm} cuts armor before the heavy {mnk_ego_crusher}. {mnk_inner_peace} heals you in the middle of a fight and {mnk_zen_focus} protects you from stuns and slows.',
      'Тримайте увімкненими «{mnk_tiger_stance}» і «{mnk_drunken_brawler_stance}», далі з\'єднуйте «{mnk_five_element_combo}» з «{mnk_exploding_palm}» та «{mnk_echo_palm}», щоб відлуння прилітали разом. «{mnk_iron_palm}» знижує броню перед важким «{mnk_ego_crusher}». «{mnk_inner_peace}» лікує посеред бою, а «{mnk_zen_focus}» захищає від оглушень і сповільнень.',
    ),
    stats: [
      { stat: 'WIS', why: T('Multiplies every Monk skill (+5% per point). The route keeps it growing all the way, then adds the DEX and STR the gems ask for.', 'Множить кожну навичку Монаха (+5% за очко). Маршрут нарощує її весь час, а потім додає СПР і СИЛ, яких вимагають самоцвіти.') },
      { stat: 'DEX', why: T('Attack speed, dodge nodes and the crit keystones of the Dexterity sector.', 'Швидкість атаки, вузли ухиляння та крит-ключові вузли сектору Спритності.') },
      { stat: 'STR', why: T('A gem requirement on every Monk skill, and it boosts unarmed and dagger hits.', 'Вимога самоцвітів на кожній навичці Монаха; також підсилює удари кулаками й кинджалом.') },
      { stat: 'CON', why: T('A modest life pool for a fighter who stands in melee range.', 'Скромний запас життя для бійця, що стоїть у ближньому бою.') },
    ],
    hotbar: [
      { skillId: 'mnk_five_element_combo', why: T('Five quick hits in one cast: the backbone of the combo.', 'П\'ять швидких ударів в одному касті: хребет комбо.') },
      { skillId: 'mnk_iron_palm', why: T('A heavy hit that cuts the target\'s armor for the rest of your combo.', 'Важкий удар, що знижує броню цілі для решти вашого комбо.') },
      { skillId: 'mnk_exploding_palm', why: T('Echo: repeats after 2 s for 60% of the damage.', 'Відлуння: повторюється через 2 с на 60% шкоди.') },
      { skillId: 'mnk_echo_palm', why: T('Echo: repeats after 1 s for the full damage. Fire it right after Exploding Palm so both echoes land together.', 'Відлуння: повторюється через 1 с на повну шкоду. Пускайте одразу після «{mnk_exploding_palm}», щоб обидва відлуння збіглися.') },
      { skillId: 'mnk_ego_crusher', why: T('The heaviest single hit on the bar; it also silences for a moment.', 'Найважчий одиночний удар на панелі; ще й на мить змушує мовчати.') },
      { skillId: 'mnk_tiger_stance', why: T('+25% movement speed and +30% attack speed: keep it running.', '+25% швидкості руху та +30% швидкості атаки: тримайте увімкненою.') },
      { skillId: 'mnk_drunken_brawler_stance', why: T('35% chance to dodge, and every dodge counter-strikes.', '35% шансу ухилитися, а кожне ухиляння завдає контрудару.') },
      { skillId: 'mnk_inner_peace', why: T('Heals 10% of your life per second for a few seconds: a mid-fight heal.', 'Лікує 10% життя за секунду кілька секунд: лікування посеред бою.') },
      { skillId: 'mnk_zen_focus', why: T('Immune to stuns and slows for a short window.', 'Імунітет до оглушень і сповільнень на короткий час.') },
    ],
    earlySkills: [
      { skillId: 'mnk_wind_palm', note: T('A cheap hit with knockback: your opener before the combos unlock.', 'Дешевий удар зі відкиданням: ваше відкриття, доки не відкрилися комбо.') },
      { skillId: 'mnk_tiger_claw', note: T('Cuts armor and bleeds: a good early damage skill.', 'Знижує броню й викликає кровотечу: добра рання навичка шкоди.') },
    ],
    gear: [
      T('Weapon: a dagger (DEX) or bare hands. Do not use a quarterstaff: Monk skills accept only unarmed, melee or dagger weapons.', 'Зброя: кинджал (СПР) або голі руки. Не беріть посох: навички Монаха приймають лише порожні руки, ближню зброю чи кинджал.'),
      T('Armour: a focus off-hand (WIS), hood, boots and gloves (DEX), and robes (INT) while the stats allow.', 'Броня: фокус у другій руці (МУД), каптур, чоботи й рукавиці (СПР) та мантія (ІНТ), поки дозволяють характеристики.'),
      T('Good affixes: of_clarity (+WIS), crit and dodge rolls.', 'Хороші афікси: of_clarity (+МУД), шанс крита й ухиляння.'),
    ],
    weaknesses: [
      T('Every strike costs mana: keep the mana regeneration nodes and never fight on an empty pool.', 'Кожен удар коштує мани: беріть вузли відновлення мани й ніколи не б\'йтеся з порожнім запасом.'),
      T('Short reach: you must stay in the target\'s face, which is dangerous against bosses with area attacks.', 'Коротка дистанція: ви мусите стояти впритул до цілі, що небезпечно проти босів з атаками по площі.'),
      T('Less healing than the Spirit Guardian build: dodge and Inner Peace are all you have.', 'Менше лікування, ніж у білді «Дух-охоронець»: ваше лише ухиляння та «{mnk_inner_peace}».'),
    ],
  },

  {
    id: 'monk_guardian',
    className: 'Monk',
    name: T('Spirit Guardian', 'Дух-охоронець'),
    summary: T(
      'A durable support-fighter: resistances, life and mana regeneration and auras from the tree, a bar full of shields and heals, and area skills that wear enemies down while you stand your ground.',
      'Витривалий боєць підтримки: опір шкоді, відновлення життя й мани та аури з дерева, панель зі щитами й лікуванням і площинні навички, що виснажують ворогів, поки ви тримаєте позицію.',
    ),
    playstyle: T(
      'Switch on {mnk_fast_mana_aura} first, then pull the group into {mnk_sphere_of_harmony} and {mnk_zen_bell_resonance}. {mnk_chi_wave} chains between targets and {mnk_spirit_burst} knocks them back and weakens what they deal. {mnk_jade_body} covers you against magic, {mnk_diamond_skin} absorbs a burst, {mnk_touch_of_life} is the emergency heal and {mnk_karma_redirection} sends damage back.',
      'Спершу вмикайте «{mnk_fast_mana_aura}», потім затягуйте групу в «{mnk_sphere_of_harmony}» і «{mnk_zen_bell_resonance}». «{mnk_chi_wave}» перескакує між цілями, а «{mnk_spirit_burst}» відкидає ворогів і послаблює їхню шкоду. «{mnk_jade_body}» захищає від магії, «{mnk_diamond_skin}» поглинає сплеск шкоди, «{mnk_touch_of_life}» — екстрене лікування, а «{mnk_karma_redirection}» повертає шкоду назад.',
    ),
    stats: [
      { stat: 'WIS', why: T('Multiplies every Monk skill (+5% per point), adds mana regeneration and powers the aura nodes on the route.', 'Множить кожну навичку Монаха (+5% за очко), додає відновлення мани й живить вузли аур на маршруті.') },
      { stat: 'CON', why: T('Life and the gem requirements: this build wants a big pool and the resistance nodes next to it.', 'Життя та вимоги самоцвітів: цей білд хоче великий запас і поруч вузли опору.') },
      { stat: 'INT', why: T('A little mana, and the Transcendence node brings it along with WIS.', 'Трохи мани; вузол «Трансцендентність» приносить її разом з МУД.') },
    ],
    hotbar: [
      { skillId: 'mnk_chi_wave', why: T('Chains to three more targets: your pack damage and a way to keep several enemies busy.', 'Перескакує ще на три цілі: ваша шкода по групі та спосіб тримати кількох ворогів зайнятими.') },
      { skillId: 'mnk_sphere_of_harmony', why: T('Leaves a damaging area on the ground: pull enemies into it.', 'Лишає на землі зону, що завдає шкоди: затягуйте в неї ворогів.') },
      { skillId: 'mnk_zen_bell_resonance', why: T('A heavier zone for bosses and dense packs.', 'Важча зона для босів і щільних груп.') },
      { skillId: 'mnk_spirit_burst', why: T('Knocks back and cuts the damage the target deals by half for a few seconds.', 'Відкидає й удвічі зменшує шкоду цілі на кілька секунд.') },
      { skillId: 'mnk_jade_body', why: T('-40% magic damage taken for a short window: the answer to casters and bosses.', '-40% отриманої магічної шкоди на коротке вікно: відповідь на чарівників і босів.') },
      { skillId: 'mnk_diamond_skin', why: T('Absorbs 500 damage: press it before a known burst.', 'Поглинає 500 шкоди: вмикайте перед відомим сплеском шкоди.') },
      { skillId: 'mnk_touch_of_life', why: T('Heals 30% of your life at once: the emergency heal.', 'Миттєво лікує 30% життя: екстрене лікування.') },
      { skillId: 'mnk_karma_redirection', why: T('Reflects 50% of the damage you take for a short window.', 'Відбиває 50% отриманої шкоди на коротке вікно.') },
      { skillId: 'mnk_fast_mana_aura', why: T('Doubles your mana regeneration: never let it lapse.', 'Подвоює відновлення мани: ніколи не дозволяйте йому згаснути.') },
    ],
    earlySkills: [
      { skillId: 'mnk_hundred_fists', note: T('A cheap channeled attack: your sustained damage before the area skills unlock.', 'Дешева канальна атака: ваша тривала шкода, доки не відкрилися площинні навички.') },
      { skillId: 'mnk_mantis_strike', note: T('Cuts the damage the target deals: a tanky early hit.', 'Зменшує шкоду цілі: витривалий ранній удар.') },
    ],
    gear: [
      T('Weapon: a dagger (DEX) or bare hands; damage matters less than staying alive.', 'Зброя: кинджал (СПР) або голі руки; шкода тут менш важлива, ніж виживання.'),
      T('Armour: a focus off-hand (WIS) and anything with resistances; robes (INT) while the stats allow.', 'Броня: фокус у другій руці (МУД) і все, що дає опір; мантія (ІНТ), поки дозволяють характеристики.'),
      T('Good affixes: of_clarity (+WIS), of_the_bear (+HP), resistance rolls.', 'Хороші афікси: of_clarity (+МУД), of_the_bear (+ЗДР), опір.'),
    ],
    weaknesses: [
      T('Low damage: you win by lasting longer than the enemy, which is slow against groups and bosses with an enrage.', 'Низька шкода: ви перемагаєте, витримуючи довше за ворога, а це повільно проти груп і босів з люттю.'),
      T('Most of the bar is on long timers: plan the order of your defensive skills before the pull.', 'Більшість панелі має довгі перезарядки: плануйте порядок захисних навичок до початку бою.'),
      T('Physical damage is only partly covered: take the physical resistance nodes on the route.', 'Фізична шкода покрита лише частково: беріть вузли фізичного опору на маршруті.'),
    ],
  },
];
