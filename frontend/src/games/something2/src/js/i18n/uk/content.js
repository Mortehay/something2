// Ukrainian entries for the "content" area. Key = the exact English string used in t(...).
//
// World content that the server sends by name: creatures, NPCs, items, affixes, bosses,
// auras, achievements, places, biomes and passive-tree node labels. The big generated
// families (288 bestiary creatures, 240 ladder items, minibosses, dungeon rooms, spire
// floors, "(STR)"-suffixed passive labels) are built from short word tables below so one
// word is translated once and every name stays consistent. Names that the client shows
// through displayName() ("pine_tree" -> "Pine tree") are registered under both spellings.
const E = {};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// Mirrors systems/inspect.js displayName(): underscores -> spaces, first letter upper-cased.
const shown = (s) => cap(String(s).trim().replace(/_+/g, " "));
// Register a raw catalog key plus the way the client may display it.
function addRaw(raw, uk) {
  E[raw] = uk;
  const d = shown(raw);
  if (d !== raw) E[d] = uk;
}

// ---------------------------------------------------------------- bestiary (288)
const BESTIARY_RUNGS = {
  Swarm: "Рій", Skirmisher: "Розвідник", Line: "Боєць", Ranged: "Стрілець", Caster: "Заклинач",
  Brute: "Громило", Heavy: "Важковик", Champion: "Чемпіон", Apex: "Володар",
};
const BESTIARY_LINES = {
  Beast: "Звіриний", Woodland: "Лісовий", Desert: "Пустельний", Tundra: "Тундровий", Swamp: "Болотяний",
  Highland: "Високогірний", Jungle: "Джунглевий", Storm: "Штормовий", Ruin: "Руїнний", Volcanic: "Вулканічний",
  Undead: "Неживий", Bonelord: "Кістяний", Cave: "Печерний", Fungal: "Грибний", Ember: "Вугільний",
  Rime: "Інеїстий", Construct: "Механічний", Hive: "Вуликовий", Drowned: "Потопельний", Umbral: "Тіньовий",
  Crystal: "Кришталевий", Blight: "Згубний", Gloom: "Похмурий", Stoneborn: "Кам'яний", Void: "Безоднений",
  Demonic: "Демонічний", Chaos: "Хаотичний", Fallen: "Занепалий", Nightmare: "Кошмарний", Titan: "Титанічний",
  Plague: "Чумний", Eldritch: "Потойбічний",
};
for (const [lk, lv] of Object.entries(BESTIARY_LINES)) {
  for (const [rk, rv] of Object.entries(BESTIARY_RUNGS)) E[`${lk} ${rk}`] = `${lv} ${rv.toLowerCase()}`;
  E[`${lk} Miniboss`] = `${lv} міні-бос`;
  E[`${lk} Elite Miniboss`] = `${lv} елітний міні-бос`;
}
// Creature-ability / behaviour labels (the bare rung names, plus the extra moves).
Object.assign(E, BESTIARY_RUNGS, {
  Slam: "Грюк", Guard: "Страж", Sentry: "Вартовий-стрілець", Lurker: "Причаєний", Nip: "Укус",
  Skittish: "Полохливий",
});

