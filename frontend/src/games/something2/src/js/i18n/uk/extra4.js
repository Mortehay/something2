// Ukrainian entries for the "extra4" area. Key = the exact English string used in t(...).
//
// Two parts: (1) small client-side strings the first pass missed (page chrome, session
// toast, join-overlay phases, key labels) and (2) the entity "prompt" texts the inspect card
// shows as a creature / scenery description. Those come straight from the server catalog
// (backend/seeds/data/*.js + the seeding migrations), so the keys must equal the catalog
// text byte for byte. The 288 generated bestiary prompts and the minibosses are built by
// loops below from a size x flavour table instead of being typed out one by one.

// Same wrapper as backend/seeds/data/spritePrompt.js styleEntityPrompt(). A catalog row can
// hold the bare subject (old migrations) or the styled form (seeds + restyle script), so both
// spellings of every hand-written subject are registered.
const STYLE_TAIL = "single object, solid transparent background";
function styled(subject) {
  const base = String(subject || "").trim().replace(/,\s*$/, "");
  return `pixel art, ${base}, ${STYLE_TAIL}`;
}

// Hand-written subjects: English subject -> Ukrainian description.
const SUBJECTS = {
  // Legacy rows (old migrations) and their current seed spellings.
  "a tall broadleaf tree with a thick trunk": "Високе листяне дерево з товстим стовбуром.",
  "a mossy grey boulder": "Сірий замшілий валун.",
  "a jagged pale blue ice boulder": "Зазубрений блідо-блакитний крижаний валун.",
  "a human adventurer in leather armour": "Людина-шукач пригод у шкіряних обладунках.",
  "a grey forest wolf": "Сірий лісовий вовк.",
  "a grey meadow wolf": "Сірий лучний вовк.",
  "a translucent green slime blob": "Напівпрозора зелена слизова грудка.",
  "a translucent orange slime blob, baked by the desert sun": "Напівпрозора помаранчева слизова грудка, запечена пустельним сонцем.",
  "an undead skeleton warrior": "Скелет-воїн із нежиті.",
  "an undead skeleton warrior, risen from the catacombs": "Скелет-воїн, що повстав із катакомб.",
  "a small brown cave bat": "Маленький бурий печерний кажан.",
  "a small bat roosting in the fungal deep, crackling with static": "Маленький кажан, що спочиває в грибних глибинах і потріскує статичними розрядами.",

  // Scenery.
  "a round leafy green shrub": "Круглий листяний зелений кущ.",
  "a green shrub covered in red roses": "Зелений кущ, обсипаний червоними трояндами.",
  "a tall dark green pine tree with a straight trunk": "Висока темно-зелена сосна з прямим стовбуром.",
  "a bare dead tree with broken branches": "Голе мертве дерево з поламаними гілками.",

  // Village and world points.
  "a glowing swirling magical stone portal archway": "Сяюча кам’яна арка магічного порталу, що закручується вихором.",
  "an ancient carved waystone with glowing blue runes": "Прадавній різьблений путівний камінь із сяйними синіми рунами.",
  "a wooden market stall with a striped awning and goods on the counter": "Дерев’яний ринковий кіоск зі смугастим навісом і товаром на прилавку.",
  "a sturdy iron-bound strongbox on a stone pedestal": "Міцна скриня, окута залізом, на кам’яному постаменті.",
  "a jeweller's stall with a velvet tray of glowing gems": "Ювелірна лавка з оксамитовим підносом сяйних самоцвітів.",
  "a scholar's lectern stacked with open spellbooks and scrolls": "Кафедра вченого, завалена розкритими книгами заклять і сувоями.",
  "a burly village blacksmith in a leather apron beside an anvil and a glowing forge": "Кремезний сільський коваль у шкіряному фартусі біля ковадла та розжареного горна.",
  "an ornate gilded treasure chest with heavy iron bands": "Розкішна позолочена скриня зі скарбами та важкими залізними смугами.",
  "a small weathered wooden chest half sunk in grass": "Невелика обвітрена дерев’яна скриня, наполовину втоплена в траву.",

  // Quest givers.
  "a white-bearded village elder in grey robes leaning on a carved staff": "Сивобородий сільський старійшина в сірих шатах, що спирається на різьблений посох.",
  "a hooded swamp hunter in dark leathers with a longbow": "Болотяний мисливець у каптурі, у темній шкірі, з довгим луком.",
  "a stern armoured lord in a crimson cloak with a thorned circlet": "Суворий броньований лорд у багряному плащі з терновим вінцем.",
  "an old sun priest in gold and white robes holding a radiant staff": "Старий жрець Сонця в золотисто-білих шатах із сяйним посохом.",
  "a tall ethereal mage in flowing blue robes with floating runes": "Високий ефірний маг у синіх шатах, що розвіваються, з рунами, які ширяють у повітрі.",
  "a desert astronomer in sand-coloured robes holding a brass astrolabe": "Пустельний астроном у шатах піщаного кольору з мідною астролябією.",
  "an elven druid in leaf-green robes with an antlered wooden staff": "Ельфійський друїд у листозелених шатах із дерев’яним посохом із рогами.",
  "a weathered sea captain in a navy coat and tricorn hat": "Обвітрений морський капітан у темно-синьому мундирі й трикутному капелюсі.",

  // World bosses and their guards.
  "A titan forged from molten core and obsidian armor.": "Титан, викуваний із розплавленого ядра та обсидіанових лат.",
  "An ancient dread beast encased in eternal permafrost.": "Прадавній жахливий звір, скований вічною мерзлотою.",
  "A harbinger of the astral void who tears reality asunder.": "Провісник астральної порожнечі, що роздирає реальність.",
  "An electrified colossus crackling with tempest storms.": "Електризований колос, що потріскує грозовими бурями.",
  "A hulking guardian of living flame summoned to defend a world boss.": "Здоровенний страж із живого полум’я, прикликаний захищати світового боса.",
  "A hulking guardian of jagged ice summoned to defend a world boss.": "Здоровенний страж із зазубреного льоду, прикликаний захищати світового боса.",
  "A hulking guardian of swirling arcane force summoned to defend a world boss.": "Здоровенний страж із вихру чародійної сили, прикликаний захищати світового боса.",
  "A hulking guardian of crackling lightning summoned to defend a world boss.": "Здоровенний страж із тріскучої блискавки, прикликаний захищати світового боса.",

  // Dungeon bosses.
  "A crowned skeletal monarch on a throne of fused bones, ruling the deepest crypt of the Catacombs.": "Увінчаний короною скелет-монарх на троні зі зрощених кісток, що владарює в найглибшому склепі Катакомб.",
  "A towering armoured skeleton keeper wrapped in burial chains, guarding the ossuary.": "Велетенський броньований скелет-вартовий, обмотаний похоронними ланцюгами, що охороняє костурню.",
  "A vast molten hive queen with a glowing ember abdomen and wings of smouldering ash.": "Величезна розплавлена королева рою з розжареним черевцем і крилами з тліючого попелу.",
  "A scorched brood mother insect trailing cinders, tending the burning hive cells.": "Обпалена комаха-матка, що розсипає жар і доглядає палаючі соти.",
  "A colossal void sentinel of living shadow, its body a doorway into starless dark.": "Велетенський вартовий Порожнечі з живої тіні, чиє тіло — вхід у беззоряну темряву.",
  "A hooded wraith herald with a tattered banner of shadow, announcing the Gatekeeper.": "Привид-вісник у каптурі з пошарпаним стягом із тіні, що сповіщає про Воротаря.",
};

