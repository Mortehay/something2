// Ukrainian overlay for buildGuides.data.js: identical shape, keys and ids (node keys,
// skillIds, slots, numbers); only the human text is translated. getBuildGuide() returns
// this when the interface language is Ukrainian. A parity test keeps the two in step.

export const BUILD_GUIDES_UK = {
  "Warrior": {
    "className": "Warrior",
    "name": "Сталевий вир",
    "summary": "Одноручний боєць ближнього бою: основна шкода йде від автоатаки, посиленої СИЛ і доведеної до межі перезарядки, плюс короткі кругові сплески «Безжалісного шквалу».",
    "playstyle": "Тримайте кнопку атаки на цілі й вмикайте «Безжалісний шквал» на 2-4 такти поспіль; довгі канали швидко стають дорогими. Перед важкими боями підтримуйте «Бойовий клич» і «Загартування сталлю». Живучість дають ЗДР з дерева та два постійні захисні шари.",
    "stats": [
      {
        "stat": "STR",
        "why": "Подвійна цінність: множить кожен удар зброєю і кожну навичку Воїна та відкриває яруси зброї. План: СИЛ 358 на 150 очках."
      },
      {
        "stat": "DEX",
        "why": "+3% швидкості за очко до межі перезарядки (0.40, або 0.35 з «Прудкістю»). План: СПР 45 на 30 очках, 84 на 150."
      },
      {
        "stat": "CON",
        "why": "+10 ЗДР за очко, +0.1 ЗДР/с і вимога самоцвітів (до 22). План: СТА 163 для 2266 ЗДР."
      }
    ],
    "hotbar": [
      {
        "slot": 1,
        "skillId": "war_flurry_of_steel",
        "name": "Безжалісний шквал",
        "unlock": "Рів. 17 · завдання act1_sunspire_reliquary · 2138 з",
        "why": "Основний круговий сплеск за 4 витривалості на такт. Вмикайте короткими серіями по 2-4 такти."
      },
      {
        "slot": 2,
        "skillId": "war_twin_slash",
        "name": "Подвійний змах",
        "unlock": "Рів. 12 · 1600 з",
        "why": "Дешевий засіб проти однієї цілі: 2 удари за 14 витривалості з перезарядкою 2 с."
      },
      {
        "slot": 3,
        "skillId": "war_windblade",
        "name": "Лезо вітру",
        "unlock": "Рів. 39 · завдання act2_obsidian_drake · 4713 з",
        "why": "Ваша єдина атака здалеку, що оплачується з мани, яка інакше простоює (14 мани, перезарядка 3 с, дальність 320)."
      },
      {
        "slot": 4,
        "skillId": "war_sunder_armor",
        "name": "Розлом броні",
        "unlock": "Рів. 52 · завдання act4_primordial_sovereign (таємний самоцвіт) · 6575 з",
        "why": "Удар по області за 11 витривалості, що ще й зменшує броню на 35% на 12 с. Починайте з нього бій із зграєю, потім бийте ослаблених."
      },
      {
        "slot": 5,
        "skillId": "war_battle_shout",
        "name": "Бойовий клич",
        "unlock": "Рів. 42 · завдання act3_nether_behemoth (таємний самоцвіт) · 5125 з",
        "why": "Єдине підсилення шкоди: шкода x1.2 на 20 с із перезарядкою 30 с (приблизно 67% часу дії)."
      },
      {
        "slot": 6,
        "skillId": "war_steel_tempering",
        "name": "Загартування сталлю",
        "unlock": "Рів. 48 · завдання act3_nether_behemoth (таємний самоцвіт) · 6025 з",
        "why": "-15% отриманої шкоди на 30 с із перезарядкою 30 с: майже постійний захисний шар."
      },
      {
        "slot": 7,
        "skillId": "war_colossus_stance",
        "name": "Стійка велетня",
        "unlock": "Рів. 46 · завдання act3_nether_behemoth (таємний самоцвіт) · 5675 з",
        "why": "+30% макс. ЗДР і x1.25 дальності на 15 с (перезарядка 50 с). Використовуйте проти босів і щільних груп."
      },
      {
        "slot": 8,
        "skillId": "war_bloodlust_stance",
        "name": "Жага крові",
        "unlock": "Рів. 45 · завдання act3_nether_behemoth (таємний самоцвіт) · 5538 з",
        "why": "До +30% швидкості атаки за 20 витривалості. Корисна лише нижче межі швидкості; згодом замініть на «Непохитність» (р. 47)."
      },
      {
        "slot": 9,
        "skillId": "war_last_stand",
        "name": "Останній рубіж",
        "unlock": "Рів. 47 · завдання act3_nether_behemoth (таємний самоцвіт) · 5888 з",
        "why": "Екстрена кнопка: ЗДР не можуть впасти нижче 1 протягом 4 с (перезарядка 120 с)."
      }
    ],
    "earlySkills": [
      {
        "skillId": "war_crushing_blow",
        "name": "Нищівний удар",
        "level": 1,
        "note": "Стартова трійка (100 з). Потрібно лише 1-2 СИЛ із перших малих вузлів."
      },
      {
        "skillId": "war_whirlwind",
        "name": "Вихор клинка",
        "level": 1,
        "note": "Канальний круговий удар за 5 витривалості на такт; користуйтеся, доки його не замінить «Безжалісний шквал»."
      },
      {
        "skillId": "war_hamstring_slash",
        "name": "Розсікання жил",
        "level": 1,
        "note": "Третя стартова навичка. План на р. 1-11: «Вихор клинка» + «Нищівний удар» + «Розсікання жил»."
      },
      {
        "skillId": "war_punishing_strike",
        "name": "Каральний випад",
        "level": 10,
        "note": "Наступне покращення ближнього бою перед «Подвійним змахом»."
      }
    ],
    "passives": {
      "startKey": "start-strength",
      "steps": [
        {
          "key": "strength-r1-0-4",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r1-0-5",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r1-0-6",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r1-0-7",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r1-0-8",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r2-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-22",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-21",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-20",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-19",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "strength-r3-3-13",
          "label": "Незламність — +20 СИЛ і +100 макс. життя",
          "kind": "keystone"
        },
        {
          "key": "strength-r3-3-14",
          "label": "Бойова майстерність",
          "kind": "greater"
        },
        {
          "key": "strength-r3-3-15",
          "label": "Відродження",
          "kind": "notable"
        },
        {
          "key": "strength-r3-3-12",
          "label": "Дар мандрівника",
          "kind": "greater"
        },
        {
          "key": "strength-r4-2-19",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r4-3-1",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "strength-r4-2-18",
          "label": "Жорстокість",
          "kind": "notable"
        },
        {
          "key": "strength-r4-2-23",
          "label": "Натиск",
          "kind": "notable"
        },
        {
          "key": "strength-r4-2-22",
          "label": "Відступництво",
          "kind": "greater"
        },
        {
          "key": "strength-r4-2-24",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "strength-r3-3-5",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-1",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r4-2-20",
          "label": "Невтомність",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-0-2",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-6",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-14",
          "label": "Заточеність",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-13",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-12",
          "label": "Бичача кров",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-11",
          "label": "Взірець",
          "kind": "greater"
        },
        {
          "key": "strength-r4-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-15",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-13",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-2-19",
          "label": "Безрозсудний змах — +25% фізичної шкоди, -10% стійкості до льоду",
          "kind": "keystone"
        },
        {
          "key": "strength-r4-2-2",
          "label": "Дисципліна",
          "kind": "minor"
        },
        {
          "key": "strength-r4-2-1",
          "label": "Друге дихання",
          "kind": "minor"
        },
        {
          "key": "strength-r4-2-5",
          "label": "Дисципліна",
          "kind": "minor"
        },
        {
          "key": "strength-r4-2-6",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "strength-r4-2-7",
          "label": "Апофеоз",
          "kind": "notable"
        },
        {
          "key": "clu_str_afterimage-hub",
          "label": "Залишкова подоба",
          "kind": "greater"
        },
        {
          "key": "strength-r4-2-3",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "strength-r3-3-2",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "strength-r3-3-7",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "strength-r3-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r2-4-8",
          "label": "Залізна шкіра — +140 макс. життя і +1.2 ЗДР/с відновлення",
          "kind": "keystone"
        },
        {
          "key": "strength-r2-4-7",
          "label": "Дилетант",
          "kind": "minor"
        },
        {
          "key": "strength-r2-4-6",
          "label": "Заточеність",
          "kind": "notable"
        },
        {
          "key": "strength-r3-3-8",
          "label": "Широта",
          "kind": "minor"
        },
        {
          "key": "strength-r3-3-9",
          "label": "Апофеоз",
          "kind": "notable"
        },
        {
          "key": "strength-r3-0-15",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-13",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-2-30",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "strength-r3-3-1",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "strength-r3-3-0",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "strength-r3-2-36",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "strength-r3-2-35",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "strength-r3-0-12",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-11",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-10",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-9",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-8",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-7",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-6",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-5",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r2-1-27",
          "label": "Кат — +15% фізичної шкоди і +12 дальності ближнього бою",
          "kind": "keystone"
        },
        {
          "key": "strength-r3-1-21",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-29",
          "label": "Гарт",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-28",
          "label": "Лезо",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-27",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "strength-r3-1-26",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "strength-r3-0-4",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-3",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-2",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-1",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-8",
          "label": "Широта",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-3",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-2",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-5",
          "label": "Апофеоз",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-3-13",
          "label": "Прудкість — ваша межа перезарядки знижується з 0.40 до 0.35",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r3-3-12",
          "label": "Дар мандрівника",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-3-11",
          "label": "Відродження",
          "kind": "notable"
        },
        {
          "key": "dexterity-r2-4-8",
          "label": "Біг по вітру — +15 СПР, +40 макс. витривалості, +5 витривалості/с відновлення",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r3-3-14",
          "label": "Майстерність стрільця",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-3-15",
          "label": "Жорстокість",
          "kind": "notable"
        },
        {
          "key": "strength-r3-1-6",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-14",
          "label": "Джерело",
          "kind": "notable"
        },
        {
          "key": "strength-r3-1-13",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-12",
          "label": "Нульове поле",
          "kind": "notable"
        },
        {
          "key": "strength-r3-1-11",
          "label": "Взірець",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-3-7",
          "label": "Широке навчання",
          "kind": "notable"
        },
        {
          "key": "clu_str_afterimage-sat0",
          "label": "Тривале лезо",
          "kind": "notable"
        },
        {
          "key": "clu_str_afterimage-sat1",
          "label": "Повільне горіння",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-0-3",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-4",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-5",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-21",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-29",
          "label": "Гарт",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-28",
          "label": "Лезо",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-27",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-26",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "constitution-r2-1-27",
          "label": "Оберіг від болю — +10% стійкості до фізичної шкоди та вогню, +1.2 ЗДР/с відновлення",
          "kind": "keystone"
        },
        {
          "key": "constitution-r3-0-6",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-7",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-8",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-9",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-10",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-11",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-12",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-13",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-15",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Багряна оборудка — кожна навичка б'є на 40% сильніше, але коштує на 30% більше життя",
          "kind": "keystone"
        },
        {
          "key": "constitution-r3-1-36",
          "label": "Всезнайко",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-8",
          "label": "Жорстокість",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-8",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-17",
          "label": "Розпалювання",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-16",
          "label": "Мозоль",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-15",
          "label": "Жорстокість",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-0",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-1",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-2",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-6",
          "label": "Вітер (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-7",
          "label": "Вітер (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-8",
          "label": "Натиск",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-1-9",
          "label": "Вітер (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-10",
          "label": "Вовчий аспект — +15 СИЛ, +15 ХАР, +12% фізичної шкоди, форми сильніші на 12%",
          "kind": "keystone"
        },
        {
          "key": "charisma-r3-0-3",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-4",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-5",
          "label": "Жили (СТА)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-1-27",
          "label": "Ведмежий аспект — +20 СИЛ, +120 ЗДР, +1.5 ЗДР/с відновлення, +5% фізичної стійкості, форми сильніші на 12%",
          "kind": "keystone"
        },
        {
          "key": "strength-r1-2-13",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "strength-r1-2-14",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "strength-r1-2-15",
          "label": "Невтомність",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-2-15",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-23",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-22",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-21",
          "label": "Заточеність",
          "kind": "notable"
        }
      ],
      "milestones": [
        {
          "points": 10,
          "summary": "СИЛ 27, 116 ЗДР, 118 мани. Поки лише малі вузли на шляху до «Незламності» (очко 12)."
        },
        {
          "points": 30,
          "summary": "СИЛ 95, СПР 45, СТА 37, 554 ЗДР. Взято «Бойову майстерність» (+10% шкоди навичок СИЛ) і кілька вузлів «Піднесення»/«Взірця»; інтервал атаки приблизно x0.45."
        },
        {
          "points": 60,
          "summary": "СИЛ 199, СТА 57, 966 ЗДР. Взято «Безрозсудний змах», «Залишкову подобу» та «Залізну шкіру»: фізична шкода +44%."
        },
        {
          "points": 100,
          "summary": "СИЛ 321, СПР 80, СТА 83, 1258 ЗДР. Взято «Ката», «Прудкість» і «Біг по вітру»; межа перезарядки 0.35."
        },
        {
          "points": 150,
          "summary": "СИЛ 358, СПР 84, СТА 163, 2266 ЗДР, 235 витривалості. Взято «Оберіг від болю», «Багряну оборудку» та вузли характеристик «Вовчого»/«Ведмежого аспекту»."
        }
      ],
      "keystones": [
        {
          "key": "strength-r3-3-13",
          "label": "Незламність — +20 СИЛ і +100 макс. життя",
          "atStep": 12,
          "note": "+20 СИЛ і +100 ЗДР; вхід у внутрішнє кільце СИЛ на очку 12. Без недоліків."
        },
        {
          "key": "strength-r3-3-14",
          "label": "Бойова майстерність",
          "atStep": 13,
          "note": "+10% шкоди всіх навичок СИЛ."
        },
        {
          "key": "strength-r3-2-19",
          "label": "Безрозсудний змах — +25% фізичної шкоди, -10% стійкості до льоду",
          "atStep": 38,
          "note": "+25% фізичної шкоди, але -10% стійкості до льоду. Пропустіть, якщо б'єтеся з крижаними босами."
        },
        {
          "key": "clu_str_afterimage-hub",
          "label": "Залишкова подоба",
          "atStep": 44,
          "note": "Хвиля ближнього бою, що дає 15% шкоди змаху за секунду (+5% від кожного з двох супутників). Без недоліків."
        },
        {
          "key": "strength-r2-4-8",
          "label": "Залізна шкіра — +140 макс. життя і +1.2 ЗДР/с відновлення",
          "atStep": 50,
          "note": "+140 ЗДР і +1.2 ЗДР/с відновлення. Без недоліків."
        },
        {
          "key": "strength-r2-1-27",
          "label": "Кат — +15% фізичної шкоди і +12 дальності ближнього бою",
          "atStep": 71,
          "note": "+15% фізичної шкоди і +12 дальності. Без недоліків."
        },
        {
          "key": "dexterity-r3-3-13",
          "label": "Прудкість — ваша межа перезарядки знижується з 0.40 до 0.35",
          "atStep": 89,
          "note": "Межа перезарядки 0.35: найшвидша атака та найнижча перезарядка."
        },
        {
          "key": "dexterity-r2-4-8",
          "label": "Біг по вітру — +15 СПР, +40 макс. витривалості, +5 витривалості/с відновлення",
          "atStep": 92,
          "note": "+15 СПР, +40 витривалості та +5 відновлення витривалості."
        },
        {
          "key": "constitution-r2-1-27",
          "label": "Оберіг від болю — +10% стійкості до фізичної шкоди та вогню, +1.2 ЗДР/с відновлення",
          "atStep": 111,
          "note": "+10% стійкості до фізичної шкоди та вогню, +1.2 ЗДР/с відновлення."
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Багряна оборудка — кожна навичка б'є на 40% сильніше, але коштує на 30% більше життя",
          "atStep": 123,
          "note": "Шкода навичок x1.4. Штраф у вигляді витрат життя для Воїна нічого не означає, тож це чистий бонус."
        },
        {
          "key": "charisma-r3-1-10",
          "label": "Вовчий аспект — +15 СИЛ, +15 ХАР, +12% фізичної шкоди, форми сильніші на 12%",
          "atStep": 139,
          "note": "Береться лише як джерело СИЛ/ЗДР на шляху; сила форм для Воїна марна (за бажання замініть на «Піднесення»)."
        },
        {
          "key": "charisma-r2-1-27",
          "label": "Ведмежий аспект — +20 СИЛ, +120 ЗДР, +1.5 ЗДР/с відновлення, +5% фізичної стійкості, форми сильніші на 12%",
          "atStep": 143,
          "note": "Береться лише як джерело СИЛ/ЗДР (+20 СИЛ, +120 ЗДР); сила форм не потрібна."
        }
      ]
    },
    "gear": [
      "Зброя: одноручний клинок на СИЛ: меч (дальність 85), сокира (більше шкоди за удар) або клинок. Зброя 2-го ярусу і вище не коштує витривалості.",
      "Яруси зброї за СИЛ: залізна 8, сталева 16, гартована 26, рунна 36, обсидіанова 48, астральна 62, порожнечі 78, драконяча 96, міфічна 116.",
      "Оминайте дворучну зброю (дворучний меч, алебарда, коса): це старе спорядження 1-го ярусу, що коштує 15-18 витривалості за змах.",
      "Обладунок: латне спорядження на СИЛ (шолом, лати, рукавиці, баклер) плюс поножі на СТА. Броня зменшує кожен удар на фіксоване значення.",
      "Персні потребують ХАР; з ХАР 44 можна носити аж до рунної смуги (36). Добрі афікси: of_might, of_the_bear, of_vigor."
    ],
    "weaknesses": [
      "Лише 190 мани на 150 очках: «Лезо вітру» вичерпує ману за кілька застосувань, тож не покладайтеся на магічні навички.",
      "Немає ні атаки здалеку, ні мобільності. Б'йтеся впритул; допомагають «Стійка велетня» (дальність x1.25) і скупчення «Розсікальний розмах».",
      "-10% стійкості до льоду, якщо взяти «Безрозсудний змах».",
      "Витривалість - ваш єдиний справжній ресурс (запас 235, відновлення 25/с): уникайте довгих каналів «Шквалу».",
      "Власного надійного контролю натовпу немає, крім кількох оглушень і сповільнень на навичках; за потреби «Залізна воля» (р. 44) дає імунітет до станів на 5 с. Боси імунні до оглушення, прикутості, мовчання й страху."
    ]
  },
  "Mage": {
    "className": "Mage",
    "name": "Ритм льоду й вогню",
    "summary": "Заклинач здалеку з двома додатковими снарядами: чергує лід і вогонь, щоб запускати «Розкол» і «Тепловий шок», а захищається «Щитом мани» і телепортацією.",
    "playstyle": "Починайте з «Елементального фокусування», далі чергуйте «Крижану стрілу» та «Вогняну кулю», щоб кожна пара запускала синергію; завершуйте «Чародійними стрілами», а проти груп вмикайте «Хуртовину». Постійно підтримуйте «Щит мани» і тікайте від небезпеки телепортацією.",
    "stats": [
      {
        "stat": "INT",
        "why": "Множить кожну навичку Мага (+5% за очко), додає 10 мани за очко та 0.5 мани/с відновлення. План: ІНТ 392."
      },
      {
        "stat": "WIS",
        "why": "+0.5 мани/с за очко; самоцвіти вимагають близько 22. План досягає МУД 73, цього з запасом."
      },
      {
        "stat": "DEX",
        "why": "Спершу шлях до «Влучного ока» та «Залпу», потім швидкість: СПР 96 разом із «Прудкістю» досягає межі 0.35."
      },
      {
        "stat": "CON",
        "why": "Лише близько 10 для самоцвітів і трохи ЗДР, бо Маг починає з 75 ЗДР. План: 724 ЗДР."
      }
    ],
    "hotbar": [
      {
        "slot": 1,
        "skillId": "mag_frostbolt",
        "name": "Крижана стріла",
        "unlock": "Рів. 17 · завдання act1_sunspire_reliquary · 2138 з",
        "why": "Дешева крижана стріла (20 мани, 1.5 с). З +2 снарядами б'є тричі. Запускає синергію «Розкол»."
      },
      {
        "slot": 2,
        "skillId": "mag_fireball",
        "name": "Вогняна куля",
        "unlock": "Рів. 16 · завдання act1_sunspire_reliquary · 2000 з",
        "why": "Вогняний снаряд по області, також 3 удари. Завершує «Розкол» і готує «Тепловий шок»; чергуйте з «Крижаною стрілою»."
      },
      {
        "slot": 3,
        "skillId": "mag_magic_missiles",
        "name": "Чародійні стріли",
        "unlock": "Рів. 31 · завдання act2_obsidian_drake · 3688 з",
        "why": "Багатоударне: 7 ударів із додатковими снарядами за 22 мани. Найкраща шкода на одиницю мани серед заклять по одній цілі."
      },
      {
        "slot": 4,
        "skillId": "mag_blizzard",
        "name": "Хуртовина",
        "unlock": "Рів. 29 · завдання act2_obsidian_drake · 3488 з",
        "why": "Канальний льодяний удар по області під курсором, 6 мани за такт. Ваше відновлення підтримує його безкінечно."
      },
      {
        "slot": 5,
        "skillId": "mag_blink",
        "name": "Телепортація (Blink)",
        "unlock": "Рів. 26 · завдання act1_sunspire_reliquary · 3150 з",
        "why": "Єдина справжня навичка пересування: приблизно 260 px уперед із перезарядкою 4 с. Рятує тендітного мага."
      },
      {
        "slot": 6,
        "skillId": "mag_mana_shield",
        "name": "Щит мани",
        "unlock": "Рів. 42 · завдання act3_nether_behemoth (таємний самоцвіт) · 5125 з",
        "why": "70% отриманої шкоди сплачується з мани. Застосування коштує 25 мани й триває 30 с: поновлюйте, коли воно закінчується, і не вмикайте на порожньому запасі."
      },
      {
        "slot": 7,
        "skillId": "mag_empower_elements",
        "name": "Посилення стихій",
        "unlock": "Рів. 50 · завдання act3_nether_behemoth (таємний самоцвіт) · 6300 з",
        "why": "Шкода x1.3 на 15 с (перезарядка 30 с); діє разом із «Чародійним інтелектом»."
      },
      {
        "slot": 8,
        "skillId": "mag_arcane_brilliance",
        "name": "Чародійний інтелект",
        "unlock": "Рів. 46 · завдання act3_nether_behemoth (таємний самоцвіт) · 5675 з",
        "why": "Шкода x1.25 на 30 с (перезарядка 60 с): вмикайте у вікна для босів, а не за кожної нагоди."
      },
      {
        "slot": 9,
        "skillId": "mag_elemental_focus",
        "name": "Елементальне фокусування",
        "unlock": "Рів. 47 · завдання act3_nether_behemoth (таємний самоцвіт) · 5888 з",
        "why": "Наступні 3 закляття завжди стають критичними. Застосуйте перед «Чародійними стрілами» або «Крижаною стрілою»."
      }
    ],
    "earlySkills": [
      {
        "skillId": "mag_arcane_dagger",
        "name": "Чародійський кинджал",
        "level": 1,
        "note": "Перша навичка (100 з). Тип ближнього бою, але потрібно тримати посох або жезл."
      },
      {
        "skillId": "mag_frost_rapier",
        "name": "Крижаний укол",
        "level": 1,
        "note": "Друга стартова навичка; теж потребує посоха або жезла в руці."
      },
      {
        "skillId": "mag_mana_blades",
        "name": "Клинки мани",
        "level": 6,
        "note": "Остання рання навичка ближнього типу; до р. 16 ваша шкода здалеку - це автоатака жезлом."
      }
    ],
    "passives": {
      "startKey": "start-intelligence",
      "steps": [
        {
          "key": "intelligence-r1-0-4",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-3",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-2",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-1",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-8",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-22",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-21",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-20",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-19",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-13",
          "label": "Трансцендентність — +25 МУД і +18 ІНТ",
          "kind": "keystone"
        },
        {
          "key": "wisdom-r3-3-12",
          "label": "Дар мандрівника",
          "kind": "greater"
        },
        {
          "key": "wisdom-r3-3-11",
          "label": "Груба шкіра",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-3-10",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-9",
          "label": "Відродження",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-1",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-2",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-1-6",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-1-14",
          "label": "Заточеність",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-1-13",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-1-12",
          "label": "Бичача кров",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-1-11",
          "label": "Взірець",
          "kind": "greater"
        },
        {
          "key": "intelligence-r1-0-5",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-6",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-7",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-8",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-1",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-2",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-3",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-4",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-5",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-1-27",
          "label": "Влучне око — +20 СПР і +1 додаткова стріла",
          "kind": "keystone"
        },
        {
          "key": "intelligence-r3-1-10",
          "label": "Кріомантія — +20% шкоди льодом, а ваші удари охолоджують",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r2-1-28",
          "label": "Дилетант",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-2-0",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "dexterity-r4-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-22",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-21",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-20",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-19",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-2-19",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-3-1",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "intelligence-r4-3-0",
          "label": "Нульове поле",
          "kind": "notable"
        },
        {
          "key": "intelligence-r4-2-24",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "intelligence-r3-3-13",
          "label": "Чародійний провідник — +15 ІНТ, +35 макс. мани, +3.0 мани/с відновлення",
          "kind": "keystone"
        },
        {
          "key": "intelligence-r3-3-14",
          "label": "Чародійна майстерність",
          "kind": "greater"
        },
        {
          "key": "intelligence-r3-3-5",
          "label": "Широке навчання",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-3-2",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-7",
          "label": "Друга дисципліна",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-1-21",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-22",
          "label": "Дилетант",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-23",
          "label": "Рефлекси мисливця",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-1-24",
          "label": "Дилетант",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-25",
          "label": "Витривалий",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-6",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-1-9",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-1-8",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-1-13",
          "label": "Широта",
          "kind": "minor"
        },
        {
          "key": "clu_dex_volley-hub",
          "label": "Залп",
          "kind": "greater"
        },
        {
          "key": "intelligence-r4-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-15",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-13",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-2-2",
          "label": "Дисципліна",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-2-1",
          "label": "Друге дихання",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-2-5",
          "label": "Дисципліна",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-2-6",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "intelligence-r4-2-3",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-3-15",
          "label": "Розпалювання",
          "kind": "notable"
        },
        {
          "key": "intelligence-r4-2-18",
          "label": "Обмороження",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-0-3",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-4",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-5",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-1-27",
          "label": "Піромантія — +20% шкоди вогнем, а ваші удари підпалюють",
          "kind": "keystone"
        },
        {
          "key": "intelligence-r3-1-21",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-1-29",
          "label": "Гарт",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-1-28",
          "label": "Лезо",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-1-27",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-1-26",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "intelligence-r1-3-16",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-4-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-4-1",
          "label": "Широке навчання",
          "kind": "notable"
        },
        {
          "key": "intelligence-r2-1-28",
          "label": "Дилетант",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-2-0",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-15",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-13",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-2-30",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-1",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-0",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-2-36",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-2-35",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "intelligence-r3-2-19",
          "label": "Скляна гармата — кожна навичка б'є на 35% сильніше й коштує на 25% більше мани, -80 макс. життя",
          "kind": "keystone"
        },
        {
          "key": "intelligence-r3-1-25",
          "label": "Витривалий",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-0-6",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-1-9",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-1-16",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "intelligence-r4-1-15",
          "label": "Приголомшливі удари",
          "kind": "notable"
        },
        {
          "key": "intelligence-r4-1-14",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "intelligence-r2-4-8",
          "label": "Грозовий поклик — +20% шкоди блискавкою, а ваші удари вражають шоком",
          "kind": "keystone"
        },
        {
          "key": "intelligence-r2-4-9",
          "label": "Гарт",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-4-10",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "intelligence-r2-4-11",
          "label": "Дисципліна",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-4-12",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "dexterity-r4-0-7",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-8",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-9",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-10",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-11",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-12",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-13",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-15",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-19",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-13",
          "label": "Прудкість — ваша межа перезарядки знижується з 0.40 до 0.35",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r3-3-12",
          "label": "Дар мандрівника",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-2-19",
          "label": "Примарний крок — 15% шансу повністю ухилитися від удару, +20 макс. витривалості",
          "kind": "keystone"
        },
        {
          "key": "intelligence-r3-2-31",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-2-32",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-0-12",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-11",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-10",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-3-3",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-3-4",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-3-5",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "intelligence-r2-3-2",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-3-1",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "intelligence-r4-2-20",
          "label": "Резонанс",
          "kind": "notable"
        },
        {
          "key": "intelligence-r2-4-7",
          "label": "Мозоль",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-4-6",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "wisdom-r4-2-19",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-2-18",
          "label": "Обмороження",
          "kind": "notable"
        },
        {
          "key": "wisdom-r4-3-1",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "wisdom-r4-2-20",
          "label": "Резонанс",
          "kind": "notable"
        },
        {
          "key": "intelligence-r2-1-26",
          "label": "Дилетант",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-1-25",
          "label": "Могутні жили",
          "kind": "notable"
        }
      ],
      "milestones": [
        {
          "points": 10,
          "summary": "ІНТ 15, МУД 16, 262 мани, 91 ЗДР. Дванадцять малих вузлів ведуть до «Трансцендентності» на очку 13."
        },
        {
          "points": 30,
          "summary": "ІНТ 101, МУД 45, 1134 мани, 262 ЗДР. Взято «Трансцендентність», «Дар мандрівника» та «Взірець»; усі вимоги самоцвітів виконано."
        },
        {
          "points": 60,
          "summary": "ІНТ 164, СПР 57, 1841 мани. Взято «Влучне око», «Кріомантію», «Чародійний провідник» і «Чародійну майстерність» (+1 снаряд, +20% льоду)."
        },
        {
          "points": 100,
          "summary": "ІНТ 275, 2963 мани, 553 ЗДР. Взято «Залп» (другий додатковий снаряд) і «Піромантію»; шкода вогню та льоду +28%."
        },
        {
          "points": 150,
          "summary": "ІНТ 392, СПР 96, 4145 мани, 724 ЗДР. Взято «Скляну гармату», «Грозовий поклик», «Прудкість» і «Примарний крок»; межа перезарядки 0.35."
        }
      ],
      "keystones": [
        {
          "key": "wisdom-r3-3-13",
          "label": "Трансцендентність — +25 МУД і +18 ІНТ",
          "atStep": 13,
          "note": "+25 МУД і +18 ІНТ; точка входу на очку 13. Без недоліків."
        },
        {
          "key": "dexterity-r2-1-27",
          "label": "Влучне око — +20 СПР і +1 додаткова стріла",
          "atStep": 38,
          "note": "+20 СПР і +1 снаряд. Без недоліків."
        },
        {
          "key": "intelligence-r3-1-10",
          "label": "Кріомантія — +20% шкоди льодом, а ваші удари охолоджують",
          "atStep": 39,
          "note": "+20% шкоди льодом і стан охолодження. Без недоліків."
        },
        {
          "key": "intelligence-r3-3-13",
          "label": "Чародійний провідник — +15 ІНТ, +35 макс. мани, +3.0 мани/с відновлення",
          "atStep": 51,
          "note": "+15 ІНТ, +35 мани та +3 мани/с відновлення. Без недоліків."
        },
        {
          "key": "intelligence-r3-3-14",
          "label": "Чародійна майстерність",
          "atStep": 52,
          "note": "+10% шкоди навичок ІНТ."
        },
        {
          "key": "clu_dex_volley-hub",
          "label": "Залп",
          "atStep": 65,
          "note": "Другий +1 снаряд, разом +2: закляття з одним ударом б'ють тричі."
        },
        {
          "key": "intelligence-r2-1-27",
          "label": "Піромантія — +20% шкоди вогнем, а ваші удари підпалюють",
          "atStep": 82,
          "note": "+20% шкоди вогнем і стан горіння. Без недоліків."
        },
        {
          "key": "intelligence-r3-2-19",
          "label": "Скляна гармата — кожна навичка б'є на 35% сильніше й коштує на 25% більше мани, -80 макс. життя",
          "atStep": 104,
          "note": "Шкода навичок x1.35, але -80 макс. ЗДР і +25% вартості мани. Компенсується «Щитом мани»; альтернатива - «Багряна оборудка»."
        },
        {
          "key": "intelligence-r2-4-8",
          "label": "Грозовий поклик — +20% шкоди блискавкою, а ваші удари вражають шоком",
          "atStep": 111,
          "note": "+20% шкоди блискавкою і стан шоку. Без недоліків."
        },
        {
          "key": "dexterity-r3-3-13",
          "label": "Прудкість — ваша межа перезарядки знижується з 0.40 до 0.35",
          "atStep": 129,
          "note": "Межа перезарядки 0.35."
        },
        {
          "key": "dexterity-r3-2-19",
          "label": "Примарний крок — 15% шансу повністю ухилитися від удару, +20 макс. витривалості",
          "atStep": 131,
          "note": "+15% ухилення та +20 витривалості. Без недоліків."
        }
      ]
    },
    "gear": [
      "Зброя: жезл (одноручний, потребує ІНТ) або посох (дворучний). Жезли й посохи за ярусами не мають стихії, тож їхня автоатака залежить від СИЛ, а не ІНТ.",
      "Виправте це каменем заміни (stone_of_*) у зброї: він дає стихію, шкоду й перезарядку, і тоді атака залежить від ІНТ.",
      "Обладунок: мантії (ІНТ), каптури (СПР), фокус у другу руку (МУД) і шолом чародійного захисту (+30% чародійної стійкості). Мантії дають приблизно вдвічі менший захист, ніж лати.",
      "Персні потребують ХАР (у Мага 11), тож реалістична лише залізна смуга. Добрі афікси: of_the_well, of_insight, of_the_bear."
    ],
    "weaknesses": [
      "Лише 724 ЗДР на 150 очках, а щит залежить від мани: уникайте боїв із порожнім запасом, наприклад одразу після відродження.",
      "Низький фізичний захист і 18% ухилення: тримайте дистанцію, користуйтеся телепортацією щойно вона перезарядиться, а «Ефірний стан» (р. 49) тримайте про запас.",
      "Вартість мани від «Скляної гармати» додається до будь-яких майбутніх вузлів вартості мани.",
      "Кожна навичка з р. 16 закрита завданнями актів (акт 1 для р. 16-27, акт 2 для р. 28-39, акт 3 для р. 40-51).",
      "Контроль короткий: «Крижаний вибух» прикуває на 3 с, «Перевтілення» оглушує на 5 с, «Крижана стріла» сповільнює. Боси імунні до оглушення й прикутості."
    ]
  },
  "Monk": {
    "className": "Monk",
    "name": "Потік ці",
    "summary": "Напівмагічний боєць на величезному запасі мани: канальні «Вихор монаха» та «Промінь нефритового змія» ніколи не вичерпуються, а стартовий вузол перетворює відновлення мани на життя.",
    "playstyle": "Починайте бій з «Аури відновлення мани» і підтримуйте «Стійку тигра». Рухайтеся короткими кроками між сплесками «Вихору монаха»; пауза понад 0.6 с скидає наростання каналу й тримає витрати низькими. Проти босів вмикайте «Промінь нефритового змія».",
    "stats": [
      {
        "stat": "WIS",
        "why": "Множить усі навички Монаха (+5% за очко), додає 0.5 мани/с відновлення і з «Переповненням ці» ще +2 макс. мани за очко. План: МУД 366."
      },
      {
        "stat": "DEX",
        "why": "Вимога самоцвітів до 24 і +3% швидкості за очко. План: СПР 45."
      },
      {
        "stat": "STR",
        "why": "Вимога самоцвітів близько 15 на кожну навичку Монаха. План: СИЛ 23."
      },
      {
        "stat": "CON",
        "why": "Вимога самоцвітів близько 15 і ваше джерело ЗДР (1725 ЗДР на 150 очках). План: СТА 137."
      }
    ],
    "hotbar": [
      {
        "slot": 1,
        "skillId": "mnk_spinning_crane_kick",
        "name": "Вихор монаха",
        "unlock": "Рів. 22 · завдання act1_sunspire_reliquary · 2675 з",
        "why": "Круговий канал за 4 мани на такт; ваше відновлення підтримує його навіть при повному наростанні каналу. Основна шкода по області."
      },
      {
        "slot": 2,
        "skillId": "mnk_jade_serpent_beam",
        "name": "Промінь нефритового змія",
        "unlock": "Рів. 32 · завдання act2_obsidian_drake · 3825 з",
        "why": "Канальний конус здалеку, дальність 400. Для окремих цілей і відступу з атакою."
      },
      {
        "slot": 3,
        "skillId": "mnk_flowing_strike",
        "name": "Атака нескінченного потоку",
        "unlock": "Рів. 29 · завдання act2_obsidian_drake · 3488 з",
        "why": "Заповнювач: 15 базової шкоди за 8 мани з перезарядкою 2 с, найвигідніший ближній удар по одній цілі."
      },
      {
        "slot": 4,
        "skillId": "mnk_spirit_burst",
        "name": "Духовний вибух",
        "unlock": "Рів. 35 · завдання act2_obsidian_drake · 4163 з",
        "why": "Радіальний вибух навколо курсора: 20 базової шкоди за 19 мани (перезарядка 4 с)."
      },
      {
        "slot": 5,
        "skillId": "mnk_dragons_breath",
        "name": "Вогняне дихання дракона",
        "unlock": "Рів. 39 · завдання act2_obsidian_drake · 4713 з",
        "why": "Конусний вибух для груп: 22 базової шкоди за 20 мани (перезарядка 4 с)."
      },
      {
        "slot": 6,
        "skillId": "mnk_tiger_stance",
        "name": "Стійка тигра",
        "unlock": "Рів. 46 · завдання act3_nether_behemoth (таємний самоцвіт) · 5675 з",
        "why": "+25% швидкості руху та x1.3 швидкості атаки на 30 с. Тримайте ввімкненою; швидкість атаки допомагає лише нижче межі."
      },
      {
        "slot": 7,
        "skillId": "mnk_fast_mana_aura",
        "name": "Аура відновлення мани",
        "unlock": "Рів. 42 · завдання act3_nether_behemoth (таємний самоцвіт) · 5125 з",
        "why": "Подвоює відновлення мани на 30 с за 12 мани. Оновлюйте кожні 30 с."
      },
      {
        "slot": 8,
        "skillId": "mnk_diamond_skin",
        "name": "Алмазна шкіра",
        "unlock": "Рів. 47 · завдання act3_nether_behemoth (таємний самоцвіт) · 5888 з",
        "why": "Поглинає 500 шкоди протягом 20 с (30 мани, перезарядка 40 с): стіна проти сильних ударів."
      },
      {
        "slot": 9,
        "skillId": "mnk_touch_of_life",
        "name": "Дотик життя",
        "unlock": "Рів. 47 · завдання act3_nether_behemoth (таємний самоцвіт) · 5813 з",
        "why": "Миттєве зцілення на 30% макс. ЗДР (35 мани, перезарядка 10 с)."
      }
    ],
    "earlySkills": [
      {
        "skillId": "mnk_wind_palm",
        "name": "Удар долонею вітру",
        "level": 1,
        "note": "Перша навичка (100 з): 8 мани, перезарядка 2 с."
      },
      {
        "skillId": "mnk_twin_serpent_strike",
        "name": "Подвійний серп",
        "level": 2,
        "note": "Відновлює ману при влучанні."
      },
      {
        "skillId": "mnk_hundred_fists",
        "name": "Кулак сотні тіней",
        "level": 8,
        "note": "Круговий канал; на р. 22 його замінює «Вихор монаха»."
      },
      {
        "skillId": "mnk_mantis_strike",
        "name": "Удар богомола",
        "level": 12,
        "note": "Навичка ближнього бою середини раннього етапу, до каналу р. 22."
      }
    ],
    "passives": {
      "startKey": "start-wisdom",
      "steps": [
        {
          "key": "wisdom-r1-0-4",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-5",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-6",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-7",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-8",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-22",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-21",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-20",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-19",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-13",
          "label": "Трансцендентність — +25 МУД і +18 ІНТ",
          "kind": "keystone"
        },
        {
          "key": "wisdom-r3-3-12",
          "label": "Дар мандрівника",
          "kind": "greater"
        },
        {
          "key": "wisdom-r3-3-11",
          "label": "Груба шкіра",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-3-10",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-9",
          "label": "Відродження",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-3-8",
          "label": "Широта",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-3",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-7",
          "label": "Друга дисципліна",
          "kind": "notable"
        },
        {
          "key": "wisdom-r1-0-3",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-2",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-1",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-8",
          "label": "Зосередженість (СТА)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-0-14",
          "label": "Бадьорість (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-18",
          "label": "Бадьорість (СТА)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-17",
          "label": "Бадьорість (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-16",
          "label": "Бадьорість (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-4-8",
          "label": "Яструбиний аспект — +20 СПР, +40 макс. витривалості, +4 витривалості/с відновлення, +8% швидкості атаки, форми сильніші на 12%",
          "kind": "keystone"
        },
        {
          "key": "charisma-r3-3-8",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-3-9",
          "label": "Друга дисципліна",
          "kind": "notable"
        },
        {
          "key": "wisdom-r4-2-19",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-3-1",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-3-10",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-3-11",
          "label": "Відродження",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-3-12",
          "label": "Дар мандрівника",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-3-13",
          "label": "Звіринець — «Аспект дикої природи» (+25 ХАР, +15 СТА, +30 макс. мани, +2.0 мани/с відновлення, форми сильніші на 15%)",
          "kind": "keystone"
        },
        {
          "key": "wisdom-r4-3-0",
          "label": "Нульове поле",
          "kind": "notable"
        },
        {
          "key": "wisdom-r4-2-24",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "wisdom-r3-3-14",
          "label": "Внутрішня майстерність",
          "kind": "greater"
        },
        {
          "key": "wisdom-r3-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-1",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-2",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-6",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-14",
          "label": "Заточеність",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-1-13",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-12",
          "label": "Бичача кров",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-1-11",
          "label": "Взірець",
          "kind": "greater"
        },
        {
          "key": "wisdom-r3-0-3",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-4",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-5",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-1-27",
          "label": "Внутрішнє полум'я — +20 МУД",
          "kind": "keystone"
        },
        {
          "key": "wisdom-r3-1-21",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-29",
          "label": "Гарт",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-28",
          "label": "Лезо",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-27",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-1-26",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "wisdom-r3-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-4-8",
          "label": "Медитація — +70 макс. мани, +2.0 мани/с відновлення, +5% частки життя від відновлення мани",
          "kind": "keystone"
        },
        {
          "key": "charisma-r3-3-14",
          "label": "Дика майстерність",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-3-15",
          "label": "Жорстокість",
          "kind": "notable"
        },
        {
          "key": "wisdom-r4-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-15",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-13",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-2-19",
          "label": "Переповнення ці — +30% шкоди навичок, поки мани майже повно, +2 макс. мани за МУД, навички коштують на 15% більше мани",
          "kind": "keystone"
        },
        {
          "key": "wisdom-r4-2-2",
          "label": "Дисципліна",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-2-1",
          "label": "Друге дихання",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-2-5",
          "label": "Дисципліна",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-2-6",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "wisdom-r4-2-3",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "charisma-r1-0-7",
          "label": "Зосередженість (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-6",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-5",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-4",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-3",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-2",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-1",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-0",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-8",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Багряна оборудка — кожна навичка б'є на 40% сильніше, але коштує на 30% більше життя",
          "kind": "keystone"
        },
        {
          "key": "wisdom-r2-1-28",
          "label": "Дилетант",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-2-0",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-4-9",
          "label": "Гарт",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-10",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-4-11",
          "label": "Дисципліна",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-12",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-0-15",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-13",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-2-30",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-1",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-3-0",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-2-36",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-2-35",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-0-15",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-13",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-12",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-11",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-10",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-9",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-8",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-36",
          "label": "Всезнайко",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-8",
          "label": "Жорстокість",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-2-7",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-6",
          "label": "Груба шкіра",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-2-5",
          "label": "Відступництво",
          "kind": "greater"
        },
        {
          "key": "wisdom-r3-1-25",
          "label": "Витривалий",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-0-6",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-1-9",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-1-16",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "wisdom-r4-1-15",
          "label": "Приголомшливі удари",
          "kind": "notable"
        },
        {
          "key": "wisdom-r4-1-14",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "wisdom-r4-1-13",
          "label": "Широта",
          "kind": "minor"
        },
        {
          "key": "clu_wis_clarity-hub",
          "label": "Ясність",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-2-15",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-23",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-22",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-21",
          "label": "Заточеність",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-2-30",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-1",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-0",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-36",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-2-35",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "wisdom-r2-4-9",
          "label": "Мозоль",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-4-10",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "wisdom-r2-4-11",
          "label": "Гарт",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-4-12",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "wisdom-r2-4-13",
          "label": "Дисципліна",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-4-3",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "wisdom-r2-4-4",
          "label": "Переповнений дух",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-8",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-17",
          "label": "Розпалювання",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-16",
          "label": "Мозоль",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-15",
          "label": "Жорстокість",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-2-31",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-2-32",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "wisdom-r1-3-6",
          "label": "Друге дихання",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-3-14",
          "label": "Економія рухів",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-3-13",
          "label": "Економія рухів",
          "kind": "minor"
        },
        {
          "key": "wisdom-r1-3-12",
          "label": "Переповнений дух",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-1-22",
          "label": "Дилетант",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-23",
          "label": "Швидкі руки",
          "kind": "notable"
        }
      ],
      "milestones": [
        {
          "points": 10,
          "summary": "МУД 27, 106 ЗДР, 128 мани, 21 мани/с відновлення. Самі малі вузли на шляху до «Трансцендентності» (очко 12)."
        },
        {
          "points": 30,
          "summary": "МУД 62, СПР 35, СТА 22, 349 ЗДР. Взято «Трансцендентність» і «Яструбиний аспект»; +40 витривалості, швидкість атаки +8%."
        },
        {
          "points": 60,
          "summary": "МУД 206, СТА 41, 774 мани, 142 мани/с відновлення. Взято «Звіринець», «Внутрішню майстерність», «Внутрішнє полум'я» та «Медитацію»."
        },
        {
          "points": 100,
          "summary": "МУД 280, СТА 70, 959 ЗДР. Взято «Переповнення ці» (+30% шкоди при мані 80%+) і «Багряну оборудку» (x1.4)."
        },
        {
          "points": 150,
          "summary": "МУД 366, СТА 137, 1725 ЗДР, 1566 мани, 224 мани/с відновлення; 25% відновленої мани повертається як життя. Взято «Ясність» і «Швидкі руки»."
        }
      ],
      "keystones": [
        {
          "key": "wisdom-r3-3-13",
          "label": "Трансцендентність — +25 МУД і +18 ІНТ",
          "atStep": 12,
          "note": "+25 МУД і +18 ІНТ; вхід у ядро МУД на очку 12. Без недоліків."
        },
        {
          "key": "charisma-r2-4-8",
          "label": "Яструбиний аспект — +20 СПР, +40 макс. витривалості, +4 витривалості/с відновлення, +8% швидкості атаки, форми сильніші на 12%",
          "atStep": 29,
          "note": "+20 СПР, +40 витривалості, +8% швидкості атаки. Береться як джерело СПР; без недоліків."
        },
        {
          "key": "charisma-r3-3-13",
          "label": "Звіринець — «Аспект дикої природи» (+25 ХАР, +15 СТА, +30 макс. мани, +2.0 мани/с відновлення, форми сильніші на 15%)",
          "atStep": 37,
          "note": "ХАР/СТА, +30 мани та +2 мани/с відновлення. Береться заради характеристик на шляху; без недоліків."
        },
        {
          "key": "wisdom-r3-3-14",
          "label": "Внутрішня майстерність",
          "atStep": 40,
          "note": "+10% шкоди навичок МУД."
        },
        {
          "key": "wisdom-r2-1-27",
          "label": "Внутрішнє полум'я — +20 МУД",
          "atStep": 52,
          "note": "+20 МУД. Без недоліків."
        },
        {
          "key": "wisdom-r2-4-8",
          "label": "Медитація — +70 макс. мани, +2.0 мани/с відновлення, +5% частки життя від відновлення мани",
          "atStep": 59,
          "note": "+70 мани, +2 мани/с і +5% частки життя. Без недоліків."
        },
        {
          "key": "wisdom-r3-2-19",
          "label": "Переповнення ці — +30% шкоди навичок, поки мани майже повно, +2 макс. мани за МУД, навички коштують на 15% більше мани",
          "atStep": 68,
          "note": "+30% шкоди навичок, поки мани 80% і більше, та +2 мани за МУД, за +15% вартості мани. Ваше відновлення це покриває."
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Багряна оборудка — кожна навичка б'є на 40% сильніше, але коштує на 30% більше життя",
          "atStep": 87,
          "note": "Шкода навичок x1.4; +30% вартості життя нічого не коштує, бо в Монаха немає навичок із витратою життя."
        },
        {
          "key": "clu_wis_clarity-hub",
          "label": "Ясність",
          "atStep": 122,
          "note": "+10% частки життя від відновлення мани."
        }
      ]
    },
    "gear": [
      "Зброя: кинджал (СПР, перезарядка 0.45, +15% шансу крита) або голі руки (3 шкоди). Рунний кинджал (р. 55) підходить до запланованих СПР 45.",
      "Не використовуйте бойовий посох: за назвою він рахується посохом, а навички Монаха приймають лише бій без зброї, зброю ближнього бою або кинджали.",
      "Обладунок: фокус у другу руку (МУД, єдине спорядження під вашу головну характеристику), каптур/чоботи/рукавиці (СПР) і мантії (ІНТ 63 вистачає до 5-го ярусу).",
      "Добрі афікси: of_clarity (+МУД) і of_the_well (+мана на фокусі та перснях)."
    ],
    "weaknesses": [
      "Автоатака слабка (без зброї 3 шкоди x1.9 СИЛ), тож шкода йде від навичок, що коштують ману. Не допускайте, щоб «Аура відновлення мани» згасала.",
      "Немає мобільності: канали сягають лише 120 px, а «Промінь нефритового змія» - 400 px. Користуйтеся «Стійкою тигра» (+25% швидкості).",
      "Середній запас ЗДР (1725). Допомагають «Алмазна шкіра» та «Дотик життя»; альтернативи - «Стійка п'яного майстра» (р. 44) і «Перенаправлення енергії (Карма)» (р. 50).",
      "Самоцвіти з р. 22 до р. 47 закриті завданнями на босів актів 1-3.",
      "«Удар просвітлення» дає +150% (разом 250%) лише при повній мані, тож починайте з нього; «Переповнення ці» тримає запас повним."
    ]
  },
  "Cultist": {
    "className": "Cultist",
    "name": "Спокута кров'ю",
    "summary": "Заклинач на життєвій силі: СТА дає і шкоду навичок, і ЗДР, закляття коштують фіксовані 15-50 ЗДР, а вампіризм разом із «Кривавим договором» тримає вас на плаву.",
    "playstyle": "Закляття коштують фіксовані ЗДР, що стає дрібницею при 4000+ ЗДР. Тримайте «Витягування душі» для зцілення й шкоди, додавайте «Кістяне списометання» та «Спис із крові» для сплесків і підтримуйте «Кривавий договір». «Броня з кісток», «Регенерація вампіра» та «Переродження у крові» - ваша страховка.",
    "stats": [
      {
        "stat": "CON",
        "why": "Подвійна цінність: +10 ЗДР за очко та +5% шкоди навичок (усі 50 навичок Культиста залежать від СТА). План: СТА 390 для 4294 ЗДР."
      },
      {
        "stat": "INT",
        "why": "Вимога самоцвітів до 25; майже кожна навичка Культиста потребує ІНТ. План: ІНТ 28."
      },
      {
        "stat": "CHA",
        "why": "Вимога самоцвітів до 28, а скіпетри потребують ХАР (6-й ярус: 48, 7-й: 62). План: ХАР 70."
      }
    ],
    "hotbar": [
      {
        "slot": 1,
        "skillId": "cul_soul_drain",
        "name": "Витягування душі",
        "unlock": "Рів. 31 · завдання act2_obsidian_drake · 3688 з",
        "why": "Канал із вампіризмом за 3 ЗДР на такт; вампіризм 35% плюс бонуси дерева. Ваша головна навичка шкоди й виживання."
      },
      {
        "slot": 2,
        "skillId": "cul_bone_spear",
        "name": "Кістяне списометання",
        "unlock": "Рів. 35 · завдання act2_obsidian_drake · 4163 з",
        "why": "Снаряд: 15 базової шкоди за 30 ЗДР з перезарядкою 2 с. Стабільна шкода; у плані немає додаткових снарядів."
      },
      {
        "slot": 3,
        "skillId": "cul_blood_lance",
        "name": "Спис із крові",
        "unlock": "Рів. 17 · завдання act1_sunspire_reliquary · 2138 з",
        "why": "Снаряд: 13 базової шкоди за 35 ЗДР (дальність 440). Ваша основа до «Витягування душі» на р. 31."
      },
      {
        "slot": 4,
        "skillId": "cul_corpse_explosion",
        "name": "Вибух трупа",
        "unlock": "Рів. 20 · завдання act1_sunspire_reliquary · 2475 з",
        "why": "Найдешевша за ЗДР: 15 ЗДР з перезарядкою 2 с, вибух по області навколо курсора."
      },
      {
        "slot": 5,
        "skillId": "cul_blood_boil",
        "name": "Кипіння крові",
        "unlock": "Рів. 19 · завдання act1_sunspire_reliquary · 2338 з",
        "why": "Шкода по області для груп: 18 базової шкоди за 40 ЗДР з перезарядкою 5 с."
      },
      {
        "slot": 6,
        "skillId": "cul_blood_pact",
        "name": "Кривавий договір",
        "unlock": "Рів. 42 · завдання act3_nether_behemoth (таємний самоцвіт) · 5125 з",
        "why": "Коштує трохи життя, триває 60 с: шкода x1.25 і отримана шкода x0.9. Оновлюйте раз на хвилину."
      },
      {
        "slot": 7,
        "skillId": "cul_vampiric_embrace",
        "name": "Регенерація вампіра",
        "unlock": "Рів. 45 · завдання act3_nether_behemoth (таємний самоцвіт) · 5538 з",
        "why": "30% вампіризму на 15 с. Не накопичується разом із «Витягуванням душі», тож використовуйте з «Кістяним списометанням» або «Списом із крові»."
      },
      {
        "slot": 8,
        "skillId": "cul_bone_armor",
        "name": "Броня з кісток",
        "unlock": "Рів. 43 · завдання act3_nether_behemoth (таємний самоцвіт) · 5263 з",
        "why": "Повністю поглинає 3 удари (30 ЗДР, перезарядка 30 с)."
      },
      {
        "slot": 9,
        "skillId": "cul_blood_rebirth",
        "name": "Переродження у крові",
        "unlock": "Рів. 50 · завдання act3_nether_behemoth (таємний самоцвіт) · 6300 з",
        "why": "Воскрешає вас із 40% ЗДР і вибухом (перезарядка 180 с): страховка від смерті."
      }
    ],
    "earlySkills": [
      {
        "skillId": "cul_sacrificial_stab",
        "name": "Жертовний кинджал",
        "level": 1,
        "note": "Перша навичка (100 з): 15 ЗДР, перезарядка 1 с, вампіризм 35%. Потребує кинджала."
      },
      {
        "skillId": "cul_flesh_siphon_strike",
        "name": "Випивання плоті",
        "level": 2,
        "note": "Навичка вампіризму для гри з кинджалом на р. 1-15."
      },
      {
        "skillId": "cul_vein_ripper",
        "name": "Розрив судин",
        "level": 4,
        "note": "Навичка кинджала для р. 1-15. Не опускайтеся нижче вартості навички в ЗДР: для застосування має лишатися щонайменше 1 ЗДР."
      },
      {
        "skillId": "cul_vampiric_bite",
        "name": "Вампіричний укус",
        "level": 12,
        "note": "Остання навичка кинджала перед закляттями."
      },
      {
        "skillId": "cul_blood_orb",
        "name": "Кривава куля",
        "level": 16,
        "note": "Перше закляття посоха/жезла; з р. 16 потрібно тримати посох або жезл."
      }
    ],
    "passives": {
      "startKey": "start-constitution",
      "steps": [
        {
          "key": "constitution-r1-0-4",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-5",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-6",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-7",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-8",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-8",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-9",
          "label": "Друга дисципліна",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-10",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-11",
          "label": "Відродження",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-0-0",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-1",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-2",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-6",
          "label": "Вітер (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-14",
          "label": "Бичача кров (ХАР)",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-1-13",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-12",
          "label": "Дар мандрівника",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-3-13",
          "label": "Кривавий договір — витрати життя знижено на 15%",
          "kind": "keystone"
        },
        {
          "key": "constitution-r3-3-5",
          "label": "Апофеоз",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-0-19",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-19",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-3-1",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "constitution-r4-3-0",
          "label": "Заземлення",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-24",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "constitution-r1-0-3",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-2-3",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-2-11",
          "label": "Широта",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-2-10",
          "label": "Широта",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-12",
          "label": "Заземлення",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-1-11",
          "label": "Взірець (ХАР)",
          "kind": "greater"
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Багряна оборудка — кожна навичка б'є на 40% сильніше, але коштує на 30% більше життя",
          "kind": "keystone"
        },
        {
          "key": "constitution-r2-4-9",
          "label": "Гарт",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-10",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-4-11",
          "label": "Дисципліна",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-12",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-4-13",
          "label": "Дисципліна",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-3",
          "label": "Дилетант",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-15",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-13",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-30",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-1",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-0",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-36",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-2-35",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-3-14",
          "label": "Кривава майстерність",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-1-10",
          "label": "Вовчий аспект — +15 СИЛ, +15 ХАР, +12% фізичної шкоди, форми сильніші на 12%",
          "kind": "keystone"
        },
        {
          "key": "constitution-r1-0-2",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-1",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-1",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-2",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-6",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-7",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-8",
          "label": "Вогнетривкість",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-9",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-10",
          "label": "Вампіричний обряд — навички зцілюють 12% завданої шкоди, +2% макс. життя за вбивство",
          "kind": "keystone"
        },
        {
          "key": "constitution-r3-1-11",
          "label": "Взірець",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-1-12",
          "label": "Бичача кров",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-14",
          "label": "Заточеність",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-15",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-13",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-2",
          "label": "Дисципліна",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-1",
          "label": "Друге дихання",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-5",
          "label": "Дисципліна",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-6",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "constitution-r4-2-7",
          "label": "Апофеоз",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-2-19",
          "label": "Кривавий обряд — витрати життя знижено ще на 12%",
          "kind": "keystone"
        },
        {
          "key": "constitution-r4-2-3",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-20",
          "label": "Натиск",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-21",
          "label": "Резонанс",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-4-4",
          "label": "Кривавий фокус",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-10",
          "label": "Зцілення",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-9",
          "label": "Зцілення",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-14",
          "label": "Відкриті рани",
          "kind": "minor"
        },
        {
          "key": "clu_con_bloodletting-hub",
          "label": "Кровопускання",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-2-20",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-21",
          "label": "Заточеність",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-13",
          "label": "Відкриті рани",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-3",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-4",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-5",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-21",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-29",
          "label": "Гарт",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-28",
          "label": "Лезо",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-27",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-26",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-2-31",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-2-32",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-25",
          "label": "Витривалий",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-6",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-1-9",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-1-16",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-1-15",
          "label": "Приголомшливі удари",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-1-14",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "constitution-r4-1-13",
          "label": "Широта",
          "kind": "minor"
        },
        {
          "key": "clu_con_sanguine-hub",
          "label": "Кривава аура",
          "kind": "greater"
        },
        {
          "key": "clu_con_sanguine-sat0",
          "label": "Багряна спрага",
          "kind": "notable"
        },
        {
          "key": "clu_con_sanguine-sat1",
          "label": "Дедалі глибша спрага",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-1",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-2",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-3",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-1-1",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-1-2",
          "label": "Резонанс",
          "kind": "notable"
        },
        {
          "key": "strength-r4-0-22",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-21",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-20",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-19",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "strength-r3-3-13",
          "label": "Незламність — +20 СИЛ і +100 макс. життя",
          "kind": "keystone"
        },
        {
          "key": "strength-r3-3-12",
          "label": "Дар мандрівника",
          "kind": "greater"
        },
        {
          "key": "strength-r3-3-14",
          "label": "Бойова майстерність",
          "kind": "greater"
        },
        {
          "key": "strength-r3-3-15",
          "label": "Відродження",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-0-12",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-11",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-10",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-3",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-2",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-1",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-3-4",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-5",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-4-5",
          "label": "Витривалий",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-6",
          "label": "Кривавий голод",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-0-12",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-0-11",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-0-10",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-15",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-25",
          "label": "Широта",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-24",
          "label": "Широта",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-23",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-3-22",
          "label": "Резонанс",
          "kind": "notable"
        },
        {
          "key": "clu_con_bloodletting-sat0",
          "label": "Червоне жниво",
          "kind": "notable"
        },
        {
          "key": "constitution-r1-1-10",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-2-1",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-2-0",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-1-16",
          "label": "Кривавий фокус",
          "kind": "notable"
        },
        {
          "key": "clu_con_bloodletting-sat1",
          "label": "Скажене ненажерство",
          "kind": "notable"
        },
        {
          "key": "constitution-r2-1-27",
          "label": "Оберіг від болю — +10% стійкості до фізичної шкоди та вогню, +1.2 ЗДР/с відновлення",
          "kind": "keystone"
        },
        {
          "key": "constitution-r2-1-28",
          "label": "Дилетант",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-2-0",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "constitution-r1-2-9",
          "label": "Глибокий запас",
          "kind": "notable"
        }
      ],
      "milestones": [
        {
          "points": 10,
          "summary": "СТА 25, 350 ЗДР, 3.0 ЗДР/с відновлення. Стартовий вузол уже знижує витрати життя на 10%."
        },
        {
          "points": 30,
          "summary": "СТА 79, ХАР 27, 916 ЗДР. Взято «Другу дисципліну», «Відродження» та «Кривавий договір» (характеристики для самоцвітів виконано рано)."
        },
        {
          "points": 60,
          "summary": "СТА 152, ХАР 62, 1662 ЗДР. Взято «Багряну оборудку» (шкода навичок x1.4); множник витрат життя x1.05."
        },
        {
          "points": 100,
          "summary": "СТА 296, 3223 ЗДР, 33 ЗДР/с відновлення. Взято «Вампіричний обряд» і «Кривавий обряд»: 12% вампіризму навичок, витрати життя x0.93."
        },
        {
          "points": 150,
          "summary": "СТА 390, СИЛ 53, 4294 ЗДР, 43.7 ЗДР/с відновлення, 20% вампіризму навичок. Взято «Криваву ауру», «Незламність» та «Оберіг від болю»."
        }
      ],
      "keystones": [
        {
          "key": "constitution-r3-3-9",
          "label": "Друга дисципліна",
          "atStep": 11,
          "note": "+8 ХАР; перший вузол «податку» характеристик для самоцвітів."
        },
        {
          "key": "constitution-r3-3-11",
          "label": "Відродження",
          "atStep": 13,
          "note": "+12 ІНТ; другий вузол «податку» характеристик для самоцвітів."
        },
        {
          "key": "constitution-r3-3-13",
          "label": "Кривавий договір — витрати життя знижено на 15%",
          "atStep": 21,
          "note": "-15% витрат життя. Без недоліків."
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Багряна оборудка — кожна навичка б'є на 40% сильніше, але коштує на 30% більше життя",
          "atStep": 34,
          "note": "Шкода навичок x1.4, але +30% витрат життя: тут це справжній штраф, який компенсують стартовий вузол, «Кривавий договір» і «Кривавий обряд»."
        },
        {
          "key": "constitution-r3-1-10",
          "label": "Вампіричний обряд — навички зцілюють 12% завданої шкоди, +2% макс. життя за вбивство",
          "atStep": 62,
          "note": "12% вампіризму навичок і +2% ЗДР за вбивство. Без недоліків."
        },
        {
          "key": "constitution-r3-2-19",
          "label": "Кривавий обряд — витрати життя знижено ще на 12%",
          "atStep": 77,
          "note": "-12% витрат життя. Без недоліків."
        },
        {
          "key": "clu_con_bloodletting-hub",
          "label": "Кровопускання",
          "atStep": 85,
          "note": "+1% ЗДР за вбивство; скупчення «Кровопускання» додає супутники вампіризму."
        },
        {
          "key": "clu_con_sanguine-hub",
          "label": "Кривава аура",
          "atStep": 106,
          "note": "Вампіризм аури зцілює 2 ЗДР/с за кожного ворога поблизу (до 6). Слабкий, тож його можна замінити на «Могутні жили»/«Піднесення»."
        },
        {
          "key": "strength-r3-3-13",
          "label": "Незламність — +20 СИЛ і +100 макс. життя",
          "atStep": 119,
          "note": "+20 СИЛ і +100 ЗДР; береться як джерело СИЛ/СПР."
        },
        {
          "key": "constitution-r2-1-27",
          "label": "Оберіг від болю — +10% стійкості до фізичної шкоди та вогню, +1.2 ЗДР/с відновлення",
          "atStep": 147,
          "note": "+10% стійкості до фізичної шкоди та вогню. Без недоліків."
        }
      ]
    },
    "gear": [
      "Зброя до р. 16: кинджал (навички р. 1-15 його вимагають). З р. 16 потрібен посох або жезл; найреальніший вибір - скіпетр (ХАР).",
      "Скіпетри: обсидіановий потребує ХАР 48 / р. 70, астральний - ХАР 62 / р. 90. Скіпетри й жезли за ярусами не витрачають ману на автоатаки.",
      "Кинджал і скіпетр доведеться міняти вручну: навички р. 1-15 потребують кинджала, а р. 16+ - посоха або жезла.",
      "Обладунок: поножі на СТА (єдине спорядження під вашу головну характеристику); решту беріть у межах характеристик плану: лати за СИЛ, каптури за СПР, мантії за ІНТ.",
      "Добрі афікси: of_vigor (+СТА) і of_the_bear (+ЗДР)."
    ],
    "weaknesses": [
      "Р. 1-25 тендітні: при 110-350 ЗДР кожне застосування болить. Спочатку покладайтеся на «Жертовний кинджал» і «Випивання плоті» (вампіризм).",
      "Два набори зброї (спершу кинджал, пізніше скіпетр або жезл) і два «податки» на характеристики (ІНТ та ХАР).",
      "Лише 389 мани та жодного доброго захисту від контролю.",
      "«Кривава аура» та подібні вузли слабкі (менше 12 ЗДР/с): замініть їх вузлами СТА та вампіризму.",
      "Якщо ваших ЗДР менше за вартість навички, застосування не вдасться; тримайте «Броню з кісток», «Регенерацію вампіра» та «Переродження у крові» напоготові."
    ]
  },
  "Archer": {
    "className": "Archer",
    "name": "Буря стріл",
    "summary": "Стрілець здалеку з двома вузлами додаткових снарядів, що примножують влучання стріл і віяло автоатаки; СПР дає навички й швидкість, а СИЛ - шкоду лука.",
    "playstyle": "До р. 22 користуйтеся кинджалом, потім луком. Випускайте «Шквал стріл» короткими серіями по 2-4 такти, стоячи на місці під «Фокусом стрільця», тримайте «Благословення лісового вітру» і відступайте зі «Спритністю гепарда». «Отруйна стріла кобри» та «Град стріл» заповнюють проміжки.",
    "stats": [
      {
        "stat": "DEX",
        "why": "Атрибут 46 з 50 навичок Лучника (+5% за очко) і швидкості: межа 0.38 досягається близько СПР 60. План: СПР 287."
      },
      {
        "stat": "STR",
        "why": "Особливість: луки без стихії масштабують удари від СИЛ, а не СПР. План: СИЛ 212 для шкоди автоатаки x11.4."
      },
      {
        "stat": "WIS",
        "why": "Лише вимога самоцвітів (до 21, для «Смертельної вразливості»). План: МУД 29."
      },
      {
        "stat": "CON",
        "why": "Вимога самоцвітів 14 і ваше джерело ЗДР. План: СТА 103 для 1343 ЗДР."
      }
    ],
    "hotbar": [
      {
        "slot": 1,
        "skillId": "arc_barrage",
        "name": "Шквал стріл",
        "unlock": "Рів. 25 · завдання act1_sunspire_reliquary · 3013 з",
        "why": "Конусний канал, 5 ударів за такт (7 зі снарядами) за 4 витривалості. Використовуйте короткими серіями."
      },
      {
        "slot": 2,
        "skillId": "arc_venom_arrow",
        "name": "Отруйна стріла кобри",
        "unlock": "Рів. 35 · завдання act2_obsidian_drake · 4163 з",
        "why": "Дешева стріла (18 витривалості, перезарядка 2 с), 3 удари з +2 снарядами. Найкраща шкода за секунду по одній цілі."
      },
      {
        "slot": 3,
        "skillId": "arc_rain_of_arrows",
        "name": "Град стріл",
        "unlock": "Рів. 32 · завдання act2_obsidian_drake · 3825 з",
        "why": "Багатоударна шкода по області навколо курсора: 10 ударів (12 зі снарядами) за 28 витривалості з перезарядкою 7 с."
      },
      {
        "slot": 4,
        "skillId": "arc_piercing_shot",
        "name": "Пронизуючий постріл",
        "unlock": "Рів. 31 · завдання act2_obsidian_drake · 3688 з",
        "why": "Конус до 560 px, що вражає кожну ціль: 17 базової шкоди за 17 витривалості."
      },
      {
        "slot": 5,
        "skillId": "arc_eagle_eye",
        "name": "Орлине око",
        "unlock": "Рів. 43 · завдання act3_nether_behemoth (таємний самоцвіт) · 5263 з",
        "why": "+20% шансу крита та +256 px дальності на 20 с (перезарядка 30 с)."
      },
      {
        "slot": 6,
        "skillId": "arc_sniper_stance",
        "name": "Фокус стрільця",
        "unlock": "Рів. 50 · завдання act3_nether_behemoth (таємний самоцвіт) · 6300 з",
        "why": "Коли стоїте на місці: +10% шкоди за секунду до +50%. Ідеально з каналом «Шквалу стріл»; потрібен лук."
      },
      {
        "slot": 7,
        "skillId": "arc_tailwind_aura",
        "name": "Благословення лісового вітру",
        "unlock": "Рів. 49 · завдання act3_nether_behemoth (таємний самоцвіт) · 6163 з",
        "why": "+15% швидкості руху та +15% ухилення на 60 с за 25 витривалості. Тримайте ввімкненою."
      },
      {
        "slot": 8,
        "skillId": "arc_cheetah_stride",
        "name": "Спритність гепарда",
        "unlock": "Рів. 45 · завдання act3_nether_behemoth (таємний самоцвіт) · 5538 з",
        "why": "+45% швидкості руху на 12 с (перезарядка 25 с) для відступу з атакою та втечі."
      },
      {
        "slot": 9,
        "skillId": "arc_expose_weakness",
        "name": "Смертельна вразливість",
        "unlock": "Рів. 56 · завдання act4_primordial_sovereign (таємний самоцвіт) · 7200 з",
        "why": "Удар по області за 11 витривалості, після якого цілі отримують на 25% більше шкоди 8 с. Застосовуйте перед «Шквалом»."
      }
    ],
    "earlySkills": [
      {
        "skillId": "arc_fan_of_knives",
        "name": "Розсікаючий віяловий ніж",
        "level": 1,
        "note": "Найсильніша рання навичка: 6 ударів по 6 за 25 витривалості, дуга ближнього типу. Потребує кинджала."
      },
      {
        "skillId": "arc_whirling_blades",
        "name": "Круговий поріз",
        "level": 14,
        "note": "Навичка кинджала для середини раннього етапу."
      },
      {
        "skillId": "arc_poison_shiv",
        "name": "Укол отруєним лезом",
        "level": 16,
        "note": "Навичка кинджала; кинджал має бути в руці."
      },
      {
        "skillId": "arc_ambush_flurry",
        "name": "Засадний розтин",
        "level": 22,
        "note": "Остання навичка кинджала: круговий канал."
      },
      {
        "skillId": "arc_aimed_shot",
        "name": "Прицільний постріл",
        "level": 23,
        "note": "Перша навичка лука; переходьте на лук з р. 23. Потребує МУД 11, тож до приблизно 30-го очка користуйтеся «Розсікаючим віяловим ножем»."
      }
    ],
    "passives": {
      "startKey": "start-dexterity",
      "steps": [
        {
          "key": "dexterity-r1-0-4",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-0-3",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-0-2",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-1-10",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-1-9",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-1-14",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-0-4",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-1-22",
          "label": "Широта",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-1-17",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-1-16",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-1-19",
          "label": "Широта",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-1-27",
          "label": "Влучне око — +20 СПР і +1 додаткова стріла",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r3-0-5",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-21",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-6",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-7",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-8",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-9",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-10",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-11",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-12",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-13",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-15",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-8",
          "label": "Широта",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-9",
          "label": "Друга дисципліна",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-3-10",
          "label": "Широта",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-11",
          "label": "Відродження",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-3-12",
          "label": "Дар мандрівника",
          "kind": "greater"
        },
        {
          "key": "dexterity-r2-1-26",
          "label": "Дилетант",
          "kind": "minor"
        },
        {
          "key": "dexterity-r2-4-8",
          "label": "Біг по вітру — +15 СПР, +40 макс. витривалості, +5 витривалості/с відновлення",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r2-4-7",
          "label": "Дилетант",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-13",
          "label": "Прудкість — ваша межа перезарядки знижується з 0.40 до 0.35",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r3-3-5",
          "label": "Апофеоз",
          "kind": "notable"
        },
        {
          "key": "dexterity-r1-0-1",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "intelligence-r1-0-8",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r2-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-8",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-9",
          "label": "Відродження",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-3-10",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-11",
          "label": "Груба шкіра",
          "kind": "notable"
        },
        {
          "key": "intelligence-r3-3-12",
          "label": "Дар мандрівника",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-3-14",
          "label": "Майстерність стрільця",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-3-15",
          "label": "Жорстокість",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-1-29",
          "label": "Гарт",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-28",
          "label": "Лезо",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-27",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-1-26",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-1-25",
          "label": "Витривалий",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-0-6",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-1-9",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-1-8",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-1-13",
          "label": "Широта",
          "kind": "minor"
        },
        {
          "key": "clu_dex_volley-hub",
          "label": "Залп",
          "kind": "greater"
        },
        {
          "key": "dexterity-r4-1-14",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-1-36",
          "label": "Всезнайко",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-2-0",
          "label": "Всезнайко",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-2-1",
          "label": "Швидке відновлення",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-2-2",
          "label": "Друга дисципліна",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-2-3",
          "label": "Моторний потік",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-2-8",
          "label": "Жорстокість",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-2-4",
          "label": "Моторний потік",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-3",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "intelligence-r3-3-7",
          "label": "Друга дисципліна",
          "kind": "notable"
        },
        {
          "key": "dexterity-r4-0-19",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-2-19",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r4-2-18",
          "label": "Розпалювання",
          "kind": "notable"
        },
        {
          "key": "dexterity-r4-2-23",
          "label": "Вогнетривкість",
          "kind": "notable"
        },
        {
          "key": "dexterity-r4-2-22",
          "label": "Відступництво",
          "kind": "greater"
        },
        {
          "key": "dexterity-r4-2-24",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "dexterity-r4-3-1",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-3-2",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-3-7",
          "label": "Широке навчання",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-1",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-2",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-3",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-4",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-5",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-6",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-7",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-8",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-9",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-0-10",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-2-15",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r3-2-16",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r3-2-17",
          "label": "Обладунок",
          "kind": "notable"
        },
        {
          "key": "strength-r3-2-18",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r3-2-19",
          "label": "Безрозсудний змах — +25% фізичної шкоди, -10% стійкості до льоду",
          "kind": "keystone"
        },
        {
          "key": "strength-r4-0-13",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-15",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-19",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "strength-r3-3-13",
          "label": "Незламність — +20 СИЛ і +100 макс. життя",
          "kind": "keystone"
        },
        {
          "key": "strength-r3-3-12",
          "label": "Дар мандрівника",
          "kind": "greater"
        },
        {
          "key": "strength-r2-1-27",
          "label": "Кат — +15% фізичної шкоди і +12 дальності ближнього бою",
          "kind": "keystone"
        },
        {
          "key": "strength-r3-3-14",
          "label": "Бойова майстерність",
          "kind": "greater"
        },
        {
          "key": "strength-r3-3-15",
          "label": "Відродження",
          "kind": "notable"
        },
        {
          "key": "strength-r4-2-19",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "strength-r4-2-20",
          "label": "Невтомність",
          "kind": "notable"
        },
        {
          "key": "strength-r4-3-1",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "strength-r4-2-18",
          "label": "Жорстокість",
          "kind": "notable"
        },
        {
          "key": "strength-r4-2-23",
          "label": "Натиск",
          "kind": "notable"
        },
        {
          "key": "strength-r4-2-22",
          "label": "Відступництво",
          "kind": "greater"
        },
        {
          "key": "strength-r4-2-24",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "dexterity-r2-4-6",
          "label": "Смертельне прицілювання",
          "kind": "notable"
        },
        {
          "key": "clu_dex_deadeye-hub",
          "label": "Фокус влучного ока",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-1",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-0-2",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-6",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-7",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-8",
          "label": "Вогнетривкість",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-1-9",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "dexterity-r3-1-10",
          "label": "Смертельна точність — +12% шансу крита та +35% шкоди крита, -50 макс. життя",
          "kind": "keystone"
        },
        {
          "key": "dexterity-r3-1-11",
          "label": "Взірець",
          "kind": "greater"
        },
        {
          "key": "dexterity-r3-1-12",
          "label": "Бичача кров",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-1-14",
          "label": "Заточеність",
          "kind": "notable"
        },
        {
          "key": "strength-r3-3-5",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "strength-r4-0-20",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-21",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "strength-r4-0-22",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-1",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-2",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-6",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-14",
          "label": "Заточеність",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-13",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-1-12",
          "label": "Бичача кров",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-1-11",
          "label": "Взірець",
          "kind": "greater"
        },
        {
          "key": "strength-r3-1-21",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-29",
          "label": "Гарт",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-28",
          "label": "Лезо",
          "kind": "minor"
        },
        {
          "key": "strength-r3-1-27",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "strength-r3-1-26",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "dexterity-r1-1-15",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "dexterity-r1-1-16",
          "label": "Зосередженість стрільця",
          "kind": "notable"
        },
        {
          "key": "dexterity-r2-1-25",
          "label": "Могутні жили",
          "kind": "notable"
        },
        {
          "key": "dexterity-r3-2-5",
          "label": "Відступництво",
          "kind": "greater"
        }
      ],
      "milestones": [
        {
          "points": 10,
          "summary": "СПР 19, СИЛ 10, 93 ЗДР; інтервал атаки x0.70 від межі перезарядки стартового вузла."
        },
        {
          "points": 30,
          "summary": "СПР 70, СИЛ 22, СТА 25, 325 ЗДР. Взято «Влучне око» (+1 снаряд); МУД/СТА для «Шквалу стріл» виконано."
        },
        {
          "points": 60,
          "summary": "СПР 149, СИЛ 42, 413 ЗДР. Взято «Біг по вітру», «Прудкість» і «Залп»: +2 снаряди, межа перезарядки 0.35."
        },
        {
          "points": 100,
          "summary": "СПР 195, СИЛ 108, 673 ЗДР. Взято блок СИЛ («Безрозсудний змах», «Незламність», «Кат»): фізична шкода +44%."
        },
        {
          "points": 150,
          "summary": "СПР 287, СИЛ 212, 1343 ЗДР, 200 витривалості. Взято «Смертельне прицілювання», «Фокус влучного ока» та «Смертельну точність»: близько 19% шансу крита, +45% шкоди крита."
        }
      ],
      "keystones": [
        {
          "key": "dexterity-r2-1-27",
          "label": "Влучне око — +20 СПР і +1 додаткова стріла",
          "atStep": 12,
          "note": "+20 СПР і +1 снаряд. Без недоліків."
        },
        {
          "key": "dexterity-r2-4-8",
          "label": "Біг по вітру — +15 СПР, +40 макс. витривалості, +5 витривалості/с відновлення",
          "atStep": 32,
          "note": "+15 СПР, +40 витривалості, +5 відновлення витривалості. Без недоліків."
        },
        {
          "key": "dexterity-r3-3-13",
          "label": "Прудкість — ваша межа перезарядки знижується з 0.40 до 0.35",
          "atStep": 34,
          "note": "Межа перезарядки 0.35. Без недоліків."
        },
        {
          "key": "clu_dex_volley-hub",
          "label": "Залп",
          "atStep": 59,
          "note": "Другий +1 снаряд (разом +2)."
        },
        {
          "key": "strength-r3-2-19",
          "label": "Безрозсудний змах — +25% фізичної шкоди, -10% стійкості до льоду",
          "atStep": 96,
          "note": "+25% фізичної шкоди, але -10% стійкості до льоду. Необов'язково: здебільшого підсилює автоатаку."
        },
        {
          "key": "strength-r3-3-13",
          "label": "Незламність — +20 СИЛ і +100 макс. життя",
          "atStep": 104,
          "note": "+20 СИЛ і +100 ЗДР. Без недоліків."
        },
        {
          "key": "strength-r2-1-27",
          "label": "Кат — +15% фізичної шкоди і +12 дальності ближнього бою",
          "atStep": 106,
          "note": "+15% фізичної шкоди і +12 дальності. Без недоліків."
        },
        {
          "key": "clu_dex_deadeye-hub",
          "label": "Фокус влучного ока",
          "atStep": 117,
          "note": "+4% шансу крита."
        },
        {
          "key": "dexterity-r3-1-10",
          "label": "Смертельна точність — +12% шансу крита та +35% шкоди крита, -50 макс. життя",
          "atStep": 125,
          "note": "+12% шансу крита та +35% шкоди крита, але -50 макс. ЗДР."
        }
      ]
    },
    "gear": [
      "Зброя: до р. 22 кинджал, далі лук (дворучний, перезарядка 0.75) або арбалет (дворучний, перезарядка 0.95, більше шкоди). Вимога СПР зростає від 8 на 2-му ярусі до 116 на 10-му.",
      "Луки мають вбудовані +10% крита, арбалети +8%. Боєприпасів немає. «Фокус стрільця» потребує лука.",
      "Обладунок: каптур, чоботи й рукавиці (СПР), усе легке. Дворучний лук не лишає місця для другої руки.",
      "Персні потребують ХАР (35 у плані): сталева смуга 16 або гартована 26. Добрі афікси: of_grace (+СПР)."
    ],
    "weaknesses": [
      "До р. 25 дві зброї (кинджал, потім лук): тримайте обидві у слотах.",
      "Мало ЗДР (1343 на 150 очках, мінус 50 зі «Смертельною точністю»), а єдиний справжній захист - «Благословення лісового вітру» (15% ухилення). Покладайтеся на дистанцію, «Спритність гепарда» та пастки (лише шкода).",
      "Витривалість - ресурс стріл (запас 200, відновлення 31/с): «Шквал стріл» вмикайте серіями по 2-4 такти; «Отруйна стріла кобри» дешева.",
      "Вимога МУД з р. 25 (МУД 12) виконується лише близько 30-го очка; до того «Прицільний постріл» і «Шквал стріл» заблоковані, тож користуйтеся «Розсікаючим віяловим ножем»."
    ]
  },
  "Druid": {
    "className": "Druid",
    "name": "Перевертень",
    "summary": "Три форми з різними ролями: Вовк для шкоди, Яструб для швидкості й відступу з атакою, Ведмідь для захисту. Усі бонуси форм залежать від сили форм з дерева.",
    "playstyle": "Увійдіть у форму вовка, застосуйте «Первісний метаморфоз» та «Знак дикої природи», далі чергуйте «Лютий укус вовка» і «Вовчий розпил». Перемикайтеся на форму яструба, щоб перебігати між групами або відступати з атакою, і на форму ведмедя, коли ЗДР падають нижче 40% або проти сильних ударників. У формі кнопку форми натискати не обов'язково: будь-яка навичка вовка, яструба чи ведмедя сама вмикає свою форму, а заклинання повертає у людську, і все це в межах одного застосування.",
    "stats": [
      {
        "stat": "CHA",
        "why": "Атрибут усіх 50 навичок Друїда (+5% за очко): головна характеристика Друїда. План: ХАР 328."
      },
      {
        "stat": "CON",
        "why": "Вимога самоцвітів 15 і ваше джерело ЗДР. План: СТА 199 для 2513 ЗДР."
      },
      {
        "stat": "WIS",
        "why": "Вимога самоцвітів 13. План: МУД 105."
      },
      {
        "stat": "INT",
        "why": "Збільшує запас мани, яку витрачають кожне перемикання форми й навичка. План: ІНТ 64 для 815 мани."
      }
    ],
    "hotbar": [
      {
        "slot": 1,
        "skillId": "dru_wolf_form",
        "name": "Трансформація у вовка",
        "unlock": "Рів. 1 · 100 з",
        "why": "Форма шкоди: +25% крита та x1.35 швидкості автоатаки (швидкість лише нижче межі). Залежить від сили форм."
      },
      {
        "slot": 2,
        "skillId": "dru_hawk_form",
        "name": "Трансформація в яструба",
        "unlock": "Рів. 1 · 100 з",
        "why": "Форма швидкості: x1.45 швидкості руху та 35% ухилення (до 60% з силою форм). Для подорожей і відступу з атакою."
      },
      {
        "slot": 3,
        "skillId": "dru_bear_form",
        "name": "Трансформація у ведмедя",
        "unlock": "Рів. 1 · 100 з",
        "why": "Форма захисту: ЗДР x1.6 і отримана шкода x0.5 (до x0.2 при силі форм 0.6 і вище). Для босів та екстрених випадків."
      },
      {
        "slot": 4,
        "skillId": "dru_feral_bite",
        "name": "Лютий укус вовка",
        "unlock": "Рів. 43 · завдання act3_nether_behemoth (таємний самоцвіт) · 5263 з",
        "why": "Найкраща навичка вовка: 15 базової шкоди за 15 мани з перезарядкою 2 с. До р. 43 користуйтеся «Вовчим розпилом» або «Шквалом вовчих лап»."
      },
      {
        "slot": 5,
        "skillId": "dru_wolf_rend",
        "name": "Вовчий розпил",
        "unlock": "Рів. 20 · завдання act1_sunspire_reliquary · 2475 з",
        "why": "Найдешевший заповнювач вовка до р. 43 (14 мани, перезарядка 2 с); чергується з «Лютим укусом вовка»."
      },
      {
        "slot": 6,
        "skillId": "dru_hawk_dive_slash",
        "name": "Пікірування яструба",
        "unlock": "Рів. 44 · завдання act3_nether_behemoth (таємний самоцвіт) · 5400 з",
        "why": "Стрибок і удар яструба (дальність 200, 11 мани): скорочує дистанцію у формі яструба."
      },
      {
        "slot": 7,
        "skillId": "dru_primal_metamorphosis",
        "name": "Первісний метаморфоз",
        "unlock": "Рів. 35 · завдання act2_obsidian_drake · 4163 з",
        "why": "Лише у формі: +180 ЗДР, шкода x1.3 і швидкість x1.35 на 20 с (перезарядка 20 с). Поза формою відхиляється."
      },
      {
        "slot": 8,
        "skillId": "dru_mark_of_the_wild",
        "name": "Знак дикої природи",
        "unlock": "Рів. 45 · завдання act3_nether_behemoth (таємний самоцвіт) · 5538 з",
        "why": "Шкода x1.1 і +10% макс. ЗДР на 1800 с (перезарядка 60 с): оновлюйте кожні пів години."
      },
      {
        "slot": 9,
        "skillId": "dru_thorns_aura",
        "name": "Шипи відплати",
        "unlock": "Рів. 48 · завдання act3_nether_behemoth (таємний самоцвіт) · 6025 з",
        "why": "Відбиває 20% фізичної шкоди нападникам протягом 60 с (25 мани). Працює у формах."
      }
    ],
    "earlySkills": [
      {
        "skillId": "dru_wolf_flurry",
        "name": "Шквал вовчих лап",
        "level": 4,
        "note": "Навичка вовка; ваша шкода до «Вовчого розпилу» та «Лютого укусу вовка»."
      },
      {
        "skillId": "dru_hawk_wind_slash",
        "name": "Вітровий поріз яструба",
        "level": 17,
        "note": "Дальній поріз яструба з дальністю 160."
      }
    ],
    "passives": {
      "startKey": "start-charisma",
      "steps": [
        {
          "key": "charisma-r1-0-4",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-5",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-6",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-7",
          "label": "Зосередженість (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-8",
          "label": "Зосередженість (СТА)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-0-14",
          "label": "Бадьорість (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-18",
          "label": "Бадьорість (СТА)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-22",
          "label": "Прозріння (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-21",
          "label": "Прозріння (ІНТ)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-20",
          "label": "Прозріння (СПР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-19",
          "label": "Прозріння (СИЛ)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-3-13",
          "label": "Звіринець — «Аспект дикої природи» (+25 ХАР, +15 СТА, +30 макс. мани, +2.0 мани/с відновлення, форми сильніші на 15%)",
          "kind": "keystone"
        },
        {
          "key": "charisma-r3-3-12",
          "label": "Дар мандрівника",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-3-11",
          "label": "Відродження",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-3-5",
          "label": "Апофеоз (ХАР)",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-2-19",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-3-1",
          "label": "Піднесення (ХАР)",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-0-17",
          "label": "Бадьорість (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-16",
          "label": "Бадьорість (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-4-8",
          "label": "Яструбиний аспект — +20 СПР, +40 макс. витривалості, +4 витривалості/с відновлення, +8% швидкості атаки, форми сильніші на 12%",
          "kind": "keystone"
        },
        {
          "key": "charisma-r3-3-14",
          "label": "Дика майстерність",
          "kind": "greater"
        },
        {
          "key": "charisma-r4-2-18",
          "label": "Первісний інстинкт",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-2-23",
          "label": "Натиск",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-2-22",
          "label": "Відступництво",
          "kind": "greater"
        },
        {
          "key": "charisma-r4-2-24",
          "label": "Піднесення (ХАР)",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-3-15",
          "label": "Жорстокість",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-0-18",
          "label": "Бадьорість (МУД)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-17",
          "label": "Бадьорість (СТА)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-16",
          "label": "Бадьорість (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-15",
          "label": "Бадьорість (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-14",
          "label": "Бадьорість (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-0-13",
          "label": "Зосередженість (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-2-19",
          "label": "Майстерність первісної форми — +30 ХАР, +10 МУД, +1.5 ЗДР/с відновлення, +3.0 витривалості/с відновлення, форми сильніші на 25%",
          "kind": "keystone"
        },
        {
          "key": "charisma-r1-0-3",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-2",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-1",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-0-0",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "constitution-r1-0-8",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Багряна оборудка — кожна навичка б'є на 40% сильніше, але коштує на 30% більше життя",
          "kind": "keystone"
        },
        {
          "key": "constitution-r3-3-8",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-9",
          "label": "Друга дисципліна",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-10",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "constitution-r3-3-11",
          "label": "Відродження",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-12",
          "label": "Дар мандрівника",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-0-0",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-1",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-2",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-6",
          "label": "Вітер (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-7",
          "label": "Вітер (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-8",
          "label": "Натиск",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-1-9",
          "label": "Вітер (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-10",
          "label": "Вовчий аспект — +15 СИЛ, +15 ХАР, +12% фізичної шкоди, форми сильніші на 12%",
          "kind": "keystone"
        },
        {
          "key": "charisma-r3-1-11",
          "label": "Взірець (ХАР)",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-0-3",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-4",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-5",
          "label": "Жили (СТА)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-1-27",
          "label": "Ведмежий аспект — +20 СИЛ, +120 ЗДР, +1.5 ЗДР/с відновлення, +5% фізичної стійкості, форми сильніші на 12%",
          "kind": "keystone"
        },
        {
          "key": "charisma-r3-1-14",
          "label": "Бичача кров (ХАР)",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-2-2",
          "label": "Дисципліна (МУД)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-2-1",
          "label": "Друге дихання",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-2-5",
          "label": "Дисципліна (ІНТ)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-2-6",
          "label": "Піднесення (ХАР)",
          "kind": "greater"
        },
        {
          "key": "charisma-r4-2-7",
          "label": "Апофеоз (ХАР)",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-13",
          "label": "Кривавий договір — витрати життя знижено на 15%",
          "kind": "keystone"
        },
        {
          "key": "constitution-r4-0-19",
          "label": "Прозріння",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-19",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-3-1",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "constitution-r4-3-0",
          "label": "Заземлення",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-24",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "constitution-r4-2-23",
          "label": "Вогнетривкість",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-22",
          "label": "Відступництво",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-3-5",
          "label": "Апофеоз",
          "kind": "notable"
        },
        {
          "key": "constitution-r3-3-14",
          "label": "Кривава майстерність",
          "kind": "greater"
        },
        {
          "key": "constitution-r3-3-15",
          "label": "Жорстокість",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-2-10",
          "label": "Дике цвітіння",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-2-17",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r4-2-16",
          "label": "Жорстокість",
          "kind": "notable"
        },
        {
          "key": "clu_cha_beast_bond-hub",
          "label": "Дике серце",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-1-21",
          "label": "Перехресне тренування",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-29",
          "label": "Гарт (МУД)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-28",
          "label": "Лезо",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-27",
          "label": "Могутні жили (СТА)",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-1-26",
          "label": "Піднесення (ХАР)",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-2-20",
          "label": "Зосередженість (ІНТ)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-2-21",
          "label": "Бичача кров (ХАР)",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-1-22",
          "label": "Дилетант",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-23",
          "label": "Дика зосередженість",
          "kind": "notable"
        },
        {
          "key": "charisma-r2-4-9",
          "label": "Гарт (СПР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-4-10",
          "label": "Могутні жили (ІНТ)",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-0-6",
          "label": "Жили (МУД)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-7",
          "label": "Зосередженість (СИЛ)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-8",
          "label": "Зосередженість (СПР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-1-36",
          "label": "Всезнайко",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-2-8",
          "label": "Жорстокість",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-2-7",
          "label": "Жили (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-2-6",
          "label": "Груба шкіра",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-2-5",
          "label": "Відступництво",
          "kind": "greater"
        },
        {
          "key": "charisma-r2-4-7",
          "label": "Мозоль",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-4-6",
          "label": "Дика зосередженість",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-3-2",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-3-7",
          "label": "Широке навчання",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-2-20",
          "label": "Шкура з шипами",
          "kind": "notable"
        },
        {
          "key": "charisma-r2-4-11",
          "label": "Дисципліна (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-4-12",
          "label": "Могутні жили (ХАР)",
          "kind": "notable"
        },
        {
          "key": "charisma-r4-2-21",
          "label": "Шкура з шипами",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-0-18",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-17",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-16",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-10",
          "label": "Зцілення",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-17",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-16",
          "label": "Жорстокість",
          "kind": "notable"
        },
        {
          "key": "charisma-r2-1-28",
          "label": "Дилетант",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-2-0",
          "label": "Майстерність (ХАР)",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-0-15",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-14",
          "label": "Бадьорість",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-0-13",
          "label": "Зосередженість",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-2",
          "label": "Дисципліна",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-8",
          "label": "Всезнайко",
          "kind": "minor"
        },
        {
          "key": "constitution-r4-2-7",
          "label": "Апофеоз",
          "kind": "notable"
        },
        {
          "key": "constitution-r4-2-6",
          "label": "Піднесення",
          "kind": "greater"
        },
        {
          "key": "constitution-r4-2-3",
          "label": "Майстерність",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-0-0",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-1",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-0-2",
          "label": "Жили",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-6",
          "label": "Вітер",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-14",
          "label": "Заточеність",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-1-13",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "wisdom-r3-1-12",
          "label": "Бичача кров",
          "kind": "notable"
        },
        {
          "key": "wisdom-r3-1-11",
          "label": "Взірець",
          "kind": "greater"
        },
        {
          "key": "charisma-r3-0-15",
          "label": "Бадьорість (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-14",
          "label": "Бадьорість (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-0-13",
          "label": "Зосередженість (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-2-30",
          "label": "Прозріння (МУД)",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-3-1",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-3-0",
          "label": "Універсальність",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-2-36",
          "label": "Могутні жили (ХАР)",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-2-35",
          "label": "Піднесення (ХАР)",
          "kind": "greater"
        },
        {
          "key": "clu_cha_beast_bond-sat1",
          "label": "Густе хутро",
          "kind": "notable"
        },
        {
          "key": "charisma-r1-1-10",
          "label": "Прозріння (ХАР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-2-1",
          "label": "Вітер (ІНТ)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-2-0",
          "label": "Вітер (СПР)",
          "kind": "minor"
        },
        {
          "key": "charisma-r1-1-16",
          "label": "Дика зосередженість",
          "kind": "notable"
        },
        {
          "key": "charisma-r2-1-26",
          "label": "Дилетант",
          "kind": "minor"
        },
        {
          "key": "charisma-r2-1-25",
          "label": "Могутні жили (ХАР)",
          "kind": "notable"
        },
        {
          "key": "charisma-r3-3-16",
          "label": "Мозоль",
          "kind": "minor"
        },
        {
          "key": "charisma-r3-3-17",
          "label": "Первісний інстинкт",
          "kind": "notable"
        }
      ],
      "milestones": [
        {
          "points": 10,
          "summary": "ХАР 18, СТА 10, 156 ЗДР, 173 мани. Стартовий вузол дає +0.03 сили форм."
        },
        {
          "points": 30,
          "summary": "ХАР 101, СТА 47, 594 ЗДР, 389 мани. Взято «Звіринець» і «Яструбиний аспект»; сила форм близько 0.35."
        },
        {
          "points": 60,
          "summary": "ХАР 203, СТА 60, 780 ЗДР, 509 мани. Взято «Майстерність первісної форми», «Багряну оборудку» та «Вовчий аспект»; сила форм близько 0.72 (ухилення яструба й захист ведмедя на межі)."
        },
        {
          "points": 100,
          "summary": "ХАР 267, СТА 120, 1569 ЗДР, 691 мани. Взято «Ведмежий аспект» і «Дике серце»; сила форм близько 0.94."
        },
        {
          "points": 150,
          "summary": "ХАР 328, СТА 199, МУД 105, 2513 ЗДР, 815 мани, 93 мани/с відновлення. Сила форм близько 0.99; ЗДР у формі ведмедя x2.19."
        }
      ],
      "keystones": [
        {
          "key": "charisma-r3-3-13",
          "label": "Звіринець — «Аспект дикої природи» (+25 ХАР, +15 СТА, +30 макс. мани, +2.0 мани/с відновлення, форми сильніші на 15%)",
          "atStep": 12,
          "note": "+25 ХАР, +15 СТА, +30 мани, +2 мани/с і +0.15 сили форм. Без недоліків."
        },
        {
          "key": "charisma-r2-4-8",
          "label": "Яструбиний аспект — +20 СПР, +40 макс. витривалості, +4 витривалості/с відновлення, +8% швидкості атаки, форми сильніші на 12%",
          "atStep": 20,
          "note": "+20 СПР, +40 витривалості, +8% швидкості атаки та +0.12 сили форм. Без недоліків."
        },
        {
          "key": "charisma-r3-2-19",
          "label": "Майстерність первісної форми — +30 ХАР, +10 МУД, +1.5 ЗДР/с відновлення, +3.0 витривалості/с відновлення, форми сильніші на 25%",
          "atStep": 33,
          "note": "+30 ХАР, +10 МУД, +0.25 сили форм: найбільший одноразовий стрибок сили форм. Без недоліків."
        },
        {
          "key": "constitution-r2-4-8",
          "label": "Багряна оборудка — кожна навичка б'є на 40% сильніше, але коштує на 30% більше життя",
          "atStep": 43,
          "note": "Шкода навичок x1.4; штраф витрат життя тут нічого не означає, бо в Друїда немає навичок із витратою життя."
        },
        {
          "key": "charisma-r3-1-10",
          "label": "Вовчий аспект — +15 СИЛ, +15 ХАР, +12% фізичної шкоди, форми сильніші на 12%",
          "atStep": 56,
          "note": "+15 СИЛ, +15 ХАР, +12% фізичної шкоди та +0.12 сили форм. Без недоліків."
        },
        {
          "key": "charisma-r2-1-27",
          "label": "Ведмежий аспект — +20 СИЛ, +120 ЗДР, +1.5 ЗДР/с відновлення, +5% фізичної стійкості, форми сильніші на 12%",
          "atStep": 61,
          "note": "+20 СИЛ, +120 ЗДР, +5% фізичної стійкості та +0.12 сили форм. Без недоліків."
        },
        {
          "key": "clu_cha_beast_bond-hub",
          "label": "Дике серце",
          "atStep": 82,
          "note": "+0.10 сили форм, що доводить загальну до приблизно 0.99. Сила форм понад 1.0 марнується."
        }
      ]
    },
    "gear": [
      "Зброя: скіпетр (одноручний, потребує ХАР; 4-й ярус: 26, до 10-го: 116) рахується посохом/жезлом, тож «Гнів природи» та «Місячний вогонь» працюють і в людській формі.",
      "Для гри лише вовком підійде також булава (СТА) або кинджал (СПР): автоатаки у формі використовують зброю в руці з множником СИЛ (x3.2).",
      "Персні (смуга, печатка) потребують ХАР - єдине спорядження під вашу головну характеристику. Інше: поножі (СТА), каптур/чоботи/рукавиці (СПР), мантії (ІНТ).",
      "Добрі афікси: of_presence (+ХАР) і of_the_bear (+ЗДР). ХАР також підвищує ціну продажу: +2% за очко, максимум при ХАР 25."
    ],
    "weaknesses": [
      "Заклинання скидає форму (повертає у людську), тож чергування заклинань і навичок форм постійно вмикає та вимикає бонуси форм.",
      "Мана (815) витрачається на кожне перемикання форми та навичку; стежте за запасом після перемикань на яструба, вовка й ведмедя та після «Первісного метаморфозу».",
      "Немає аури відновлення мани, як «Аура відновлення мани» в Монаха; допомагає «Звіринець», а вузол «Омолодження» (+2 мани/с) - необов'язкове доповнення поза планом.",
      "Таємні самоцвіти з р. 43 до р. 48 закриті завданням act3_nether_behemoth; до того ваша шкода - «Вовчий розпил» і «Шквал вовчих лап».",
      "«Первісний метаморфоз» потребує форми: поза нею його відхиляють, нічого не витрачаючи."
    ]
  }
};