// ---------------------------------------------------------------- creatures, NPCs, objects
Object.assign(E, {
  Wolf: "Вовк", Slime: "Слиз", Skeleton: "Скелет", Bat: "Кажан", Player: "Гравець",
  Warrior: "Воїн", Ranger: "Рейнджер", Mage: "Маг", Monk: "Монах", Cultist: "Культист", Archer: "Лучник", Druid: "Друїд",
  "Village Guard": "Сільський вартовий", "Village Blacksmith": "Сільський коваль",
  "Fire Elemental Guard": "Вогняний страж-елементаль",
  "Ice Elemental Guard": "Крижаний страж-елементаль",
  "Arcane Elemental Guard": "Чародійський страж-елементаль",
  "Lightning Elemental Guard": "Блискавичний страж-елементаль",
  // world bosses
  "Ignis, the Magma Colossus": "Ігніс, Магмовий Колос",
  "Glacius, the Frost Leviathan": "Глаціус, Крижаний Левіафан",
  "Abyssor, the Voidreaver": "Абіссор, Пожирач Безодні",
  "Gorgon, the Thunder Titan": "Горгон, Громовий Титан",
  // dungeon bosses
  "The Bone Regent": "Кістяний Регент", "Ossuary Warden": "Вартовий Костниці",
  "The Ember Queen": "Жарова Королева", "Cinder Matriarch": "Матріарх Попелу",
  "The Umbral Gatekeeper": "Тіньовий Воротар", "Shade Herald": "Вісник Тіні",
  // quest givers
  "Elder Eldrin": "Старійшина Елдрін", "Shadow Hunter": "Тіньовий мисливець", "Lord Thorn": "Лорд Торн",
  "Elder Sunspire": "Старійшина Сонячного Шпиля", "Archon Aether": "Архонт Ефір", "Astronomer Zahir": "Астроном Захір",
  "Arch-Druid Elyona": "Архідруїд Еліона", "Captain Valdor": "Капітан Вальдор",
});
// auras (snake_case ids as the server sends them)
for (const [raw, uk] of Object.entries({
  pack_leader: "Ватажок зграї", ossuary_dread: "Жах костниці", cinder_brood: "Попелястий виводок",
  shade_veil: "Тіньова запона", ignis_inferno: "Пекло Ігніса", glacius_permafrost: "Вічна мерзлота Глаціуса",
  abyssor_void_rend: "Розрив порожнечі Абіссора", gorgon_static_field: "Статичне поле Горгона",
})) addRaw(raw, uk);
// terrain objects, decorations and world points
Object.assign(E, { Tree: "Дерево", Stone: "Камінь", IceRock: "Крижана скеля" });
for (const [raw, uk] of Object.entries({
  bush: "Кущ", rose_bush: "Трояндовий кущ", pine_tree: "Сосна", dead_tree: "Мертве дерево",
  portal: "Портал", waypoint_stone: "Шляховий камінь", merchant_post: "Торговий намет", bank_post: "Банківська скриня",
  gem_merchant_post: "Лавка самоцвітів", skill_merchant_post: "Кафедра навичок",
  chest_vault: "Скарбниця", chest_field: "Польова скриня",
})) addRaw(raw, uk);

// ---------------------------------------------------------------- items
// Gear ladder: "<tier>-<family>" (e.g. "crude-blade"). Adjectives agree in gender with the noun.
const TIER_STEM = {
  crude: "груб", iron: "залізн", steel: "сталев", tempered: "гартован", runed: "рунн",
  obsidian: "обсидіанов", astral: "астральн", void: "безоднен", dragon: "драконяч", mythic: "міфічн",
};
// [noun, gender]  m / f / p (plural)
const FAMILY = {
  blade: ["клинок", "m"], sword: ["меч", "m"], axe: ["сокира", "f"], mace: ["булава", "f"], spear: ["спис", "m"],
  dagger: ["кинджал", "m"], quarterstaff: ["бойовий посох", "m"], bow: ["лук", "m"], crossbow: ["арбалет", "m"],
  wand: ["паличка", "f"], staff: ["жезл", "m"], scepter: ["скіпетр", "m"], buckler: ["баклер", "m"],
  focus: ["фокус", "m"], helm: ["шолом", "m"], hood: ["каптур", "m"], plate: ["нагрудник", "m"],
  robe: ["мантія", "f"], gauntlets: ["рукавиці", "p"], gloves: ["рукавички", "p"], greaves: ["наголінники", "p"],
  boots: ["чоботи", "p"], band: ["перстень", "m"], signet: ["печатка", "f"],
};
const ENDING = { m: "ий", f: "а", p: "і" };
for (const [tier, stem] of Object.entries(TIER_STEM)) {
  for (const [fam, [noun, g]] of Object.entries(FAMILY)) {
    const raw = `${tier}-${fam}`;
    addRaw(raw, cap(`${stem}${ENDING[g]} ${noun}`));
  }
}
// Everything else in the item catalog.
for (const [raw, uk] of Object.entries({
  "leather-vest": "Шкіряна жилетка", "arcane-ward": "Чародійний оберіг",
  knife: "Ніж", stick: "Палиця", club: "Дубина", "short sword": "Короткий меч", "mid club": "Важка дубина",
  "long sword": "Довгий меч", "morning star": "Моргенштерн", "two-handed sword": "Дворучний меч",
  scythe: "Коса", pike: "Піка", darts: "Дротики", sling: "Праща", arbalest: "Великий арбалет",
  halberd: "Алебарда", unarmed: "Голі руки", "magic-bolt": "Магічна стріла",
  "apprentice staff": "Посох учня", "frost staff": "Крижаний посох", "flame staff": "Вогняний посох",
  "storm staff": "Штормовий посох", "archmage staff": "Посох архімага",
  arrow: "Стріла", bolt: "Болт",
  gold: "Золото", loot_map: "Мапа здобичі",
  enchant_scroll: "Сувій зачарування", enchant_scroll_basic: "Простий сувій зачарування",
  enchant_scroll_blessed: "Благословенний сувій зачарування",
  "stone_of_apprentice staff": "Камінь посоху учня", "stone_of_frost staff": "Камінь крижаного посоху",
  "stone_of_flame staff": "Камінь вогняного посоху", "stone_of_storm staff": "Камінь штормового посоху",
  "stone_of_archmage staff": "Камінь посоху архімага", "stone_of_magic-bolt": "Камінь магічної стріли",
  stone_of_frost_edge: "Камінь крижаного леза", stone_of_ember_edge: "Камінь жарового леза",
  "power-tinders": "Силові постоли", "warbound-circlet": "Обруч воєводи",
  "gilded-fists": "Позолочені кулаки", "stormlight-mantle": "Мантія штормового світла",
})) addRaw(raw, uk);
// Affix labels (rolled onto blue/yellow/foxy gear).
Object.assign(E, {
  "of Might": "Могутності", "of Grace": "Грації", "of Vigor": "Живучості", "of Insight": "Прозорливості",
  "of Clarity": "Ясності", "of Presence": "Величі", "of the Bear": "Ведмедя", "of the Well": "Джерела",
  Flaming: "Палаючий", Freezing: "Морозний", Warded: "Захищений", Cursed: "Проклятий",
});

