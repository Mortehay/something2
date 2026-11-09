// Extra Cultist builds. See warrior.mjs for the conventions ({skill_id} placeholders, no cost/cooldown numbers).
// Cultist spells cost LIFE, not mana: their cost is not quoted as a mana/stamina number anywhere here.
const T = (en, uk) => ({ en, uk });

export default [
  {
    id: 'cultist_bone',
    className: 'Cultist',
    name: T('Bone Warlock', 'Кістяний чаклун'),
    summary: T(
      'A heavy-hitting caster of bone and blood: big area and single-target spells, summons, life-cost reduction and leech from the tree, and a few strong defensive buffs to cover the life you spend.',
      'Чаклун кісток і крові з важкими ударами: потужні площинні й одноцільові закляття, прикликання, зменшення вартості життям та вампіризм з дерева і кілька сильних захисних підсилень, що покривають витрачене життя.',
    ),
    playstyle: T(
      'Open with {cul_blood_pact}, call {cul_summon_blood_golem} and lay {cul_death_decay} and {cul_bone_storm} under the pack. {cul_bone_spear} and {cul_corpse_explosion} are the cheap fillers, and {cul_final_rite} is the big finisher. Keep {cul_bone_armor} for the next heavy hits and {cul_blood_rebirth} as the last safety net.',
      'Починайте з «{cul_blood_pact}», прикличте «{cul_summon_blood_golem}» й кладіть «{cul_death_decay}» та «{cul_bone_storm}» під групу. «{cul_bone_spear}» і «{cul_corpse_explosion}» — дешеві наповнювачі, а «{cul_final_rite}» — великий добивальник. «{cul_bone_armor}» бережіть для наступних важких ударів, а «{cul_blood_rebirth}» — як останню страховку.',
    ),
    stats: [
      { stat: 'CON', why: T('Double value: +10 HP per point and +5% skill damage, since every Cultist skill uses CON. The route puts almost everything here.', 'Подвійна цінність: +10 ЗДР за очко та +5% шкоди навичок, бо всі навички Культиста використовують СТА. Маршрут вкладає сюди майже все.') },
      { stat: 'INT', why: T('A gem requirement on most Cultist skills; the route takes only what the gems ask for.', 'Вимога самоцвітів на більшості навичок Культиста; маршрут бере лише те, чого вони вимагають.') },
      { stat: 'CHA', why: T('Needed for scepters and a few gems; a small amount is enough.', 'Потрібна для скіпетрів і кількох самоцвітів; достатньо невеликої кількості.') },
    ],
    hotbar: [
      { skillId: 'cul_bone_spear', why: T('Three bone hits for a big total at a low life cost: the main single-target filler.', 'Три кістяні удари з великою сумою за невеликий кошт життя: основний одноцільовий наповнювач.') },
      { skillId: 'cul_corpse_explosion', why: T('A cheap blast with a short wait: spam it between the heavier spells.', 'Дешевий вибух із короткою перезарядкою: пускайте між важчими закляттями.') },
      { skillId: 'cul_bone_storm', why: T('A heavy hit that leaves a damaging zone for several seconds: good against packs and bosses.', 'Важкий удар, що лишає зону шкоди на кілька секунд: добре проти груп і босів.') },
      { skillId: 'cul_summon_blood_golem', why: T('A golem that fights for you and draws attacks off you.', 'Голем, що б\'ється за вас і відволікає на себе атаки.') },
      { skillId: 'cul_death_decay', why: T('A damaging zone that also cuts armor by 20% for a few seconds.', 'Зона шкоди, що ще й знижує броню на 20% на кілька секунд.') },
      { skillId: 'cul_final_rite', why: T('The biggest hit on the bar, on a long timer: your finisher for bosses.', 'Найбільший удар на панелі з довгою перезарядкою: ваш добивальник для босів.') },
      { skillId: 'cul_blood_pact', why: T('+25% damage dealt and -10% damage taken for 60 s: keep it running.', '+25% завданої шкоди та -10% отриманої на 60 с: тримайте увімкненою.') },
      { skillId: 'cul_bone_armor', why: T('Negates the next three hits: your shield against heavy blows.', 'Скасовує наступні три удари: ваш щит від важких атак.') },
      { skillId: 'cul_blood_rebirth', why: T('Revives you with 40% life once, when you would die: the last safety net.', 'Один раз воскрешає вас із 40% життя, коли ви мали б померти: остання страховка.') },
    ],
    earlySkills: [
      { skillId: 'cul_sacrificial_stab', note: T('A cheap hit that heals you a little: your first safe damage with the dagger.', 'Дешевий удар, що трохи лікує вас: перша безпечна шкода з кинджалом.') },
      { skillId: 'cul_vein_ripper', note: T('Bleeds the target and hits bleeding targets harder.', 'Викликає кровотечу й сильніше б\'є ціль, що кровоточить.') },
    ],
    gear: [
      T('Weapon: a dagger for the skills of level 1-15, then a staff or wand type; a scepter (CHA) is the realistic choice. Swap by hand.', 'Зброя: кинджал для навичок 1-15 рівня, далі посох чи паличка; реальний вибір — скіпетр (ХАР). Міняйте вручну.'),
      T('Armour: CON greaves (the only gear for your main stat), otherwise plate by STR or robes by INT within the plan.', 'Броня: наголінники на СТА (єдине спорядження для вашої головної характеристики), решта — пластини на СИЛ чи мантії на ІНТ у межах плану.'),
      T('Good affixes: of_vigor (+CON) and of_the_bear (+HP).', 'Хороші афікси: of_vigor (+СТА) і of_the_bear (+ЗДР).'),
    ],
    weaknesses: [
      T('The first levels are fragile: every cast costs life, so lean on the leech skills early.', 'Перші рівні крихкі: кожен каст коштує життя, тож на старті спирайтеся на навички з вампіризмом.'),
      T('If your life is below a skill\'s cost the cast fails: keep {cul_bone_armor} and {cul_blood_rebirth} ready.', 'Якщо життя менше за ціну навички, каст не вдається: тримайте «{cul_bone_armor}» і «{cul_blood_rebirth}» напоготові.'),
      T('Little protection against crowd control and almost no mana: do not rely on mana effects.', 'Мало захисту від контролю й майже немає мани: не покладайтеся на ефекти мани.'),
    ],
  },

  {
    id: 'cultist_curse',
    className: 'Cultist',
    name: T('Plague Doctor', 'Чумний лікар'),
    summary: T(
      'A debuff caster that wins by attrition: poison, bleed and curses that make enemies take more and deal less, backed by leech, life regeneration and resistances from the tree.',
      'Чаклун дебафів, що перемагає виснаженням: отрута, кровотеча та прокляття, через які вороги отримують більше шкоди й завдають менше, а в тилу — вампіризм, відновлення життя й опір з дерева.',
    ),
    playstyle: T(
      'Spread {cul_black_plague} through the pack, add {cul_hemophilia} and {cul_plague_globule} for damage over time, then stack {cul_curse_of_vulnerability}, {cul_curse_of_doom} and {cul_curse_of_frailty} on the big target. {cul_vampiric_embrace} keeps your life up while the effects work. {cul_bone_armor} and {cul_blood_rebirth} are the safety nets.',
      'Розносіть «{cul_black_plague}» по групі, додайте «{cul_hemophilia}» і «{cul_plague_globule}» для шкоди з часом, а потім накладайте «{cul_curse_of_vulnerability}», «{cul_curse_of_doom}» і «{cul_curse_of_frailty}» на велику ціль. «{cul_vampiric_embrace}» тримає ваше життя, поки ефекти працюють. «{cul_bone_armor}» і «{cul_blood_rebirth}» — страховки.',
    ),
    stats: [
      { stat: 'CON', why: T('Life and skill damage in one stat. The route keeps taking it, with the leech and regeneration nodes next to it.', 'Життя й шкода навичок в одній характеристиці. Маршрут постійно бере її разом з вузлами вампіризму та відновлення поруч.') },
      { stat: 'CHA', why: T('A gem requirement on several curses, and it opens scepters.', 'Вимога самоцвітів на кількох прокляттях; відкриває скіпетри.') },
      { stat: 'WIS', why: T('A small amount for the curse gems that ask for it.', 'Невелика кількість для самоцвітів-прокляттів, які цього вимагають.') },
    ],
    hotbar: [
      { skillId: 'cul_plague_globule', why: T('A cheap poison hit: your damage-over-time filler.', 'Дешевий удар з отрутою: ваш наповнювач для шкоди з часом.') },
      { skillId: 'cul_black_plague', why: T('Poisons and chains to three more targets: spread it through the whole pack.', 'Отруює й перескакує ще на три цілі: розносьте по всій групі.') },
      { skillId: 'cul_hemophilia', why: T('A long bleed on a single target.', 'Довга кровотеча на одній цілі.') },
      { skillId: 'cul_curse_of_vulnerability', why: T('The target takes 40% more damage for 10 s: the first curse on a boss.', 'Ціль отримує на 40% більше шкоди 10 с: перше прокляття на босі.') },
      { skillId: 'cul_curse_of_doom', why: T('Echo: repeats after 10 s for 200% of the damage: a delayed big hit.', 'Відлуння: повторюється через 10 с на 200% шкоди: відкладений великий удар.') },
      { skillId: 'cul_curse_of_frailty', why: T('The target deals 35% less damage for 12 s: your defence against a single hard hitter.', 'Ціль завдає на 35% менше шкоди 12 с: ваш захист від одного сильного ворога.') },
      { skillId: 'cul_vampiric_embrace', why: T('Heals you for 30% of the damage you deal: strong with damage over time.', 'Лікує на 30% завданої шкоди: добре працює зі шкодою з часом.') },
      { skillId: 'cul_bone_armor', why: T('Negates the next three hits.', 'Скасовує наступні три удари.') },
      { skillId: 'cul_blood_rebirth', why: T('Revives you with 40% life once, when you would die.', 'Один раз воскрешає вас із 40% життя, коли ви мали б померти.') },
    ],
    earlySkills: [
      { skillId: 'cul_sacrificial_stab', note: T('A cheap hit that heals you a little: your first safe damage with the dagger.', 'Дешевий удар, що трохи лікує вас: перша безпечна шкода з кинджалом.') },
      { skillId: 'cul_flesh_siphon_strike', note: T('Heals you for the full damage it deals: your best early sustain.', 'Лікує на всю завдану шкоду: ваше найкраще раннє підтримання.') },
    ],
    gear: [
      T('Weapon: a dagger for the skills of level 1-15, then a staff or wand type; a scepter (CHA) is the realistic choice.', 'Зброя: кинджал для навичок 1-15 рівня, далі посох чи паличка; реальний вибір — скіпетр (ХАР).'),
      T('Armour: CON greaves and anything with resistances; the route takes resistance nodes, so pick gear for life.', 'Броня: наголінники на СТА та все, що дає опір; маршрут бере вузли опору, тож обирайте спорядження на здоров\'я.'),
      T('Good affixes: of_vigor (+CON), of_the_bear (+HP), life leech rolls.', 'Хороші афікси: of_vigor (+СТА), of_the_bear (+ЗДР), вампіризм.'),
    ],
    weaknesses: [
      T('Slow to kill: damage over time needs a few seconds to build, so quick burst fights are not your strength.', 'Повільно вбиває: шкода з часом потребує кількох секунд, тож швидкі бої на вибух шкоди — не ваша сильна сторона.'),
      T('Curses are skills with long timers: plan which target gets which curse.', 'Прокляття — це навички з довгими перезарядками: плануйте, яка ціль отримає яке прокляття.'),
      T('Bosses shrug off some status effects: check what a boss ignores before you stack debuffs on it.', 'Боси ігнорують частину статусів: перевіряйте, що бос ігнорує, перш ніж накладати дебафи.'),
    ],
  },
];
