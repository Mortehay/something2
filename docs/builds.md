# Збірки персонажів для шести класів something2

> Документ згенеровано з реальних даних гри: жива dev-БД (`passive_nodes` 2322 вузли, `passive_edges` 3000 ребер, `item_types`, `entity_types`), каталог скілів (`skillsCatalog.generated.js`, `backend/seeds/data/skills.js`) і серверна логіка (`backend/src/authority/skillBalance.js`, `skillSynergy.js`, `world.js`, `backend/src/services/playerStats.js`, `statComposition.js`, `passiveTreeStore.js`, `progressionConstants.js`). Назви скілів, вузлів і предметів — англійською, як у даних.

## 0. Як читати документ і які припущення

**Структура кожного білда:** (1) назва та стиль гри; (2) пріоритет статів; (3) хотбар з 9 слотів, порядок розблокування; (4) шлях по пасивному дереву (вузли за `id`/`key`/`label`, у порядку взяття, з вартістю в очках); (5) зброя й броня; (6) слабкі місця.

**Припущення про очки та правила дерева (перевірено):**

* `passive_points_per_level = 1` (таблиця `game_settings` у dev-БД, `gameSettings.js`). Рівень L дає L−1 очко. Додатково квести дають `passive_points_reward`: у `questsData.js` 33 квести на суму **36** очок (частина квестів може бути недоступна — вважайте їх бонусом). Максимальний рівень 150, тобто стеля ≈ 149 + 36 = 185 очок. XP-крива: `35 × L^1.45` на рівень (сумарно ≈ 57 тис. XP до L30, ≈ 203 тис. до L50, ≈ 1,12 млн до L100).
* Орієнтири віх: **10 очок** ≈ рівень 8–10 (з 1–3 квестами), **30** ≈ L25–30, **60** ≈ L50–55, **100** ≈ L85–90, **150** ≈ L115–120. Усі плани нижче розраховано рівно на 150 очок; решту (до 185) витрачайте на «Ascendance/Mastery» поруч із шляхом.
* **Ціни гемів** (`gemPrice` з каталогу) ростуть від 100 g (перший скіл класу) через 388–463 g (L1) до ≈ 6,6 тис. g (L52+); сума гемів хотбара кожного білда — у таблицях. Геми купуються в торговця поруч, потрібні рівень, атрибути та (для L16+) пройдений квест-бос.
* **Кожен вузол коштує рівно 1 очко** незалежно від типу (minor/notable/greater/keystone). Вартість «шляху» = кількість вузлів, які треба взяти, включно з проміжними minor-вузлами.
* Вузол можна взяти лише якщо він сусідить зі **стартовим вузлом свого класу** або з уже взятим вузлом (`passiveRules.isAllocatable`). Стартовий вузол безкоштовний, у `character_passives` не потрапляє, але його грант діє. **Вузли `kind = start` чужих класів брати не можна** (`allocateNode` відхиляє будь-який `start`), тому при обході графа я виключив їх як прохідні (усе одно кожен вузол досяжний: 2316 + власний старт).
* Повернення очок: по одному вузлу, лише якщо видалення не розірве зв'язність (`unallocateNode`); повний respec коштує `respec_base_gold × level` = 50 золота за рівень.
* **Усі шість характеристик на старті = 5** (`player_progression` default; значення 10/12 у `entity_types` сервер не читає — звідти береться тільки `max_hp` / `max_mana`). Клас дає лише базові пули й стартовий вузол.
* Зв'язність усіх шляхів перевірена скриптом (обхід BFS від старту класу по `passive_edges`, кожен наступний вузол сусідить з попередніми, жоден чужий `start` не використано). Повні впорядковані списки `id` наведено в кінці кожного білда.

**Як будувалися плани.** Я написав скрипт, що відтворює `statComposition.composeStats` та `playerStats.derivePlayerStats`, і жадібно (за відношенням приросту цільової функції до вартості шляху) нарощує зв'язну множину вузлів до 150 очок, а потім переупорядковує її так, щоб найкорисніше й потрібне для гемів ішло раніше. Цільова функція — евристика, різна для кожного класу (див. розділ білда: що саме максимізується). Це **не** результат ігрового тестування: числа «на 150 очок» — проєкція формул коду, а не виміри в бою. Якщо смак чи патч змінює вагу чогось (наприклад, не хочете `Glass Cannon`) — замініть відповідний блок вузлів і пересуньте решту вузлів.

### 0.1 Формули, на які спираються всі плани (з коду)

| Що | Формула |
|---|---|
| Макс. HP | `classBase + 10 × (CON − 5) + HP з дерева` (classBase: Warrior 100, Mage 75, Monk 90, Cultist 110, Archer 85, Druid 90) |
| Макс. мана | `classBase + 10 × (INT − 5) + manaPerWisdom × (WIS − 5) + мана з дерева` (classBase: Warrior 100, Mage 150, Monk 110, Cultist 90, Archer 115, Druid 135) |
| Макс. стамина | `100 + стамина з дерева` (жоден стат її не збільшує) |
| Реген мани | `10 + 0,5 × (WIS − 5) + 0,5 × (INT − 5) + manaRegen з дерева` за секунду |
| Реген HP | `1 + 0,1 × (CON − 5) + hpRegen з дерева`; реген стамини `10 + staminaRegen` |
| Множник кулдауну | `max(floor, 1 / (1 + 0,03 × (DEX − 5)))`; `floor` = 0,40 за замовчуванням, 0,38 від стартового вузла Archer, 0,35 від `Fleet` (правило `min`) |
| Удар зброєю | `weapon.damage × (1 + 0,05 × (STR − 5))` для безелементної/фізичної зброї (**також луки й безелементні стафи!**) або `× (1 + 0,05 × (INT − 5))` для зброї/каменя з елементом; далі `× множник елемента з дерева × crit` |
| Інтервал атаки | `weapon.cooldown × max(floor, кулдаун-множник / (attackSpeedMult × бафи atk))` — тобто швидкість атаки **впирається в той самий `floor`** |
| Удар скілом | `(base скіла + 10–15 % від damage зброї) × (1 + 0,05 × (атрибут скіла − 5)) × (1 + правило атрибута) × skillDamageMult × (1 + % елемента) × (умовні: lowLife / fullMana) × (1 + 1 % за кожен куплений рівень скіла, макс. 15) × crit × синергія × бафи dealt` |
| Базова шкода скіла | `(6 + 0,12 × reqLvl) × (1 + 0,45 × ln(cooldown))`, обмежена 4…30; канальні ×0,6 за такт; багатоударні скіли мають ручні значення (`MULTI_HIT`) |
| Правила `product` (skillDamageMult, manaCostMult, attackSpeedMult …) | складаються **як надлишок над 1**: `Crimson Bargain` (×1,4) + `Glass Cannon` (×1,35) дають ×1,75, а не ×1,89; знижки <1 віднімаються (мінімум 0,10) |

### 0.2 Знахідки, що впливають на всі білди (перевірено за кодом)

1. **Опис скіла ≠ механіка.** `world.castSkill` рахує лише шкоду (+ `blink` для id, що містять `blink/teleport/shadow_step`, тобто реально тільки `Blink` Мага; затягування в `Gravity Singularity`; спеціальні баф-ефекти з таблиці `BUFFS`). Оглушення, сповільнення, сліпота, «ігнорує броню» з описів **не реалізовані**, окрім ефектів із `BUFFS` і статусів з дерева (burn/chill/shock/stun). Скіли типу `debuff` — просто AoE-шкода із цінами «як у заклять».
2. **Форма ураження.** Канальні melee-скіли (`Whirlwind`, `Flurry of Steel`, `Hundred Fists`, `Spinning Crane Kick`, `Ambush Flurry`) б'ють по **колу 360°** (радіус 120 + бонуси досяжності). Id з `beam`, `ray`, `multishot`, `split_shot`, `aimed_shot`, `piercing`, `barrage` — конус ±40° (+ упритул 85 px) до `range`. Інші magic/debuff-скіли — коло навколо **курсору** радіусом `max(90, radius×1,5) × aoeRadiusMult`; `Frost Nova` і `Cyclone` — навколо гравця.
3. **Канали накопичують «ступінь».** Кожен такт каналу в межах 600 мс від попереднього піднімає ступінь (+1 на 2 такти, максимум 8): шкода такту ×(1 + 0,15 × ступінь), вартість такту = `базова × (1 + 0,35 × ступінь) + пул × 0,0125 × ступінь / 4`. Пауза >600 мс скидає ступінь. Для `Flurry of Steel` (база 4 стамини) при пулі 100 вартість по тактах: 4, 4, 6, 6, 7, 7, 9, 9, 11, 11, 13, 13, 14, 14, 16, 16 (≈160 за 16 тактів). Отже **канал краще «клювати» короткими серіями по 2–4 такти**: це найдешевша шкода в грі.
4. **Автоатака проти скілів.** Скіл має «стелю» бази 30, а зброя T10 — 100+ шкоди, яка теж множиться на STR. Для Warrior/Archer автоатака — основний DPS; скіли дають AoE, burst і баффи. Для Mage/Monk/Cultist/Druid основне — скіли (їх атрибут — клас-стат), автоатака — допоміжна.
5. **Стеля швидкості атаки.** Швидкість атаки/каста не може перевищити `1/floor` (2,5× за замовчуванням, 2,86× з `Fleet`). DEX ≈ 55 уже досягає 0,40; понад це DEX корисний лише як атрибут скілів/вимог. Бафи `atk` (`Rapid Fire`, `Tiger Stance`, `Wolf Form`, `Bloodlust Stance`, `Haste`) діють **тільки на інтервал автоатаки** (не на кулдауни скілів) і зайві, коли ви вже на стелі.
6. **`Crimson Bargain` (×1,4 до шкоди скілів) — майже безкоштовний для всіх, крім Cultist.** Його «+30 % вартості життя» застосовується лише до скілів з `costType: hp` (їх 50 — усі у Cultist) і до автоатаки класу з `usesLifeCost` (лише `Cultist`, `server.js`). Для решти — чистий +40 %.
7. **`+N projectile`** (`Deadeye`, `Volley`): для скілів-снарядів додає N ударів (Archer: усі `magic`-скіли; Mage: `Fireball`, `Frostbolt`, `Magic Missiles`; Cultist: `Blood Orb`, `Blood Lance`, `Bone Spear`, `Plague Globule`) і N стріл у віері автоатаки. Для одноударних скілів +2 = ×3 шкоди.
8. **Пастки з категоріями зброї.** Клієнт і сервер мають однаковий `getWeaponCategory`: `quarterstaff` містить «staff» → категорія `staff_wand` (а не `melee`). Скіли Monk (`unarmed`) приймають лише `unarmed` / `melee` / `dagger`, тож **Monk з quarterstaff не зможе кастувати власні скіли**. `melee`-скіли приймають і кинджали. Скіли Mage — завжди `staff_wand`; Cultist: L1–15 — `dagger`, L16+ — `staff_wand`; Archer: L1–22 — `dagger`, L23+ — `bow`.
9. **Гейти гемів:** рівень + атрибути + квести-боси: L16+ `act1_sunspire_reliquary`, L28+ `act2_obsidian_drake`, L40+ `act3_nether_behemoth`, L52+ `act4_primordial_sovereign`; геми з індексом ≥31 (≈ L42+) «секретні» — невидимі в торговця, поки умови не виконано. Зброя при купівлі не перевіряється — лише при касті.
10. **Синергії** (`skillSynergy.js`): каст скіла «заряджає» його теги на 5 с; наступний інший скіл, що завершує пару, множить шкоду (`Shatter` лід→вогонь/мілі ×1,30; `Thermal Shock` вогонь→лід ×1,25; `Conduction` блискавка→мілі ×1,25; `Catalyst` отрута→вогонь/блискавка ×1,30; `Ambush` контроль→мілі/кровотеча ×1,30; `Exploit Weakness` прокляття/мітка→мілі/магія ×1,20; `Empowered Strike` баф→мілі ×1,15; `Blood Poisoning` кров→отрута/тінь ×1,25; `Eclipse` тінь→блискавка/вогонь ×1,20). Окремо: різні скіли підряд у вікні 3,5 с дають ланцюг +6 % за ланку (до +18 %).


## 1. Warrior — «Сталевий вихор» (Steel Whirl)

**Стиль:** ближній бій з великою зброєю в одній руці: основний DPS — автоатака зі STR-множником і швидкістю на стелі кулдауна, плюс 360° burst `Flurry of Steel` короткими серіями; товстий за рахунок HP з дерева і двох постійних шарів захисту.

### 1.1 Пріоритет статів

1. **STR** — подвійна віддача: `×(1 + 0,05 × (STR − 5))` до кожного удару зброєю **і** до всіх скілів Warrior (атрибут усіх 50 скілів — strength). Також вимога для зброї (меч/сокира/клинок tier N → STR 8/16/26/36/48/62/78/96/116).
2. **DEX до ≈ 55–65** — кожне очко = +3 % швидкості (кулдаун-множник), стеля 0,40 (0,35 із `Fleet`). За план DEX 45 на 30 очках і 84 на 150.
3. **CON** — +10 HP/очко й +0,1 HP/с; вимога гемів (до 22). План: CON 163 → 2266 HP.
4. INT/WIS/CHA — практично не потрібні (мана 190 вистачає на `Windblade`).

### 1.2 Хотбар (9 слотів)