// Generated bestiary: "a {size} [{element}-touched] {flavour} creature" -> feminine adjectives.
// [English size, article, Ukrainian]
const SIZES = [
  ["tiny", "a", "крихітна"], ["small", "a", "маленька"], ["lean", "a", "жилава"],
  ["armed", "an", "озброєна"], ["skilled", "a", "вправна"], ["hulking", "a", "здоровенна"],
  ["armoured", "an", "броньована"], ["commanding", "a", "владна"], ["towering", "a", "велетенська"],
];
const ELEMENT_UK = { fire: "вогняна", ice: "крижана", lightning: "блискавична", physical: "" };
// [flavour, element ("" = none, no "-touched" in the prompt), feminine, masculine]
const FLAVOURS = [
  ["beast", "", "звіряча", "звіриний"], ["woodland", "", "лісова", "лісовий"],
  ["desert", "fire", "пустельна", "пустельний"], ["tundra", "ice", "тундрова", "тундровий"],
  ["swamp", "physical", "болотяна", "болотяний"], ["highland", "physical", "нагірна", "нагірний"],
  ["jungle", "lightning", "джунглева", "джунглевий"], ["storm", "lightning", "штормова", "штормовий"],
  ["ruin", "ice", "руїнна", "руїнний"], ["volcanic", "fire", "вулканічна", "вулканічний"],
  ["undead", "ice", "мертва", "мертвий"], ["bonelord", "ice", "кістяна", "кістяний"],
  ["cave", "physical", "печерна", "печерний"], ["fungal", "lightning", "грибна", "грибний"],
  ["ember", "fire", "розжарена", "розжарений"], ["rime", "ice", "паморозна", "паморозний"],
  ["construct", "physical", "рукотворна", "рукотворний"], ["hive", "physical", "роєва", "роєвий"],
  ["drowned", "ice", "потоплена", "потоплений"], ["umbral", "physical", "тіньова", "тіньовий"],
  ["crystal", "lightning", "кришталева", "кришталевий"], ["blight", "physical", "осквернена", "осквернений"],
  ["gloom", "ice", "похмура", "похмурий"], ["stoneborn", "fire", "кам’яна", "кам’яний"],
  ["void", "physical", "пустотна", "пустотний"], ["demonic", "fire", "демонічна", "демонічний"],
  ["chaos", "lightning", "хаотична", "хаотичний"], ["fallen", "ice", "занепала", "занепалий"],
  ["nightmare", "physical", "кошмарна", "кошмарний"], ["titan", "physical", "титанічна", "титанічний"],
  ["plague", "fire", "чумна", "чумний"], ["eldritch", "physical", "потойбічна", "потойбічний"],
];

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const generated = {};
for (const [flavour, element, fem] of FLAVOURS) {
  for (const [size, article, sizeUk] of SIZES) {
    const phrase = element ? `${element}-touched ${flavour}` : flavour;
    const en = styled(`${article} ${size} ${phrase} creature`);
    const adj = [sizeUk, element ? ELEMENT_UK[element] : "", fem].filter(Boolean).join(" ");
    generated[en] = `${cap(adj)} істота.`;
  }
}
for (const [flavour, , , masc] of FLAVOURS) {
  generated[`pixel art boss creature, a powerful ${flavour}-themed miniboss, ${STYLE_TAIL}`] = `Могутній ${masc} міні-бос.`;
  generated[`pixel art boss creature, a fearsome elite ${flavour}-themed miniboss, ${STYLE_TAIL}`] = `Грізний елітний ${masc} міні-бос.`;
}