// ---------------------------------------------------------------- biomes
Object.assign(E, {
  Meadow: "Луки", "Deep Forest": "Глибокий ліс", "Arid Dunes": "Посушливі дюни", "Frozen Waste": "Крижана пустка",
  Mire: "Трясовина", Highlands: "Нагір'я", "Verdant Jungle": "Зелені джунглі", "Storm Coast": "Штормове узбережжя",
  "Sunken Ruins": "Затоплені руїни", Ashfields: "Попелясті поля", Catacombs: "Катакомби", Ossuary: "Костниця",
  Cavern: "Печера", "Fungal Deep": "Грибні глибини", Emberdepths: "Вугільні глибини", Frostvault: "Морозний склеп",
  Deepvault: "Глибинне сховище", "Hive Warrens": "Вуликові лабіринти", "Sunken Cistern": "Затоплена цистерна",
  "Umbral Warren": "Тіньове лігво", "Crystal Hollows": "Кришталеві порожнини", Blightworks: "Згубні майстерні",
  Gloomfen: "Похмурі болота", "Sunken Foundry": "Затоплена ливарня", "Abyssal Rift": "Безодний розлом",
  "Infernal Gate": "Пекельна брама", "Shattered Vault": "Розколоте сховище", "Fallen Sanctum": "Занепале святилище",
  "Dreaming Dark": "Темрява снів", "Grave of Titans": "Могила титанів", "Pestilent Deep": "Чумні глибини",
  "The Maw": "Паща",
});