| Слот | Скіл (id) | Тип / ресурс | Кулдаун | Рівень | Вимоги до статів | Ціна гема | Квест-гейт | Навіщо |
|---|---|---|---|---|---|---|---|---|
| 1 | **Flurry of Steel** (`war_flurry_of_steel`) | melee, канал, stamina 4 | 0 c | 17 | STR15 DEX5 CON10; зброя: melee | 2138 g | act1_sunspire_reliquary | Ядро AoE-burst: 4 удари × 5 за такт, коло 360° (канальні melee б'ють навколо). Вартість 4 стамини за такт — «клювати» серіями по 2–4 такти (див. 0.2 п.3). |
| 2 | **Twin Slash** (`war_twin_slash`) | melee, stamina 14 | 3 c | 12 | STR12 DEX4 CON8; зброя: melee | 1600 g | — | Дешевий одноцільовий філер: 2 удари по 8 за 14 стамини, кулдаун 3 с (найкраща шкода/ресурс серед не-канальних melee). |
| 3 | **Windblade** (`war_windblade`) | magic, mana 18 | 5 c | 39 | STR26 DEX8 CON18; зброя: melee | 4713 g | act2_obsidian_drake | Єдине дальнє «жало»: 18 мани (беремо з **окремого** пулу мани, що інакше простоює), кулдаун 5 с, дальність 320, фізична шкода (Warrior-magic скіли фізичні). |
| 4 | **Sunder Armor** (`war_sunder_armor`) | debuff, stamina 15 | 5 c | 52 | STR32 DEX10 CON22; зброя: any | 6575 g | act4_primordial_sovereign (secret gem) | Тип `debuff`, але фактично AoE-удар за 15 стамини / кулдаун 5 с: 21 бази — приблизно на чверть краще за Twin Slash на ресурс. (Ефект «−35 % броні» не реалізований.) |
| 5 | **Battle Shout** (`war_battle_shout`) | buff, stamina 20 | 30 c | 42 | STR27 DEX8 CON19; зброя: any | 5125 g | act3_nether_behemoth (secret gem) | Єдиний «dealt»-баф у Warrior: ×1,2 шкоди на 20 с при кулдауні 30 с (≈67 % аптайму). |
| 6 | **Steel Tempering** (`war_steel_tempering`) | buff, stamina 20 | 30 c | 48 | STR30 DEX9 CON21; зброя: any | 6025 g | act3_nether_behemoth (secret gem) | −15 % отриманої шкоди на 30 с при кулдауні 30 с = постійний шар захисту за 20 стамини. |
| 7 | **Colossus Stance** (`war_colossus_stance`) | buff, stamina 30 | 50 c | 46 | STR29 DEX9 CON20; зброя: any | 5675 g | act3_nether_behemoth (secret gem) | +30 % макс. HP і ×1,25 досяжності на 15 с (кулдаун 50 с) — для босів і щільних пачок. |
| 8 | **Bloodlust Stance** (`war_bloodlust_stance`) | buff, stamina 0 | 5 c | 45 | STR29 DEX9 CON20; зброя: any | 5538 g | act3_nether_behemoth (secret gem) | До +30 % швидкості автоатаки (3 % за змах, макс. 10 стеків, скидається за 4 с простою), коштує 0 стамини. Корисний, поки ви нижче стелі швидкості (приблизно до DEX 65 + Fleet); потім замініть на `Unstoppable` (L47, лікує 10 %). |
| 9 | **Last Stand** (`war_last_stand`) | buff, stamina 0 | 120 c | 47 | STR30 DEX9 CON20; зброя: any | 5888 g | act3_nether_behemoth (secret gem) | Аварійна кнопка: HP не падає нижче 1 на 4 с (кулдаун 120 с). |

_Сума цін гемів хотбара: 43277 g._

**Порядок розблокування.**

| Скіл | Рівень | Вимоги | Ціна | Зброя |
|---|---|---|---|---|
| Crushing Blow (`war_crushing_blow`) | 1 | STR6 DEX2 CON5 | 100 g | melee |
| Whirlwind (`war_whirlwind`) | 1 | STR7 DEX2 CON6 | 388 g | melee |
| Hamstring Slash (`war_hamstring_slash`) | 1 | STR8 DEX2 CON7 | 463 g | melee |
| Punishing Strike (`war_punishing_strike`) | 10 | STR11 DEX4 CON8 | 1400 g | melee |
| Twin Slash (`war_twin_slash`) | 12 | STR12 DEX4 CON8 | 1600 g | melee |

* **L1–11:** `Whirlwind` (стамина 5/такт, 360°, канал) + `Crushing Blow` + `Hamstring Slash` — геми стартової трійки коштують 100 / 388 / 463 g. Для цього потрібні +1…+2 STR (вимоги `Str6–7 Con5–6`), тобто першого ж minor-вузла.
* **L12:** `Twin Slash` → **L17 (після `act1_sunspire_reliquary`):** `Flurry of Steel` — з цього моменту `Whirlwind` зайвий (той самий радіус, база 4 проти 20 за такт).
* **L39 (`act2`)**: `Windblade`; **L42–48 (`act3`)**: `Battle Shout`, `Bloodlust Stance`, `Colossus Stance`, `Last Stand`, `Steel Tempering` (секретні геми — з'являться в торговця після квесту); **L52 (`act4`)**: `Sunder Armor`.
* Вимоги до атрибутів усього хотбара (макс.: STR 32, DEX 10, CON 22) виконуються з **26-го очка** плану; `Twin Slash` (STR12 CON8) — з 14-го очка (на 3 очки пізніше за 11 очок рівня L12 — перекривається ранніми квестами або `of_might` на шмотках).

**Техніка:** тримайте ЛКМ (автоатака) на цілях, а `Flurry of Steel` вмикайте на 0,5–1 с (2–4 такти) — це в 3–5 разів дешевше за довгий канал. `Battle Shout` + `Steel Tempering` піднімайте перед важкими боями (кулдаун 30 с = майже постійні).

### 1.3 Пасивне дерево

**Стартовий вузол:** `start-strength` (id 919, «Warrior») — `damage physical +3 %`. Ключові вузли плану та вартість найкоротшого шляху до них від старту окремо:

| id | Вузол | Вартість найкоротшого шляху від старту окремо | Позиція в плані |
|---|---|---|---|
| 21076 | Unbreakable (keystone) | 12 | 12 |
| 1197 | Reckless Swing (keystone) | 17 | 38 |
| 54213 | Afterimage (greater) | 21 | 44 |
| 20964 | Iron Hide (keystone) | 10 | 50 |
| 1044 | Executioner (keystone) | 12 | 71 |
| 20780 | Fleet (keystone) | 13 | 89 |
| 20668 | Windrunner (keystone) | 11 | 92 |
| 1340 | Pain Ward (keystone) | 14 | 111 |
| 21260 | Crimson Bargain (keystone) | 19 | 123 |
| 1743 | Wolf Aspect (keystone) | 24 | 139 |
| 1636 | Bear Aspect (keystone) | 23 | 143 |

**Віхи** (стати після вказаної кількості очок):

| Очок | STR | DEX | CON | INT | WIS | CHA | Макс. HP | Макс. мана | Реген мани/с | Макс. стамина | Реген стам./с | Реген HP/с | Множник скілів (головний стат) | Множник удару зброї (STR) | Інтервал автоатаки, × від cd зброї (менше = швидше) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 27 | 5 | 5 | 5 | 5 | 5 | 116 | 118 | 10 | 100 | 10 | 1.0 | ×2.1 | ×2.1 | ×1.00 |
| 30 | 95 | 45 | 37 | 5 | 5 | 5 | 554 | 124 | 10 | 125 | 15 | 4.2 | ×6.1 | ×5.5 | ×0.45 |
| 60 | 199 | 45 | 57 | 5 | 7 | 8 | 966 | 136 | 11 | 150 | 15 | 7.4 | ×11.8 | ×10.7 | ×0.45 |
| 100 | 321 | 80 | 83 | 7 | 9 | 11 | 1258 | 170 | 13 | 200 | 20 | 10.0 | ×18.5 | ×16.8 | ×0.35 |
| 150 | 358 | 84 | 163 | 9 | 11 | 44 | 2266 | 190 | 15 | 235 | 25 | 20.7 | ×28.7 | ×18.7 | ×0.35 |

Правила/відсотки на віхах (лише ненульові): 10 очок — `без правил`; damage% physical +3; пули з дерева hp +16, mana +18; 30 — `strengthSkillDamage 0.1; staminaRegen 5`; damage% physical +15, lightning +8; пули з дерева hp +134, mana +24, stamina +25; 60 — `strengthSkillDamage 0.1; staminaRegen 5; meleeWaveShare 0.15; hpRegen 1.2`; damage% physical +44, lightning +8; resist% ice -10; пули з дерева hp +346, mana +36, stamina +50; 100 — `strengthSkillDamage 0.1; staminaRegen 10; meleeWaveShare 0.15; hpRegen 1.2; meleeReachBonus 12; cooldownFloor 0.35; dexteritySkillDamage 0.1`; damage% physical +70, lightning +8; resist% physical +1, arcane +5, ice -10; пули з дерева hp +378, mana +50, stamina +100; 150 — `strengthSkillDamage 0.1; staminaRegen 15; meleeWaveShare 0.25; hpRegen 3.9; meleeReachBonus 12; cooldownFloor 0.35; dexteritySkillDamage 0.1; skillDamageMult 1.4; lifeCostMultiplier 1.3; formPower 0.24`; damage% physical +105, fire +8, lightning +16; resist% physical +19, arcane +5, fire +10, ice -10; пули з дерева hp +586, mana +50, stamina +135.

**Послідовність вузлів** (у порядку взяття; «Очок» — сумарно після взяття вузла; рядки `·` — проміжні minor-вузли, їхні `id` у блоці нижче):

| № | Очок (накопичено) | id | key | Назва (kind) | Що дає |
|---|---|---|---|---|---|
| · | 1–11 | 11 шт. | _minor-вузли на шляху_ | – | STR +24, hp +16, mana +24 |
| 1 | 12 | 21076 | `strength-r3-3-13` | **Unbreakable** (keystone) | strength+20 ; hp+100 |
| 2 | 13 | 21077 | `strength-r3-3-14` | **Martial Mastery** (greater) | R:strengthSkillDamage=0.1 |
| 3 | 14 | 21078 | `strength-r3-3-15` | **Renaissance** (notable) | constitution+12 |
| 4 | 15 | 21075 | `strength-r3-3-12` | **Wanderer's Gift** (greater) | dexterity+18 |
| · | 16–16 | 1 шт. | _minor-вузли на шляху_ | – | STR +2 |
| 5 | 17 | 115687 | `strength-r4-3-1` | **Ascendance** (greater) | strength+18 |
| 6 | 18 | 115671 | `strength-r4-2-18` | **Brutality** (notable) | dmg physical+8 |
| 7 | 19 | 115677 | `strength-r4-2-23` | **Charge** (notable) | dmg lightning+8 |
| 8 | 20 | 115676 | `strength-r4-2-22` | **Apostasy** (greater) | dexterity+20 |
| 9 | 21 | 115678 | `strength-r4-2-24` | **Ascendance** (greater) | strength+18 |
| 10 | 22 | 21068 | `strength-r3-3-5` | **Mastery** (notable) | strength+8 |
| · | 23–24 | 2 шт. | _minor-вузли на шляху_ | – | CON +4 |
| 11 | 25 | 115674 | `strength-r4-2-20` | **Unflagging** (notable) | R:staminaRegen=5 ; stamina+20 |
| · | 26–27 | 2 шт. | _minor-вузли на шляху_ | – | CON +4, stamina +5 |
| 12 | 28 | 1451 | `constitution-r3-1-14` | **Honed** (notable) | constitution+6 ; dmg physical+4 |
| · | 29–29 | 1 шт. | _minor-вузли на шляху_ | – | DEX +2 |
| 13 | 30 | 1449 | `constitution-r3-1-12` | **Ox Blood** (notable) | constitution+6 ; hp+18 |
| 14 | 31 | 1448 | `constitution-r3-1-11` | **Paragon** (greater) | constitution+20 |
| · | 32–37 | 6 шт. | _minor-вузли на шляху_ | – | STR +13, hp +40 |
| 15 | 38 | 1197 | `strength-r3-2-19` | **Reckless Swing** (keystone) | dmg physical+25 ; res ice-10 |
| · | 39–41 | 3 шт. | _minor-вузли на шляху_ | – | STR +8, stamina +10 |
| 16 | 42 | 115682 | `strength-r4-2-6` | **Ascendance** (greater) | strength+18 |
| 17 | 43 | 115683 | `strength-r4-2-7` | **Apotheosis** (notable) | strength+12 |
| 18 | 44 | 54213 | `clu_str_afterimage-hub` | **Afterimage** (greater) | R:meleeWaveShare=0.15 |
| 19 | 45 | 115679 | `strength-r4-2-3` | **Mastery** (notable) | strength+8 |
| · | 46–46 | 1 шт. | _minor-вузли на шляху_ | – | STR +2, stamina +5 |
| 20 | 47 | 21070 | `strength-r3-3-7` | **Mastery** (notable) | strength+8 |
| · | 48–49 | 2 шт. | _minor-вузли на шляху_ | – | STR +4, hp +16 |
| 21 | 50 | 20964 | `strength-r2-4-8` | **Iron Hide** (keystone) | hp+140 ; R:hpRegen=1.2 |
| · | 51–51 | 1 шт. | _minor-вузли на шляху_ | – | WIS +2, mana +6 |
| 22 | 52 | 20962 | `strength-r2-4-6` | **Honed** (notable) | strength+6 ; dmg physical+4 |
| · | 53–53 | 1 шт. | _minor-вузли на шляху_ | – | CHA +3 |
| 23 | 54 | 21072 | `strength-r3-3-9` | **Apotheosis** (notable) | strength+12 |
| · | 55–60 | 6 шт. | _minor-вузли на шляху_ | – | STR +13, hp +16, mana +6, stamina +10 |
| 24 | 61 | 1214 | `strength-r3-2-36` | **Great Sinew** (notable) | strength+6 |
| 25 | 62 | 1213 | `strength-r3-2-35` | **Ascendance** (greater) | strength+18 |
| · | 63–70 | 8 шт. | _minor-вузли на шляху_ | – | STR +22 |
| 26 | 71 | 1044 | `strength-r2-1-27` | **Executioner** (keystone) | dmg physical+15 ; R:meleeReachBonus=12 |
| · | 72–74 | 3 шт. | _minor-вузли на шляху_ | – | CON +2, hp +8, STR +2, res physical +1, dmg physical +3 |
| 27 | 75 | 1168 | `strength-r3-1-27` | **Great Sinew** (notable) | strength+6 |
| 28 | 76 | 1167 | `strength-r3-1-26` | **Ascendance** (greater) | strength+18 |
| · | 77–87 | 11 шт. | _minor-вузли на шляху_ | – | STR +10, DEX +8, hp +24, CHA +3, WIS +2, stamina +5 |
| 29 | 88 | 20772 | `dexterity-r3-3-5` | **Apotheosis** (notable) | dexterity+12 |
| 30 | 89 | 20780 | `dexterity-r3-3-13` | **Fleet** (keystone) | R:cooldownFloor=0.35 |
| 31 | 90 | 20779 | `dexterity-r3-3-12` | **Wanderer's Gift** (greater) | constitution+18 |
| 32 | 91 | 20778 | `dexterity-r3-3-11` | **Renaissance** (notable) | strength+12 |
| 33 | 92 | 20668 | `dexterity-r2-4-8` | **Windrunner** (keystone) | dexterity+15 ; stamina+40 ; R:staminaRegen=5 |
| 34 | 93 | 20781 | `dexterity-r3-3-14` | **Marksman's Mastery** (greater) | R:dexteritySkillDamage=0.1 |
| 35 | 94 | 20782 | `dexterity-r3-3-15` | **Brutality** (notable) | dmg physical+8 |
| · | 95–95 | 1 шт. | _minor-вузли на шляху_ | – | STR +2, stamina +5 |
| 36 | 96 | 1155 | `strength-r3-1-14` | **Wellspring** (notable) | strength+6 ; mana+14 |
| · | 97–97 | 1 шт. | _minor-вузли на шляху_ | – | INT +2 |
| 37 | 98 | 1153 | `strength-r3-1-12` | **Null Field** (notable) | res arcane+5 |
| 38 | 99 | 1152 | `strength-r3-1-11` | **Paragon** (greater) | strength+20 |
| 39 | 100 | 20774 | `dexterity-r3-3-7` | **Broad Study** (notable) | constitution+6 |
| 40 | 101 | 54214 | `clu_str_afterimage-sat0` | **Lingering Edge** (notable) | R:meleeWaveShare=0.05 |
| 41 | 102 | 54215 | `clu_str_afterimage-sat1` | **Slow Burn** (notable) | R:meleeWaveShare=0.05 |
| · | 103–108 | 6 шт. | _minor-вузли на шляху_ | – | CON +8, CHA +2, hp +8, res physical +1, dmg physical +3 |
| 42 | 109 | 1464 | `constitution-r3-1-27` | **Great Sinew** (notable) | constitution+6 |
| 43 | 110 | 1463 | `constitution-r3-1-26` | **Ascendance** (greater) | constitution+18 |
| 44 | 111 | 1340 | `constitution-r2-1-27` | **Pain Ward** (keystone) | res physical+10 ; res fire+10 ; R:hpRegen=1.2 |
| · | 112–122 | 11 шт. | _minor-вузли на шляху_ | – | CON +29, hp +24 |
| 45 | 123 | 21260 | `constitution-r2-4-8` | **Crimson Bargain** (keystone) | R:skillDamageMult=1.4 ; R:lifeCostMultiplier=1.3 |
| · | 124–124 | 1 шт. | _minor-вузли на шляху_ | – | DEX +4 |
| 46 | 125 | 1482 | `constitution-r3-2-8` | **Brutality** (notable) | dmg physical+8 |
| · | 126–126 | 1 шт. | _minor-вузли на шляху_ | – | STR +2, hp +8 |
| 47 | 127 | 21376 | `constitution-r3-3-17` | **Kindling** (notable) | dmg fire+8 |
| · | 128–128 | 1 шт. | _minor-вузли на шляху_ | – | res physical +2 |
| 48 | 129 | 21374 | `constitution-r3-3-15` | **Brutality** (notable) | dmg physical+8 |
| · | 130–136 | 7 шт. | _minor-вузли на шляху_ | – | CON +4, hp +16, CHA +10, stamina +10 |
| 49 | 137 | 1741 | `charisma-r3-1-8` | **Charge** (notable) | dmg lightning+8 |
| · | 138–138 | 1 шт. | _minor-вузли на шляху_ | – | CHA +2, stamina +5 |
| 50 | 139 | 1743 | `charisma-r3-1-10` | **Wolf Aspect** (keystone) | strength+15 ; charisma+15 ; dmg physical+12 ; R:formPower=0.12 |
| · | 140–142 | 3 шт. | _minor-вузли на шляху_ | – | CHA +4, CON +2 |
| 51 | 143 | 1636 | `charisma-r2-1-27` | **Bear Aspect** (keystone) | strength+20 ; hp+120 ; R:hpRegen=1.5 ; res physical+5 ; R:formPower=0.12 |
| · | 144–145 | 2 шт. | _minor-вузли на шляху_ | – | WIS +2, hp +16, INT +2 |
| 52 | 146 | 969 | `strength-r1-2-15` | **Unflagging** (notable) | R:staminaRegen=5 ; stamina+20 |
| · | 147–149 | 3 шт. | _minor-вузли на шляху_ | – | CON +7, hp +16 |
| 53 | 150 | 1495 | `constitution-r3-2-21` | **Honed** (notable) | constitution+6 ; dmg physical+4 |

**Що брати першим (≈ 10 очок):** 11 minor-вузлів STR (+24 STR, +16 HP, +24 мани) ведуть до `Unbreakable` (id 21076; +20 STR, +100 HP) на 12-му очку — це «вхід» у внутрішнє кільце сектора STR. **30 очок** (STR 95, DEX 45, CON 37, 554 HP): `Martial Mastery` (+10 % до скілів STR), кілька `Ascendance` (+18 STR), `Apostasy` (+20 DEX), `Paragon` (+20 CON). **60 очок:** `Reckless Swing` (+25 % фіз. шкоди), `Afterimage` (хвиля 15 %), `Iron Hide` (+140 HP). **100:** `Executioner` (+15 %, +12 reach), `Fleet` (floor 0,35), `Windrunner` (+15 DEX, +40 стамини, +5 регена стамини). **150:** `Pain Ward` (111), **`Crimson Bargain`** (123; ×1,4 до скілів — для Warrior вартість життя нічого не коштує), добір фіз.%/стамини і `Wolf Aspect` (139) / `Bear Aspect` (143) лише як джерело STR/HP (їхній `formPower` Warrior не потрібен; за бажанням замініть на `Ascendance`).

**Кейстоуни та їхні мінуси:**
* `Reckless Swing` (1197): +25 % фіз. шкоди, **−10 % опору льоду** — обирайте, якщо не граєте проти крижаних босів (або компенсуйте `Warm Blood` +5 %).
* `Iron Hide` (20964), `Unbreakable` (21076), `Executioner` (1044), `Windrunner` (20668), `Fleet` (20780), `Pain Ward` (1340) — **без мінусів**. `Crimson Bargain` (21260): «+30 % вартості життя» для Warrior нерелевантне (немає скілів за життя) — чистий ×1,4.
* Кластер `Afterimage` (54213): хвиля 15 % шкоди замаху за секунду (+5 % на кожен із двох сателітів) — без мінусів. `Whirlwind` (54205, +3,5 рад дуги) **не брав**: він мінус 20 % шкоди замаху (`meleeDamageMult 0,8`).

**Усі `id` у порядку взяття (150 очок), по віхах — для перевірки зв'язності й швидкого проходу:**

```
# очки 1–10
924 925 926 927 928 1002 1122 115638 115637 115636
# очки 11–30
115634 21076 21077 21078 21075 115672 115687 115671 115677 115676 115678 21068 1400 1401 115674 1402 1443 1451 1450 1449
# очки 31–60
1448 115633 115632 115631 115630 115629 115628 1197 115673 115662 115681 115682 115683 54213 115679 21065 21070 1121 1120 20964 20963 20962 21071 21072 1119 1118 1117 1208 21064 21063
# очки 61–100
1214 1213 1116 1115 1114 1113 1112 1111 1110 1109 1044 1162 1170 1169 1168 1167 1108 1107 1106 1105 1104 826 825 824 20775 20770 20769 20772 20780 20779 20778 20668 20781 20782 1147 1155 1154 1153 1152 20774
# очки 101–150
54214 54215 1403 1404 1405 1458 1466 1465 1464 1463 1340 1406 1407 1408 1409 1410 1411 1412 1413 1414 1415 1416 21260 1473 1482 21367 21376 21375 21374 1417 1418 1696 1697 1698 1739 1740 1741 1742 1743 1699 1700 1701 1636 967 968 969 1489 1497 1496 1495
```

### 1.4 Зброя та броня

* **Зброя:** одноручний STR-клинок — `*-sword` (reach 85, arc 1,3, cd 0,6), `*-axe` (reach 75, arc 1,4, cd 0,7, більша шкода за удар) або `*-blade` (reach 80, cd 0,55). Усі T2+ мають `stamina_cost 0`. У T10 `mythic-sword` = 101,5 шкоди / 0,6 с, `mythic-axe` = 116 / 0,7 с (потрібні STR 116 і L150). Проміжні: `iron-*` (L10, STR 8), `steel-*` (L25, STR 16), `tempered-*` (L40, STR 26), `runed-*` (L55, STR 36), `obsidian-*` (L70, STR 48), `astral-*` (L90, STR 62), `void-*` (L110, STR 78), `dragon-*` (L130, STR 96). Дворучні (`two-handed sword`, `halberd`, `scythe`) — лише T1-легасі з `stamina_cost` 15–18 за змах, не варті. `*-mace` дає 20 % оглушення 1 с (але вимагає CON), `Concussion` кластер теж.
* **Броня:** плита STR — `*-helm`, `*-plate`, `*-gauntlets`, `*-buckler` (off_hand); `*-greaves` (CON) для ніг. T4: plate STR 26 / L40 (def 10,2), T7: STR 62 / L90 (23,4), T10: STR 116 / L150 (43,5). Захист віднімається від кожного удару (flat). Кільця (`*-band`, `*-signet`) вимагають **CHA** (T2 — 8 … T10 — 116): Warrior має CHA 44 на 150 очках, тож носить до `runed-band` (36).
* **Афікси на синіх+ предметах:** `of_might` (+1…+12 STR), `of_the_bear` (+HP на голову/груди/ноги), `of_vigor`; `flaming/freezing` (жовті+, зброя) — додають % вогню/льоду.

### 1.5 Слабкі місця та як їх обійти

* **Мана 190 на 150 очках** — `Windblade` 10 разів поспіль і порожньо; не покладайтеся на магічні скіли.
* **Немає дальньої атаки й мобільності** (`Leap Slam`/`Earth Stride` — просто урон, не стрибок). Кайтити не вийде: беріть бої впритул, користуйтеся `Colossus Stance` (reach ×1,25) і `Cleaving Reach` кластером (id 54202; +20/+10/+10 досяжності) за потреби.
* **Опір льоду −10 %** після `Reckless Swing`.
* **Стамина — єдиний ресурс:** 235 пул при регені 25/с (з `Unflagging` ×2 і `Windrunner`). Не підтримуйте довгий `Flurry`; для «марафону» беріть вузли `Unflagging`/`Fleeting Rest`/`Endurance`.
* **Оглушення й контроль** у цієї гри слабкі (у скілів вони не реалізовані), але `Iron Will` (L44) дає імунітет до станів 5 с, якщо знадобиться.


## 2. Mage — «Льодо-вогняний ритм» (Frost-Fire Cadence)

**Стиль:** далекобійний кастер: INT-множник на всі закляття, +2 снаряди (`Deadeye` + `Volley`) → одноударні заклять б'ють утричі, чергування льоду й вогню активує `Shatter`/`Thermal Shock`; захист — `Mana Shield` (70 % шкоди з гігантського пулу мани) і `Blink`.

### 2.1 Пріоритет статів

1. **INT** — множник усіх скілів Mage (атрибут усіх 50 скілів — intelligence, `+5 %`/очко), +10 мани/очко, +0,5 мани/с реґену, і `spellMult` для зброї/каменів з елементом. План: INT 392.
2. **WIS** (≈ 22 для гемів) — +0,5 мани/с за очко; план дає WIS 73 (більше нам не потрібно).
3. **DEX** — спершу як шлях до `Deadeye`/`Volley`; DEX 96 на 150 очках (кулдаун-множник = 0,35 з `Fleet`) прискорює і автоатаку/каст зі зброї, і кулдауни скілів (на частку 50 %).
4. **CON** — лише ≥10 для гемів і HP; Mage має 75 базових HP, тож беремо `Ox Blood`/`Thick Skin` по дорозі (у плані HP 724 при базових 75).

### 2.2 Хотбар (9 слотів)

| Слот | Скіл (id) | Тип / ресурс | Кулдаун | Рівень | Вимоги до статів | Ціна гема | Квест-гейт | Навіщо |
|---|---|---|---|---|---|---|---|---|
| 1 | **Frostbolt** (`mag_frostbolt`) | magic, mana 20 | 1.5 c | 17 | CON5 INT15 WIS10; зброя: staff_wand | 2138 g | act1_sunspire_reliquary | Дешевий (20 мани, кулдаун 1,5 с) снаряд льоду; з `Deadeye`+`Volley` (+2) б'є **3 рази**. Ініціатор синергії `Shatter` (лід → вогонь ×1,30). |
| 2 | **Fireball** (`mag_fireball`) | magic, mana 25 | 2 c | 16 | CON4 INT14 WIS10; зброя: staff_wand | 2000 g | act1_sunspire_reliquary | Вогняний AoE-снаряд (25 мани, кд 2 с), теж 3 удари з +2 снаряди; завершує `Shatter` і «заряджає» `Thermal Shock` (вогонь → лід ×1,25). Чергуйте Frostbolt ↔ Fireball: кожен каст добиває синергію (+ланцюг до +18 %). |
| 3 | **Magic Missiles** (`mag_magic_missiles`) | magic, mana 22 | 3 c | 31 | CON7 INT22 WIS15; зброя: staff_wand | 3688 g | act2_obsidian_drake | Багатоударний скіл (5 стріл × 6 + 2 від +projectile = 7 ударів × 6 = 42 бази) за 22 мани, кд 3 с — найкраща шкода на ману серед «одиничних» заклять. |
| 4 | **Blizzard** (`mag_blizzard`) | magic, канал, mana 6 | 0 c | 29 | CON6 INT21 WIS14; зброя: staff_wand | 3488 g | act2_obsidian_drake | Канал AoE по курсору (лід, 6 бази/такт, 6 мани/такт з ростом): із регеном 240 мани/с підтримується безперервно; радіус росте зі ступенем каналу. |
| 5 | **Blink** (`mag_blink`) | magic, mana 25 | 8 c | 26 | CON6 INT19 WIS13; зброя: staff_wand | 3150 g | act1_sunspire_reliquary | Єдиний справжній скіл-переміщення в грі: тепер на `min(260, range)` px уперед (опис каже «8 тайлів», код — 260 px). Рятує крихкого мага (HP 724). |
| 6 | **Mana Shield** (`mag_mana_shield`) | buff, mana 0 | 5 c | 42 | CON8 INT27 WIS19; зброя: any | 5125 g | act3_nether_behemoth (secret gem) | `manaShield 0,7`: 70 % отриманої шкоди сплачується маною (4145 пул ≈ величезний буфер). Кошт мани 0, кд 5 с, тривалість 30 с — тримайте постійно. |
| 7 | **Empower Elements** (`mag_empower_elements`) | buff, mana 30 | 30 c | 50 | CON10 INT31 WIS22; зброя: any | 6300 g | act3_nether_behemoth (secret gem) | ×1,3 шкоди на 15 с (кд 30 с), множиться з `Arcane Brilliance`. |
| 8 | **Arcane Brilliance** (`mag_arcane_brilliance`) | buff, mana 40 | 60 c | 46 | CON9 INT29 WIS20; зброя: any | 5675 g | act3_nether_behemoth (secret gem) | ×1,25 шкоди на 30 с (кд 60 с). Опис каже «30m», у коді `dur: 30` секунд. |
| 9 | **Elemental Focus** (`mag_elemental_focus`) | buff, mana 20 | 25 c | 47 | CON9 INT30 WIS20; зброя: any | 5888 g | act3_nether_behemoth (secret gem) | Наступні **3 закляття гарантовано критують** (`critNext 3`, 30 с, кд 25 с) — ставте перед `Magic Missiles`/`Frostbolt`. |

_Сума цін гемів хотбара: 37452 g._

**Порядок розблокування.**

| Скіл | Рівень | Вимоги | Ціна | Зброя |
|---|---|---|---|---|
| Arcane Dagger (`mag_arcane_dagger`) | 1 | CON2 INT6 WIS5 | 100 g | staff_wand |
| Frost Rapier (`mag_frost_rapier`) | 1 | CON2 INT8 WIS7 | 463 g | staff_wand |
| Mana Blades (`mag_mana_blades`) | 6 | CON3 INT9 WIS6 | 1000 g | staff_wand |
| Fireball (`mag_fireball`) | 16 | CON4 INT14 WIS10 | 2000 g | staff_wand |
| Frostbolt (`mag_frostbolt`) | 17 | CON5 INT15 WIS10 | 2138 g | staff_wand |

* **L1–15:** усі 10 перших скілів Mage — типу `melee` (діють як ближній дугоподібний удар), але вимагають `staff_wand` у руці (тримайте жезл/стаф): `Arcane Dagger` (cd 1 с, 12 мани), `Frost Rapier`, `Mana Blades`. Основний дальній урон до L16 — автоатака жезлом/каменем.
* **L16 (`act1`)**: `Fireball`, **L17**: `Frostbolt` — з цього моменту ядро готове (Int 14–15, Wis 10, Con 4–5; усе виконано до 7-го очка плану).
* **L26** `Blink` (гейт `act1`), **L29** `Blizzard` і **L31** `Magic Missiles` (гейт `act2`).
* **L42–50 (`act3`)**: `Mana Shield` (L42), `Arcane Brilliance` (L46), `Elemental Focus` (L47), `Empower Elements` (L50). Усі вимоги атрибутів виконано на 17-му очку.

**Ротація:** `Elemental Focus` → `Frostbolt` → `Fireball` → `Frostbolt` → `Fireball` (кожна пара = синергія) → `Magic Missiles`; `Blizzard` — для щільних пачок; `Empower Elements` + `Arcane Brilliance` одночасно (×1,625).

### 2.3 Пасивне дерево

**Стартовий вузол:** `start-intelligence` (id 327, «Mage») — `damage arcane +3 %`.

| id | Вузол | Вартість найкоротшого шляху від старту окремо | Позиція в плані |
|---|---|---|---|
| 20188 | Transcendence (keystone) | 13 | 13 |
| 748 | Deadeye (keystone) | 14 | 38 |
| 559 | Cryomancy (keystone) | 14 | 39 |
| 20484 | Arcane Conduit (keystone) | 12 | 51 |
| 54194 | Volley (greater) | 19 | 65 |
| 452 | Pyromancy (keystone) | 12 | 82 |
| 605 | Glass Cannon (keystone) | 17 | 104 |
| 20372 | Storm Caller (keystone) | 10 | 111 |
| 20780 | Fleet (keystone) | 21 | 129 |
| 901 | Phantom Step (keystone) | 23 | 131 |

**Віхи:**

| Очок | STR | DEX | CON | INT | WIS | CHA | Макс. HP | Макс. мана | Реген мани/с | Макс. стамина | Реген стам./с | Реген HP/с | Множник скілів (головний стат) | Множник удару зброї (STR) | Інтервал автоатаки, × від cd зброї (менше = швидше) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 5 | 5 | 5 | 15 | 16 | 5 | 91 | 262 | 20 | 100 | 10 | 1.0 | ×1.5 | ×1.0 | ×1.00 |
| 30 | 7 | 7 | 17 | 101 | 45 | 7 | 262 | 1134 | 78 | 105 | 10 | 2.2 | ×5.8 | ×1.1 | ×0.94 |
| 60 | 7 | 57 | 29 | 164 | 47 | 9 | 405 | 1841 | 114 | 105 | 10 | 3.4 | ×9.8 | ×1.1 | ×0.40 |
| 100 | 11 | 61 | 35 | 275 | 47 | 11 | 553 | 2963 | 169 | 115 | 10 | 4.0 | ×16.0 | ×1.3 | ×0.40 |
| 150 | 11 | 96 | 53 | 392 | 73 | 11 | 724 | 4145 | 240 | 140 | 10 | 5.8 | ×30.2 | ×1.3 | ×0.35 |

Правила/відсотки на віхах: 10 очок — `без правил`; damage% arcane +3; пули з дерева hp +16, mana +12; 30 — `без правил`; damage% physical +4, arcane +3; пули з дерева hp +67, mana +24, stamina +5; 60 — `projectileCount 1; manaRegen 3; intelligenceSkillDamage 0.1; dodgeChance 0.03`; damage% physical +4, arcane +3, ice +20; resist% arcane +5; пули з дерева hp +90, mana +101, stamina +5; 100 — `projectileCount 2; manaRegen 3; intelligenceSkillDamage 0.1; dodgeChance 0.03`; damage% physical +7, arcane +3, fire +28, ice +28; resist% physical +1, arcane +5; пули з дерева hp +178, mana +113, stamina +15; 150 — `projectileCount 2; manaRegen 3; intelligenceSkillDamage 0.1; dodgeChance 0.18; skillDamageMult 1.35; manaCostMult 1.25; cooldownFloor 0.35`; damage% physical +7, arcane +19, fire +28, ice +36, lightning +20; resist% physical +4, arcane +5; пули з дерева hp +169, mana +125, stamina +40.

**Послідовність вузлів:**

| № | Очок (накопичено) | id | key | Назва (kind) | Що дає |
|---|---|---|---|---|---|
| · | 1–12 | 12 шт. | _minor-вузли на шляху_ | – | INT +10, WIS +15, hp +16, mana +24 |
| 1 | 13 | 20188 | `wisdom-r3-3-13` | **Transcendence** (keystone) | wisdom+25 ; intelligence+18 |
| 2 | 14 | 20187 | `wisdom-r3-3-12` | **Wanderer's Gift** (greater) | intelligence+18 |
| 3 | 15 | 20186 | `wisdom-r3-3-11` | **Thick Skin** (notable) | hp+25 |
| · | 16–16 | 1 шт. | _minor-вузли на шляху_ | – | CHA +2, hp +8 |
| 4 | 17 | 20184 | `wisdom-r3-3-9` | **Renaissance** (notable) | constitution+12 |
| · | 18–21 | 4 шт. | _minor-вузли на шляху_ | – | INT +8, stamina +5 |
| 5 | 22 | 563 | `intelligence-r3-1-14` | **Honed** (notable) | intelligence+6 ; dmg physical+4 |
| · | 23–23 | 1 шт. | _minor-вузли на шляху_ | – | STR +2 |
| 6 | 24 | 561 | `intelligence-r3-1-12` | **Ox Blood** (notable) | intelligence+6 ; hp+18 |
| 7 | 25 | 560 | `intelligence-r3-1-11` | **Paragon** (greater) | intelligence+20 |
| · | 26–37 | 12 шт. | _minor-вузли на шляху_ | – | INT +10, DEX +16 |
| 8 | 38 | 748 | `dexterity-r2-1-27` | **Deadeye** (keystone) | dexterity+20 ; R:projectileCount=1 |
| 9 | 39 | 559 | `intelligence-r3-1-10` | **Cryomancy** (keystone) | dmg ice+20 ; status chill |
| · | 40–40 | 1 шт. | _minor-вузли на шляху_ | – | INT +2, mana +6 |
| 10 | 41 | 750 | `dexterity-r2-2-0` | **Mastery** (notable) | dexterity+8 |
| · | 42–47 | 6 шт. | _minor-вузли на шляху_ | – | DEX +2, INT +10, mana +24 |
| 11 | 48 | 115326 | `intelligence-r4-3-1` | **Ascendance** (greater) | intelligence+18 |
| 12 | 49 | 115325 | `intelligence-r4-3-0` | **Null Field** (notable) | res arcane+5 |
| 13 | 50 | 115317 | `intelligence-r4-2-24` | **Ascendance** (greater) | intelligence+18 |
| 14 | 51 | 20484 | `intelligence-r3-3-13` | **Arcane Conduit** (keystone) | intelligence+15 ; mana+35 ; R:manaRegen=3 |
| 15 | 52 | 20485 | `intelligence-r3-3-14` | **Arcane Mastery** (greater) | R:intelligenceSkillDamage=0.1 |
| 16 | 53 | 20476 | `intelligence-r3-3-5` | **Broad Study** (notable) | dexterity+6 |
| · | 54–54 | 1 шт. | _minor-вузли на шляху_ | – | CON +2 |
| 17 | 55 | 20478 | `intelligence-r3-3-7` | **Second Discipline** (notable) | constitution+8 |
| · | 56–57 | 2 шт. | _minor-вузли на шляху_ | – | CON +2, hp +8, CHA +2, mana +6 |
| 18 | 58 | 868 | `dexterity-r3-1-23` | **Hunter's Reflexes** (notable) | R:dodgeChance=0.03 |
| · | 59–64 | 6 шт. | _minor-вузли на шляху_ | – | WIS +2, mana +6, hp +15, DEX +2, STR +2, INT +5 |
| 19 | 65 | 54194 | `clu_dex_volley-hub` | **Volley** (greater) | R:projectileCount=1 |
| · | 66–74 | 9 шт. | _minor-вузли на шляху_ | – | INT +21, hp +40, stamina +10 |
| 20 | 75 | 115321 | `intelligence-r4-2-6` | **Ascendance** (greater) | intelligence+18 |
| 21 | 76 | 115318 | `intelligence-r4-2-3` | **Mastery** (notable) | intelligence+8 |
| 22 | 77 | 20486 | `intelligence-r3-3-15` | **Kindling** (notable) | dmg fire+8 |
| 23 | 78 | 115310 | `intelligence-r4-2-18` | **Frostbite** (notable) | dmg ice+8 |
| · | 79–81 | 3 шт. | _minor-вузли на шляху_ | – | INT +6 |
| 24 | 82 | 452 | `intelligence-r2-1-27` | **Pyromancy** (keystone) | dmg fire+20 ; status burn |
| · | 83–85 | 3 шт. | _minor-вузли на шляху_ | – | CHA +2, hp +8, INT +2, res physical +1, dmg physical +3 |
| 25 | 86 | 576 | `intelligence-r3-1-27` | **Great Sinew** (notable) | intelligence+6 |
| 26 | 87 | 575 | `intelligence-r3-1-26` | **Ascendance** (greater) | intelligence+18 |
| · | 88–89 | 2 шт. | _minor-вузли на шляху_ | – | INT +4 |
| 27 | 90 | 20255 | `intelligence-r1-4-1` | **Broad Study** (notable) | constitution+6 |
| · | 91–91 | 1 шт. | _minor-вузли на шляху_ | – | DEX +2, mana +6 |
| 28 | 92 | 454 | `intelligence-r2-2-0` | **Mastery** (notable) | intelligence+8 |
| · | 93–101 | 9 шт. | _minor-вузли на шляху_ | – | INT +15, hp +40, mana +6, STR +2, DEX +2 |
| 29 | 102 | 622 | `intelligence-r3-2-36` | **Mastery** (notable) | intelligence+8 |
| 30 | 103 | 621 | `intelligence-r3-2-35` | **Ascendance** (greater) | intelligence+18 |
| 31 | 104 | 605 | `intelligence-r3-2-19` | **Glass Cannon** (keystone) | R:skillDamageMult=1.35 ; R:manaCostMult=1.25 ; hp-80 |
| · | 105–108 | 4 шт. | _minor-вузли на шляху_ | – | hp +23, INT +2, WIS +4 |
| 32 | 109 | 115282 | `intelligence-r4-1-15` | **Jarring Blows** (notable) | status shock |
| 33 | 110 | 115281 | `intelligence-r4-1-14` | **Ascendance** (greater) | intelligence+18 |
| 34 | 111 | 20372 | `intelligence-r2-4-8` | **Storm Caller** (keystone) | dmg lightning+20 ; status shock |
| · | 112–112 | 1 шт. | _minor-вузли на шляху_ | – | INT +2, res physical +1 |
| 35 | 113 | 20374 | `intelligence-r2-4-10` | **Great Sinew** (notable) | intelligence+6 |
| · | 114–114 | 1 шт. | _minor-вузли на шляху_ | – | INT +4 |
| 36 | 115 | 20376 | `intelligence-r2-4-12` | **Mastery** (notable) | intelligence+8 |
| · | 116–128 | 13 шт. | _minor-вузли на шляху_ | – | DEX +33, hp +40, mana +6 |
| 37 | 129 | 20780 | `dexterity-r3-3-13` | **Fleet** (keystone) | R:cooldownFloor=0.35 |
| 38 | 130 | 20779 | `dexterity-r3-3-12` | **Wanderer's Gift** (greater) | constitution+18 |
| 39 | 131 | 901 | `dexterity-r3-2-19` | **Phantom Step** (keystone) | R:dodgeChance=0.15 ; stamina+20 |
| · | 132–132 | 1 шт. | _minor-вузли на шляху_ | – | INT +2, stamina +5 |
| 40 | 133 | 618 | `intelligence-r3-2-32` | **Great Sinew** (notable) | intelligence+6 |
| · | 134–138 | 5 шт. | _minor-вузли на шляху_ | – | INT +14, hp +8 |
| 41 | 139 | 488 | `intelligence-r2-3-5` | **Mastery** (notable) | intelligence+8 |
| · | 140–140 | 1 шт. | _minor-вузли на шляху_ | – | INT +3 |
| 42 | 141 | 484 | `intelligence-r2-3-1` | **Great Sinew** (notable) | intelligence+6 |
| 43 | 142 | 115313 | `intelligence-r4-2-20` | **Resonance** (notable) | dmg arcane+8 |
| · | 143–143 | 1 шт. | _minor-вузли на шляху_ | – | res physical +2 |
| 44 | 144 | 20370 | `intelligence-r2-4-6` | **Great Sinew** (notable) | intelligence+6 |
| · | 145–145 | 1 шт. | _minor-вузли на шляху_ | – | WIS +2 |
| 45 | 146 | 116041 | `wisdom-r4-2-18` | **Frostbite** (notable) | dmg ice+8 |
| 46 | 147 | 116057 | `wisdom-r4-3-1` | **Ascendance** (greater) | wisdom+18 |
| 47 | 148 | 116044 | `wisdom-r4-2-20` | **Resonance** (notable) | dmg arcane+8 |
| · | 149–149 | 1 шт. | _minor-вузли на шляху_ | – | WIS +2, mana +6 |
| 48 | 150 | 450 | `intelligence-r2-1-25` | **Great Sinew** (notable) | intelligence+6 |

**Логіка:** 12 minor-вузлів ведуть до `Transcendence` (id 20188; +25 WIS, +18 INT) на 13-му очку, поруч `Wanderer's Gift` (+18 INT), `Paragon` (+20 INT). 38-е очко — **`Deadeye`** (+1 снаряд), потім `Cryomancy` (+20 % льоду), `Arcane Conduit` (+3 мани/с), `Arcane Mastery` (+10 % до INT-скілів), 65-е очко — **`Volley`** (+1 снаряд, разом +2), 82-е — `Pyromancy` (+20 % вогню), 104-е — **`Glass Cannon`** (×1,35, **−80 макс. HP**, +25 % вартості мани), 111-е — `Storm Caller`, 129-е — `Fleet` (floor 0,35), 131 — `Phantom Step` (+15 % ухилення).

**Кейстоуни та їхні мінуси:**
* `Glass Cannon` (605; від старту 17 вузлів): −80 HP (на 724 HP відчутно): компенсуйте `Mana Shield` (70 % шкоди з мани); +25 % вартості мани при регені 240/с некритично. **Альтернатива:** замість нього візьміть `Crimson Bargain` (21260, ×1,4, безкоштовний для Mage; найкоротший шлях від старту — 29 вузлів) — вони складаються (1 + 0,35 + 0,40 = ×1,75).
* `Deadeye` (748) і `Phantom Step` (901), `Fleet` (20780), `Arcane Conduit` (20484), `Transcendence` (20188) — без мінусів. `Cryomancy`, `Pyromancy`, `Storm Caller` — +20 % елемента + статус (chill/burn/shock) без мінусів; усі три, якщо дозволяють очки.

**Усі `id` у порядку взяття (150 очок), по віхах — для перевірки зв'язності й швидкого проходу:**

```
# очки 1–10
332 331 330 329 328 40 114 234 115998 115997
# очки 11–30
115996 115994 20188 20187 20186 20185 20184 512 513 514 555 563 562 561 560 333 334 335 336 624
# очки 31–60
692 808 809 810 811 812 813 748 559 749 750 114882 115267 115266 115265 115263 115311 115326 115325 115317 20484 20485 20476 20473 20478 866 867 868 869 870
# очки 61–100
114901 114929 114928 114910 54194 115262 115261 115260 115259 115258 115257 115312 115301 115320 115321 115318 20486 115310 515 516 517 452 570 578 577 576 575 395 20254 20255 453 454 530 529 528 527 526 525 616 20472
# очки 101–150
20471 622 621 605 574 115271 115299 115283 115282 115281 20372 20373 20374 20375 20376 114902 114903 114904 114884 114885 114886 114887 114888 114889 114890 114891 114892 114893 20780 20779 901 617 618 524 523 522 486 487 488 485 484 115313 20371 20370 116042 116041 116057 116044 451 450
```

### 2.4 Зброя та броня

* **Зброя:** жезл `*-wand` (1H, вимагає INT: T2 8 … T10 116) або стаф `*-staff` (2H). **Важливо:** тірові стафи/жезли — **безелементні** (`element NULL`), їхня автоатака масштабується **STR** (у плані Mage STR 11 → ×1,3), а не INT. Тому в зброю вставляють **replace-камінь** (`stone_of_*`): елемент, шкода, кулдаун і ману беруть з каменя (`stone_of_archmage staff`: 24 шкоди, cd 1,1, 32 мани, arcane; `stone_of_flame staff` — 16, 0,8, 18, fire; `stone_of_frost staff` — 15, 0,7, 16, ice; `stone_of_storm staff` — 15, 1,1, 22, lightning), а дальність/снаряд — зі зброї. Така атака масштабується INT (×20 на 150 очках). Дві `augment`-каменя (`stone_of_frost_edge/ember_edge`) — для мілі, не для Mage.
* **Броня:** `*-robe` (chest, **INT**: T4 26 / L40, T7 62 / L90, T10 116 / L150; def лише половина від плити), `*-hood` (DEX), `*-focus` (off_hand, **WIS**), `arcane-ward` (head, +30 % арканного опору). Кільця — CHA (Mage CHA 11, тож лише `iron-band`). Афікси: `of_the_well` (+мана на кільця/off_hand), `of_insight` (+INT), `of_the_bear` (+HP на голову/груди/ноги); `flaming`/`freezing` на зброю додають % елемента.

### 2.5 Слабкі місця та як їх обійти

* **724 HP на 150 очках** і щит залежить від мани: не лишайтеся без мани (при регені 240/с це практично нереально, але перший бій після респауну — з порожнім пулом нема).
* **Низький фізичний захист/ухилення 18 %** — тримайте дистанцію, `Blink` на кулдауні, `Ethereal Form` (L49, 3,5 с імунітет до фізики) у запасі.
* **`Glass Cannon` +25 % вартості мани** та `manaCostMult` стакаються адитивно з майбутніми вузлами.
* **Усі скіли L16+ під квест-гейтами** (`act1` для L16–27, `act2` для L28–39, `act3` для L40–51). До акту 1 граєте на `Arcane Dagger` + жезл.
* Багато заклять не мають реальних ефектів з опису (`Frost Nova` не «заморожує», `Polymorph` не перетворює) — це чиста шкода.


## 3. Monk — «Потік Ци» (Flow of Chi)

**Стиль:** напівмагічний боєць на мані: канали `Spinning Crane Kick` / `Jade Serpent Beam` не гаснуть завдяки величезному регену мани (≈ 220/с), `Ki Overflow` підвищує шкоду, поки мана ≥ 80 %, а стартовий вузол перетворює реген мани на життя.

### 3.1 Пріоритет статів

1. **WIS** — множник усіх скілів Monk (+5 % за очко), +0,5 мани/с за очко **і** (з `Ki Overflow`) +2 макс. мани за очко. План: WIS 366 → реген мани 224/с.
2. **DEX 24 + STR 15 + CON 15** — вимоги гемів (кожен скіл Monk вимагає також Dex/Str/Con); DEX також +3 % швидкості. План: DEX 45, STR 23, CON 137, INT 63.
3. **CON** — HP (1725 на 150) і реген HP.

### 3.2 Хотбар (9 слотів)

| Слот | Скіл (id) | Тип / ресурс | Кулдаун | Рівень | Вимоги до статів | Ціна гема | Квест-гейт | Навіщо |
|---|---|---|---|---|---|---|---|---|
| 1 | **Spinning Crane Kick** (`mnk_spinning_crane_kick`) | melee, канал, mana 4 | 0 c | 22 | STR9 DEX14 CON9 WIS14; зброя: unarmed | 2675 g | act1_sunspire_reliquary | Канал 360° (5 бази/такт, 4 мани/такт): за регену мани ≈ 220/с утримується безперервно навіть на повному ступені (≈ 20 мани/такт). Основний AoE. |
| 2 | **Jade Serpent Beam** (`mnk_jade_serpent_beam`) | magic, канал, mana 5 | 0 c | 32 | STR11 DEX18 CON11 WIS18; зброя: unarmed | 3825 g | act2_obsidian_drake | Дальній канал-конус (id `beam`): 6 бази/такт, дальність 400 — для одиночних цілей і кайтингу. |
| 3 | **Flowing Strike** (`mnk_flowing_strike`) | melee, mana 12 | 4 c | 29 | STR10 DEX17 CON10 WIS17; зброя: unarmed | 3488 g | act2_obsidian_drake | Філер: 15 бази за 12 мани, кд 4 с — найкраща шкода/кулдаун серед одиничних melee Monk. |
| 4 | **Spirit Burst** (`mnk_spirit_burst`) | magic, mana 24 | 8 c | 35 | STR12 DEX19 CON12 WIS19; зброя: unarmed | 4163 g | act2_obsidian_drake | Радіальний вибух 20 бази за 24 мани / кд 8 с, радіус вибуху навколо курсору. |
| 5 | **Dragon's Breath** (`mnk_dragons_breath`) | magic, mana 30 | 10 c | 39 | STR13 DEX21 CON13 WIS21; зброя: unarmed | 4713 g | act2_obsidian_drake | Конус-вибух 22 бази за 30 мани / кд 10 с: бурст по групі. |
| 6 | **Tiger Stance** (`mnk_tiger_stance`) | buff, mana 10 | 5 c | 46 | STR15 DEX23 CON15 WIS23; зброя: any | 5675 g | act3_nether_behemoth (secret gem) | +25 % швидкості руху, ×1,3 до швидкості автоатаки, 10 мани / кд 5 с / 30 с дії — тримати постійно (атака лише поки не на стелі). |
| 7 | **Fast Mana Aura** (`mnk_fast_mana_aura`) | buff, mana 0 | 0 c | 42 | STR14 DEX22 CON14 WIS22; зброя: any | 5125 g | act3_nether_behemoth (secret gem) | `manaRegen ×2` (додає ще 100 % реген мани) — 0 мани, кд 0, 30 с дії: поновлюйте кожні 30 с. З регеном ≈ 224/с це +224 мани/с. |
| 8 | **Diamond Skin** (`mnk_diamond_skin`) | buff, mana 30 | 40 c | 47 | STR15 DEX24 CON15 WIS24; зброя: any | 5888 g | act3_nether_behemoth (secret gem) | Поглинає 500 шкоди (30 мани, дія 20 с, кд 40 с) — стіна проти алфа-ударів. |
| 9 | **Touch of Life** (`mnk_touch_of_life`) | buff, mana 35 | 20 c | 47 | STR15 DEX24 CON15 WIS24; зброя: any | 5813 g | act3_nether_behemoth (secret gem) | Миттєвий хіл 30 % макс. HP (35 мани, кд 20 с) — для витягування з небезпеки. |

_Сума цін гемів хотбара: 41365 g._

**Порядок розблокування.**

| Скіл | Рівень | Вимоги | Ціна | Зброя |
|---|---|---|---|---|
| Wind Palm (`mnk_wind_palm`) | 1 | STR3 DEX6 CON3 WIS6 | 100 g | unarmed |
| Twin Serpent Strike (`mnk_twin_serpent_strike`) | 2 | STR4 DEX6 CON4 WIS6 | 600 g | unarmed |
| Hundred Fists (`mnk_hundred_fists`) | 8 | STR5 DEX8 CON5 WIS8 | 1200 g | unarmed |
| Mantis Strike (`mnk_mantis_strike`) | 12 | STR6 DEX10 CON6 WIS10 | 1600 g | unarmed |
| Spinning Crane Kick (`mnk_spinning_crane_kick`) | 22 | STR9 DEX14 CON9 WIS14 | 2675 g | unarmed |

* **L1–11:** `Wind Palm` (мана 8, кд 2 с), `Twin Serpent Strike` (відновлює ману), `Dragon Kick`; **L8** `Hundred Fists` (канал 360°, 4 бази/такт) — замінюється на `Spinning Crane Kick` на L22 (5 бази/такт, той самий радіус).
* **L22 → `Spinning Crane Kick`, L29 → `Flowing Strike`, L32 → `Jade Serpent Beam`, L35 → `Spirit Burst`, L39 → `Dragon's Breath`** (гейти `act1`/`act2`).
* **L42–47 (`act3`)**: `Fast Mana Aura`, `Tiger Stance`, `Touch of Life`, `Diamond Skin`. Пізніше (L57, `act4`) варто додати `Off-Balance` (12 мани, кд 8 с, 25 бази — найкраща шкода/ресурс).
* Стат-вимоги хотбара (макс. STR 15, DEX 24, CON 15, WIS 24) повністю виконано до 31-го очка; `Spinning Crane Kick` (L22) і `Flowing Strike` (L29) — на 29-му очку (відставання від L22 на ≈ 8 очок перекривається ранніми квестами).

**Техніка:** `Fast Mana Aura` на початку бою, `Tiger Stance` постійно; рухайтеся короткими відрізками між серіями `Spinning Crane Kick` (ступінь каналу скидається паузою >0,6 с — так вартість лишається мінімальною); `Jade Serpent Beam` — для босів.

### 3.3 Пасивне дерево

**Стартовий вузол:** `start-wisdom` (id 31, «Monk») — `regenLifeShare 0,1`: 10 % мани, яку ви реально відновили за такт, повертається життям (лише коли мана < максимуму).

| id | Вузол | Вартість найкоротшого шляху від старту окремо | Позиція в плані |
|---|---|---|---|
| 20188 | Transcendence (keystone) | 12 | 12 |
| 21556 | Hawk Aspect (keystone) | 11 | 29 |
| 21668 | Menagerie (keystone) | 13 | 37 |
| 156 | Inner Flame (keystone) | 12 | 52 |
| 20076 | Meditation (keystone) | 10 | 59 |
| 309 | Ki Overflow (keystone) | 17 | 68 |
| 21260 | Crimson Bargain (keystone) | 20 | 87 |
| 54181 | Clarity (greater) | 18 | 122 |

**Віхи:**

| Очок | STR | DEX | CON | INT | WIS | CHA | Макс. HP | Макс. мана | Реген мани/с | Макс. стамина | Реген стам./с | Реген HP/с | Множник скілів (головний стат) | Множник удару зброї (STR) | Інтервал автоатаки, × від cd зброї (менше = швидше) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 5 | 5 | 5 | 5 | 27 | 5 | 106 | 128 | 21 | 100 | 10 | 1.0 | ×2.1 | ×1.0 | ×1.00 |
| 30 | 10 | 35 | 22 | 41 | 62 | 13 | 349 | 494 | 56 | 140 | 14 | 2.7 | ×3.9 | ×1.2 | ×0.49 |
| 60 | 18 | 37 | 41 | 59 | 206 | 38 | 581 | 774 | 142 | 145 | 14 | 4.6 | ×12.2 | ×1.6 | ×0.47 |
| 100 | 18 | 39 | 70 | 61 | 280 | 55 | 959 | 1356 | 180 | 160 | 14 | 7.5 | ×22.7 | ×1.6 | ×0.46 |
| 150 | 23 | 45 | 137 | 63 | 366 | 59 | 1725 | 1566 | 224 | 170 | 14 | 14.2 | ×29.3 | ×1.9 | ×0.42 |

Правила/відсотки на віхах: 10 очок — `regenLifeShare 0.1`; пули з дерева hp +16, mana +18; 30 — `staminaRegen 4; attackSpeedMult 1.08; formPower 0.12; regenLifeShare 0.1`; пули з дерева hp +89, mana +24, stamina +40; 60 — `staminaRegen 4; attackSpeedMult 1.08; formPower 0.27; manaRegen 4; wisdomSkillDamage 0.1; regenLifeShare 0.15; charismaSkillDamage 0.1`; damage% physical +7; resist% physical +1, arcane +5; пули з дерева hp +131, mana +124, stamina +45; 100 — `staminaRegen 4; attackSpeedMult 1.08; formPower 0.27; manaRegen 4; wisdomSkillDamage 0.1; regenLifeShare 0.15; charismaSkillDamage 0.1; fullManaDamage 0.3; manaPerWisdom 2; manaCostMult 1.15; skillDamageMult 1.4; lifeCostMultiplier 1.3`; damage% physical +15; resist% physical +2, arcane +5; пули з дерева hp +219, mana +136, stamina +60; 150 — `staminaRegen 4; attackSpeedMult 1.08; formPower 0.27; manaRegen 4; wisdomSkillDamage 0.1; regenLifeShare 0.25; charismaSkillDamage 0.1; fullManaDamage 0.46; manaPerWisdom 2; manaCostMult 1.09; skillDamageMult 1.4; lifeCostMultiplier 1.3; skillCooldownMult 0.97`; damage% physical +35, fire +8; resist% physical +7, arcane +5; пули з дерева hp +315, mana +154, stamina +70.

**Послідовність вузлів:**

| № | Очок (накопичено) | id | key | Назва (kind) | Що дає |
|---|---|---|---|---|---|
| · | 1–11 | 11 шт. | _minor-вузли на шляху_ | – | WIS +24, hp +16, mana +24 |
| 1 | 12 | 20188 | `wisdom-r3-3-13` | **Transcendence** (keystone) | wisdom+25 ; intelligence+18 |
| 2 | 13 | 20187 | `wisdom-r3-3-12` | **Wanderer's Gift** (greater) | intelligence+18 |
| 3 | 14 | 20186 | `wisdom-r3-3-11` | **Thick Skin** (notable) | hp+25 |
| · | 15–15 | 1 шт. | _minor-вузли на шляху_ | – | CHA +2, hp +8 |
| 4 | 16 | 20184 | `wisdom-r3-3-9` | **Renaissance** (notable) | constitution+12 |
| · | 17–18 | 2 шт. | _minor-вузли на шляху_ | – | STR +5 |
| 5 | 19 | 20182 | `wisdom-r3-3-7` | **Second Discipline** (notable) | dexterity+8 |
| · | 20–28 | 9 шт. | _minor-вузли на шляху_ | – | WIS +8, CON +5, CHA +6, hp +32 |
| 6 | 29 | 21556 | `charisma-r2-4-8` | **Hawk Aspect** (keystone) | dexterity+20 ; stamina+40 ; R:staminaRegen=4 ; R:attackSpeedMult=1.08 ; R:formPower=0.12 |
| · | 30–30 | 1 шт. | _minor-вузли на шляху_ | – | DEX +2, hp +8 |
| 7 | 31 | 21664 | `charisma-r3-3-9` | **Second Discipline** (notable) | strength+8 |
| · | 32–32 | 1 шт. | _minor-вузли на шляху_ | – | WIS +2 |
| 8 | 33 | 116057 | `wisdom-r4-3-1` | **Ascendance** (greater) | wisdom+18 |
| · | 34–34 | 1 шт. | _minor-вузли на шляху_ | – | CON +2, hp +8 |
| 9 | 35 | 21666 | `charisma-r3-3-11` | **Renaissance** (notable) | wisdom+12 |
| 10 | 36 | 21667 | `charisma-r3-3-12` | **Wanderer's Gift** (greater) | intelligence+18 |
| 11 | 37 | 21668 | `charisma-r3-3-13` | **Menagerie** (keystone) | charisma+25 ; constitution+15 ; mana+30 ; R:manaRegen=2 ; R:formPower=0.15 |
| 12 | 38 | 116056 | `wisdom-r4-3-0` | **Null Field** (notable) | res arcane+5 |
| 13 | 39 | 116048 | `wisdom-r4-2-24` | **Ascendance** (greater) | wisdom+18 |
| 14 | 40 | 20189 | `wisdom-r3-3-14` | **Inner Mastery** (greater) | R:wisdomSkillDamage=0.1 |
| · | 41–44 | 4 шт. | _minor-вузли на шляху_ | – | WIS +8, stamina +5 |
| 15 | 45 | 267 | `wisdom-r3-1-14` | **Honed** (notable) | wisdom+6 ; dmg physical+4 |
| · | 46–46 | 1 шт. | _minor-вузли на шляху_ | – | DEX +2 |
| 16 | 47 | 265 | `wisdom-r3-1-12` | **Ox Blood** (notable) | wisdom+6 ; hp+18 |
| 17 | 48 | 264 | `wisdom-r3-1-11` | **Paragon** (greater) | wisdom+20 |
| · | 49–51 | 3 шт. | _minor-вузли на шляху_ | – | WIS +6 |
| 18 | 52 | 156 | `wisdom-r2-1-27` | **Inner Flame** (keystone) | wisdom+20 |
| · | 53–55 | 3 шт. | _minor-вузли на шляху_ | – | CON +2, hp +8, WIS +2, res physical +1, dmg physical +3 |
| 19 | 56 | 280 | `wisdom-r3-1-27` | **Great Sinew** (notable) | wisdom+6 |
| 20 | 57 | 279 | `wisdom-r3-1-26` | **Ascendance** (greater) | wisdom+18 |
| · | 58–58 | 1 шт. | _minor-вузли на шляху_ | – | WIS +2, hp +8 |
| 21 | 59 | 20076 | `wisdom-r2-4-8` | **Meditation** (keystone) | mana+70 ; R:manaRegen=2 ; R:regenLifeShare=0.05 |
| 22 | 60 | 21669 | `charisma-r3-3-14` | **Wild Mastery** (greater) | R:charismaSkillDamage=0.1 |
| 23 | 61 | 21670 | `charisma-r3-3-15` | **Brutality** (notable) | dmg physical+8 |
| · | 62–67 | 6 шт. | _minor-вузли на шляху_ | – | WIS +13, hp +40 |
| 24 | 68 | 309 | `wisdom-r3-2-19` | **Ki Overflow** (keystone) | R:fullManaDamage=0.3 ; R:manaPerWisdom=2 ; R:manaCostMult=1.15 |
| · | 69–71 | 3 шт. | _minor-вузли на шляху_ | – | WIS +8, stamina +10 |
| 25 | 72 | 116052 | `wisdom-r4-2-6` | **Ascendance** (greater) | wisdom+18 |
| 26 | 73 | 116049 | `wisdom-r4-2-3` | **Mastery** (notable) | wisdom+8 |
| · | 74–86 | 13 шт. | _minor-вузли на шляху_ | – | CHA +17, CON +11, hp +32 |
| 27 | 87 | 21260 | `constitution-r2-4-8` | **Crimson Bargain** (keystone) | R:skillDamageMult=1.4 ; R:lifeCostMultiplier=1.3 |
| · | 88–88 | 1 шт. | _minor-вузли на шляху_ | – | DEX +2, mana +6 |
| 28 | 89 | 158 | `wisdom-r2-2-0` | **Mastery** (notable) | wisdom+8 |
| · | 90–90 | 1 шт. | _minor-вузли на шляху_ | – | CON +2, res physical +1 |
| 29 | 91 | 21262 | `constitution-r2-4-10` | **Great Sinew** (notable) | constitution+6 |
| · | 92–92 | 1 шт. | _minor-вузли на шляху_ | – | CON +4 |
| 30 | 93 | 21264 | `constitution-r2-4-12` | **Great Sinew** (notable) | constitution+6 |
| · | 94–99 | 6 шт. | _minor-вузли на шляху_ | – | WIS +11, hp +16, mana +6, INT +2, stamina +5 |
| 31 | 100 | 326 | `wisdom-r3-2-36` | **Mastery** (notable) | wisdom+8 |
| 32 | 101 | 325 | `wisdom-r3-2-35` | **Ascendance** (greater) | wisdom+18 |
| · | 102–110 | 9 шт. | _minor-вузли на шляху_ | – | CON +22, hp +16, DEX +4 |
| 33 | 111 | 1482 | `constitution-r3-2-8` | **Brutality** (notable) | dmg physical+8 |
| · | 112–112 | 1 шт. | _minor-вузли на шляху_ | – | CON +2 |
| 34 | 113 | 1480 | `constitution-r3-2-6` | **Thick Skin** (notable) | hp+25 |
| 35 | 114 | 1479 | `constitution-r3-2-5` | **Apostasy** (greater) | wisdom+20 |
| · | 115–118 | 4 шт. | _minor-вузли на шляху_ | – | hp +23, WIS +2, CON +4 |
| 36 | 119 | 116013 | `wisdom-r4-1-15` | **Jarring Blows** (notable) | status shock |
| 37 | 120 | 116012 | `wisdom-r4-1-14` | **Ascendance** (greater) | wisdom+18 |
| · | 121–121 | 1 шт. | _minor-вузли на шляху_ | – | STR +3 |
| 38 | 122 | 54181 | `clu_wis_clarity-hub` | **Clarity** (greater) | R:regenLifeShare=0.1 |
| · | 123–125 | 3 шт. | _minor-вузли на шляху_ | – | CON +7, hp +16 |
| 39 | 126 | 1495 | `constitution-r3-2-21` | **Honed** (notable) | constitution+6 ; dmg physical+4 |
| · | 127–129 | 3 шт. | _minor-вузли на шляху_ | – | CON +2, mana +6, DEX +2, INT +2 |
| 40 | 130 | 1510 | `constitution-r3-2-36` | **Great Sinew** (notable) | constitution+6 |
| 41 | 131 | 1509 | `constitution-r3-2-35` | **Ascendance** (greater) | constitution+18 |
| · | 132–132 | 1 шт. | _minor-вузли на шляху_ | – | res physical +2 |
| 42 | 133 | 20078 | `wisdom-r2-4-10` | **Great Sinew** (notable) | wisdom+6 |
| · | 134–134 | 1 шт. | _minor-вузли на шляху_ | – | WIS +2, res physical +1 |
| 43 | 135 | 20080 | `wisdom-r2-4-12` | **Mastery** (notable) | wisdom+8 |
| · | 136–137 | 2 шт. | _minor-вузли на шляху_ | – | WIS +4, CHA +2, hp +8 |
| 44 | 138 | 20072 | `wisdom-r2-4-4` | **Overflowing Spirit** (notable) | R:fullManaDamage=0.08 |
| · | 139–139 | 1 шт. | _minor-вузли на шляху_ | – | STR +2, hp +8 |
| 45 | 140 | 21376 | `constitution-r3-3-17` | **Kindling** (notable) | dmg fire+8 |
| · | 141–141 | 1 шт. | _minor-вузли на шляху_ | – | res physical +2 |
| 46 | 142 | 21374 | `constitution-r3-3-15` | **Brutality** (notable) | dmg physical+8 |
| · | 143–143 | 1 шт. | _minor-вузли на шляху_ | – | WIS +2, mana +6 |
| 47 | 144 | 322 | `wisdom-r3-2-32` | **Great Sinew** (notable) | wisdom+6 |
| · | 145–147 | 3 шт. | _minor-вузли на шляху_ | – | stamina +10, manaCostMult +1.94 |
| 48 | 148 | 95 | `wisdom-r1-3-12` | **Overflowing Spirit** (notable) | R:fullManaDamage=0.08 |
| · | 149–149 | 1 шт. | _minor-вузли на шляху_ | – | CHA +2, mana +6 |
| 49 | 150 | 276 | `wisdom-r3-1-23` | **Quick Hands** (notable) | R:skillCooldownMult=0.97 |

**Логіка:** `Transcendence` (id 20188, +25 WIS/+18 INT) на 12-му очку — вхід до WIS-ядра; `Hawk Aspect` (id 21556) на 29-му дає +20 DEX / +40 стамини (DEX-вимога скілів Monk — до 25); `Menagerie` (21668) на 37-му (CON/CHA + реген мани); `Inner Mastery` (+10 % до WIS-скілів) на 40-му; `Inner Flame` (+20 WIS) на 52-му; `Meditation` на 59-му; `Ki Overflow` (id 309) на 68-му — **+30 % шкоди скілів при мані ≥ 80 %** і +2 мани/WIS ціною +15 % вартості мани (регена вистачає); `Crimson Bargain` (21260, ×1,4) на 87-му; `Clarity` (хаб 54181, +10 % життя з регену мани) на 122-му.

**Кейстоуни та їхні мінуси:**
* `Ki Overflow` (309): +15 % вартості мани скілів (пул і реген її перекривають).
* `Crimson Bargain` (21260): +30 % вартості життя — Monk не має жодних скілів/атак за життя, тому **безкоштовно**.
* `Inner Flame` (156, +20 WIS), `Meditation` (20076, +70 мани, +2 мани/с, +5 % life share), `Hawk Aspect`, `Menagerie` (21668; ці два входять як джерело DEX/CON/мани по шляху) — без мінусів. По дорозі трапляються слабкі «прохідні» вузли (`Wild Mastery`, `Brutality`, `Jarring Blows`, `Kindling`) — їх можна обминути, якщо знайдете коротший шлях.

**Усі `id` у порядку взяття (150 очок), по віхах — для перевірки зв'язності й швидкого проходу:**

```
# очки 1–10
36 37 38 39 40 114 234 115998 115997 115996
# очки 11–30
115994 20188 20187 20186 20185 20184 20183 20178 20182 35 34 33 32 1520 1594 1714 1713 1712 21556 21663
# очки 31–60
21664 116042 116057 21665 21666 21667 21668 116056 116048 20189 216 217 218 259 267 266 265 264 219 220 221 156 274 282 281 280 279 232 20076 21669
# очки 61–100
21670 115993 115992 115991 115990 115989 115988 309 116043 116032 116051 116052 116049 1519 1518 1517 1516 1515 1514 1513 1512 1224 1298 1418 1417 1416 21260 157 158 21261 21262 21263 21264 231 230 229 320 20176 20175 326
# очки 101–150
325 1415 1414 1413 1412 1411 1410 1409 1408 1473 1482 1481 1480 1479 278 116002 116030 116014 116013 116012 116011 54181 1489 1497 1496 1495 1504 21360 21359 1510 1509 20077 20078 20079 20080 20081 20071 20072 21367 21376 21375 21374 321 322 89 97 96 95 275 276
```

### 3.4 Зброя та броня

* **Зброя:** **кинджал** (`*-dagger`, DEX: T3 16 … T10 116; cd 0,45; +15 % шанс крита зброї) **або порожні руки** (`unarmed` 3 шкоди). **Не беріть `*-quarterstaff`** (WIS-зброя): за назвою це `staff_wand`, і скіли Monk `unarmed` його не приймають (див. 0.2 п.8). `*-mace` (CON) і `*-sword/-axe` (STR) теж підходять за категорією `melee`, але вимагають статів, яких Monk не качає. Реалістично: кинджал T4–T5 (DEX 26–36; плану DEX 45 вистачає на `runed-dagger`, L55).
* **Броня:** `*-focus` (off_hand, **WIS** — єдина броня, що вимагає ваш головний стат: T4 26 … T10 116), `*-hood` / `*-boots` / `*-gloves` (DEX 26 на T4, 62 на T7); `*-robe` (INT) теж реальний вибір, бо INT 63 (T5: 36 / L55). Афікси: `of_clarity` (+WIS), `of_the_well` (+мана на focus/кільця).

### 3.5 Слабкі місця та як їх обійти

* **Автоатака слабка:** `unarmed` — 3 шкоди × STR(23 → ×1,9); основну шкоду дають скіли, а вони витрачають ману — **не вимикайте `Fast Mana Aura`**.
* **Цілі поза 120 px (канал-коло) і 400 px (`Jade Serpent Beam`)** — немає мобільності; використовуйте `Tiger Stance` (+25 %).
* **Пул HP середній (1725):** `Diamond Skin` (500), `Touch of Life`, `Drunken Brawler Stance` (L44; +35 % ухилення, контрудар 12) як альтернатива, `Karma Redirection` (L50; відбиває 50 %).
* **Гейти на рівні 22–47 лежать за квест-босами актів 1–3.**
* Опис `Zen Strike` («250 % при повній мані») у коді **не реалізований** — ставка на `Ki Overflow` замість нього.


## 4. Cultist — «Кривава спокута» (Blood Atonement)

**Стиль:** кастер на життя: CON одночасно дає шкоду скілів і пул HP; заклять коштують **фіксований** HP (15–50), тож при HP 4000+ вони майже безкоштовні; витоки (`Soul Drain`, `Vampiric Rite`, `killHeal`) повертають життя, `Blood Pact` постійно підсилює.

### 4.1 Пріоритет статів

1. **CON** — подвійна віддача: +10 HP/очко **і** +5 % до шкоди скілів (усі 50 скілів Cultist мають атрибут constitution; елемент скілів — arcane). План: CON 390 → 4294 HP, +43,7 HP/с реґену.
2. **INT 25–28 і CHA 28–30** — **вимоги гемів**: майже кожен скіл Cultist має Int і Cha (до INT 25 / CHA 28 для `Blood Rebirth`); це перший реальний «податок»: перші 46 очок включають `Second Discipline` (+8 CHA), `Renaissance` (+12 INT), `Ox Blood (CHA)`, `Paragon (CHA)`.
3. **CHA/WIS/INT ≥ ≈ 50 для зброї:** закляття L16+ вимагають зброю категорії `staff_wand`; скіпетр (`*-scepter`) вимагає CHA (T6: 48, T7: 62) — план дає CHA 70.

### 4.2 Хотбар (9 слотів)

| Слот | Скіл (id) | Тип / ресурс | Кулдаун | Рівень | Вимоги до статів | Ціна гема | Квест-гейт | Навіщо |
|---|---|---|---|---|---|---|---|---|
| 1 | **Soul Drain** (`cul_soul_drain`) | magic, канал, hp 3 | 0 c | 31 | CON12 INT17 CHA19; зброя: staff_wand | 3688 g | act2_obsidian_drake | Канал із витоком: 3 HP/такт, `LEECH_SKILL_SHARE 0,35` повертає 35 % шкоди такту (+12 % `Vampiric Rite` +4 % `Blood Hunger`…), частка витоку = 35 % + `skillLeech` з дерева (у плані 20 %) = 55 %, ліміт за такт = 1 % макс. HP × (1 + 10 × skillLeech) — при HP 4294 до ≈ 130 HP за такт. Головний скіл виживання й шкоди. |
| 2 | **Bone Spear** (`cul_bone_spear`) | magic, hp 30 | 3 c | 35 | CON14 INT19 CHA21; зброя: staff_wand | 4163 g | act2_obsidian_drake | Снаряд (id у `PROJECTILE_SKILL_IDS`: `+projectile` із `Deadeye`/`Volley` додавав би удари, у плані їх нема): 15 бази за 30 HP / кд 3 с — стабільний DPS. |
| 3 | **Blood Lance** (`cul_blood_lance`) | magic, hp 35 | 4 c | 17 | CON8 INT12 CHA13; зброя: staff_wand | 2138 g | act1_sunspire_reliquary | Снаряд (`projectile`): 13 бази за 35 HP / кд 4 с, дальність 440; відкривається вже на L17, тож є ядром до L31. |
| 4 | **Corpse Explosion** (`cul_corpse_explosion`) | magic, hp 15 | 3 c | 20 | CON9 INT13 CHA14; зброя: staff_wand | 2475 g | act1_sunspire_reliquary | Найдешевший по HP-вартості заряд: 15 HP / кд 3 с, 13 бази — AoE-вибух навколо курсору. |
| 5 | **Blood Boil** (`cul_blood_boil`) | magic, hp 40 | 12 c | 19 | CON9 INT13 CHA14; зброя: staff_wand | 2338 g | act1_sunspire_reliquary | AoE 18 бази за 40 HP / кд 12 с — для пачок. |
| 6 | **Blood Pact** (`cul_blood_pact`) | buff, hp 0 | 0 c | 42 | CON16 INT22 CHA24; зброя: any | 5125 g | act3_nether_behemoth (secret gem) | Безкоштовний (0 HP, кд 0) і постійний (60 с): ×1,25 шкоди, ×0,9 отриманої шкоди — єдиний баф, що не конкурує за кнопки; оновлюйте раз на хвилину. |
| 7 | **Vampiric Embrace** (`cul_vampiric_embrace`) | buff, hp 25 | 30 c | 45 | CON17 INT23 CHA25; зброя: any | 5538 g | act3_nether_behemoth (secret gem) | `leech 0,3` на 15 с (кд 30 с): 30 % шкоди скілів без власного витоку йдуть у здоров'я. З `Soul Drain` **не складається** (береться більше з 0,35 і 0,3), тож вмикайте під `Bone Spear`/`Blood Lance`. |
| 8 | **Bone Armor** (`cul_bone_armor`) | buff, hp 30 | 30 c | 43 | CON16 INT22 CHA24; зброя: any | 5263 g | act3_nether_behemoth (secret gem) | Поглинає **3 удари повністю** (30 HP, кд 30 с). |
| 9 | **Blood Rebirth** (`cul_blood_rebirth`) | buff, hp 0 | 180 c | 50 | CON18 INT25 CHA28; зброя: any | 6300 g | act3_nether_behemoth (secret gem) | Воскресіння з 40 % HP + вибух навколо (кд 180 с, 600 с дії) — страховка від смерті. |

_Сума цін гемів хотбара: 37028 g._

**Порядок розблокування.**

| Скіл | Рівень | Вимоги | Ціна | Зброя |
|---|---|---|---|---|
| Sacrificial Stab (`cul_sacrificial_stab`) | 1 | CON3 INT6 CHA6 | 100 g | dagger |
| Flesh Siphon Strike (`cul_flesh_siphon_strike`) | 2 | CON4 INT6 CHA6 | 600 g | dagger |
| Vein Ripper (`cul_vein_ripper`) | 4 | CON4 INT7 CHA7 | 800 g | dagger |
| Vampiric Bite (`cul_vampiric_bite`) | 12 | CON7 INT10 CHA10 | 1600 g | dagger |
| Blood Orb (`cul_blood_orb`) | 16 | CON8 INT11 CHA12 | 2000 g | staff_wand |

* **L1–15 (кинджал):** `Sacrificial Stab` (15 HP, кд 1 с; витік за ім'ям `sacrificial` — 35 %), `Flesh Siphon Strike` (`siphon`), `Vein Ripper`, `Blood Scythe`. На базових 110 HP діє обережність: **не опускайтеся нижче вартості скіла**, `canPayLife` вимагає лишити ≥1 HP.
* **L16+ (потрібен `staff_wand`, `act1`)**: `Blood Lance` (L17), `Blood Boil` (L19), `Corpse Explosion` (L20), **L31 `Soul Drain`** (act2), **L35 `Bone Spear`**.
* **L42+ (`act3`)**: `Blood Pact` (L42), `Bone Armor` (L43), `Vampiric Embrace` (L45), **L50 `Blood Rebirth`** (act3).
* Стат-вимоги хотбара (макс. CON 18, INT 25, CHA 28) виконано з 46-го очка плану (раніше лише `Soul Drain` — з 16-го).

### 4.3 Пасивне дерево

**Стартовий вузол:** `start-constitution` (id 1215, «Cultist») — `lifeCostMultiplier ×0,9` (−10 % вартості життя).

| id | Вузол | Вартість найкоротшого шляху від старту окремо | Позиція в плані |
|---|---|---|---|
| 21372 | Blood Pact (keystone) | 12 | 21 |
| 21260 | Crimson Bargain (keystone) | 10 | 34 |
| 1743 | Wolf Aspect (keystone) | 15 | 50 |
| 1447 | Vampiric Rite (keystone) | 14 | 62 |
| 1493 | Sanguine Rite (keystone) | 17 | 77 |
| 116351 | Bloodletting (greater) | 18 | 85 |
| 54219 | Sanguine Aura (greater) | 18 | 106 |
| 21076 | Unbreakable (keystone) | 13 | 119 |
| 1340 | Pain Ward (keystone) | 12 | 147 |

**Віхи:**

| Очок | STR | DEX | CON | INT | WIS | CHA | Макс. HP | Макс. мана | Реген мани/с | Макс. стамина | Реген стам./с | Реген HP/с | Множник скілів (головний стат) | Множник удару зброї (STR) | Інтервал автоатаки, × від cd зброї (менше = швидше) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 7 | 5 | 25 | 5 | 5 | 5 | 350 | 90 | 10 | 100 | 10 | 3.0 | ×2.0 | ×1.1 | ×1.00 |
| 30 | 7 | 26 | 79 | 19 | 9 | 27 | 916 | 236 | 19 | 105 | 10 | 8.4 | ×4.7 | ×1.1 | ×0.61 |
| 60 | 22 | 28 | 152 | 26 | 9 | 62 | 1662 | 318 | 22 | 115 | 10 | 15.7 | ×12.9 | ×1.9 | ×0.59 |
| 100 | 22 | 28 | 296 | 26 | 9 | 64 | 3223 | 318 | 22 | 135 | 10 | 33.1 | ×24.8 | ×1.9 | ×0.59 |
| 150 | 53 | 48 | 390 | 28 | 13 | 70 | 4294 | 389 | 26 | 155 | 10 | 43.7 | ×33.5 | ×3.4 | ×0.44 |

Правила/відсотки на віхах: 10 очок — `lifeCostMultiplier 0.9`; пули з дерева hp +40; 30 — `lifeCostMultiplier 0.75`; resist% lightning +5; пули з дерева hp +66, mana +6, stamina +5; 60 — `lifeCostMultiplier 1.05; skillDamageMult 1.4; constitutionSkillDamage 0.1; formPower 0.12`; damage% physical +12; resist% physical +1, fire +5, lightning +10; пули з дерева hp +82, mana +18, stamina +15; 100 — `lifeCostMultiplier 0.93; skillDamageMult 1.4; constitutionSkillDamage 0.14; formPower 0.12; skillLeech 0.12; killHeal 0.04; hpRegen 3.0`; damage% physical +23, arcane +8, lightning +8; resist% physical +2, fire +5, lightning +10; пули з дерева hp +203, mana +18, stamina +35; 150 — `lifeCostMultiplier 0.93; skillDamageMult 1.4; constitutionSkillDamage 0.18; formPower 0.12; skillLeech 0.2; killHeal 0.04; hpRegen 4.2; auraLeech 2.0; strengthSkillDamage 0.1`; damage% physical +23, arcane +24, lightning +8; resist% physical +12, fire +15, lightning +10; пули з дерева hp +334, mana +69, stamina +55.

**Послідовність вузлів:**

| № | Очок (накопичено) | id | key | Назва (kind) | Що дає |
|---|---|---|---|---|---|
| · | 1–10 | 10 шт. | _minor-вузли на шляху_ | – | CON +20, hp +40, STR +2 |
| 1 | 11 | 21368 | `constitution-r3-3-9` | **Second Discipline** (notable) | charisma+8 |
| · | 12–12 | 1 шт. | _minor-вузли на шляху_ | – | WIS +2, hp +8 |
| 2 | 13 | 21370 | `constitution-r3-3-11` | **Renaissance** (notable) | intelligence+12 |
| · | 14–17 | 4 шт. | _minor-вузли на шляху_ | – | CHA +8, stamina +5 |
| 3 | 18 | 1747 | `charisma-r3-1-14` | **Ox Blood (CHA)** (notable) | charisma+6 ; hp+18 |
| · | 19–19 | 1 шт. | _minor-вузли на шляху_ | – | INT +2 |
| 4 | 20 | 21371 | `constitution-r3-3-12` | **Wanderer's Gift** (greater) | dexterity+18 |
| 5 | 21 | 21372 | `constitution-r3-3-13` | **Blood Pact** (keystone) | R:lifeCostMultiplier=0.85 |
| 6 | 22 | 21364 | `constitution-r3-3-5` | **Apotheosis** (notable) | constitution+12 |
| · | 23–24 | 2 шт. | _minor-вузли на шляху_ | – | CON +4, mana +6 |
| 7 | 25 | 114586 | `constitution-r4-3-1` | **Ascendance** (greater) | constitution+18 |
| 8 | 26 | 114585 | `constitution-r4-3-0` | **Grounding** (notable) | res lightning+5 |
| 9 | 27 | 114577 | `constitution-r4-2-24` | **Ascendance** (greater) | constitution+18 |
| · | 28–31 | 4 шт. | _minor-вузли на шляху_ | – | CON +2, WIS +2, DEX +3, INT +3 |
| 10 | 32 | 1745 | `charisma-r3-1-12` | **Grounding** (notable) | res lightning+5 |
| 11 | 33 | 1744 | `charisma-r3-1-11` | **Paragon (CHA)** (greater) | charisma+20 |
| 12 | 34 | 21260 | `constitution-r2-4-8` | **Crimson Bargain** (keystone) | R:skillDamageMult=1.4 ; R:lifeCostMultiplier=1.3 |
| · | 35–35 | 1 шт. | _minor-вузли на шляху_ | – | CON +2, res physical +1 |
| 13 | 36 | 21262 | `constitution-r2-4-10` | **Great Sinew** (notable) | constitution+6 |
| · | 37–37 | 1 шт. | _minor-вузли на шляху_ | – | CON +4 |
| 14 | 38 | 21264 | `constitution-r2-4-12` | **Great Sinew** (notable) | constitution+6 |
| · | 39–46 | 8 шт. | _minor-вузли на шляху_ | – | CON +13, INT +4, mana +12, hp +16, DEX +2 |
| 15 | 47 | 1510 | `constitution-r3-2-36` | **Great Sinew** (notable) | constitution+6 |
| 16 | 48 | 1509 | `constitution-r3-2-35` | **Ascendance** (greater) | constitution+18 |
| 17 | 49 | 21373 | `constitution-r3-3-14` | **Sanguine Mastery** (greater) | R:constitutionSkillDamage=0.1 |
| 18 | 50 | 1743 | `charisma-r3-1-10` | **Wolf Aspect** (keystone) | strength+15 ; charisma+15 ; dmg physical+12 ; R:formPower=0.12 |
| · | 51–59 | 9 шт. | _minor-вузли на шляху_ | – | CON +18, stamina +10 |
| 19 | 60 | 1445 | `constitution-r3-1-8` | **Fireproof** (notable) | res fire+5 |
| · | 61–61 | 1 шт. | _minor-вузли на шляху_ | – | CON +2, stamina +5 |
| 20 | 62 | 1447 | `constitution-r3-1-10` | **Vampiric Rite** (keystone) | R:skillLeech=0.12 ; R:killHeal=0.02 |
| 21 | 63 | 1448 | `constitution-r3-1-11` | **Paragon** (greater) | constitution+20 |
| 22 | 64 | 1449 | `constitution-r3-1-12` | **Ox Blood** (notable) | constitution+6 ; hp+18 |
| 23 | 65 | 1451 | `constitution-r3-1-14` | **Honed** (notable) | constitution+6 ; dmg physical+4 |
| · | 66–74 | 9 шт. | _minor-вузли на шляху_ | – | CON +21, hp +40, stamina +10 |
| 24 | 75 | 114581 | `constitution-r4-2-6` | **Ascendance** (greater) | constitution+18 |
| 25 | 76 | 114582 | `constitution-r4-2-7` | **Apotheosis** (notable) | constitution+12 |
| 26 | 77 | 1493 | `constitution-r3-2-19` | **Sanguine Rite** (keystone) | R:lifeCostMultiplier=0.88 |
| 27 | 78 | 114578 | `constitution-r4-2-3` | **Mastery** (notable) | constitution+8 |
| 28 | 79 | 114573 | `constitution-r4-2-20` | **Charge** (notable) | dmg lightning+8 |
| 29 | 80 | 114574 | `constitution-r4-2-21` | **Resonance** (notable) | dmg arcane+8 |
| 30 | 81 | 21256 | `constitution-r2-4-4` | **Sanguine Focus** (notable) | R:constitutionSkillDamage=0.04 |
| · | 82–84 | 3 шт. | _minor-вузли на шляху_ | – | hpRegen +3, hp +40, killHeal +0.005 |
| 31 | 85 | 116351 | `clu_con_bloodletting-hub` | **Bloodletting** (greater) | R:killHeal=0.01 |
| · | 86–86 | 1 шт. | _minor-вузли на шляху_ | – | CON +3 |
| 32 | 87 | 1495 | `constitution-r3-2-21` | **Honed** (notable) | constitution+6 ; dmg physical+4 |
| · | 88–94 | 7 шт. | _minor-вузли на шляху_ | – | killHeal +0.005, CON +8, CHA +2, hp +8, res physical +1, dmg physical +3 |
| 33 | 95 | 1464 | `constitution-r3-1-27` | **Great Sinew** (notable) | constitution+6 |
| 34 | 96 | 1463 | `constitution-r3-1-26` | **Ascendance** (greater) | constitution+18 |
| · | 97–97 | 1 шт. | _minor-вузли на шляху_ | – | CON +2, stamina +5 |
| 35 | 98 | 1506 | `constitution-r3-2-32` | **Great Sinew** (notable) | constitution+6 |
| · | 99–102 | 4 шт. | _minor-вузли на шляху_ | – | hp +23, CON +2, WIS +4 |
| 36 | 103 | 114542 | `constitution-r4-1-15` | **Jarring Blows** (notable) | status shock |
| 37 | 104 | 114541 | `constitution-r4-1-14` | **Ascendance** (greater) | constitution+18 |
| · | 105–105 | 1 шт. | _minor-вузли на шляху_ | – | CHA +3 |
| 38 | 106 | 54219 | `clu_con_sanguine-hub` | **Sanguine Aura** (greater) | R:auraLeech=1 |
| 39 | 107 | 54220 | `clu_con_sanguine-sat0` | **Crimson Thirst** (notable) | R:auraLeech=0.5 |
| 40 | 108 | 54221 | `clu_con_sanguine-sat1` | **Deepening Thirst** (notable) | R:auraLeech=0.5 |
| · | 109–113 | 5 шт. | _minor-вузли на шляху_ | – | CON +10, stamina +5 |
| 41 | 114 | 114547 | `constitution-r4-1-2` | **Resonance** (notable) | dmg arcane+8 |
| · | 115–118 | 4 шт. | _minor-вузли на шляху_ | – | STR +8, mana +24 |
| 42 | 119 | 21076 | `strength-r3-3-13` | **Unbreakable** (keystone) | strength+20 ; hp+100 |
| 43 | 120 | 21075 | `strength-r3-3-12` | **Wanderer's Gift** (greater) | dexterity+18 |
| 44 | 121 | 21077 | `strength-r3-3-14` | **Martial Mastery** (greater) | R:strengthSkillDamage=0.1 |
| 45 | 122 | 21078 | `strength-r3-3-15` | **Renaissance** (notable) | constitution+12 |
| · | 123–127 | 5 шт. | _minor-вузли на шляху_ | – | CON +15 |
| 46 | 128 | 1372 | `constitution-r2-3-1` | **Great Sinew** (notable) | constitution+6 |
| · | 129–129 | 1 шт. | _minor-вузли на шляху_ | – | CON +2, hp +8 |
| 47 | 130 | 1376 | `constitution-r2-3-5` | **Great Sinew** (notable) | constitution+6 |
| · | 131–131 | 1 шт. | _minor-вузли на шляху_ | – | hp +15 |
| 48 | 132 | 21258 | `constitution-r2-4-6` | **Blood Hunger** (notable) | R:skillLeech=0.04 |
| · | 133–139 | 7 шт. | _minor-вузли на шляху_ | – | CON +11, stamina +5, CHA +3, STR +3, DEX +2 |
| 49 | 140 | 1393 | `constitution-r2-3-22` | **Resonance** (notable) | dmg arcane+8 |
| 50 | 141 | 116352 | `clu_con_bloodletting-sat0` | **Red Harvest** (notable) | R:skillLeech=0.02 |
| · | 142–144 | 3 шт. | _minor-вузли на шляху_ | – | CON +6, mana +6, stamina +10 |
| 51 | 145 | 1249 | `constitution-r1-1-16` | **Sanguine Focus** (notable) | R:constitutionSkillDamage=0.04 |
| 52 | 146 | 116353 | `clu_con_bloodletting-sat1` | **Feeding Frenzy** (notable) | R:skillLeech=0.02 |
| 53 | 147 | 1340 | `constitution-r2-1-27` | **Pain Ward** (keystone) | res physical+10 ; res fire+10 ; R:hpRegen=1.2 |
| · | 148–148 | 1 шт. | _minor-вузли на шляху_ | – | INT +2, mana +6 |
| 54 | 149 | 1342 | `constitution-r2-2-0` | **Mastery** (notable) | constitution+8 |
| 55 | 150 | 1259 | `constitution-r1-2-9` | **Deep Reserve** (notable) | mana+15 |

**Логіка:** 11 очок до `Second Discipline`/`Renaissance` (CHA/INT для гемів), `Wanderer's Gift` → **`Blood Pact`** (id 21372, 15 % дешевші витрати HP) на 21-му; **`Crimson Bargain`** (id 21260; ×1,4 шкоди, +30 % вартості HP) на 34-му — для HP 1600+ платня зникає. **`Vampiric Rite`** (id 1447, 12 % витоку, +2 % HP за вбивство) — 62-ге очко; `Sanguine Rite` (1493, −12 % вартості) — 77-ме; `Sanguine Aura` (54219) кластер на 106–108 (виліковує 2 HP/с за кожного ворога в радіусі 120 px до 6 цілей — **слабко, замінюваний блок** на `Great Sinew`/`Ascendance`); `Unbreakable` + `Wanderer's Gift` + `Martial Mastery` після 119-го як джерело STR/DEX.

**Кейстоуни та їхні мінуси:**
* `Crimson Bargain` (21260): +30 % вартості життя — для Cultist це **реальний** мінус, але він компенсується стартом (−10 %), `Blood Pact` (−15 %) і `Sanguine Rite` (−12 %): на 60 очках множник вартості ×1,05, на 100–150 — ×0,93 від базової (сума правил: 1 + 0,30 − 0,10 − 0,15 − 0,12). При HP 1600+ ціна 15–50 HP — крихти.
* `Blood Pact`, `Vampiric Rite`, `Sanguine Rite`, `Pain Ward` (1340; +10 % фіз/вогонь опору) — без мінусів.

**Усі `id` у порядку взяття (150 очок), по віхах — для перевірки зв'язності й швидкого проходу:**

```
# очки 1–10
1220 1221 1222 1223 1224 1298 1418 1417 1416 21367
# очки 11–30
21368 21369 21370 1696 1697 1698 1739 1747 1746 21371 21372 21364 114523 114571 114586 114585 114577 1219 1253 1261
# очки 31–60
1260 1745 1744 21260 21261 21262 21263 21264 21265 21255 1415 1414 1413 1504 21360 21359 1510 1509 21373 1743 1218 1217 1216 1284 1400 1401 1402 1443 1444 1445
# очки 61–100
1446 1447 1448 1449 1451 114522 114521 114520 114519 114518 114517 114572 114561 114580 114581 114582 1493 114578 114573 114574 21256 114562 114584 114566 116351 1494 1495 114565 1403 1404 1405 1458 1466 1465 1464 1463 1505 1506 1462 114531
# очки 101–150
114559 114543 114542 114541 114540 54219 54220 54221 114512 114513 114524 114528 114536 114547 115638 115637 115636 115634 21076 21075 21077 21078 1412 1411 1410 1374 1373 1372 1375 1376 21257 21258 1296 1295 1294 1386 1396 1395 1394 1393 116352 1243 1251 1250 1249 116353 1340 1341 1342 1259
```

### 4.4 Зброя та броня

* **Зброя:** до L16 — кинджал (`*-dagger`, DEX; T1 `dagger`/`knife` без вимог). З L16 — `staff_wand`: найреалістичніший вибір — **скіпетр** (`*-scepter`, 1H, CHA: T6 `obsidian-scepter` 36 шкоди, CHA 48 / L70; T7 `astral-scepter` 46,8, CHA 62 / L90) або жезл (INT). Автоатака для Cultist платиться життям, а не маною (`usesLifeCost`), але тірові скіпетри/жезли мають `mana_cost 0` — тобто безкоштовна. Кинджал і скіпетр доведеться міняти вручну (скіли L1–15 вимагають `dagger`, L16+ — `staff_wand`).
* **Броня:** `*-greaves` (CON: T4 26/L40, T7 62/L90, T10 116/L150) — єдина броня під ваш головний стат; решту беріть за тим, що дозволяють стати плану (STR 53, DEX 52, INT 28): плита/шолом/рукавиці STR до T6 (48), `*-hood`/`*-boots`/`*-gloves` DEX до T6, `*-robe` INT до T4 (26). Афікси: `of_vigor` (+CON), `of_the_bear` (+HP).

### 4.5 Слабкі місця та як їх обійти

* **L1–25:** при 110–350 HP кожен каст «б'є» вас самих; граєте на `Sacrificial Stab` (витік 35 %), `Flesh Siphon Strike`; без квестів до L16 скілів-заклять нема.
* **Подвійний набір зброї** (кинджал L1–15, скіпетр/жезл L16+) і два «податки» на статах (INT, CHA).
* **Мана 389** і **немає ефективного захисту від контролю** (Dark Blessing лише проти burn/charm).
* `Sanguine Aura` та подібні дрібниці — малопотужні (≤ 12 HP/с); замінюйте на CON/витоки.
* **Підказка про ризик:** при HP < вартість скіла каст не проходить (`reason: hp`), тому тримайте `Bone Armor` / `Vampiric Embrace` і `Blood Rebirth`.


## 5. Archer — «Град стріл» (Arrow Storm)

**Стиль:** далекобійний стрілець: два «+1 снаряд» вузли (`Deadeye` + `Volley`) множать кількість ударів стріл-скілів і віяла автоатаки; DEX дає шкоду скілів і швидкість (стеля 0,35 із `Fleet`), а **STR масштабує автоатаку луком**.

### 5.1 Пріоритет статів

1. **DEX** — атрибут 46 з 50 скілів Archer (+5 % за очко) і швидкість: кулдаун-множник 0,38 від старту (floor Archer 0,38) досягається при **DEX ≈ 60**; `Fleet` знижує до 0,35 (DEX ≈ 65). План: DEX 287.
2. **STR** — парадокс коду: лук/арбалет без `element` вважається фізичним, `weaponDamage` множить його на **STR**-множник (`meleeMult`), а не DEX. План: STR 212 → ×11,4 до автоатаки. (4 «елементні» стріли — `Lightning Arrow`, `Explosive Arrow`, `Frost Arrow`, `Starfall Arrow` — мають атрибут INT; плану в них не вкладено, тож їх не беремо.)
3. **WIS 21 / CON 14** — лише вимоги гемів (Wis до 21 на `Expose Weakness`); CON ще й HP (план: 1343).

### 5.2 Хотбар (9 слотів)

| Слот | Скіл (id) | Тип / ресурс | Кулдаун | Рівень | Вимоги до статів | Ціна гема | Квест-гейт | Навіщо |
|---|---|---|---|---|---|---|---|---|
| 1 | **Barrage** (`arc_barrage`) | magic, канал, stamina 4 | 0 c | 25 | DEX19 CON8 WIS12; зброя: bow | 3013 g | act1_sunspire_reliquary | Канал-конус із 5 ударами × 4 за такт (+2 від `projectileCount` = 7 × 4 = 28 бази), id `barrage` — конус ±40° до 440 px; 4 стамини за такт. «Клювати» серіями (див. 0.2 п.3). |
| 2 | **Venom Arrow** (`arc_venom_arrow`) | magic, stamina 18 | 2 c | 35 | DEX24 CON10 WIS15; зброя: bow | 4163 g | act2_obsidian_drake | Дешевий снаряд (18 стамини, кд 2 с, 13 бази) — з +2 снаряди б'є 3 рази; найкраща шкода/секунду серед одиночних стріл. |
| 3 | **Rain of Arrows** (`arc_rain_of_arrows`) | magic, stamina 40 | 18 c | 32 | DEX22 CON9 WIS14; зброя: bow | 3825 g | act2_obsidian_drake | Багатоударний AoE: 10 ударів × 5 (+2 = 12) по області 5×5 навколо курсору за 40 стамини / кд 18 с. |
| 4 | **Piercing Shot** (`arc_piercing_shot`) | magic, stamina 22 | 5 c | 31 | DEX22 CON9 WIS13; зброя: bow | 3688 g | act2_obsidian_drake | Id `piercing` → конус до 560 px по **всіх** цілях: 17 бази за 22 стамини / кд 5 с (+ударів від projectileCount). |
| 5 | **Eagle Eye** (`arc_eagle_eye`) | buff, stamina 20 | 30 c | 43 | DEX28 CON12 WIS17; зброя: any | 5263 g | act3_nether_behemoth (secret gem) | +20 % шансу крита на 20 с (кд 30 с) + 256 px дальності: добре з `Deadly Precision`/`Deadeye Focus`. |
| 6 | **Sniper Stance** (`arc_sniper_stance`) | buff, stamina 15 | 10 c | 50 | DEX31 CON13 WIS19; зброя: bow | 6300 g | act3_nether_behemoth (secret gem) | Стоячи на місці: +10 % шкоди за секунду, до +50 % (30 с дії, кд 10 с) — ідеально з `Barrage` (канал стоячи). |
| 7 | **Tailwind Aura** (`arc_tailwind_aura`) | buff, stamina 0 | 0 c | 49 | DEX31 CON13 WIS19; зброя: any | 6163 g | act3_nether_behemoth (secret gem) | +15 % руху та 15 % ухилення на 60 с за 0 стамини й 0 кулдауну — постійно вмикайте. |
| 8 | **Cheetah Stride** (`arc_cheetah_stride`) | buff, stamina 20 | 25 c | 45 | DEX29 CON12 WIS18; зброя: any | 5538 g | act3_nether_behemoth (secret gem) | +45 % руху на 12 с (кд 25 с) — кайтинг і втеча. |
| 9 | **Expose Weakness** (`arc_expose_weakness`) | debuff, stamina 15 | 6 c | 56 | DEX34 CON14 WIS21; зброя: bow | 7200 g | act4_primordial_sovereign (secret gem) | Тип `debuff`, але просто хороший AoE-удар: 23 бази за 15 стамини / кд 6 с (L56, act4). Дебаф «−5 % опору» не реалізований. |

_Сума цін гемів хотбара: 45153 g._

**Порядок розблокування.**

| Скіл | Рівень | Вимоги | Ціна | Зброя |
|---|---|---|---|---|
| Fan of Knives (`arc_fan_of_knives`) | 1 | DEX8 CON3 WIS7 | 463 g | dagger |
| Whirling Blades (`arc_whirling_blades`) | 14 | DEX13 CON6 WIS8 | 1800 g | dagger |
| Poison Shiv (`arc_poison_shiv`) | 16 | DEX14 CON6 WIS9 | 2000 g | dagger |
| Ambush Flurry (`arc_ambush_flurry`) | 22 | DEX17 CON7 WIS11 | 2675 g | dagger |
| Aimed Shot (`arc_aimed_shot`) | 23 | DEX18 CON8 WIS11 | 2813 g | bow |

* **L1–22 — кинджал (`dagger`)**: `Fan of Knives` (L1; 6 ударів по 6 = 36 бази за 25 стамини, кд 6 с — **найсильніший скіл раннього Archer**; це `melee`-скіл, тож б'є дугою ~135° перед гравцем), `Whirling Blades` (L14), `Poison Shiv` (L16), `Ambush Flurry` (L22, канал 360°). Кинджал має бути в руці — скіли `dagger` з луком не спрацюють; лук беріть з L23.
* **L23 `Aimed Shot` → L25 `Barrage` (потрібен лук)**, L31 `Piercing Shot`, L32 `Rain of Arrows`, L35 `Venom Arrow` (гейти `act1`/`act2`).
* **L43–50 (`act3`)**: `Eagle Eye`, `Cheetah Stride`, `Tailwind Aura`, `Sniper Stance`; **L56 `Expose Weakness`** (act4).
* Стат-вимоги хотбара (макс. DEX 34, CON 14, WIS 21) виконано з 44-го очка плану; `Barrage` (L25: DEX 19, CON 8, WIS 12) — на 30-му очку (запізнення ≈ 6 очок від L25 перекривається квестами), решта — до 44-го.

### 5.3 Пасивне дерево

**Стартовий вузол:** `start-dexterity` (id 623, «Archer») — `cooldownFloor 0,38` (правило `min`: стеля швидкості 2,63×).

| id | Вузол | Вартість найкоротшого шляху від старту окремо | Позиція в плані |
|---|---|---|---|
| 748 | Deadeye (keystone) | 12 | 12 |
| 20668 | Windrunner (keystone) | 10 | 32 |
| 20780 | Fleet (keystone) | 12 | 34 |
| 54194 | Volley (greater) | 18 | 59 |
| 1197 | Reckless Swing (keystone) | 23 | 96 |
| 21076 | Unbreakable (keystone) | 21 | 104 |
| 1044 | Executioner (keystone) | 14 | 106 |
| 116360 | Deadeye Focus (greater) | 15 | 117 |
| 855 | Deadly Precision (keystone) | 14 | 125 |

**Віхи:**

| Очок | STR | DEX | CON | INT | WIS | CHA | Макс. HP | Макс. мана | Реген мани/с | Макс. стамина | Реген стам./с | Реген HP/с | Множник скілів (головний стат) | Множник удару зброї (STR) | Інтервал автоатаки, × від cd зброї (менше = швидше) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 10 | 19 | 5 | 7 | 5 | 5 | 93 | 147 | 11 | 100 | 10 | 1.0 | ×1.7 | ×1.2 | ×0.70 |
| 30 | 22 | 70 | 25 | 10 | 13 | 11 | 325 | 177 | 16 | 100 | 10 | 3.0 | ×4.2 | ×1.9 | ×0.38 |
| 60 | 42 | 149 | 25 | 26 | 29 | 13 | 413 | 349 | 32 | 140 | 15 | 3.0 | ×9.0 | ×2.9 | ×0.35 |
| 100 | 108 | 195 | 47 | 30 | 29 | 15 | 673 | 395 | 34 | 155 | 26 | 6.2 | ×11.6 | ×6.2 | ×0.35 |
| 150 | 212 | 287 | 103 | 30 | 29 | 35 | 1343 | 419 | 34 | 200 | 31 | 11.8 | ×17.2 | ×11.4 | ×0.35 |

Правила/відсотки на віхах: 10 очок — `cooldownFloor 0.38`; пули з дерева hp +8, mana +12; 30 — `projectileCount 1; cooldownFloor 0.38`; пули з дерева hp +40, mana +12; 60 — `projectileCount 2; staminaRegen 5; cooldownFloor 0.35; dexteritySkillDamage 0.1`; damage% physical +11; resist% physical +1; пули з дерева hp +128, mana +24, stamina +40; 100 — `projectileCount 2; staminaRegen 16; cooldownFloor 0.35; dexteritySkillDamage 0.1; hpRegen 1.0`; damage% physical +44, fire +8; resist% physical +6, fire +5, ice -10; пули з дерева hp +168, mana +30, stamina +55; 150 — `projectileCount 2; staminaRegen 21; cooldownFloor 0.35; dexteritySkillDamage 0.14; hpRegen 1.0; meleeReachBonus 12; strengthSkillDamage 0.1; critChance 0.19; critDamage 0.45`; damage% physical +78, fire +8, lightning +8; resist% physical +7, fire +10, ice -10; пули з дерева hp +278, mana +54, stamina +100.

**Послідовність вузлів:**

| № | Очок (накопичено) | id | key | Назва (kind) | Що дає |
|---|---|---|---|---|---|
| · | 1–11 | 11 шт. | _minor-вузли на шляху_ | – | DEX +14, mana +12, hp +8, STR +5, INT +2, CHA +3 |
| 1 | 12 | 748 | `dexterity-r2-1-27` | **Deadeye** (keystone) | dexterity+20 ; R:projectileCount=1 |
| · | 13–26 | 14 шт. | _minor-вузли на шляху_ | – | DEX +31, CON +2, hp +32, CHA +3 |
| 2 | 27 | 20776 | `dexterity-r3-3-9` | **Second Discipline** (notable) | wisdom+8 |
| · | 28–28 | 1 шт. | _minor-вузли на шляху_ | – | INT +3 |
| 3 | 29 | 20778 | `dexterity-r3-3-11` | **Renaissance** (notable) | strength+12 |
| 4 | 30 | 20779 | `dexterity-r3-3-12` | **Wanderer's Gift** (greater) | constitution+18 |
| · | 31–31 | 1 шт. | _minor-вузли на шляху_ | – | WIS +2, mana +6 |
| 5 | 32 | 20668 | `dexterity-r2-4-8` | **Windrunner** (keystone) | dexterity+15 ; stamina+40 ; R:staminaRegen=5 |
| · | 33–33 | 1 шт. | _minor-вузли на шляху_ | – | WIS +2, mana +6 |
| 6 | 34 | 20780 | `dexterity-r3-3-13` | **Fleet** (keystone) | R:cooldownFloor=0.35 |
| 7 | 35 | 20772 | `dexterity-r3-3-5` | **Apotheosis** (notable) | dexterity+12 |
| · | 36–43 | 8 шт. | _minor-вузли на шляху_ | – | DEX +4, INT +11, hp +40, CHA +2 |
| 8 | 44 | 20480 | `intelligence-r3-3-9` | **Renaissance** (notable) | wisdom+12 |
| · | 45–45 | 1 шт. | _minor-вузли на шляху_ | – | DEX +2, hp +8 |
| 9 | 46 | 20482 | `intelligence-r3-3-11` | **Thick Skin** (notable) | hp+25 |
| 10 | 47 | 20483 | `intelligence-r3-3-12` | **Wanderer's Gift** (greater) | strength+18 |
| 11 | 48 | 20781 | `dexterity-r3-3-14` | **Marksman's Mastery** (greater) | R:dexteritySkillDamage=0.1 |
| 12 | 49 | 20782 | `dexterity-r3-3-15` | **Brutality** (notable) | dmg physical+8 |
| · | 50–51 | 2 шт. | _minor-вузли на шляху_ | – | DEX +2, res physical +1, dmg physical +3 |
| 13 | 52 | 872 | `dexterity-r3-1-27` | **Great Sinew** (notable) | dexterity+6 |
| 14 | 53 | 871 | `dexterity-r3-1-26` | **Ascendance** (greater) | dexterity+18 |
| · | 54–58 | 5 шт. | _minor-вузли на шляху_ | – | hp +15, DEX +2, STR +2, INT +5 |
| 15 | 59 | 54194 | `clu_dex_volley-hub` | **Volley** (greater) | R:projectileCount=1 |
| 16 | 60 | 114911 | `dexterity-r4-1-14` | **Ascendance** (greater) | dexterity+18 |
| · | 61–63 | 3 шт. | _minor-вузли на шляху_ | – | INT +4, STR +4, staminaRegen +3, stamina +10 |
| 17 | 64 | 884 | `dexterity-r3-2-2` | **Second Discipline** (notable) | constitution+8 |
| · | 65–65 | 1 шт. | _minor-вузли на шляху_ | – | staminaRegen +4, hpRegen +0.5 |
| 18 | 66 | 890 | `dexterity-r3-2-8` | **Brutality** (notable) | dmg physical+8 |
| · | 67–68 | 2 шт. | _minor-вузли на шляху_ | – | staminaRegen +4, hpRegen +0.5, CHA +2 |
| 19 | 69 | 20478 | `intelligence-r3-3-7` | **Second Discipline** (notable) | constitution+8 |
| · | 70–71 | 2 шт. | _minor-вузли на шляху_ | – | DEX +4, mana +6 |
| 20 | 72 | 114940 | `dexterity-r4-2-18` | **Kindling** (notable) | dmg fire+8 |
| 21 | 73 | 114946 | `dexterity-r4-2-23` | **Fireproof** (notable) | res fire+5 |
| 22 | 74 | 114945 | `dexterity-r4-2-22` | **Apostasy** (greater) | strength+20 |
| 23 | 75 | 114947 | `dexterity-r4-2-24` | **Ascendance** (greater) | dexterity+18 |
| 24 | 76 | 114956 | `dexterity-r4-3-1` | **Ascendance** (greater) | dexterity+18 |
| · | 77–77 | 1 шт. | _minor-вузли на шляху_ | – | DEX +2, stamina +5 |
| 25 | 78 | 20774 | `dexterity-r3-3-7` | **Broad Study** (notable) | constitution+6 |
| · | 79–93 | 15 шт. | _minor-вузли на шляху_ | – | DEX +4, hp +16, STR +30 |
| 26 | 94 | 1195 | `strength-r3-2-17` | **Plating** (notable) | res physical+5 |
| · | 95–95 | 1 шт. | _minor-вузли на шляху_ | – | STR +3 |
| 27 | 96 | 1197 | `strength-r3-2-19` | **Reckless Swing** (keystone) | dmg physical+25 ; res ice-10 |
| · | 97–103 | 7 шт. | _minor-вузли на шляху_ | – | STR +15, hp +40, mana +6 |
| 28 | 104 | 21076 | `strength-r3-3-13` | **Unbreakable** (keystone) | strength+20 ; hp+100 |
| 29 | 105 | 21075 | `strength-r3-3-12` | **Wanderer's Gift** (greater) | dexterity+18 |
| 30 | 106 | 1044 | `strength-r2-1-27` | **Executioner** (keystone) | dmg physical+15 ; R:meleeReachBonus=12 |
| 31 | 107 | 21077 | `strength-r3-3-14` | **Martial Mastery** (greater) | R:strengthSkillDamage=0.1 |
| 32 | 108 | 21078 | `strength-r3-3-15` | **Renaissance** (notable) | constitution+12 |
| · | 109–109 | 1 шт. | _minor-вузли на шляху_ | – | STR +2 |
| 33 | 110 | 115674 | `strength-r4-2-20` | **Unflagging** (notable) | R:staminaRegen=5 ; stamina+20 |
| 34 | 111 | 115687 | `strength-r4-3-1` | **Ascendance** (greater) | strength+18 |
| 35 | 112 | 115671 | `strength-r4-2-18` | **Brutality** (notable) | dmg physical+8 |
| 36 | 113 | 115677 | `strength-r4-2-23` | **Charge** (notable) | dmg lightning+8 |
| 37 | 114 | 115676 | `strength-r4-2-22` | **Apostasy** (greater) | dexterity+20 |
| 38 | 115 | 115678 | `strength-r4-2-24` | **Ascendance** (greater) | strength+18 |
| 39 | 116 | 20666 | `dexterity-r2-4-6` | **Deadly Aim** (notable) | R:critChance=0.03 ; R:critDamage=0.1 |
| 40 | 117 | 116360 | `clu_dex_deadeye-hub` | **Deadeye Focus** (greater) | R:critChance=0.04 |
| · | 118–122 | 5 шт. | _minor-вузли на шляху_ | – | DEX +10, stamina +10 |
| 41 | 123 | 853 | `dexterity-r3-1-8` | **Fireproof** (notable) | res fire+5 |
| · | 124–124 | 1 шт. | _minor-вузли на шляху_ | – | DEX +2, stamina +5 |
| 42 | 125 | 855 | `dexterity-r3-1-10` | **Deadly Precision** (keystone) | R:critChance=0.12 ; R:critDamage=0.35 ; hp-50 |
| 43 | 126 | 856 | `dexterity-r3-1-11` | **Paragon** (greater) | dexterity+20 |
| 44 | 127 | 857 | `dexterity-r3-1-12` | **Ox Blood** (notable) | dexterity+6 ; hp+18 |
| 45 | 128 | 859 | `dexterity-r3-1-14` | **Honed** (notable) | dexterity+6 ; dmg physical+4 |
| 46 | 129 | 21068 | `strength-r3-3-5` | **Mastery** (notable) | strength+8 |
| · | 130–137 | 8 шт. | _minor-вузли на шляху_ | – | STR +6, mana +18, CON +10, stamina +5 |
| 47 | 138 | 1451 | `constitution-r3-1-14` | **Honed** (notable) | constitution+6 ; dmg physical+4 |
| · | 139–139 | 1 шт. | _minor-вузли на шляху_ | – | DEX +2 |
| 48 | 140 | 1449 | `constitution-r3-1-12` | **Ox Blood** (notable) | constitution+6 ; hp+18 |
| 49 | 141 | 1448 | `constitution-r3-1-11` | **Paragon** (greater) | constitution+20 |
| · | 142–144 | 3 шт. | _minor-вузли на шляху_ | – | CON +2, hp +8, STR +2, res physical +1, dmg physical +3 |
| 50 | 145 | 1168 | `strength-r3-1-27` | **Great Sinew** (notable) | strength+6 |
| 51 | 146 | 1167 | `strength-r3-1-26` | **Ascendance** (greater) | strength+18 |
| · | 147–147 | 1 шт. | _minor-вузли на шляху_ | – | DEX +2, stamina +5 |
| 52 | 148 | 657 | `dexterity-r1-1-16` | **Marksman's Focus** (notable) | R:dexteritySkillDamage=0.04 |
| 53 | 149 | 746 | `dexterity-r2-1-25` | **Great Sinew** (notable) | dexterity+6 |
| 54 | 150 | 887 | `dexterity-r3-2-5` | **Apostasy** (greater) | charisma+20 |

**Логіка:** **12 очок → `Deadeye`** (id 748; +20 DEX, +1 снаряд): з цього моменту Barrage/Rain/Venom/Piercing б'ють на +1 удар, віяло автоатаки — 2 стріли. Далі WIS/CON-вузли для гемів (27–30), `Windrunner` (id 20668, 32-ге очко) та `Fleet` (id 20780, 34-те; floor 0,35), `Marksman's Mastery` (48), `Ascendance` (+18 DEX) на 53/60/75/76, **`Volley`** (id 54194) — лише на 59-му (+1 снаряд, разом +2). Блок STR (94–115: `Plating`, `Reckless Swing`, `Unbreakable`, `Executioner`, `Martial Mastery`, `Ascendance`) підсилює автоатаку лука; нарешті `Deadly Aim` (116), `Deadeye Focus` (117), `Deadly Precision` (125) — крит ≈ 19 %, крит-шкода +45 %.

**Кейстоуни та їхні мінуси:**
* `Deadly Precision` (855): **−50 макс. HP** (при 1343 HP відчутно, але +12 % крита й +35 % крит-шкоди).
* `Reckless Swing` (1197): −10 % опору льоду; можна пропустити — майже вся його користь для автоатаки. Він стоїть на 96-му очку.
* `Deadeye`, `Fleet`, `Windrunner`, `Executioner`, `Unbreakable` — без мінусів.
* `Crimson Bargain` (21260) у плані **не стоїть**: найкоротший шлях від старту — 28 вузлів; за потреби +40 % до скілів замініть ним блок STR 94–115 (він підсилює автоатаку, тоді як Crimson — лише скіли).

**Усі `id` у порядку взяття (150 очок), по віхах — для перевірки зв'язності й швидкого проходу:**

```
# очки 1–10
628 627 626 651 650 655 696 743 738 737
# очки 11–30
740 748 813 866 814 815 816 817 818 819 820 821 822 823 824 20775 20776 20777 20778 20779
# очки 31–60
747 20668 20667 20780 20772 625 624 336 410 530 529 528 20479 20480 20481 20482 20483 20781 20782 874 873 872 871 870 114901 114929 114928 114910 54194 114911
# очки 61–100
881 882 883 884 885 890 886 20474 20478 114893 114941 114940 114946 114945 114947 114956 20769 20774 825 826 1104 1105 1106 1107 1108 1109 1110 1111 1112 1113 1114 1193 1194 1195 1196 1197 115628 115629 115630 115631
# очки 101–150
115632 115633 115634 21076 21075 1044 21077 21078 115672 115674 115687 115671 115677 115676 115678 20666 116360 808 809 810 851 852 853 854 855 856 857 859 21068 115636 115637 115638 114512 1400 1401 1402 1443 1451 1450 1449 1448 1162 1170 1169 1168 1167 656 657 746 887
```

### 5.4 Зброя та броня

* **Зброя:** до L22 — кинджал (`*-dagger`, DEX; крит +15 %); з L23 — лук: `*-bow` (2H, cd 0,75) або `*-crossbow` (2H, cd 0,95, більше шкоди: T10 130,5 проти 101,5), обидва DEX-вимога T2 8 … T10 116. Лук має вбудований +10 % крита, арбалет +8 %. Боєприпасів немає. `Sniper Stance` вимагає лук (`reqWeapon: bow`).
* **Броня:** `*-hood`, `*-boots`, `*-gloves` (DEX: T4 26 … T10 116), легка (def T10: hood 14,5, boots/gloves 10,1). Off_hand у дворучного лука вільний не буде (2H). Кільця — CHA (35 у плані → `steel-band` 16 / `tempered-band` 26).
* **Афікси:** `of_grace` (+DEX), `flaming/freezing` (дадуть % вогню/льоду автоатаці — але ваш елемент фізичний).

### 5.5 Слабкі місця та як їх обійти

* **Подвійна зброя** до L25 (кинджал → лук) — тримайте обидва в слотах.
* **Мало HP** (1343 на 150 очках; −50 з `Deadly Precision`) і жодного справжнього захисту, окрім `Tailwind Aura` (ухилення 15 %); рятує дистанція: `Cheetah Stride` (+45 %), `Bear Trap`/`Tar Trap` (L46/L47) — тільки шкода, без утримання.
* **Стамина — єдиний ресурс стріл:** 200 пул, реген 31/с. Серії `Barrage` по 2–4 такти (див. 0.2 п.3); `Venom Arrow` дешевий.
* **WIS-вимога з L25 (WIS 12) наздоганяє лише на 30-му очку** — до цього `Aimed Shot` (WIS 11) та `Barrage` недоступні, користуйтеся кинджальним `Fan of Knives`.


## 6. Druid — «Мисливець форм» (Shapeshifter)

**Стиль:** три форми з різними ролями: **Wolf Form — шкода**, **Hawk Form — швидкість і кайтинг**, **Bear Form — танк** (за вашим прикладом: яструб для швидкості, вовк для шкоди). Усі бонуси форм множаться `formPower` з дерева (`1 + formPower`, обмежено +100 %). У формі **заклять (magic/debuff) не кастують**.

### 6.1 Як працюють форми (з коду)

| Форма | База (`BUFFS`) | При `formPower = 0` | При `formPower ≈ 0,35` (30 очок) | При `formPower ≈ 0,72` (60 очок) | При `formPower ≈ 0,99` (150 очок) |
|---|---|---|---|---|---|
| `dru_wolf_form` | `atk 1,35`, `crit +0,25` | автоатака ×1,35, крит 25 % | ×1,47, 33,8 % | ×1,60, 43 % | ×1,70, 49,7 % |
| `dru_hawk_form` | `speed 1,45`, `dodge 0,35` | рух ×1,45, ухилення 35 % | ×1,61, 47 % | ×1,77, **60 % (стеля)** | ×1,90, 60 % |
| `dru_bear_form` | `hpMult 1,6`, `taken 0,5` | HP ×1,6, шкода ×0,5 | ×1,81, ×0,325 | ×2,03, **×0,2 (стеля, −80 %)** | ×2,19, ×0,2 |

Форма діє 2 години (`FORM_DUR 7200`), перемикається повторним кастом тієї ж форми (знімає її) або кастом іншої (міняє; кошт 20 мани + кд 2 с). Скіли з префіксами `bear_/wolf_/hawk_` та `dru_maul`, `dru_ursocs_wrath` (Bear), `dru_feral_bite` (Wolf) **працюють лише у своїй формі** (`formGate`). `Primal Metamorphosis` (`formOnly`) вимагає будь-якої форми.

**Важливо:** `atk` (вовк) прискорює лише автоатаку й тільки поки ви **нижче стелі швидкості**: у вовчій формі для стелі 0,40 достатньо DEX ≈ 21–34 (залежно від `formPower`), тож DEX 56 з плану частково дублює вовка. Головна причина брати `Hawk Aspect` — `formPower +0,12` і стамина, а не DEX.

### 6.2 Пріоритет статів

1. **CHA** — атрибут усіх 50 скілів Druid (+5 % за очко), тому це «STR» друїда. План: CHA 328.
2. **CON 15 + WIS 13** — вимоги; CON також HP (2513 у плані). **INT** для мани (815 у плані).
3. **STR** (для автоатаки, ×3,2) і DEX — другорядні, надходять через `Bear/Wolf/Hawk Aspect` (+20/+15 STR, +20 DEX) по дорозі.

### 6.3 Хотбар (9 слотів)

| Слот | Скіл (id) | Тип / ресурс | Кулдаун | Рівень | Вимоги до статів | Ціна гема | Квест-гейт | Навіщо |
|---|---|---|---|---|---|---|---|---|
| 1 | **Wolf Form** (`dru_wolf_form`) | buff, mana 20 | 2 c | 1 | —; зброя: any | 100 g | — | Форма шкоди: `crit +25 %` (скіли й автоатака) і `atk ×1,35` (лише швидкість автоатаки). Масштабується `formPower`. |
| 2 | **Hawk Form** (`dru_hawk_form`) | buff, mana 20 | 2 c | 1 | —; зброя: any | 100 g | — | Форма швидкості: `speed ×1,45` і `dodge 35 %` (до 60 % із `formPower`) — подорожі, кайтинг, стрибки між пачками. |
| 3 | **Bear Form** (`dru_bear_form`) | buff, mana 20 | 2 c | 1 | —; зброя: any | 100 g | — | Форма танка: `hpMult ×1,6`, отримана шкода ×0,5 (до ×0,2 при `formPower ≥ 0,6`) — боси, аварійний режим. |
| 4 | **Wolf Bite** (`dru_feral_bite`) | melee, mana 15 | 2 c | 43 | CON14 WIS12 CHA27; зброя: any | 5263 g | act3_nether_behemoth (secret gem) | Найкращий вовчий скіл: 15 бази за 15 мани / кд 2 с (L43, секретний гем). До L43 — `Wolf Rend` / `Wolf Flurry`. |
| 5 | **Wolf Rend** (`dru_wolf_rend`) | melee, mana 14 | 3 c | 20 | CON8 WIS7 CHA15; зброя: any | 2475 g | act1_sunspire_reliquary | 14 мани, кд 3 с, 13 бази — найдешевший вовчий філер до L43; б'є разом із `Wolf Bite` у ротації. |
| 6 | **Hawk Dive Slash** (`dru_hawk_dive_slash`) | melee, mana 16 | 4 c | 44 | CON14 WIS12 CHA27; зброя: any | 5400 g | act3_nether_behemoth (secret gem) | Єдиний стрибково-ударний скіл яструба (L44): 18 бази за 16 мани / кд 4 с, дальність 200 — «закриваєте» дистанцію в Hawk Form. |
| 7 | **Primal Metamorphosis** (`dru_primal_metamorphosis`) | buff, mana 30 | 18 c | 35 | CON12 WIS10 CHA23; зброя: any | 4163 g | act2_obsidian_drake | L35. Лише в формі: +180 HP миттєво, **×1,3 шкоди та ×1,35 швидкості на 20 с при кулдауні 18 с** — постійний аптайм. (Каст поза формою втрачає ману й кулдаун даремно.) |
| 8 | **Mark of the Wild** (`dru_mark_of_the_wild`) | buff, mana 35 | 60 c | 45 | CON14 WIS12 CHA28; зброя: any | 5538 g | act3_nether_behemoth (secret gem) | ×1,15 шкоди й +15 % макс. HP на 1800 с (кд 60 с) — оновлюйте раз на півгодини. |
| 9 | **Thorns Aura** (`dru_thorns_aura`) | buff, mana 0 | 0 c | 48 | CON15 WIS13 CHA29; зброя: any | 6025 g | act3_nether_behemoth (secret gem) | 0 мани, кд 0: 20 % фізичної шкоди відбивається нападникам (60 с). У формах діє (баф, не закляття). |

_Сума цін гемів хотбара: 29164 g._

**Порядок розблокування.**

| Скіл | Рівень | Вимоги | Ціна | Зброя |
|---|---|---|---|---|
| Wolf Form (`dru_wolf_form`) | 1 | — | 100 g | any |
| Hawk Form (`dru_hawk_form`) | 1 | — | 100 g | any |
| Bear Form (`dru_bear_form`) | 1 | — | 100 g | any |
| Wolf Flurry (`dru_wolf_flurry`) | 4 | CON4 WIS4 CHA7 | 800 g | any |
| Hawk Wind Slash (`dru_hawk_wind_slash`) | 17 | CON7 WIS6 CHA14 | 2138 g | any |

* **L1 (100 g кожна, без вимог до статів):** `Wolf Form`, `Hawk Form`, `Bear Form` — відкривають клас. Усі форм-скіли мають `reqWeapon: any`.
* **L2–L29 — по формах:** Bear — `Bear Slam` (L2), `Bear Charge` (L8), `Ursoc's Wrath` (L29, AoE 23 бази); Wolf — `Wolf Flurry` (L4), `Wolf Pounce` (L10), `Wolf Rend` (L20), `Wolf Pack Strike` (L26); Hawk — `Hawk Talon Strike` (L6), `Hawk Wind Slash` (L17, дальність 160), `Hawk Razor Feathers` (L28).
* **L35** `Primal Metamorphosis` (кіллер-баф), **L43** `Wolf Bite`, **L44** `Hawk Dive Slash`, **L45** `Mark of the Wild`, **L48** `Thorns Aura` (всі `act3`; секретні геми).
* Стат-вимоги хотбара (CHA 29, CON 15, WIS 13) виконано **з 14-го очка** плану.
* Закляття (`Wrath` L31, `Moonfire` L32, `Starfall`, `Solar Beam`, `Cyclone`) потребують `staff_wand` і людської форми — у цій збірці не використовуються.

**Цикл бою:** 1) увійти у `Wolf Form` (кд 2 с, 20 мани); 2) `Primal Metamorphosis` + `Mark of the Wild`; 3) `Wolf Bite` ↔ `Wolf Rend` (різні скіли поспіль дають ланцюг +6…18 %); 4) `Hawk Form` для переходів між пачками/кайтингу — `Hawk Dive Slash` як захоплення; 5) `Bear Form`, коли HP < 40 % або в босів із важкими ударами.