const prompts = {};
for (const [en, uk] of Object.entries(SUBJECTS)) {
  prompts[en] = uk;
  prompts[styled(en)] = uk;
}

export default {
  // --- Join overlay phases (Game.initChunked onProgress) ---
  "Connecting to the world…": "З’єднуємося зі світом…",
  "Loading the map…": "Завантажуємо мапу…",
  "Loading images…": "Завантажуємо зображення…",

  // --- Session / auth / navigation chrome ---
  "Session expired — please sign in again": "Сеанс завершився — увійдіть знову",
  "Something went wrong": "Щось пішло не так",
  "Account": "Обліковий запис",
  "authentication failed": "Не вдалося увійти",
  "no token returned": "Сервер не повернув токен",
  "Failed to fetch": "Не вдалося з’єднатися з сервером",
  "Load failed": "Не вдалося з’єднатися з сервером",
  "Failed to fetch worlds": "Не вдалося отримати світи",
  "Failed to load worlds: {message}": "Не вдалося завантажити світи: {message}",

  // --- Key labels in Settings ---
  "Mouse 4": "Миша 4",
  "Mouse 5": "Миша 5",
  "Mouse {n}": "Миша {n}",

  // --- Inspect card: creature / scenery descriptions (catalog "prompt" text) ---
  ...prompts,
  ...generated,
};