// ---------------------------------------------------------------- places
// Dungeon / descent worlds are named "<Dungeon>: <Room>".
const DUNGEONS = {
  "The Underdeep": "Підземна Глибінь", "The Umbral Gate": "Тіньова брама", "The Ossuary Depths": "Глибини Костниці",
  "The Frozen Vaults": "Крижані склепи", "The Emberhive": "Жаровулик", "The Crystal Foundry": "Кришталева ливарня",
  "The Catacombs": "Катакомби", "The Abyss": "Безодня",
  "The Sunscar Hollows": "Печери Сонячного Рубця", "The Rimevault": "Інеїсте сховище",
};
const ROOMS = {
  Shrine: "Святилище", Pass: "Прохід", Gorge: "Ущелина", Entry: "Вхід", End: "Кінець", Elite: "Елітна зала",
  Deep: "Глибина", Cache: "Схованка", Spur: "Відгалуження", Southwing: "Південне крило", Heart: "Серце",
  Farhall: "Дальня зала", Eastwing: "Східне крило", Deepvault: "Глибинне сховище", SubBranch: "Бічна гілка",
  SpokeN: "Північна галерея", SpokeE: "Східна галерея", SpokeS: "Південна галерея", SpokeW: "Західна галерея",
  Hub: "Центр",
  Threshold: "Поріг", "The Long Dark": "Довга Темрява", "Spore Den": "Лігво спор", Sinkgorge: "Провальна ущелина",
  "Mycelian Vault": "Грибницьке склепіння", "Dry Cache": "Суха схованка", Chokestone: "Задушливий камінь",
  "Buried Shrine": "Поховане святилище", "Still Wing": "Тихе крило", Shatterfloor: "Розбита підлога",
  "Sealed Core": "Запечатане ядро", Hold: "Твердиня", "Hoarfrost Gallery": "Галерея паморозі", Coldforge: "Холодна кузня",
};
for (const [dk, dv] of Object.entries(DUNGEONS)) {
  for (const [rk, rv] of Object.entries(ROOMS)) E[`${dk}: ${rk}`] = `${dv}: ${rv}`;
}
for (let n = 1; n <= 100; n += 1) E[`Spire of Trials: Floor ${n}`] = `Шпиль Випробувань: поверх ${n}`;
Object.assign(E, { "Spire of Trials": "Шпиль Випробувань" });
// "<Biome> Reach" / "<Biome> Frontier" overworld stretches.
for (const b of ["Highlands", "Verdant Jungle", "Storm Coast", "Sunken Ruins", "Ashfields"]) {
  E[`${b} Reach`] = `${E[b]} (окраїна)`;
  E[`${b} Frontier`] = `${E[b]} (рубіж)`;
}
// The Vale region (vale-region.map.json): worlds, villages and waypoints.
Object.assign(E, {
  "Vale Crossing": "Перехрестя Долини", "Thornbriar Reach": "Терновий Прикрай", "Thornbriar Green": "Терновий Луг",
  "Windwatch Pass": "Перевал Вітрового Дозору", "Windwatch Waystone": "Шляховий камінь Вітрового Дозору",
  "Sunscar Flats": "Рівнини Сонячного Рубця", "Rimehollow": "Інейова Западина",
  "The Deep Cut": "Глибокий Розріз", "Sunken Eastwing": "Затоплене східне крило", "Shrikewind Gorge": "Ущелина Сорокопудового Вітру",
  "Sealed Mausoleum": "Запечатаний мавзолей", "Old Trailhead": "Стара Стежка", "Old Trailhead Commons": "Громада Старої Стежки",
  "Hollow Cache": "Порожня Схованка", "Glacier's End": "Кінець Льодовика", "Glacier's End Sanctum": "Святилище Кінця Льодовика",
  "Frozen Ossuary Heart": "Серце Замерзлої Костниці", "Frostbound Shrine": "Святилище Мороза", "Farrow Hall": "Зала Фарроу",
  "Drowned Southwing": "Затоплене південне крило", "Deepvault Row": "Ряд Глибинного Сховища", "Catacomb Threshold": "Поріг катакомб",
  "Blackfen Sinks": "Провалля Чорнотопу", "Ashfang Den": "Лігво Попелоікла",
  "Vale Crossing Waypoint": "Шляхова точка: Перехрестя Долини",
  "Sunscar Outpost Waypoint": "Шляхова точка: застава Сонячного Рубця",
  "Rimehollow Haven Waypoint": "Шляхова точка: пристанище Інейової Западини",
  "Hollow Cache Waypoint": "Шляхова точка: Порожня Схованка",
  "Frostbound Shrine Waypoint": "Шляхова точка: Святилище Мороза",
  "Deep Cut Waypoint": "Шляхова точка: Глибокий Розріз",
  "Blackfen Refuge Waypoint": "Шляхова точка: сховок Чорнотопу",
  Waypoint: "Шляхова точка",
});