### 6.4 Пасивне дерево

**Стартовий вузол:** `start-charisma` (id 1511, «Druid») — `formPower +0,03`.

| id | Вузол | Вартість найкоротшого шляху від старту окремо | Позиція в плані |
|---|---|---|---|
| 21668 | Menagerie (keystone) | 12 | 12 |
| 21556 | Hawk Aspect (keystone) | 10 | 20 |
| 1789 | Primal Form Mastery (keystone) | 17 | 33 |
| 21260 | Crimson Bargain (keystone) | 11 | 43 |
| 1743 | Wolf Aspect (keystone) | 14 | 56 |
| 1636 | Bear Aspect (keystone) | 12 | 61 |
| 21372 | Blood Pact (keystone) | 13 | 68 |
| 54224 | Wild Heart (greater) | 21 | 82 |

**Віхи:**

| Очок | STR | DEX | CON | INT | WIS | CHA | Макс. HP | Макс. мана | Реген мани/с | Макс. стамина | Реген стам./с | Реген HP/с | Множник скілів (головний стат) | Множник удару зброї (STR) | Інтервал автоатаки, × від cd зброї (менше = швидше) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 5 | 7 | 10 | 7 | 5 | 18 | 156 | 173 | 11 | 100 | 10 | 1.5 | ×1.6 | ×1.0 | ×0.94 |
| 30 | 7 | 27 | 47 | 25 | 19 | 101 | 594 | 389 | 29 | 140 | 14 | 5.2 | ×6.4 | ×1.1 | ×0.56 |
| 60 | 24 | 45 | 60 | 37 | 31 | 203 | 780 | 509 | 41 | 155 | 17 | 8.0 | ×16.8 | ×2.0 | ×0.42 |
| 100 | 49 | 50 | 120 | 54 | 59 | 267 | 1569 | 691 | 65 | 165 | 19 | 16.3 | ×22.5 | ×3.2 | ×0.40 |
| 150 | 49 | 56 | 199 | 64 | 105 | 328 | 2513 | 815 | 93 | 180 | 19 | 27.2 | ×29.3 | ×3.2 | ×0.40 |

