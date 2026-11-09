// Which item affixes suit each build (Build Guide window, "Gear & Tips" tab).
//
// The affixes are the server's catalog (backend/seeds/data/affixTypes.js, docs/item-affixes.md); a test reads that
// catalog and fails when an entry here names an affix that does not exist, cannot roll in the slot or on the weapon
// family the entry claims, or is missing its Ukrainian text. So advice cannot drift from the loot table.
//
// An entry: { label, core, where, effect, why }
//   label   the affix as the game names it (translated by the i18n table, like an item tooltip)
//   core    true = the affixes the build is made of; false = good when they come up
//   where   where it can roll (a weapon family or the slots), written for the player
//   effect  what the line on the item says
//   why      why THIS build wants it
import { getLang } from "../i18n/i18n.js";
import { SKILLS } from "./skillsData.js";

const T = (en, uk) => ({ en, uk });
const A = (label, core, where, effect, why) => ({ label, core, where, effect, why });

// ---- where an affix can appear ---------------------------------------------------------------------
const W = {
  melee: T("melee weapon", "зброя ближнього бою"),
  bow: T("bow / crossbow", "лук / арбалет"),
  caster: T("staff / wand / scepter", "посох / жезл / скіпетр"),
  anyWeapon: T("any weapon", "будь-яка зброя"),
  weaponRing: T("weapon, rings", "зброя, каблучки"),
  weaponChest: T("weapon, chest", "зброя, нагрудник"),
  ringOff: T("rings, off-hand", "каблучки, друга рука"),
  armour: T("chest, helm, gloves, boots, off-hand", "нагрудник, шолом, рукавиці, чоботи, друга рука"),
  helmGlovesRings: T("helm, gloves, rings", "шолом, рукавиці, каблучки"),
  manaGear: T("helm, off-hand, rings", "шолом, друга рука, каблучки"),
  bodyRegen: T("chest, helm, gloves, boots", "нагрудник, шолом, рукавиці, чоботи"),
  chestOff: T("chest, off-hand", "нагрудник, друга рука"),
  chestHelm: T("chest, helm", "нагрудник, шолом"),
  glovesBoots: T("gloves, boots", "рукавиці, чоботи"),
  stamGear: T("boots, gloves, chest", "чоботи, рукавиці, нагрудник"),
  evade: T("helm, gloves, boots", "шолом, рукавиці, чоботи"),
  chestRings: T("chest, rings", "нагрудник, каблучки"),
  beastGear: T("rings, chest, gloves", "каблучки, нагрудник, рукавиці"),
  hunterGear: T("gloves, boots, rings", "рукавиці, чоботи, каблучки"),
};

// ---- the affix lines (what the item says), shared by every build that wants them -----------------------
const E = {
  phys: T("+% physical damage", "+% фізичної шкоди"),
  fire: T("+% fire damage", "+% шкоди вогнем"),
  cold: T("+% cold damage", "+% шкоди холодом"),
  lightning: T("+% lightning damage", "+% шкоди блискавкою"),
  arcane: T("+% arcane damage", "+% чародійної шкоди"),
  critDmg: T("+% critical damage", "+% шкоди критичного удару"),
  critCh: T("+% critical chance", "+% шансу критичного удару"),
  critGlobal: T("+% global critical chance", "+% загального шансу критичного удару"),
  reach: T("+ weapon reach", "+ дальність зброї"),
  pierce: T("projectiles pierce more targets", "снаряди пробивають більше цілей"),
  area: T("+% area of effect", "+% площі ураження"),
  spellLvl: T("+ levels to all spells", "+ рівні всіх заклять"),
  atkSpeed: T("+% attack speed", "+% швидкості атаки"),
  castSpeed: T("+% cast speed", "+% швидкості чаклування"),
  projs: T("+ additional projectiles", "+ додаткові снаряди"),
  projSpeed: T("+% projectile speed", "+% швидкості снарядів"),
  stun: T("+% chance to stun", "+% шансу оглушення"),
  leech: T("% of skill damage leeched as life", "% шкоди навичок повертається життям"),
  slayer: T("+% of max life on kill", "+% макс. життя за вбивство"),
  life: T("+ maximum life", "+ максимальне життя"),
  lifeRegen: T("+ life regeneration", "+ відновлення життя"),
  manaRegen: T("+ mana regeneration", "+ відновлення мани"),
  stamRegen: T("+ stamina regeneration", "+ відновлення витривалості"),
  dodge: T("+% chance to dodge", "+% шансу ухилитися"),
  thorns: T("reflects % of damage taken", "відбиває % отриманої шкоди"),
  beast: T("shapeshift forms stronger", "форми перевтілення сильніші"),
  resFire: T("+% fire resistance", "+% опору вогню"),
  resCold: T("+% cold resistance", "+% опору холоду"),
  resLight: T("+% lightning resistance", "+% опору блискавці"),
  resArcane: T("+% arcane resistance", "+% опору чародійству"),
  resPhys: T("+% physical resistance", "+% опору фізичній шкоді"),
  atr: (n, u) => T(`+% damage with ${n} skills`, `+% шкоди навичок ${u}`),
  fullMana: T("+% damage at full mana", "+% шкоди при повній мані"),
  lowLife: T("+% damage at low life", "+% шкоди при низькому здоров'ї"),
  cooldown: T("-% skill cooldown", "-% перезарядки навичок"),
  manaCost: T("-% mana cost", "-% вартості мани"),
  stamCost: T("-% stamina cost", "-% вартості витривалості"),
  lifeCost: T("-% life cost", "-% вартості життям"),
  ignite: T("chance to ignite on hit", "шанс підпалити при ударі"),
  chill: T("chance to chill on hit", "шанс охолодити при ударі"),
  shock: T("chance to shock on hit", "шанс вразити струмом при ударі"),
  manaKill: T("kill restores mana", "вбивство відновлює ману"),
  stamKill: T("kill restores stamina", "вбивство відновлює витривалість"),
  fury: T("chance on kill: +15% damage for 6s", "шанс після вбивства: +15% шкоди на 6 с"),
  ward: T("chance when hit: -25% damage taken for 4s", "шанс при ударі по вас: −25% отриманої шкоди на 4 с"),
  phoenix: T("chance when hit: heal 8% of max life", "шанс при ударі по вас: лікування 8% макс. життя"),
};