// ---------------------------------------------------------------- passive tree node labels
Object.assign(E, {
  // core ring
  Constitution: "Статура", Attunement: "Налаштування", Stamina: "Витривалість", Toughness: "Загартованість",
  // start nodes reuse the class names (Monk, Mage, Archer, Warrior, Cultist, Druid)
  // minors
  Sinew: "Жили", Focus: "Зосередження", Vigour: "Жвавість", Insight: "Прозріння", Wind: "Подих",
  Versatility: "Універсальність", Breadth: "Широта", "Cross-Training": "Перехресне тренування", Dabbler: "Дилетант",
  Hardy: "Витривалий", Reserve: "Запас", Callus: "Мозоль", Edge: "Лезо", Temper: "Гарт", "Second Wind": "Друге дихання",
  Discipline: "Дисципліна", Polymath: "Всебічність", Mending: "Загоєння", Bloodflow: "Струм крові",
  Regrowth: "Відновлення", "Enduring Flesh": "Невмируща плоть", "Battle Breath": "Бойовий подих",
  "Arcane Recovery": "Чародійне відновлення", "Meditation Spark": "Іскра медитації", "Inner Harmony": "Внутрішня гармонія",
  Serenity: "Безтурботність", "Quick Recovery": "Швидке відновлення", "Nimble Flow": "Моторний потік",
  "Wild Bloom": "Дике цвітіння", "Natural Vigour": "Природна сила", "Feral Edge": "Дика грань",
  // notables
  "Great Sinew": "Могутні жили", Mastery: "Майстерність", Apotheosis: "Апофеоз", "Broad Study": "Широке навчання",
  "Second Discipline": "Друга дисципліна", Renaissance: "Ренесанс", "Deep Reserve": "Глибокий запас",
  "Thick Skin": "Груба шкіра", Endurance: "Витримка", Brutality: "Жорстокість", "Sanguine Spring": "Кривавий потік",
  "Iron Recovery": "Залізне відновлення", Unflagging: "Невтомність", "Font of Power": "Джерело сили",
  "Tranquil Flow": "Тихий потік", "Fleeting Rest": "Швидкоплинний спокій", "Primal Instinct": "Первісний інстинкт",
  "Thorn Hide": "Шкіра з шипів", Rejuvenation: "Омолодження", Kindling: "Розпал", Frostbite: "Обмороження",
  Charge: "Заряд", Resonance: "Резонанс", Plating: "Обладунок", Fireproof: "Вогнетривкість", "Warm Blood": "Тепла кров",
  Grounding: "Заземлення", "Null Field": "Нульове поле", "Ox Blood": "Бичача кров", Wellspring: "Витік",
  Honed: "Заточений", Quickening: "Прискорення", Ward: "Захист", "Searing Blows": "Пекучі удари",
  "Numbing Blows": "Заморожувальні удари", "Jarring Blows": "Струсні удари",
  "Martial Focus": "Бойове зосередження", "Marksman's Focus": "Зосередження стрільця", "Sanguine Focus": "Кривава зосередженість",
  "Arcane Focus": "Чародійне зосередження", "Inner Focus": "Внутрішнє зосередження", "Wild Focus": "Дике зосередження",
  "Keen Eye": "Гострий зір", "Deadly Aim": "Смертельний приціл", "Hunter's Reflexes": "Рефлекси мисливця",
  "Light Step": "Легка хода", "Heavy Hand": "Важка рука", "Concussive Force": "Сила струсу", "Spiked Hide": "Шипаста шкіра",
  "Berserker's Fury": "Лють берсерка", "Efficient Casting": "Економне чаклунство", "Wide Casting": "Широке чаклунство",
  "Ki Flow": "Потік ці", "Economy of Motion": "Економія руху", "Overflowing Spirit": "Переповнений дух",
  "Open Wounds": "Відкриті рани", "Blood Hunger": "Жага крові", "Gallows Humour": "Гумор шибениці", "Quick Hands": "Спритні руки",
  // greaters
  Ascendance: "Піднесення", Paragon: "Взірець", "Wanderer's Gift": "Дар мандрівника", Apostasy: "Відступництво",
  "Martial Mastery": "Бойова майстерність", "Marksman's Mastery": "Майстерність стрільця", "Sanguine Mastery": "Кривава майстерність",
  "Arcane Mastery": "Чародійна майстерність", "Inner Mastery": "Внутрішня майстерність", "Wild Mastery": "Дика майстерність",
  // cluster hubs
  "Cleaving Reach": "Довгий розсік", Spearpoint: "Вістря списа", Afterimage: "Залишкове видіння", Sweep: "Змах",
  Volley: "Залп", Swiftshot: "Швидкий постріл", Quickcast: "Швидке чаклунство", Spellpierce: "Пробиття чарів",
  "Sanguine Aura": "Кривава аура", Clarity: "Ясність", Concussion: "Струс", "Deadeye Focus": "Зосередження снайпера",
  "Wide Arcana": "Широка аркана", Overflow: "Переповнення", Bloodletting: "Кровопускання", "Wild Heart": "Дике серце",
  // cluster satellites
  "Long Guard": "Довга варта", "Extended Guard": "Подовжена варта", Momentum: "Імпульс", "Follow-Through": "Доведення удару",
  "Whirling Step": "Крутний крок", "Unending Swing": "Нескінченний змах", Lunge: "Випад", "Pike Drill": "Муштра піки",
  "Lingering Edge": "Тривале лезо", "Slow Burn": "Повільне горіння", "Wide Stance": "Широка стійка", "Scything Blow": "Косовий удар",
  "Split Arrow": "Розщеплена стріла", "Taut String": "Натягнута тятива", Fletching: "Оперення",
  "Brimming Cup": "Повна чаша", "Crimson Thirst": "Багряна спрага", "Dazed Foe": "Приголомшений ворог", "Deep Reservoir": "Глибокий резервуар",
  "Deepening Thirst": "Наростаюча спрага", "Draw Weight": "Сила натягу", "Even Breath": "Рівне дихання", "Feeding Frenzy": "Кривавий шал",
  "Feral Surge": "Дикий порив", "Frugal Hands": "Ощадні руки", "Killing Line": "Лінія вбивства", "Last Gasp": "Останній подих",
  "Loosed Wind": "Вільний вітер", "Open Palm": "Відкрита долоня", "Practised Cadence": "Відпрацьований ритм", "Quiet Mind": "Тихий розум",
  "Red Harvest": "Червоний урожай", "Rending Bolt": "Роздираючий болт", "Ringing Blow": "Дзвінкий удар", "Rolling Thunder": "Розкотистий грім",
  "Sharp Syllables": "Гострі склади", "Spreading Light": "Світло, що розтікається", "Spreading Stain": "Пляма, що розповзається",
  Stagger: "Хитання", "Steady Breath": "Рівномірне дихання", "Still Water": "Тиха вода", "Swift Incant": "Швидке закляття",
  "Thick Pelt": "Густе хутро", Thoughtform: "Мислеформа", "Unbound Frost": "Вільна холоднеча", "Unspent Force": "Невитрачена сила",
  "Vital Mark": "Життєва мітка", "Wide Communion": "Широка єдність",
});
// Passive labels in the Druid (charisma) sector name the stat they give: "Sinew (STR)".
const STAT_ABBR_UK = { STR: "СИЛ", DEX: "СПР", CON: "СТА", INT: "ІНТ", WIS: "МУД", CHA: "ХАР" };
for (const base of [
  "Sinew", "Focus", "Vigour", "Insight", "Wind", "Temper", "Discipline",
  "Great Sinew", "Mastery", "Apotheosis", "Ox Blood", "Wellspring", "Honed", "Ascendance", "Paragon",
]) {
  for (const [en, uk] of Object.entries(STAT_ABBR_UK)) E[`${base} (${en})`] = `${E[base]} (${uk})`;
}