Правила/відсотки на віхах: 10 очок — `formPower 0.03`; пули з дерева hp +16, mana +18; 30 — `manaRegen 2; formPower 0.35; staminaRegen 4; attackSpeedMult 1.08; charismaSkillDamage 0.1`; damage% physical +8, lightning +8; пули з дерева hp +84, mana +54, stamina +40; 60 — `manaRegen 2; formPower 0.72; staminaRegen 7; attackSpeedMult 1.08; charismaSkillDamage 0.1; hpRegen 1.5; skillDamageMult 1.4; lifeCostMultiplier 1.3`; damage% physical +20, lightning +16; пули з дерева hp +140, mana +54, stamina +55; 100 — `manaRegen 3.5; formPower 0.94; staminaRegen 9; attackSpeedMult 1.08; charismaSkillDamage 0.14; hpRegen 3.8; skillDamageMult 1.4; lifeCostMultiplier 1.15; constitutionSkillDamage 0.1`; damage% physical +47, lightning +16; resist% physical +7, fire +5, lightning +5; пули з дерева hp +329, mana +66, stamina +65; 150 — `manaRegen 3.5; formPower 0.99; staminaRegen 9; attackSpeedMult 1.08; charismaSkillDamage 0.22; hpRegen 6.8; skillDamageMult 1.4; lifeCostMultiplier 1.15; constitutionSkillDamage 0.1`; damage% physical +59, lightning +16; resist% physical +21, fire +5, lightning +5; пули з дерева hp +483, mana +90, stamina +80.