// ---- the builds ------------------------------------------------------------------------------------------
// Keyed by the build's id; the main build of a class is "<class>_main" (lowercase).
export const BUILD_AFFIXES = {
  warrior_main: {
    items: [
      A("of Celerity", true, W.melee, E.atkSpeed, T("Your damage is the auto-attack: every point of attack speed is a point of damage, until the cooldown floor.", "Ваша шкода — автоатака: кожен відсоток швидкості атаки — це відсоток шкоди, аж до мінімуму перезарядки.")),
      A("Brutal", true, W.melee, E.phys, T("Raises every hit of the weapon, the auto-attack and the {war_flurry_of_steel} bursts alike.", "Підсилює кожен удар зброєю — і автоатаку, і сплески «{war_flurry_of_steel}».")),
      A("Mighty", true, W.ringOff, E.atr("Strength", "Сили"), T("Warrior skills are Strength skills: this multiplies all of them.", "Навички Воїна — це навички Сили: цей афікс множить їх усі.")),
      A("of Focus", true, W.ringOff, E.cooldown, T("Shorter cooldowns on {war_flurry_of_steel}, {war_windblade} and the stances.", "Коротші перезарядки «{war_flurry_of_steel}», «{war_windblade}» й стійок.")),
      A("Vicious", false, W.anyWeapon, E.critDmg, T("Pays off once crit chance comes from the tree.", "Окупається, коли шанс крита вже йде з дерева.")),
      A("of Precision", false, W.anyWeapon, E.critCh, T("The other half of crit: chance to land those hits.", "Друга половина крита: шанс влучити такими ударами.")),
      A("of the Leech", false, W.weaponRing, E.leech, T("Sustain for a melee build that never leaves the pack.", "Відновлення для бійця, що не виходить із натовпу.")),
      A("of Vengeance", false, W.weaponRing, E.fury, T("Each kill can start a damage window: it chains through a pack.", "Кожне вбивство може відкрити вікно шкоди: у групі воно тягнеться ланцюжком.")),
    ],
    avoid: T("Skip Sweeping, Savant and the other caster affixes: they cannot roll on a sword or axe anyway.", "Не женіться за «Розмашистим», «Знавцем» та іншими афіксами для чародіїв: на мечі чи сокирі вони не випадають."),
  },
  warrior_bulwark: {
    items: [
      A("Stalwart", true, W.armour, E.life, T("+10 HP per CON is not enough alone: flat life on every piece of armour is the tank's pool.", "+10 ЗДР за СТА самих не вистачає: плоске життя на кожній частині броні — запас танка.")),
      A("of the Bulwark", true, W.armour, E.resPhys, T("Most of what hits a tank is physical.", "Більшість того, що б'є танка, — фізична шкода.")),
      A("of Regeneration", true, W.bodyRegen, E.lifeRegen, T("Between hits the fight never stops: regeneration is a heal every second.", "Бій між ударами не зупиняється: відновлення — це лікування щосекунди.")),
      A("of the Turtle", true, W.chestOff, E.ward, T("A defensive window that opens by itself when you are hit.", "Захисне вікно, що відкривається саме, коли по вас б'ють.")),
      A("of the Phoenix", false, W.chestHelm, E.phoenix, T("A free heal when the pack lands a hit.", "Безкоштовне лікування, коли група пробила вас.")),
      A("of Thorns", false, W.chestOff, E.thorns, T("{war_taunt} pulls the pack onto you: they hurt themselves.", "«{war_taunt}» збирає групу на вас — вони шкодять самі собі.")),
      A("of Stunning", false, W.melee, E.stun, T("Control that stacks with {war_shield_slam}.", "Контроль, що додається до «{war_shield_slam}».")),
      A("of the Salamander", false, W.armour, E.resFire, T("Take the element a boss uses; the suffixes for fire, cold, lightning and arcane all roll here.", "Беріть стихію, якою б'є бос; опори до вогню, холоду, блискавки й чарів тут усі випадають.")),
      A("of the Marathon", false, W.glovesBoots, E.stamCost, T("Tank skills cost stamina: this keeps the bar full.", "Навички танка коштують витривалості — це тримає смугу повною.")),
    ],
    avoid: T("Damage affixes matter less than the next 100 life; spend your slots on defence first.", "Афікси шкоди менш важливі, ніж ще 100 життя: спершу віддайте слоти захисту."),
  },
  warrior_executioner: {
    items: [
      A("Vicious", true, W.anyWeapon, E.critDmg, T("Every execute is a crit away from a kill: critical damage is the build's multiplier.", "Кожна страта — це крит до вбивства: критична шкода — множник цього білду.")),
      A("of Precision", true, W.anyWeapon, E.critCh, T("More crits more often; pairs with Vicious.", "Більше критів частіше; пара до «Лютого».")),
      A("of the Assassin", true, W.helmGlovesRings, E.critGlobal, T("Global crit chance from armour slots, so the weapon is free for damage.", "Загальний шанс крита зі слотів броні, тож зброя вільна для шкоди.")),
      A("Brutal", true, W.melee, E.phys, T("Big single hits: physical damage lifts all of them.", "Великі поодинокі удари: фізична шкода підіймає їх усі.")),
      A("Mighty", false, W.ringOff, E.atr("Strength", "Сили"), T("All Executioner skills are Strength skills.", "Усі навички Ката — це навички Сили.")),
      A("of Vengeance", false, W.weaponRing, E.fury, T("A kill opens a window for the next duel.", "Вбивство відкриває вікно для наступної дуелі.")),
      A("of the Leech", false, W.weaponRing, E.leech, T("Big hits heal for a lot.", "Великі удари лікують багато.")),
      A("of Focus", false, W.ringOff, E.cooldown, T("Execute skills are on cooldowns: shorter ones mean more kills.", "Страти — на перезарядках: коротші дають більше вбивств.")),
    ],
    avoid: T("Attack speed is a second choice here: you win by the size of the hit, not the count.", "Швидкість атаки тут другорядна: ви перемагаєте розміром удару, а не їх кількістю."),
  },

  mage_main: {
    items: [
      A("of the Savant", true, W.caster, E.castSpeed, T("More {mag_frostbolt} and {mag_fireball} per second,.", "Більше «{mag_frostbolt}» і «{mag_fireball}» за секунду.")),
      A("Sagacious", true, W.caster, E.spellLvl, T("Spell levels raise every spell on the bar at once; each is worth five times a level bought from the smith.", "Рівні заклять підсилюють усі закляття на панелі одразу; кожен вартує п'ять рівнів, куплених у коваля.")),
      A("Glacial", true, W.caster, E.cold, T("Your ice half. Pair it with Blazing: alternating elements is the build.", "Ваша крижана половина. Поєднайте з «Полум'яним»: чергування стихій — це і є білд.")),
      A("Blazing", true, W.caster, E.fire, T("Your fire half; see Glacial.", "Ваша вогняна половина; див. «Крижаний».")),
      A("Brilliant", true, W.ringOff, E.atr("Intelligence", "Інтелекту"), T("Mage skills scale with Intelligence.", "Навички Мага залежать від Інтелекту.")),
      A("of Economy", false, W.manaGear, E.manaCost, T("Cheaper spells, more casts from the same pool.", "Дешевші закляття — більше кастів з того самого запасу.")),
      A("of Recovery", false, W.manaGear, E.manaRegen, T("Mana is your health with {mag_mana_shield}: regenerate it.", "З «{mag_mana_shield}» мана — це ваше здоров'я: відновлюйте її.")),
      A("Sweeping", false, W.caster, E.area, T("A bigger {mag_blizzard}.", "Більша «{mag_blizzard}».")),
      A("of the Harvest", false, W.manaGear, E.manaKill, T("A kill refills mana in a pack fight.", "Вбивство поповнює ману в бою з групою.")),
    ],
    avoid: T("Brutal and Celerity are for melee and bows: they never roll on a staff.", "«Брутальний» і «Прудкість» — для ближнього бою й луків: на посоху їх не буває."),
  },
  mage_missiles: {
    items: [
      A("Eldritch", true, W.caster, E.arcane, T("Arcane damage is the whole damage of this build.", "Чародійна шкода — це вся шкода цього білду.")),
      A("of the Savant", true, W.caster, E.castSpeed, T("Cast speed is the battery's rate of fire.", "Швидкість чаклування — це швидкострільність батареї.")),
      A("Sagacious", true, W.caster, E.spellLvl, T("Every spell on the bar is arcane: all of them level up together.", "Усі закляття на панелі чародійні: вони всі підсилюються разом.")),
      A("of the Gale", true, W.caster, E.projSpeed, T("Missiles and beams arrive sooner.", "Снаряди й промені досягають цілі швидше.")),
      A("Empowered", true, W.ringOff, E.fullMana, T("The build spends mana in bursts: open every fight at full mana.", "Білд витрачає ману сплесками: починайте кожен бій з повною маною.")),
      A("Brilliant", false, W.ringOff, E.atr("Intelligence", "Інтелекту"), T("Intelligence skills scale with it.", "Навички Інтелекту множаться ним.")),
      A("of Economy", false, W.manaGear, E.manaCost, T("The battery lasts longer.", "Батарея живе довше.")),
      A("of Recovery", false, W.manaGear, E.manaRegen, T("Mana is also your armour here.", "Мана тут ще й ваша броня.")),
      A("of the Veil", false, W.armour, E.resArcane, T("Arcane is also what hurts you in this line of play.", "У цьому стилі гри чародійство ще й шкодить вам самим.")),
    ],
    avoid: T("Fire and ice damage are wasted on an arcane build.", "Шкода вогнем і льодом на чародійному білді марна."),
  },
  mage_storm: {
    items: [
      A("Thundering", true, W.caster, E.lightning, T("Your whole bar deals lightning.", "Уся ваша панель б'є блискавкою.")),
      A("of the Savant", true, W.caster, E.castSpeed, T("{mag_chain_lightning} and the storms come out faster.", "«{mag_chain_lightning}» і бурі виходять швидше.")),
      A("Sagacious", true, W.caster, E.spellLvl, T("Levels for every spell of the storm.", "Рівні для кожного закляття бурі.")),
      A("Sweeping", true, W.caster, E.area, T("{mag_thunderstorm} and {mag_ball_lightning} are area spells: a bigger area is more targets.", "«{mag_thunderstorm}» і «{mag_ball_lightning}» — закляття по площі: більша площа — більше цілей.")),
      A("of Precision", false, W.anyWeapon, E.critCh, T("The build leans on crits from your buffs.", "Білд спирається на криті з ваших баффів.")),
      A("Vicious", false, W.anyWeapon, E.critDmg, T("Makes those crits count.", "Робить ці криті вагомими.")),
      A("of the Assassin", false, W.helmGlovesRings, E.critGlobal, T("Crit chance from armour slots.", "Шанс крита зі слотів броні.")),
      A("of the Storm Touch", false, W.anyWeapon, E.shock, T("More shocks on top of the ones the spells make.", "Більше шоків понад ті, що роблять закляття.")),
      A("of the Stormward", false, W.armour, E.resLight, T("Lightning resistance for the enemies that fight back with it.", "Опір блискавці проти ворогів, що б'ють нею у відповідь.")),
    ],
    avoid: T("Keep one elemental prefix: a second element dilutes the build.", "Лишайте один елементний префікс: друга стихія розмиває білд."),
  },

  monk_main: {
    items: [
      A("Serene", true, W.ringOff, E.atr("Wisdom", "Мудрості"), T("Monk skills scale with Wisdom.", "Навички Монаха залежать від Мудрості.")),
      A("of Recovery", true, W.manaGear, E.manaRegen, T("The big mana pool is the engine; channels drain it, this refills it.", "Великий запас мани — двигун; канали його випорожнюють, цей афікс наповнює.")),
      A("of Economy", true, W.manaGear, E.manaCost, T("The channels never run dry.", "Канали ніколи не вичерпуються.")),
      A("of Celerity", true, W.melee, E.atkSpeed, T("A dagger or bare hands: more strikes between channels.", "Кинджал чи голі руки: більше ударів між каналами.")),
      A("Empowered", false, W.ringOff, E.fullMana, T("With a pool this large you spend most fights near the top.", "З таким запасом більшість боїв ви проводите майже з повною маною.")),
      A("of the Harvest", false, W.manaGear, E.manaKill, T("Kills refill the pool.", "Вбивства наповнюють запас.")),
      A("of Precision", false, W.anyWeapon, E.critCh, T("A dagger already has crit built in.", "У кинджала крит уже вбудований.")),
      A("of Evasion", false, W.evade, E.dodge, T("You are in melee range: dodge keeps you there.", "Ви в ближньому бою: ухилення дозволяє там лишитись.")),
    ],
    avoid: T("Not a quarterstaff: its name counts as a staff and Monk skills refuse it.", "Не посох: за назвою він рахується посохом, і навички Монаха його не приймають."),
  },
  monk_fist: {
    items: [
      A("of Celerity", true, W.melee, E.atkSpeed, T("Combos want speed: every extra strike is a combo step.", "Комбо потребують швидкості: кожен додатковий удар — крок комбо.")),
      A("Brutal", true, W.melee, E.phys, T("Strikes are physical hits.", "Удари — це фізична шкода.")),
      A("of Precision", true, W.anyWeapon, E.critCh, T("Dagger crit plus this: counter-hits crit often.", "Крит кинджала плюс цей афікс: контрудари часто критують.")),
      A("Vicious", true, W.anyWeapon, E.critDmg, T("Makes the crits hurt.", "Робить криті болючими.")),
      A("Serene", true, W.ringOff, E.atr("Wisdom", "Мудрості"), T("The strikes are Wisdom skills.", "Удари — це навички Мудрості.")),
      A("of Evasion", false, W.evade, E.dodge, T("The build counter-attacks after a dodge.", "Білд контратакує після ухилення.")),
      A("of the Assassin", false, W.helmGlovesRings, E.critGlobal, T("Crit from armour slots.", "Крит зі слотів броні.")),
      A("of the Leech", false, W.weaponRing, E.leech, T("Close range sustain.", "Відновлення в ближньому бою.")),
      A("of Stunning", false, W.melee, E.stun, T("Stunned enemies cannot hit back.", "Приголомшені вороги не б'ють у відповідь.")),
    ],
    avoid: T("Cast speed and spell levels are for staves, and you fight with fists.", "Швидкість чаклування й рівні заклять — для посохів, а ви б'єтесь кулаками."),
  },
  monk_guardian: {
    items: [
      A("of Regeneration", true, W.bodyRegen, E.lifeRegen, T("A durable build that stands its ground: a heal every second.", "Живучий білд, що тримає позицію: лікування щосекунди.")),
      A("of Recovery", true, W.manaGear, E.manaRegen, T("Auras and shields run on mana.", "Аури й щити живляться маною.")),
      A("Stalwart", true, W.armour, E.life, T("Life on every piece.", "Життя на кожній частині.")),
      A("of the Bulwark", true, W.armour, E.resPhys, T("Physical resistance for the front line.", "Фізичний опір для лінії фронту.")),
      A("of the Turtle", true, W.chestOff, E.ward, T("A defensive window opens when you are hit.", "Захисне вікно відкривається, коли по вас б'ють.")),
      A("of the Phoenix", false, W.chestHelm, E.phoenix, T("A free heal on a hit.", "Безкоштовне лікування при ударі.")),
      A("of the Harvest", false, W.manaGear, E.manaKill, T("Area skills kill packs; each kill refills mana.", "Навички по площі вбивають групи; кожне вбивство наповнює ману.")),
      A("Serene", false, W.ringOff, E.atr("Wisdom", "Мудрості"), T("The skills you do use scale with Wisdom.", "Навички, які ви використовуєте, залежать від Мудрості.")),
      A("of Economy", false, W.manaGear, E.manaCost, T("More shields and heals per pool.", "Більше щитів і лікувань з одного запасу.")),
    ],
    avoid: T("Chasing damage here wastes the point of the build: the fight is won by not dying.", "Погоня за шкодою нівелює сенс білду: бій виграється тим, що ви не помираєте."),
  },

  cultist_main: {
    items: [
      A("of the Martyr", true, W.chestRings, E.lifeCost, T("Spells cost HP: every point of reduction is life you keep.", "Закляття коштують ЗДР: кожен відсоток знижки — це життя, яке ви зберігаєте.")),
      A("of the Leech", true, W.weaponRing, E.leech, T("The life you spend comes back with damage.", "Витрачене життя повертається шкодою.")),
      A("Hardy", true, W.ringOff, E.atr("Constitution", "Статури"), T("Constitution is your damage as well as your health.", "Статура — це і ваша шкода, і здоров'я.")),
      A("Stalwart", true, W.armour, E.life, T("A bigger pool to spend.", "Більший запас, який можна витрачати.")),
      A("of the Savant", false, W.caster, E.castSpeed, T("Faster casts, faster life spending: use with leech.", "Швидші касти — швидша витрата життя: поєднуйте з вампіризмом.")),
      A("Sagacious", false, W.caster, E.spellLvl, T("Stronger spells for the same cost.", "Сильніші закляття за ту саму ціну.")),
      A("of the Phoenix", false, W.chestHelm, E.phoenix, T("Life back when you are hit.", "Життя повертається, коли по вас б'ють.")),
      A("of the Slayer", false, W.weaponChest, E.slayer, T("A heal on every kill.", "Лікування за кожне вбивство.")),
      A("Desperate", false, W.ringOff, E.lowLife, T("You run low by design: get paid for it.", "Ви навмисно падаєте до низького життя — отримайте за це бонус.")),
    ],
    avoid: T("Mana affixes (Economy, Recovery, Harvest) do nothing for a build that pays in life.", "Афікси мани («Ощадливість», «Одужання», «Жнива») нічого не дають білду, що платить життям."),
  },
  cultist_bone: {
    items: [
      A("Sagacious", true, W.caster, E.spellLvl, T("{cul_bone_spear}, {cul_corpse_explosion} and {cul_bone_storm} all rise together.", "«{cul_bone_spear}», «{cul_corpse_explosion}» і «{cul_bone_storm}» підсилюються разом.")),
      A("of the Savant", true, W.caster, E.castSpeed, T("More of the heavy spells per minute.", "Більше важких заклять за хвилину.")),
      A("Sweeping", true, W.caster, E.area, T("{cul_corpse_explosion}, {cul_bone_storm} and {cul_death_decay} are area spells.", "«{cul_corpse_explosion}», «{cul_bone_storm}» і «{cul_death_decay}» діють по площі.")),
      A("of the Martyr", true, W.chestRings, E.lifeCost, T("Heavy spells, heavy life costs.", "Важкі закляття — висока ціна життям.")),
      A("Hardy", true, W.ringOff, E.atr("Constitution", "Статури"), T("Constitution skills multiply with it.", "Навички Статури множаться ним.")),
      A("of the Leech", false, W.weaponRing, E.leech, T("Sustain for the life you spend.", "Відновлення витраченого життя.")),
      A("Stalwart", false, W.armour, E.life, T("Pool to spend and to survive on.", "Запас і для витрат, і для виживання.")),
      A("of the Turtle", false, W.chestOff, E.ward, T("A defensive window while golems fight.", "Захисне вікно, поки б'ються големи.")),
      A("of the Slayer", false, W.weaponChest, E.slayer, T("Kills that heal.", "Вбивства, що лікують.")),
    ],
    avoid: T("Brutal needs a melee or bow weapon: it does not roll on a scepter.", "«Брутальний» потребує зброї ближнього бою чи лука: на скіпетрі він не випадає."),
  },
  cultist_curse: {
    items: [
      A("of the Savant", true, W.caster, E.castSpeed, T("Curses and poisons go out sooner, so the pack decays sooner.", "Прокляття й отрути накладаються швидше — отже, група гниє швидше.")),
      A("Sagacious", true, W.caster, E.spellLvl, T("Higher levels for every curse on the bar.", "Вищі рівні для кожного прокляття на панелі.")),
      A("Hardy", true, W.ringOff, E.atr("Constitution", "Статури"), T("Constitution skills scale with it.", "Навички Статури множаться ним.")),
      A("Charismatic", true, W.ringOff, E.atr("Charisma", "Харизми"), T("The curses scale with Charisma.", "Прокляття залежать від Харизми.")),
      A("of the Leech", true, W.weaponRing, E.leech, T("Attrition wins when you heal while they rot.", "Виснаження перемагає, коли ви лікуєтесь, поки вони гниють.")),
      A("of Regeneration", false, W.bodyRegen, E.lifeRegen, T("The slow fight needs a slow heal.", "Повільному бою потрібне повільне лікування.")),
      A("of the Phoenix", false, W.chestHelm, E.phoenix, T("A heal when something reaches you.", "Лікування, коли щось до вас дістається.")),
      A("of the Bulwark", false, W.armour, E.resPhys, T("The enemy is weakened but not gone.", "Ворог ослаблений, але не зник.")),
      A("of the Martyr", false, W.chestRings, E.lifeCost, T("Cheaper curses.", "Дешевші прокляття.")),
    ],
    avoid: T("Burst affixes (crit, Vengeance) are for builds that kill fast; this one kills slowly.", "Афікси вибухової шкоди (крит, «Помста») — для швидких вбивць, а цей білд вбиває повільно."),
  },

  archer_main: {
    items: [
      A("of the Hawk", true, W.bow, E.atkSpeed, T("The auto-attack fan is the build: attack speed multiplies it.", "Віяло автоатаки — це і є білд: швидкість атаки його множить.")),
      A("of the Volley", true, W.bow, E.projs, T("Extra projectiles multiply every arrow hit and the fan.", "Додаткові снаряди множать кожне влучання й віяло.")),
      A("Brutal", true, W.bow, E.phys, T("Arrows are physical hits.", "Стріли — це фізична шкода.")),
      A("Nimble", true, W.ringOff, E.atr("Dexterity", "Спритності"), T("Archer skills are Dexterity skills.", "Навички Лучника — це навички Спритності.")),
      A("Piercing", false, W.bow, E.pierce, T("Arrows pass through a pack.", "Стріли проходять крізь групу.")),
      A("of the Gale", false, W.bow, E.projSpeed, T("Faster arrows hit moving targets.", "Швидші стріли влучають у рухомі цілі.")),
      A("of Precision", false, W.anyWeapon, E.critCh, T("A bow already has crit built in.", "У лука крит уже вбудований.")),
      A("of Endurance", false, W.stamGear, E.stamRegen, T("Skills cost stamina.", "Навички коштують витривалості.")),
      A("of the Marathon", false, W.glovesBoots, E.stamCost, T("Cheaper shots, more of them.", "Дешевші постріли — їх більше.")),
    ],
    avoid: T("Cast speed, spell levels and area belong to staves; they do not roll on a bow.", "Швидкість чаклування, рівні заклять і площа — для посохів, на луці вони не випадають."),
  },
  archer_sniper: {
    items: [
      A("Vicious", true, W.anyWeapon, E.critDmg, T("{arc_aimed_shot} and {arc_heartseeker} are single big hits: critical damage is the multiplier.", "«{arc_aimed_shot}» і «{arc_heartseeker}» — великі поодинокі удари: критична шкода є множником.")),
      A("of Precision", true, W.anyWeapon, E.critCh, T("Chance to land them.", "Шанс їх влучити.")),
      A("of the Assassin", true, W.helmGlovesRings, E.critGlobal, T("Crit from the armour slots so the bow carries damage.", "Крит зі слотів броні, щоб лук ніс шкоду.")),
      A("Brutal", true, W.bow, E.phys, T("Raises every shot.", "Підсилює кожен постріл.")),
      A("Piercing", true, W.bow, E.pierce, T("Piercing shots are part of the plan.", "Пробивні постріли — частина плану.")),
      A("of the Gale", false, W.bow, E.projSpeed, T("Fast arrows at long range.", "Швидкі стріли на великій відстані.")),
      A("Nimble", false, W.ringOff, E.atr("Dexterity", "Спритності"), T("All of the skills are Dexterity skills.", "Усі навички — це навички Спритності.")),
      A("of the Volley", false, W.bow, E.projs, T("An extra arrow on every shot, an extra chance to crit.", "Зайва стріла в кожному пострілі — зайвий шанс на крит.")),
      A("of the Hawk", false, W.bow, E.atkSpeed, T("The rate of fire matters less than the hit, but helps.", "Швидкострільність менш важлива, ніж удар, але допомагає.")),
    ],
    avoid: T("Stamina and speed are second to crit: spend your slots on the big hit.", "Витривалість і швидкість поступаються криту: віддайте слоти великому удару."),
  },
  archer_venom: {
    items: [
      A("of Focus", true, W.ringOff, E.cooldown, T("A trap rotation lives on cooldowns.", "Ротація пасток живе на перезарядках.")),
      A("of the Marathon", true, W.glovesBoots, E.stamCost, T("Traps and arrows cost stamina; cheaper ones mean a faster rotation.", "Пастки й стріли коштують витривалості; дешевші — швидша ротація.")),
      A("of Endurance", true, W.stamGear, E.stamRegen, T("The other half of the stamina plan.", "Друга половина плану витривалості.")),
      A("Nimble", true, W.ringOff, E.atr("Dexterity", "Спритності"), T("Traps and poison arrows are Dexterity skills.", "Пастки й отруйні стріли — навички Спритності.")),
      A("of the Frost Touch", false, W.anyWeapon, E.chill, T("More slows to go with the ones your traps make.", "Більше сповільнень до тих, що роблять пастки.")),
      A("of the Volley", false, W.bow, E.projs, T("{arc_scattershot} gets more pellets.", "«{arc_scattershot}» отримує більше куль.")),
      A("of the Hawk", false, W.bow, E.atkSpeed, T("Faster poison arrows, faster stacks.", "Швидші отруйні стріли — швидші стаки.")),
      A("of Evasion", false, W.evade, E.dodge, T("When something reaches you, dodge it.", "Коли щось до вас дістається — ухиліться.")),
      A("of Regeneration", false, W.bodyRegen, E.lifeRegen, T("A safe fight is a slow one: heal as you wait.", "Безпечний бій повільний: лікуйтесь, поки чекаєте.")),
    ],
    avoid: T("A crossbow hits harder per shot, which suits a slow trap rotation better than a fast bow.", "Арбалет б'є сильніше за постріл, що краще пасує повільній ротації пасток, ніж швидкий лук."),
  },

  druid_main: {
    items: [
      A("of the Beast", true, W.beastGear, E.beast, T("Every form bonus scales with form power: this is the build's multiplier.", "Усі бонуси форм залежать від сили форми: це множник білду.")),
      A("Charismatic", true, W.ringOff, E.atr("Charisma", "Харизми"), T("Druid skills are Charisma skills.", "Навички Друїда — це навички Харизми.")),
      A("Stalwart", true, W.armour, E.life, T("The Bear needs a big pool.", "Ведмедю потрібен великий запас.")),
      A("of Regeneration", true, W.bodyRegen, E.lifeRegen, T("A form with a heal between fights.", "Форма з лікуванням між боями.")),
      A("of Celerity", false, W.melee, E.atkSpeed, T("Form attacks use the weapon in hand: bring a mace or dagger.", "Атаки форм використовують зброю в руці: візьміть булаву чи кинджал.")),
      A("of Precision", false, W.anyWeapon, E.critCh, T("Wolf and Hawk have crit bonuses.", "Вовк і Яструб мають бонуси до крита.")),
      A("of Thorns", false, W.chestOff, E.thorns, T("Pairs with the {dru_thorns_aura} in {dru_bear_form}.", "Пасує до «{dru_thorns_aura}» у формі «{dru_bear_form}».")),
      A("of the Turtle", false, W.chestOff, E.ward, T("A defensive window in Bear form.", "Захисне вікно у формі Ведмедя.")),
      A("of Evasion", false, W.evade, E.dodge, T("Hawk kites; dodge keeps you alive.", "Яструб кружляє; ухилення зберігає життя.")),
    ],
    avoid: T("Scepter affixes (Savant, Sagacious) only help in human form: a shapeshifter rarely uses it.", "Афікси скіпетра («Знавець», «Премудрий») допомагають лише в людській формі, а перевертень нею майже не користується."),
  },
  druid_wolf: {
    items: [
      A("of the Beast", true, W.beastGear, E.beast, T("The wolf bonuses scale with form power.", "Бонуси вовка залежать від сили форми.")),
      A("of Celerity", true, W.melee, E.atkSpeed, T("The Wolf's bonus is attack speed: stack more of it. Use a mace or dagger.", "Бонус Вовка — швидкість атаки: накопичуйте її. Беріть булаву чи кинджал.")),
      A("of Precision", true, W.anyWeapon, E.critCh, T("Wolf Form has a crit bonus to build on.", "Форма Вовка має бонус до крита, на якому можна будувати.")),
      A("Vicious", true, W.anyWeapon, E.critDmg, T("Makes those crits count.", "Робить ці криті вагомими.")),
      A("Brutal", true, W.melee, E.phys, T("Wolf attacks are physical hits.", "Атаки Вовка — фізична шкода.")),
      A("Charismatic", false, W.ringOff, E.atr("Charisma", "Харизми"), T("All Druid skills are Charisma skills.", "Усі навички Друїда — це навички Харизми.")),
      A("of the Assassin", false, W.helmGlovesRings, E.critGlobal, T("Crit from the armour slots.", "Крит зі слотів броні.")),
      A("of the Leech", false, W.weaponRing, E.leech, T("Sustain in melee.", "Відновлення в ближньому бою.")),
      A("of Vengeance", false, W.weaponRing, E.fury, T("A kill opens a damage window for the next target.", "Вбивство відкриває вікно шкоди для наступної цілі.")),
    ],
    avoid: T("A scepter is for casting; the wolf bites with the weapon in hand, so take a melee one.", "Скіпетр — для чаклунства, а вовк кусає зброєю в руці, тож беріть зброю ближнього бою."),
  },
  druid_moon: {
    items: [
      A("Sagacious", true, W.caster, E.spellLvl, T("{dru_wrath}, {dru_moonfire} and {dru_starfall} all rise together.", "«{dru_wrath}», «{dru_moonfire}» і «{dru_starfall}» підсилюються разом.")),
      A("of the Savant", true, W.caster, E.castSpeed, T("A caster in human form: faster casts, more damage.", "Чаклун у людській формі: швидші касти — більша шкода.")),
      A("Sweeping", true, W.caster, E.area, T("{dru_starfall} and {dru_storm_lightning} cover a bigger ground.", "«{dru_starfall}» і «{dru_storm_lightning}» покривають більше землі.")),
      A("Charismatic", true, W.ringOff, E.atr("Charisma", "Харизми"), T("The nature spells are Charisma skills.", "Закляття природи — це навички Харизми.")),
      A("of Economy", true, W.manaGear, E.manaCost, T("The build runs on mana.", "Білд живиться маною.")),
      A("of Recovery", false, W.manaGear, E.manaRegen, T("Refills the pool between spells.", "Наповнює запас між заклинаннями.")),
      A("of Focus", false, W.ringOff, E.cooldown, T("{dru_starfall}, {dru_solar_beam} and {dru_natures_swiftness} are on cooldowns.", "«{dru_starfall}», «{dru_solar_beam}» і «{dru_natures_swiftness}» — на перезарядках.")),
      A("Empowered", false, W.ringOff, E.fullMana, T("Open every fight with a full pool.", "Починайте кожен бій з повним запасом.")),
      A("of the Harvest", false, W.manaGear, E.manaKill, T("Kills refill mana.", "Вбивства наповнюють ману.")),
    ],
    avoid: T("Melee affixes (Celerity, Brutal) do not roll on a scepter.", "Афікси ближнього бою («Прудкість», «Брутальний») на скіпетрі не випадають."),
  },
};

const SKILL_NAMES = new Map(SKILLS.map((s) => [s.id, s]));
// {skill_id} -> the skill's name in the language shown, so a name here can never differ from the one the game uses.
const fillSkills = (text, uk) => String(text).replace(/\{([a-z0-9_]+)\}/g, (m, id) => {
  const s = SKILL_NAMES.get(id);
  return s ? (uk ? s.nameUk : s.nameEn) : m;
});
const PICK = (v, uk) => (v && typeof v === "object" ? fillSkills(uk ? v.uk : v.en, uk) : v);

// The advice for a guide object (main or variant), in the interface language: { core, good, avoid } or null.
export function getGuideAffixes(guide) {
  if (!guide) return null;
  const id = guide.id || `${String(guide.className || "").toLowerCase()}_main`;
  const b = BUILD_AFFIXES[id];
  if (!b) return null;
  const uk = getLang() === "uk";
  const line = (e) => ({ label: e.label, core: e.core, where: PICK(e.where, uk), effect: PICK(e.effect, uk), why: PICK(e.why, uk) });
  const items = b.items.map(line);
  return { core: items.filter((i) => i.core), good: items.filter((i) => !i.core), avoid: PICK(b.avoid, uk) };
}