// Keystones: the label carries the whole effect text, so each is translated as one string.
Object.assign(E, {
  "Inner Flame — +20 WIS": "Внутрішнє полум'я — +20 МУД",
  "Meditation — +70 max mana, +2.0 mana regen/s, +5% life share from mana regen": "Медитація — +70 макс. мани, +2.0 регенерації мани/с, +5% частки життя від регенерації мани",
  "Spirit Ward — +12% arcane resistance, +0.8 HP regen/s": "Захист духу — +12% чародійної стійкості, +0.8 регенерації ЗДР/с",
  "Ki Overflow — +30% skill damage while mana is nearly full, +2 max mana per WIS, skills cost 15% more mana": "Переповнення ці — +30% шкоди навичок, поки мана майже повна, +2 макс. мани за МУД, навички коштують на 15% більше мани",
  "Transcendence — +25 WIS and +18 INT": "Трансцендентність — +25 МУД і +18 ІНТ",
  "Pyromancy — +20% fire damage, and your hits burn": "Піромантія — +20% вогняної шкоди, ваші удари підпалюють",
  "Storm Caller — +20% lightning damage, and your hits shock": "Грозовик — +20% блискавичної шкоди, ваші удари вражають струмом",
  "Cryomancy — +20% ice damage, and your hits chill": "Кріомантія — +20% крижаної шкоди, ваші удари холодять",
  "Glass Cannon — every skill hits 35% harder and costs 25% more mana, -80 max life": "Скляна гармата — кожна навичка б'є на 35% сильніше й коштує на 25% більше мани, -80 макс. ЗДР",
  "Arcane Conduit — +15 INT, +35 max mana, +3.0 mana regen/s": "Чародійний провідник — +15 ІНТ, +35 макс. мани, +3.0 регенерації мани/с",
  "Deadeye — +20 DEX and +1 Extra Arrow": "Снайпер — +20 СПР і +1 додаткова стріла",
  "Windrunner — +15 DEX, +40 max stamina, +5 stamina regen/s": "Біжучий за вітром — +15 СПР, +40 макс. витривалості, +5 регенерації витривалості/с",
  "Deadly Precision — +12% crit chance and +35% crit damage, -50 max life": "Смертельна точність — +12% шансу криту й +35% шкоди криту, -50 макс. ЗДР",
  "Phantom Step — 15% chance to dodge a blow outright, +20 max stamina": "Крок-привид — 15% шансу цілком ухилитися від удару, +20 макс. витривалості",
  "Fleet — your cooldown floor drops from 0.40 to 0.35": "Прудкість — мінімум перезарядки падає з 0.40 до 0.35",
  "Executioner — +15% physical damage and +12 melee reach": "Кат — +15% фізичної шкоди й +12 до досяжності ближнього бою",
  "Iron Hide — +140 maximum life and +1.2 HP regen/s": "Залізна шкіра — +140 макс. ЗДР і +1.2 регенерації ЗДР/с",
  "Berserker — +30% skill damage while below 35% life, +8% stun chance, -60 max life": "Берсерк — +30% шкоди навичок, коли ЗДР нижче 35%, +8% шансу оглушення, -60 макс. ЗДР",
  "Reckless Swing — +25% physical damage, -10% ice resistance": "Безрозсудний змах — +25% фізичної шкоди, -10% крижаної стійкості",
  "Unbreakable — +20 STR and +100 maximum life": "Незламний — +20 СИЛ і +100 макс. ЗДР",
  "Pain Ward — +10% physical and +10% fire resistance, +1.2 HP regen/s": "Захист від болю — +10% фізичної та +10% вогняної стійкості, +1.2 регенерації ЗДР/с",
  "Crimson Bargain — every skill hits 40% harder, but costs 30% more life": "Багряна угода — кожна навичка б'є на 40% сильніше, але коштує на 30% більше ЗДР",
  "Vampiric Rite — skills heal 12% of the damage they deal, +2% max life per kill": "Вампірський обряд — навички лікують на 12% завданої шкоди, +2% макс. ЗДР за вбивство",
  "Sanguine Rite — life costs are reduced a further 12%": "Кривавий обряд — витрати ЗДР зменшено ще на 12%",
  "Blood Pact — life costs are reduced 15%": "Кривавий пакт — витрати ЗДР зменшено на 15%",
  "Bear Aspect — +20 STR, +120 HP, +1.5 HP regen/s, +5% physical resistance, forms 12% stronger": "Аспект ведмедя — +20 СИЛ, +120 ЗДР, +1.5 регенерації ЗДР/с, +5% фізичної стійкості, подоби на 12% сильніші",
  "Hawk Aspect — +20 DEX, +40 max stamina, +4 stamina regen/s, +8% attack speed, forms 12% stronger": "Аспект яструба — +20 СПР, +40 макс. витривалості, +4 регенерації витривалості/с, +8% швидкості атаки, подоби на 12% сильніші",
  "Wolf Aspect — +15 STR, +15 CHA, +12% physical damage, forms 12% stronger": "Аспект вовка — +15 СИЛ, +15 ХАР, +12% фізичної шкоди, подоби на 12% сильніші",
  "Primal Form Mastery — +30 CHA, +10 WIS, +1.5 HP regen/s, +3.0 stamina regen/s, forms 25% stronger": "Майстерність первісної подоби — +30 ХАР, +10 МУД, +1.5 регенерації ЗДР/с, +3.0 регенерації витривалості/с, подоби на 25% сильніші",
  "Menagerie — Aspect of the Wild (+25 CHA, +15 CON, +30 max mana, +2.0 mana regen/s, forms 15% stronger)": "Звіринець — Аспект дикої природи (+25 ХАР, +15 СТА, +30 макс. мани, +2.0 регенерації мани/с, подоби на 15% сильніші)",
});
// Hub label shared with the skill of the same name (keep in step with uk/data.js).
E.Whirlwind = "Вихор клинка";

export default E;