**Послідовність вузлів:**

| № | Очок (накопичено) | id | key | Назва (kind) | Що дає |
|---|---|---|---|---|---|
| · | 1–11 | 11 шт. | _minor-вузли на шляху_ | – | CHA +13, CON +5, hp +16, mana +24, INT +2, DEX +2, STR +2 |
| 1 | 12 | 21668 | `charisma-r3-3-13` | **Menagerie** (keystone) | charisma+25 ; constitution+15 ; mana+30 ; R:manaRegen=2 ; R:formPower=0.15 |
| 2 | 13 | 21667 | `charisma-r3-3-12` | **Wanderer's Gift** (greater) | intelligence+18 |
| 3 | 14 | 21666 | `charisma-r3-3-11` | **Renaissance** (notable) | wisdom+12 |
| 4 | 15 | 21660 | `charisma-r3-3-5` | **Apotheosis (CHA)** (notable) | charisma+12 |
| · | 16–16 | 1 шт. | _minor-вузли на шляху_ | – | CHA +2 |
| 5 | 17 | 114170 | `charisma-r4-3-1` | **Ascendance (CHA)** (greater) | charisma+18 |
| · | 18–19 | 2 шт. | _minor-вузли на шляху_ | – | CHA +4, hp +16 |
| 6 | 20 | 21556 | `charisma-r2-4-8` | **Hawk Aspect** (keystone) | dexterity+20 ; stamina+40 ; R:staminaRegen=4 ; R:attackSpeedMult=1.08 ; R:formPower=0.12 |
| 7 | 21 | 21669 | `charisma-r3-3-14` | **Wild Mastery** (greater) | R:charismaSkillDamage=0.1 |
| 8 | 22 | 114154 | `charisma-r4-2-18` | **Primal Instinct** (notable) | R:formPower=0.05 ; hp+20 |
| 9 | 23 | 114160 | `charisma-r4-2-23` | **Charge** (notable) | dmg lightning+8 |
| 10 | 24 | 114159 | `charisma-r4-2-22` | **Apostasy** (greater) | constitution+20 |
| 11 | 25 | 114161 | `charisma-r4-2-24` | **Ascendance (CHA)** (greater) | charisma+18 |
| 12 | 26 | 21670 | `charisma-r3-3-15` | **Brutality** (notable) | dmg physical+8 |
| · | 27–32 | 6 шт. | _minor-вузли на шляху_ | – | WIS +2, hp +40, CON +2, CHA +9 |
| 13 | 33 | 1789 | `charisma-r3-2-19` | **Primal Form Mastery** (keystone) | charisma+30 ; wisdom+10 ; R:hpRegen=1.5 ; R:staminaRegen=3 ; R:formPower=0.25 |
| · | 34–42 | 9 шт. | _minor-вузли на шляху_ | – | CHA +8, CON +11, hp +32 |
| 14 | 43 | 21260 | `constitution-r2-4-8` | **Crimson Bargain** (keystone) | R:skillDamageMult=1.4 ; R:lifeCostMultiplier=1.3 |
| · | 44–44 | 1 шт. | _minor-вузли на шляху_ | – | STR +2, hp +8 |
| 15 | 45 | 21368 | `constitution-r3-3-9` | **Second Discipline** (notable) | charisma+8 |
| · | 46–46 | 1 шт. | _minor-вузли на шляху_ | – | WIS +2, hp +8 |
| 16 | 47 | 21370 | `constitution-r3-3-11` | **Renaissance** (notable) | intelligence+12 |
| 17 | 48 | 21371 | `constitution-r3-3-12` | **Wanderer's Gift** (greater) | dexterity+18 |
| · | 49–53 | 5 шт. | _minor-вузли на шляху_ | – | CHA +10, stamina +10 |
| 18 | 54 | 1741 | `charisma-r3-1-8` | **Charge** (notable) | dmg lightning+8 |
| · | 55–55 | 1 шт. | _minor-вузли на шляху_ | – | CHA +2, stamina +5 |
| 19 | 56 | 1743 | `charisma-r3-1-10` | **Wolf Aspect** (keystone) | strength+15 ; charisma+15 ; dmg physical+12 ; R:formPower=0.12 |
| 20 | 57 | 1744 | `charisma-r3-1-11` | **Paragon (CHA)** (greater) | charisma+20 |
| · | 58–60 | 3 шт. | _minor-вузли на шляху_ | – | CHA +4, CON +2 |
| 21 | 61 | 1636 | `charisma-r2-1-27` | **Bear Aspect** (keystone) | strength+20 ; hp+120 ; R:hpRegen=1.5 ; res physical+5 ; R:formPower=0.12 |
| 22 | 62 | 1747 | `charisma-r3-1-14` | **Ox Blood (CHA)** (notable) | charisma+6 ; hp+18 |
| · | 63–65 | 3 шт. | _minor-вузли на шляху_ | – | WIS +4, stamina +10, INT +4 |
| 23 | 66 | 114165 | `charisma-r4-2-6` | **Ascendance (CHA)** (greater) | charisma+18 |
| 24 | 67 | 114166 | `charisma-r4-2-7` | **Apotheosis (CHA)** (notable) | charisma+12 |
| 25 | 68 | 21372 | `constitution-r3-3-13` | **Blood Pact** (keystone) | R:lifeCostMultiplier=0.85 |
| · | 69–70 | 2 шт. | _minor-вузли на шляху_ | – | CON +4, mana +6 |
| 26 | 71 | 114586 | `constitution-r4-3-1` | **Ascendance** (greater) | constitution+18 |
| 27 | 72 | 114585 | `constitution-r4-3-0` | **Grounding** (notable) | res lightning+5 |
| 28 | 73 | 114577 | `constitution-r4-2-24` | **Ascendance** (greater) | constitution+18 |
| 29 | 74 | 114576 | `constitution-r4-2-23` | **Fireproof** (notable) | res fire+5 |
| 30 | 75 | 114575 | `constitution-r4-2-22` | **Apostasy** (greater) | wisdom+20 |
| 31 | 76 | 21364 | `constitution-r3-3-5` | **Apotheosis** (notable) | constitution+12 |
| 32 | 77 | 21373 | `constitution-r3-3-14` | **Sanguine Mastery** (greater) | R:constitutionSkillDamage=0.1 |
| 33 | 78 | 21374 | `constitution-r3-3-15` | **Brutality** (notable) | dmg physical+8 |
| · | 79–80 | 2 шт. | _minor-вузли на шляху_ | – | hpRegen +0.8, manaRegen +1.5, staminaRegen +2, CHA +2 |
| 34 | 81 | 114152 | `charisma-r4-2-16` | **Brutality** (notable) | dmg physical+8 |
| 35 | 82 | 54224 | `clu_cha_beast_bond-hub` | **Wild Heart** (greater) | R:formPower=0.1 |
| · | 83–85 | 3 шт. | _minor-вузли на шляху_ | – | STR +2, hp +8, WIS +2, res physical +1, dmg physical +3 |
| 36 | 86 | 1760 | `charisma-r3-1-27` | **Great Sinew (CON)** (notable) | constitution+6 |
| 37 | 87 | 1759 | `charisma-r3-1-26` | **Ascendance (CHA)** (greater) | charisma+18 |
| · | 88–88 | 1 шт. | _minor-вузли на шляху_ | – | INT +3 |
| 38 | 89 | 1791 | `charisma-r3-2-21` | **Ox Blood (CHA)** (notable) | charisma+6 ; hp+18 |
| · | 90–90 | 1 шт. | _minor-вузли на шляху_ | – | CON +2, mana +6 |
| 39 | 91 | 1756 | `charisma-r3-1-23` | **Wild Focus** (notable) | R:charismaSkillDamage=0.04 |
| · | 92–92 | 1 шт. | _minor-вузли на шляху_ | – | DEX +2, res physical +1 |
| 40 | 93 | 21558 | `charisma-r2-4-10` | **Great Sinew (INT)** (notable) | intelligence+6 |
| · | 94–97 | 4 шт. | _minor-вузли на шляху_ | – | WIS +2, STR +3, DEX +3, INT +4 |
| 41 | 98 | 1778 | `charisma-r3-2-8` | **Brutality** (notable) | dmg physical+8 |
| · | 99–99 | 1 шт. | _minor-вузли на шляху_ | – | CHA +2 |
| 42 | 100 | 1776 | `charisma-r3-2-6` | **Thick Skin** (notable) | hp+25 |
| 43 | 101 | 1775 | `charisma-r3-2-5` | **Apostasy** (greater) | constitution+20 |
| · | 102–102 | 1 шт. | _minor-вузли на шляху_ | – | res physical +2 |
| 44 | 103 | 21554 | `charisma-r2-4-6` | **Wild Focus** (notable) | R:charismaSkillDamage=0.04 |
| · | 104–104 | 1 шт. | _minor-вузли на шляху_ | – | DEX +2 |
| 45 | 105 | 21662 | `charisma-r3-3-7` | **Broad Study** (notable) | intelligence+6 |
| 46 | 106 | 114157 | `charisma-r4-2-20` | **Thorn Hide** (notable) | res physical+5 ; hp+20 |
| · | 107–107 | 1 шт. | _minor-вузли на шляху_ | – | CHA +4 |
| 47 | 108 | 21560 | `charisma-r2-4-12` | **Great Sinew (CHA)** (notable) | charisma+6 |
| 48 | 109 | 114158 | `charisma-r4-2-21` | **Thorn Hide** (notable) | res physical+5 ; hp+20 |
| · | 110–114 | 5 шт. | _minor-вузли на шляху_ | – | CON +8, hp +44, hpRegen +1.5 |
| 49 | 115 | 114568 | `constitution-r4-2-16` | **Brutality** (notable) | dmg physical+8 |
| · | 116–116 | 1 шт. | _minor-вузли на шляху_ | – | WIS +2, mana +6 |
| 50 | 117 | 1638 | `charisma-r2-2-0` | **Mastery (CHA)** (notable) | charisma+8 |
| · | 118–122 | 5 шт. | _minor-вузли на шляху_ | – | CON +11, hp +16, CHA +4 |
| 51 | 123 | 114582 | `constitution-r4-2-7` | **Apotheosis** (notable) | constitution+12 |
| 52 | 124 | 114581 | `constitution-r4-2-6` | **Ascendance** (greater) | constitution+18 |
| 53 | 125 | 114578 | `constitution-r4-2-3` | **Mastery** (notable) | constitution+8 |
| · | 126–129 | 4 шт. | _minor-вузли на шляху_ | – | WIS +8, stamina +5 |
| 54 | 130 | 267 | `wisdom-r3-1-14` | **Honed** (notable) | wisdom+6 ; dmg physical+4 |
| · | 131–131 | 1 шт. | _minor-вузли на шляху_ | – | DEX +2 |
| 55 | 132 | 265 | `wisdom-r3-1-12` | **Ox Blood** (notable) | wisdom+6 ; hp+18 |
| 56 | 133 | 264 | `wisdom-r3-1-11` | **Paragon** (greater) | wisdom+20 |
| · | 134–139 | 6 шт. | _minor-вузли на шляху_ | – | CHA +7, hp +16, WIS +4, mana +6, INT +2 |
| 57 | 140 | 1806 | `charisma-r3-2-36` | **Great Sinew (CHA)** (notable) | charisma+6 |
| 58 | 141 | 1805 | `charisma-r3-2-35` | **Ascendance (CHA)** (greater) | charisma+18 |
| 59 | 142 | 54226 | `clu_cha_beast_bond-sat1` | **Thick Pelt** (notable) | R:hpRegen=1.5 |
| · | 143–145 | 3 шт. | _minor-вузли на шляху_ | – | CHA +2, mana +6, INT +2, stamina +10, DEX +2 |
| 60 | 146 | 1545 | `charisma-r1-1-16` | **Wild Focus** (notable) | R:charismaSkillDamage=0.04 |
| · | 147–147 | 1 шт. | _minor-вузли на шляху_ | – | CON +2, mana +6 |
| 61 | 148 | 1634 | `charisma-r2-1-25` | **Great Sinew (CHA)** (notable) | charisma+6 |
| · | 149–149 | 1 шт. | _minor-вузли на шляху_ | – | res physical +2 |
| 62 | 150 | 21672 | `charisma-r3-3-17` | **Primal Instinct** (notable) | R:formPower=0.05 ; hp+20 |

**Логіка:** `Menagerie` (id 21668; +25 CHA, +15 CON, +30 мани, +2 мани/с, `formPower +0,15`) на **12-му очку** — вхід у CHA-ядро. `Hawk Aspect` (id 21556; +20 DEX, +40 стамини, +8 % швидкості атаки, `formPower +0,12`) на 20-му. **`Primal Form Mastery`** (id 1789; +30 CHA, +10 WIS, `formPower +0,25`) на **33-му очку** — `formPower` ≈ 0,60 (Bear уже на стелі −80 % шкоди). `Crimson Bargain` (21260) на 43-му — ×1,4 до скілів (за відсутності скілів за життя безкоштовно), `Wolf Aspect` (id 1743; +15 STR, +15 CHA, +12 % фіз., `formPower +0,12`) на 56-му (`formPower` ≈ 0,72), `Bear Aspect` (id 1636; +20 STR, +120 HP, +5 % фіз. опору, `formPower +0,12`) на 61-му (≈ 0,84): ухилення Hawk (60 %) і захист Bear (−80 %) упираються у **стелі** вже на ≈ 0,72. `Wild Heart` (хаб 54224, +0,10) на 82-му — доводить суму до ≈ 0,99. Усе, що вище 1,0, марне (обмеження коду `formPower ≤ 1`).

**Кейстоуни та їхні мінуси:** `Menagerie`, `Hawk/Wolf/Bear Aspect`, `Primal Form Mastery` — без мінусів. `Crimson Bargain` — +30 % вартості життя не діє на друїда (скілів за життя немає). `Blood Pact` (21372) і `Sanguine Mastery` (21373) у плані — лише як шлях до CON-вузлів (скілів за життя в Druid немає, тож `Blood Pact` нічого не дає).

**Усі `id` у порядку взяття (150 очок), по віхах — для перевірки зв'язності й швидкого проходу:**

```
# очки 1–10
1516 1517 1518 1519 1520 1594 1714 114111 114110 114109
# очки 11–30
114107 21668 21667 21666 21660 114155 114170 1713 1712 21556 21669 114154 114160 114159 114161 21670 114106 114105 114104 114103
# очки 31–60
114102 114101 1789 1515 1514 1513 1512 1224 1298 1418 1417 1416 21260 21367 21368 21369 21370 21371 1696 1697 1698 1739 1740 1741 1742 1743 1744 1699 1700 1701
# очки 61–100
1636 1747 114156 114145 114164 114165 114166 21372 114523 114571 114586 114585 114577 114576 114575 21364 21373 21374 114146 114153 114152 54224 1754 1762 1761 1760 1759 1790 1791 1755 1756 21557 21558 1702 1703 1704 1769 1778 1777 1776
# очки 101–150
1775 21555 21554 21657 21662 114157 21559 21560 114158 114522 114521 114520 114562 114569 114568 1637 1638 114519 114518 114517 114572 114583 114582 114581 114578 216 217 218 259 267 266 265 264 1711 1710 1709 1800 21656 21655 1806 1805 54226 1539 1547 1546 1545 1635 1634 21671 21672
```

### 6.5 Зброя та броня

* **Зброя:** **скіпетр** (`*-scepter`, 1H, **CHA** — єдина зброя під головний стат: T4 26, T5 36, T6 48, T7 62, … T10 116; projectile, cd 0,65, T10 = 87 шкоди) — категорія `staff_wand`, тож `Wrath`/`Moonfire` теж працюватимуть у людській формі. Для тільки-вовчої гри можна взяти `*-mace` (CON) або `*-dagger` (DEX) — автоатака у формі працює зі зброєю в руці, множник STR ×3,2.
* **Броня:** `*-band` / `*-signet` (кільця, **CHA**: T10 116 — єдина група, де вимога = ваш головний стат; захист символічний 0,2–2,9). Решта — за доступним статом: `*-greaves` (CON), `*-hood/boots/gloves` (DEX), `*-robe` (INT). Афікси: `of_presence` (+CHA), `of_the_bear` (+HP).
* **Бонус CHA:** +2 % ціни продажу за очко (`priceMult` = 0,5 + 0,02 × (CHA − 5), стеля 0,9 досягається вже при CHA 25).

### 6.6 Слабкі місця та як їх обійти

* **Закляття заблоковані у формі** — або повністю йдіть у фізику, або перемикайтесь у людську форму (ціна: 20 мани й кд 2 с).
* **Мана 815 при витратах 14–35** на скіл: регена 93/с достатньо, але після `Hawk`→`Wolf`→`Bear` перемикань (по 20 мани) і `Primal Metamorphosis` (30) слідкуйте за пулом.
* **Усе — на мані, а ауру збільшення регену мани (як `Fast Mana Aura` Monk) Druid не має:** допомагають `Menagerie` (+2 мани/с, у плані) та, за бажанням, вузол `Rejuvenation` (id 1561: +2 мани/с, +1,5 HP/с, +3 стамини/с; у плані його нема).
* **Секретні геми L43–L48 під `act3_nether_behemoth`:** до цього шкода — `Wolf Rend` (13 бази) й `Wolf Flurry`.
* **Пастка:** `Primal Metamorphosis` поза формою марнує ману й кулдаун (повертає `null`, але ресурси вже списано).


## 7. Порівняльна таблиця шести білдів

| Клас / білд | Головний стат → що дає | Ядро шкоди | Рух / контроль | Виживання (150 очок) | Ресурс | Ключові вузли | Головна слабкість | Складність |
|---|---|---|---|---|---|---|---|---|
| **Warrior** — Steel Whirl | STR 358 (×18,7 до зброї, ×28,7 до скілів), DEX 84 | Автоатака мечем/сокирою на стелі швидкості + `Flurry of Steel` (360° серії) | Немає (лише `Colossus Stance` ×1,25 reach) | 2266 HP, 20,7 HP/с, `Steel Tempering` −15 %, `Last Stand` | Стамина 235 / 25 за с | `Unbreakable`, `Martial Mastery`, `Reckless Swing`, `Iron Hide`, `Fleet`, `Windrunner` | Мана 190, нуль дальності | Низька |
| **Mage** — Frost-Fire Cadence | INT 392 (×30,2 до заклять, мана 4145, реген 240/с) | `Frostbolt` ↔ `Fireball` (Shatter / Thermal Shock), `Magic Missiles` ×7 ударів, `Blizzard` | `Blink`, `Haste`-альтернатива; ухилення 18 % | 724 HP, `Mana Shield` (70 % з мани), `Spell Ward` | Мана | `Transcendence`, `Deadeye`, `Volley`, `Glass Cannon`, `Cryomancy`/`Pyromancy`, `Fleet` | Крихкість (724 HP), гейти на акти | Середня |
| **Monk** — Flow of Chi | WIS 366 (×29,3 до скілів, ще ×1,46 при мані ≥ 80 %; мана 1566, реген 224/с) | `Spinning Crane Kick` / `Jade Serpent Beam` (канали), `Ki Overflow` | `Tiger Stance` (+25 %), без блінка | 1725 HP, `Diamond Skin`, `Touch of Life`, `regenLifeShare` 25 % | Мана | `Transcendence`, `Hawk Aspect`, `Ki Overflow`, `Crimson Bargain`, `Clarity` | Слабка автоатака, мало дальності | Середня |
| **Cultist** — Blood Atonement | CON 390 (HP 4294 і ×33,5 до скілів) | `Soul Drain` (витік), `Bone Spear`/`Blood Lance` (снаряди), `Blood Pact` | `Abyssal Cloak` (+40 %) — поза хотбаром | 4294 HP, 43,7 HP/с, витік ~20 %, `Blood Rebirth` | HP (фіксовані 15–50) | `Blood Pact`, `Crimson Bargain`, `Vampiric Rite`, `Sanguine Rite`, `Second Discipline` | Раннє життя крихке, подвійна зброя, INT/CHA-податок | Висока |
| **Archer** — Arrow Storm | DEX 287 (×17,2 до скілів, стеля швидкості 0,35), STR 212 (×11,4 до автоатаки лука) | `Barrage` (7 ударів/такт), `Venom Arrow` ×3, `Rain of Arrows` ×12, лук | `Cheetah Stride`, `Tailwind Aura`; кайтинг | 1343 HP, ухилення 15 % (бафом) | Стамина 200 / 31 за с | `Deadeye`, `Volley`, `Fleet`, `Windrunner`, `Deadly Precision` | Кинджал → лук (дві зброї), WIS-вимога з L25, мало HP | Середня |
| **Druid** — Shapeshifter | CHA 328 (×29,3 до скілів), `formPower` ≈ 0,99 | `Wolf Form` (крит 50 %) + `Wolf Bite`/`Wolf Rend`, `Primal Metamorphosis` ×1,3 | `Hawk Form` (×1,9 швидкості, 60 % ухилення) | `Bear Form` (HP ×2,19, −80 % шкоди), 2513 HP | Мана 815 / 93 за с | `Menagerie`, `Hawk Aspect`, `Primal Form Mastery`, `Wolf/Bear Aspect`, `Wild Heart` | Закляття заблоковані у формі, перемикання коштує ману | Середня–висока |

**Висновки для балансу (якщо захочете підкрутити гру):** (а) `Crimson Bargain` фактично безкоштовний ×1,4 для п'яти класів із шести; (б) безелементні луки/стафи масштабуються STR, що ламає ідею «Archer = DEX, Mage = INT» для автоатаки; (в) більшість «ефектів» опису скілів (оглушення, сповільнення, сліпота, зняття броні) не реалізовані, тож скіли `debuff` — просто додаткова AoE-шкода; (г) канали накопичують ступінь, тому короткі серії тактів виграють у довгого утримання; (д) `Whirlwind`-кластер дуги −20 % замаху — єдина «справжня» ціна у melee-вузлів.

## 8. Що не вдалося перевірити / відкриті питання

* Ігровий бій не запускався: усі «числа на 150 очок» — розрахунок за формулами коду, а не заміри.
* Параметри ворогів (HP, захист, шкода) і реальна швидкість отримання XP не враховані; вони визначають, чи реально дійти до 100–150 очок.
* Вага цілей у евристиці підбору вузлів — моя (грубо: ln(проксі DPS) + 0,3–0,6·ln(HP) + ресурс; для Cultist/решти додано штраф за недобір статів для гемів). Для Archer/Cultist/Druid за потреби змініть місце `Crimson Bargain` чи цілих блоків.
* Каталог клієнта (`skillsCatalog.generated.js`) і сервера (`seeds/data/skills.js`) з'єднано через парність-тест; вимоги й ціни гемів наведено з клієнтського файлу.
* У `class_loadouts` для шести класів у dev-БД немає рядків, тому стартовий набір предметів невідомий.
* Реальні ціни гема в торговця залежать від налаштувань; наведено `gemPrice` з каталогу.

