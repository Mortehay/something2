// frontend/src/games/something2/src/js/core/skillsData.js
// ES module mirror of the 300 active/passive combat skills catalog across the 6 playable classes.

export const SKILLS = [
  // =========================================================================
  // 1. WARRIOR (Воїн) — 50 skills
  // =========================================================================
  {
    id: 'war_crushing_blow', class: 'Warrior', type: 'melee',
    nameUk: 'Нищівний удар', nameEn: 'Crushing Blow',
    costType: 'stamina', cost: 15, cooldown: 4, range: 40, icon: '🔨', iconColor: '#e11d48',
    descUk: 'Потужний удар основною зброєю, що наносить 180% фізичної шкоди та ігнорує 25% броні.',
    descEn: 'A devastating strike with main weapon dealing 180% physical damage and ignoring 25% armor.'
  },
  {
    id: 'war_whirlwind', class: 'Warrior', type: 'melee',
    nameUk: 'Вихор клинка', nameEn: 'Whirlwind',
    costType: 'stamina', cost: 25, cooldown: 6, range: 60, icon: '🌀', iconColor: '#f43f5e',
    descUk: 'Кругова атака, яка вражає всіх ворогів навколо у радіусі 3 клітинок.',
    descEn: 'Spinning attack striking all enemies in a 3-tile radius around the warrior.'
  },
  {
    id: 'war_hamstring_slash', class: 'Warrior', type: 'melee',
    nameUk: 'Розсікання жил', nameEn: 'Hamstring Slash',
    costType: 'stamina', cost: 12, cooldown: 5, range: 45, icon: '🗡️', iconColor: '#be123c',
    descUk: 'Швидкий косий випад по ногах, що завдає шкоди та сповільнює ціль на 40% на 4 сек.',
    descEn: 'Swift strike at the legs dealing damage and slowing target by 40% for 4s.'
  },
  {
    id: 'war_shield_slam', class: 'Warrior', type: 'melee',
    nameUk: 'Удар щитом', nameEn: 'Shield Slam',
    costType: 'stamina', cost: 18, cooldown: 8, range: 35, icon: '🛡️', iconColor: '#fbbf24',
    descUk: 'Оглушає ворога щитом на 2 сек. та наносить шкоду, що масштабується від показника захисту щита.',
    descEn: 'Stuns target with shield for 2s and deals damage scaling with shield armor value.'
  },
  {
    id: 'war_skull_splitter', class: 'Warrior', type: 'melee',
    nameUk: 'Розкол черепа', nameEn: 'Skull Splitter',
    costType: 'stamina', cost: 20, cooldown: 7, range: 40, icon: '💀', iconColor: '#e2e8f0',
    descUk: 'Важкий вертикальний удар із шансом 35% викликати дезорієнтацію на 3 сек.',
    descEn: 'Heavy overhead strike with 35% chance to disorient target for 3s.'
  },
  {
    id: 'war_bleeding_cleave', class: 'Warrior', type: 'melee',
    nameUk: 'Кривавий розтин', nameEn: 'Bleeding Cleave',
    costType: 'stamina', cost: 16, cooldown: 5, range: 50, icon: '🩸', iconColor: '#dc2626',
    descUk: 'Широкий помах сокирою/мечем, що накладає кровотечу на 6 сек. на групу ворогів перед воїном.',
    descEn: 'Wide cleave inflicting bleed over 6s on enemies in front of the warrior.'
  },
  {
    id: 'war_piercing_thrust', class: 'Warrior', type: 'melee',
    nameUk: 'Колотий випад', nameEn: 'Piercing Thrust',
    costType: 'stamina', cost: 14, cooldown: 4, range: 55, icon: '🗡️', iconColor: '#94a3b8',
    descUk: 'Пробиваючий випад списом чи мечем по прямій лінії крізь двох ворогів поспіль.',
    descEn: 'Piercing lunge through up to 2 enemies in a straight line.'
  },
  {
    id: 'war_punishing_strike', class: 'Warrior', type: 'melee',
    nameUk: 'Каральний випад', nameEn: 'Punishing Strike',
    costType: 'stamina', cost: 10, cooldown: 3, range: 40, icon: '⚡', iconColor: '#f59e0b',
    descUk: 'Контратака: наносить потрійну шкоду, якщо застосована протягом 1.5 сек після парирування або блоку.',
    descEn: 'Counter-attack: deals 300% damage if used within 1.5s after a parry or block.'
  },
  {
    id: 'war_twin_slash', class: 'Warrior', type: 'melee',
    nameUk: 'Подвійний змах', nameEn: 'Twin Slash',
    costType: 'stamina', cost: 14, cooldown: 3, range: 40, icon: '⚔️', iconColor: '#cbd5e1',
    descUk: 'Два блискавичні удари підряд, кожен наносить по 75% базової шкоди.',
    descEn: 'Two rapid strikes in quick succession dealing 75% weapon damage each.'
  },
  {
    id: 'war_ground_breaker', class: 'Warrior', type: 'melee',
    nameUk: 'Землетрусний розкол', nameEn: 'Ground Breaker',
    costType: 'stamina', cost: 22, cooldown: 9, range: 70, icon: '🌋', iconColor: '#d97706',
    descUk: 'Удар зброєю об землю, що запускає коротку ударну хвилю перед собою.',
    descEn: 'Smash weapon into the ground sending a shockwave forward.'
  },
  {
    id: 'war_decapitate', class: 'Warrior', type: 'melee',
    nameUk: 'Смертельний страк', nameEn: 'Decapitate',
    costType: 'stamina', cost: 30, cooldown: 12, range: 40, icon: '🪓', iconColor: '#991b1b',
    descUk: 'Добиваючий удар: наносить додатково +150% шкоди цілям, у яких менше 25% HP.',
    descEn: 'Execution strike dealing +150% bonus damage to targets below 25% HP.'
  },
  {
    id: 'war_flurry_of_steel', class: 'Warrior', type: 'melee',
    nameUk: 'Безжалісний шквал', nameEn: 'Flurry of Steel',
    costType: 'stamina', cost: 28, cooldown: 10, range: 45, icon: '⚔️', iconColor: '#e2e8f0',
    descUk: 'Серія з 4 швидких послідовних ударів по одній цілі.',
    descEn: 'Unleashes a rapid series of 4 consecutive strikes on a single target.'
  },
  {
    id: 'war_disarming_bash', class: 'Warrior', type: 'melee',
    nameUk: 'Обеззброюючий удар', nameEn: 'Disarming Bash',
    costType: 'stamina', cost: 18, cooldown: 14, range: 35, icon: '✋', iconColor: '#a855f7',
    descUk: 'Вибиває зброю з рук супротивника, блокуючи його атаки на 2 сек.',
    descEn: 'Knocks weapon from target hand, disarming them for 2s.'
  },
  {
    id: 'war_hilt_strike', class: 'Warrior', type: 'melee',
    nameUk: 'Удар колодою', nameEn: 'Hilt Strike',
    costType: 'stamina', cost: 10, cooldown: 8, range: 30, icon: '👊', iconColor: '#64748b',
    descUk: 'Швидкий удар рукояткою зброї, що перериває читання заклинань ворога.',
    descEn: 'Quick bash with weapon hilt interrupting enemy spellcasting.'
  },
  {
    id: 'war_sweeping_strike', class: 'Warrior', type: 'melee',
    nameUk: 'Круговий розмах', nameEn: 'Sweeping Strike',
    costType: 'stamina', cost: 20, cooldown: 7, range: 50, icon: '🔄', iconColor: '#f97316',
    descUk: 'Відкидає всіх ворогів перед воїном на 2 клітинки назад.',
    descEn: 'Knocks all enemies in front of warrior back by 2 tiles.'
  },
  {
    id: 'war_overpowering_smash', class: 'Warrior', type: 'melee',
    nameUk: 'Удар на виріст', nameEn: 'Overpowering Smash',
    costType: 'stamina', cost: 22, cooldown: 6, range: 45, icon: '💥', iconColor: '#ef4444',
    descUk: 'Важка атака, що не може бути зблокована чи ухилена.',
    descEn: 'Heavy unblockable and undodgeable smash.'
  },
  {
    id: 'war_wave_cleaver', class: 'Warrior', type: 'melee',
    nameUk: 'Хвилеріз', nameEn: 'Wave Cleaver',
    costType: 'stamina', cost: 24, cooldown: 8, range: 60, icon: '🌊', iconColor: '#38bdf8',
    descUk: 'Розсікаючий удар, який розбиває енергетичні щити цілей.',
    descEn: 'Cleaving strike shattering magical and physical shields on impact.'
  },
  {
    id: 'war_berzerker_rampage', class: 'Warrior', type: 'melee',
    nameUk: 'Лють берсерка', nameEn: 'Berzerker Rampage',
    costType: 'stamina', cost: 20, cooldown: 15, range: 40, icon: '🔥', iconColor: '#ea580c',
    descUk: 'Воїн б\'є щосили 3 рази, жертвуючи 5% HP для подвоєння шансу криту.',
    descEn: 'Strikes 3 times with double critical chance, sacrificing 5% current HP.'
  },
  {
    id: 'war_titanic_impact', class: 'Warrior', type: 'melee',
    nameUk: 'Титанічний випад', nameEn: 'Titanic Impact',
    costType: 'stamina', cost: 35, cooldown: 18, range: 50, icon: '⚡', iconColor: '#facc15',
    descUk: 'Величезний удар молотом чи дворучником, що залишає розлом на землі на 3 сек.',
    descEn: 'Colossal strike leaving a fissure in the earth for 3s.'
  },
  {
    id: 'war_blood_harvest', class: 'Warrior', type: 'melee',
    nameUk: 'Кривава м\'ясорубка', nameEn: 'Blood Harvest',
    costType: 'stamina', cost: 26, cooldown: 12, range: 45, icon: '🩸', iconColor: '#b91c1c',
    descUk: 'Melee-атака, що відновлює 25% від нанесеної шкоди у вигляді здоров\'я воїна.',
    descEn: 'Brutal melee attack restoring 25% of damage dealt as warrior health.'
  },

  // Warrior Magic & Powers
  {
    id: 'war_shockwave', class: 'Warrior', type: 'magic',
    nameUk: 'Ударна хвиля', nameEn: 'Shockwave',
    costType: 'mana', cost: 20, cooldown: 8, range: 120, icon: '💨', iconColor: '#94a3b8',
    descUk: 'Випускає конус звукової енергії, що наносить фізичну магічну шкоду.',
    descEn: 'Fires a cone of acoustic force dealing physical magic damage.'
  },
  {
    id: 'war_flame_edge', class: 'Warrior', type: 'magic',
    nameUk: 'Палаючий клинок', nameEn: 'Flame Edge',
    costType: 'mana', cost: 25, cooldown: 20, range: 0, icon: '🔥', iconColor: '#f97316',
    descUk: 'Заряджає зброю вогнем, додаючи +20% вогняної шкоди до всіх фізичних атак на 15 сек.',
    descEn: 'Imbues weapon with fire, adding +20% fire damage to physical attacks for 15s.'
  },
  {
    id: 'war_earth_stride', class: 'Warrior', type: 'magic',
    nameUk: 'Стихійний ривок', nameEn: 'Earth Stride',
    costType: 'mana', cost: 30, cooldown: 12, range: 140, icon: '🪨', iconColor: '#78716c',
    descUk: 'Швидкий рух крізь землю до цільової точки з вибухом кам\'яних уламків.',
    descEn: 'Charges through the ground to target point with rock shrapnel explosion.'
  },
  {
    id: 'war_ignite_blade', class: 'Warrior', type: 'magic',
    nameUk: 'Вогняний спалах зброї', nameEn: 'Ignite Blade',
    costType: 'mana', cost: 22, cooldown: 10, range: 60, icon: '💥', iconColor: '#ef4444',
    descUk: 'Вивільняє полум\'я з клинка, підпалюючи всіх ворогів у радіусі 2 клітинок.',
    descEn: 'Releases radial burst of fire igniting all surrounding enemies.'
  },
  {
    id: 'war_thunder_strike', class: 'Warrior', type: 'magic',
    nameUk: 'Громовий удар', nameEn: 'Thunder Strike',
    costType: 'mana', cost: 28, cooldown: 9, range: 50, icon: '⚡', iconColor: '#eab308',
    descUk: 'Удар зброєю, насичений блискавкою, що вражає до 3 додаткових цілей дугою.',
    descEn: 'Lightning-infused melee strike chaining electrical arcs to 3 nearby foes.'
  },
  {
    id: 'war_stoneskin_burst', class: 'Warrior', type: 'magic',
    nameUk: 'Кам\'яна оболонка', nameEn: 'Stoneskin Burst',
    costType: 'mana', cost: 35, cooldown: 25, range: 50, icon: '🛡️', iconColor: '#a8a29e',
    descUk: 'Скидає кам\'яні пластини, завдаючи осколкової шкоди ворогам навколо.',
    descEn: 'Shatters stone carapace dealing shrapnel damage to all nearby enemies.'
  },
  {
    id: 'war_leap_slam', class: 'Warrior', type: 'magic',
    nameUk: 'Вибуховий стрибок', nameEn: 'Leap Slam',
    costType: 'stamina', cost: 30, cooldown: 10, range: 180, icon: '☄️', iconColor: '#f59e0b',
    descUk: 'Стрибок у вказане місце, що розбиває землю і завдає AoE-шкоди.',
    descEn: 'Leaps to target location, smashing the ground with area impact.'
  },
  {
    id: 'war_windblade', class: 'Warrior', type: 'magic',
    nameUk: 'Лезо вітру', nameEn: 'Windblade',
    costType: 'mana', cost: 18, cooldown: 5, range: 160, icon: '🍃', iconColor: '#38bdf8',
    descUk: 'Випускає розрізаючу хвилю стисненого повітря на відстань.',
    descEn: 'Releases a crescent wave of pressurized cutting wind.'
  },
  {
    id: 'war_frostforge_strike', class: 'Warrior', type: 'magic',
    nameUk: 'Крижана кузня', nameEn: 'Frostforge Strike',
    costType: 'mana', cost: 24, cooldown: 8, range: 45, icon: '❄️', iconColor: '#67e8f9',
    descUk: 'Насичує удар холодом, заморожуючи землю під ногами ворога.',
    descEn: 'Strikes with frost power, freezing the ground beneath the target.'
  },
  {
    id: 'war_war_avatar', class: 'Warrior', type: 'magic',
    nameUk: 'Поклик війни', nameEn: 'War Avatar',
    costType: 'mana', cost: 50, cooldown: 60, range: 100, icon: '👑', iconColor: '#fbbf24',
    descUk: 'Прикликає фантомного велетня, який завдає масивного удару мечем по площі.',
    descEn: 'Summons a colossal spectral warlord delivering a massive sweeping strike.'
  },

  // Warrior Buffs
  {
    id: 'war_battle_shout', class: 'Warrior', type: 'buff',
    nameUk: 'Бойовий клич', nameEn: 'Battle Shout',
    costType: 'stamina', cost: 20, cooldown: 30, range: 120, icon: '🗣️', iconColor: '#ef4444',
    descUk: 'Підвищує фізичну шкоду воїна та союзників на 20% на 20 сек.',
    descEn: 'Increases warrior and nearby allies physical damage by 20% for 20s.'
  },
  {
    id: 'war_shield_wall', class: 'Warrior', type: 'buff',
    nameUk: 'Стіна щитів', nameEn: 'Shield Wall',
    costType: 'stamina', cost: 25, cooldown: 45, range: 0, icon: '🛡️', iconColor: '#3b82f6',
    descUk: 'Збільшує шанс блокування на 50% та знижує весь отримуваний урон на 30% на 8 сек.',
    descEn: 'Increases block chance by 50% and reduces damage taken by 30% for 8s.'
  },
  {
    id: 'war_iron_will', class: 'Warrior', type: 'buff',
    nameUk: 'Залізна воля', nameEn: 'Iron Will',
    costType: 'stamina', cost: 15, cooldown: 35, range: 0, icon: '⛓️', iconColor: '#64748b',
    descUk: 'Дає імунітет до оглушення, сповільнення та відкидання на 5 сек.',
    descEn: 'Grants immunity to stuns, slows, and knockbacks for 5s.'
  },
  {
    id: 'war_bloodlust_stance', class: 'Warrior', type: 'buff',
    nameUk: 'Жага крові', nameEn: 'Bloodlust Stance',
    costType: 'stamina', cost: 0, cooldown: 5, range: 0, icon: '🩸', iconColor: '#dc2626',
    descUk: 'Стійка: кожна атака дає +3% до швидкості атаки (стакається до 10 разів).',
    descEn: 'Stance: each hit grants +3% attack speed (stacks up to 10 times).'
  },
  {
    id: 'war_colossus_stance', class: 'Warrior', type: 'buff',
    nameUk: 'Стійка велетня', nameEn: 'Colossus Stance',
    costType: 'stamina', cost: 30, cooldown: 50, range: 0, icon: '🗿', iconColor: '#78716c',
    descUk: 'Збільшує розмір воїна, максимальне HP на 30% та радіус melee атак.',
    descEn: 'Increases warrior size, max HP by 30% and melee reach for 15s.'
  },
  {
    id: 'war_unstoppable', class: 'Warrior', type: 'buff',
    nameUk: 'Непохитність', nameEn: 'Unstoppable',
    costType: 'stamina', cost: 20, cooldown: 40, range: 0, icon: '💪', iconColor: '#f97316',
    descUk: 'Миттєво знімає всі ефекти контролю та відновлює 10% максимального HP.',
    descEn: 'Instantly breaks crowd control and restores 10% max HP.'
  },
  {
    id: 'war_last_stand', class: 'Warrior', type: 'buff',
    nameUk: 'Останній рубіж', nameEn: 'Last Stand',
    costType: 'stamina', cost: 0, cooldown: 120, range: 0, icon: '⚔️', iconColor: '#fbbf24',
    descUk: 'Протягом 4 сек здоров\'я воїна не може опуститися нижче 1 HP.',
    descEn: 'Health cannot drop below 1 HP for 4s.'
  },
  {
    id: 'war_steel_tempering', class: 'Warrior', type: 'buff',
    nameUk: 'Загартування сталлю', nameEn: 'Steel Tempering',
    costType: 'stamina', cost: 20, cooldown: 30, range: 0, icon: '🛡️', iconColor: '#94a3b8',
    descUk: 'Збільшує броню на 40% на 30 сек.',
    descEn: 'Increases total armor rating by 40% for 30s.'
  },
  {
    id: 'war_duelist_focus', class: 'Warrior', type: 'buff',
    nameUk: 'Стійка дуеліста', nameEn: 'Duelist Focus',
    costType: 'stamina', cost: 15, cooldown: 25, range: 0, icon: '🎯', iconColor: '#a855f7',
    descUk: 'Збільшує шанс парирування на 25% та силу критичного удару на 50%.',
    descEn: 'Grants +25% parry chance and +50% critical damage for 12s.'
  },
  {
    id: 'war_banner_of_victory', class: 'Warrior', type: 'buff',
    nameUk: 'Прапор звитяги', nameEn: 'Banner of Victory',
    costType: 'stamina', cost: 35, cooldown: 60, range: 100, icon: '🚩', iconColor: '#e11d48',
    descUk: 'Встановлює штандарт, який додає регенерацію здоров\'я союзникам навколо.',
    descEn: 'Plants war standard generating continuous health regeneration aura.'
  },

  // Warrior Debuffs
  {
    id: 'war_intimidating_roar', class: 'Warrior', type: 'debuff',
    nameUk: 'Залякуючий рев', nameEn: 'Intimidating Roar',
    costType: 'stamina', cost: 20, cooldown: 20, range: 100, icon: '🦁', iconColor: '#b45309',
    descUk: 'Зменшує силу атаки ворогів навколо на 25% на 10 сек.',
    descEn: 'Reduces nearby enemies attack power by 25% for 10s.'
  },
  {
    id: 'war_sunder_armor', class: 'Warrior', type: 'debuff',
    nameUk: 'Розлом броні', nameEn: 'Sunder Armor',
    costType: 'stamina', cost: 15, cooldown: 5, range: 45, icon: '🔨', iconColor: '#ea580c',
    descUk: 'Знижує показник броні цілі на 35% на 12 сек (стакається до 3 разів).',
    descEn: 'Shreds target armor by 35% for 12s (stacks up to 3 times).'
  },
  {
    id: 'war_tendon_rupture', class: 'Warrior', type: 'debuff',
    nameUk: 'Травма зв\'язок', nameEn: 'Tendon Rupture',
    costType: 'stamina', cost: 16, cooldown: 12, range: 45, icon: '🩸', iconColor: '#be123c',
    descUk: 'Ворог отримує шкоду кожного разу, коли робить крок протягом 6 сек.',
    descEn: 'Target suffers bleed damage each time it moves for 6s.'
  },
  {
    id: 'war_taunt', class: 'Warrior', type: 'debuff',
    nameUk: 'Провокація', nameEn: 'Taunt',
    costType: 'stamina', cost: 10, cooldown: 15, range: 120, icon: '🤬', iconColor: '#ef4444',
    descUk: 'Змушує ворогів атакувати воїна протягом 4 сек та зменшує їх захист на 15%.',
    descEn: 'Forces enemies to attack warrior for 4s and reduces their defense by 15%.'
  },
  {
    id: 'war_gouge', class: 'Warrior', type: 'debuff',
    nameUk: 'Кривавий слід', nameEn: 'Gouge',
    costType: 'stamina', cost: 14, cooldown: 10, range: 40, icon: '👁️', iconColor: '#991b1b',
    descUk: 'Знижує точність атак ворога на 30% через кровотечу в очі на 6 сек.',
    descEn: 'Blinds target with blood, lowering attack accuracy by 30% for 6s.'
  },
  {
    id: 'war_demoralize', class: 'Warrior', type: 'debuff',
    nameUk: 'Деморалізація', nameEn: 'Demoralize',
    costType: 'stamina', cost: 18, cooldown: 18, range: 80, icon: '😨', iconColor: '#7c3aed',
    descUk: 'Вороги в конусі перед воїном сповільнюють швидкість касту заклинань на 40%.',
    descEn: 'Slows enemy spellcasting speed by 40% in a frontal cone for 8s.'
  },
  {
    id: 'war_cracked_bones', class: 'Warrior', type: 'debuff',
    nameUk: 'Зламані кістки', nameEn: 'Cracked Bones',
    costType: 'stamina', cost: 18, cooldown: 12, range: 45, icon: '🦴', iconColor: '#cbd5e1',
    descUk: 'Знижує максимальну швидкість пересування цілі на 50% на 5 сек.',
    descEn: 'Reduces target maximum movement speed by 50% for 5s.'
  },
  {
    id: 'war_terrifying_glare', class: 'Warrior', type: 'debuff',
    nameUk: 'Постріл страхом', nameEn: 'Terrifying Glare',
    costType: 'stamina', cost: 15, cooldown: 25, range: 60, icon: '👀', iconColor: '#475569',
    descUk: 'Змушує одну ціль втікати в паніці (Fear) на 2.5 сек.',
    descEn: 'Fears a single target causing them to flee uncontrollably for 2.5s.'
  },
  {
    id: 'war_deep_wound', class: 'Warrior', type: 'debuff',
    nameUk: 'Глибока рана', nameEn: 'Deep Wound',
    costType: 'stamina', cost: 16, cooldown: 14, range: 45, icon: '💉', iconColor: '#881337',
    descUk: 'Знижує ефективність будь-якого лікування цілі на 60% на 8 сек.',
    descEn: 'Reduces healing received by target by 60% for 8s.'
  },
  {
    id: 'war_maim', class: 'Warrior', type: 'debuff',
    nameUk: 'Каліцтво', nameEn: 'Maim',
    costType: 'stamina', cost: 15, cooldown: 10, range: 45, icon: '🩼', iconColor: '#b45309',
    descUk: 'Знижує швидкість атаки ворога на 35% на 8 сек.',
    descEn: 'Maims target reducing their attack speed by 35% for 8s.'
  },

  // =========================================================================
  // 2. MAGE (Маг) — 50 skills
  // =========================================================================
  {
    id: 'mag_arcane_dagger', class: 'Mage', type: 'melee',
    nameUk: 'Чародійський кинджал', nameEn: 'Arcane Dagger',
    costType: 'mana', cost: 12, cooldown: 1, range: 40, icon: '🗡️', iconColor: '#c084fc',
    descUk: 'Удар магічним клинком з мани, що завдає чистої чародійської шкоди.',
    descEn: 'Conjures a blade of pure mana dealing direct arcane damage in melee.'
  },
  {
    id: 'mag_combustion_touch', class: 'Mage', type: 'melee',
    nameUk: 'Вогняний дотик', nameEn: 'Combustion Touch',
    costType: 'mana', cost: 25, cooldown: 6, range: 35, icon: '🔥', iconColor: '#f97316',
    descUk: 'Ближній удар долонею, що підриває ворога зсередини на 220% шкоди вогнем.',
    descEn: 'Melee palm strike detonating the foe from within for 220% fire damage.'
  },
  {
    id: 'mag_frost_rapier', class: 'Mage', type: 'melee',
    nameUk: 'Крижаний укол', nameEn: 'Frost Rapier',
    costType: 'mana', cost: 18, cooldown: 4, range: 50, icon: '❄️', iconColor: '#38bdf8',
    descUk: 'Пронизуючий удар чарівним льодовим стилем, що заморожує ворога на 1.5 сек.',
    descEn: 'Thrust with an ice rapier freezing the target in place for 1.5s.'
  },
  {
    id: 'mag_static_palm', class: 'Mage', type: 'melee',
    nameUk: 'Електричний розряд рукою', nameEn: 'Static Palm',
    costType: 'mana', cost: 20, cooldown: 5, range: 40, icon: '⚡', iconColor: '#facc15',
    descUk: 'Удар рукою, що заряджає ціль струмом і відкидає її на 3 клітинки.',
    descEn: 'Shocking palm strike knocking the target back 3 tiles.'
  },
  {
    id: 'mag_point_blank_burst', class: 'Mage', type: 'melee',
    nameUk: 'Магічний спалах впритул', nameEn: 'Point-Blank Burst',
    costType: 'mana', cost: 30, cooldown: 8, range: 60, icon: '💥', iconColor: '#e879f9',
    descUk: 'Вибух чародійської енергії навколо тіла мага, що відштовхує ворогів.',
    descEn: 'Point-blank arcane explosion knocking back all surrounding enemies.'
  },
  {
    id: 'mag_mana_blades', class: 'Mage', type: 'melee',
    nameUk: 'Клинки мани', nameEn: 'Mana Blades',
    costType: 'mana', cost: 15, cooldown: 3, range: 45, icon: '⚔️', iconColor: '#818cf8',
    descUk: 'Дворучний удар двома лезами з чистої енергії, що відновлює ману при попаданні.',
    descEn: 'Dual strike with energy blades restoring mana on successful hit.'
  },
  {
    id: 'mag_staff_shock', class: 'Mage', type: 'melee',
    nameUk: 'Шоковий удар палицею', nameEn: 'Staff Shock',
    costType: 'mana', cost: 16, cooldown: 9, range: 45, icon: '🪄', iconColor: '#fbbf24',
    descUk: 'Удар посохом по голові, який накладає безмовність (Silence) на 2 сек.',
    descEn: 'Staff bash that silences target spellcaster for 2s.'
  },
  {
    id: 'mag_mana_tap', class: 'Mage', type: 'melee',
    nameUk: 'Всмоктуючий дотик', nameEn: 'Mana Tap',
    costType: 'mana', cost: 0, cooldown: 10, range: 35, icon: '🔮', iconColor: '#a855f7',
    descUk: 'Ближній контакт, що викрадає 50 мани у ворожого заклинателя.',
    descEn: 'Melee touch siphoning 50 mana from enemy spellcasters.'
  },
  {
    id: 'mag_arcane_sweep', class: 'Mage', type: 'melee',
    nameUk: 'Сяючий круговий помах', nameEn: 'Arcane Sweep',
    costType: 'mana', cost: 22, cooldown: 5, range: 55, icon: '💫', iconColor: '#c084fc',
    descUk: 'Розмашистий удар посохом, що випускає коротку світлову дугу.',
    descEn: 'Sweeping staff strike releasing a crescent arc of light.'
  },
  {
    id: 'mag_illusionary_jab', class: 'Mage', type: 'melee',
    nameUk: 'Ілюзорний випад', nameEn: 'Illusionary Jab',
    costType: 'mana', cost: 20, cooldown: 7, range: 40, icon: '🎭', iconColor: '#a78bfa',
    descUk: 'Маг робить оманливий удар з телепортацією на 2 кроки назад.',
    descEn: 'Deceptive melee jab instantly blinking the mage 2 paces backwards.'
  },

  // Mage Spells
  {
    id: 'mag_fireball', class: 'Mage', type: 'magic',
    nameUk: 'Вогняна куля', nameEn: 'Fireball',
    costType: 'mana', cost: 25, cooldown: 2, range: 200, icon: '🔥', iconColor: '#ea580c',
    descUk: 'Снаряд, що вибухає у радіусі 3 клітинок, підпалюючи всіх у зоні.',
    descEn: 'Hurls an explosive sphere of fire with a 3-tile blast radius.'
  },
  {
    id: 'mag_frostbolt', class: 'Mage', type: 'magic',
    nameUk: 'Крижана стріла', nameEn: 'Frostbolt',
    costType: 'mana', cost: 20, cooldown: 1.5, range: 220, icon: '❄️', iconColor: '#38bdf8',
    descUk: 'Стріла льоду, що завдає холодної шкоди та сповільнює ціль на 50%.',
    descEn: 'Fires an ice projectile dealing cold damage and slowing target by 50%.'
  },
  {
    id: 'mag_chain_lightning', class: 'Mage', type: 'magic',
    nameUk: 'Ланцюгова блискавка', nameEn: 'Chain Lightning',
    costType: 'mana', cost: 35, cooldown: 6, range: 180, icon: '⚡', iconColor: '#eab308',
    descUk: 'Блискавка, що перестрибує між 5 ворогами, втрачаючи по 15% сили за стрибок.',
    descEn: 'Arc of lightning jumping between up to 5 targets.'
  },
  {
    id: 'mag_meteor_shower', class: 'Mage', type: 'magic',
    nameUk: 'Метеоритний дощ', nameEn: 'Meteor Shower',
    costType: 'mana', cost: 60, cooldown: 30, range: 240, icon: '☄️', iconColor: '#dc2626',
    descUk: 'Викликає падіння 4 метеоритів у вказану область із масивною шкодою.',
    descEn: 'Bombards target area with 4 devastating meteors.'
  },
  {
    id: 'mag_frost_nova', class: 'Mage', type: 'magic',
    nameUk: 'Кільце морозу', nameEn: 'Frost Nova',
    costType: 'mana', cost: 30, cooldown: 12, range: 100, icon: '❄️', iconColor: '#0284c7',
    descUk: 'Миттєвий льодовий спалах навколо мага, що приморожує ворогів до землі на 3 сек.',
    descEn: 'Freezes all nearby enemies to the ground for 3s.'
  },
  {
    id: 'mag_arcane_beam', class: 'Mage', type: 'magic',
    nameUk: 'Чародійський промінь', nameEn: 'Arcane Beam',
    costType: 'mana', cost: 15, cooldown: 0, range: 250, icon: '🟣', iconColor: '#9333ea',
    descUk: 'Неперервний лазерний промінь, що наносить шкоду кожні 0.25 сек.',
    descEn: 'Continuous channeled beam of pure arcane devastation.'
  },
  {
    id: 'mag_ball_lightning', class: 'Mage', type: 'magic',
    nameUk: 'Кульова блискавка', nameEn: 'Ball Lightning',
    costType: 'mana', cost: 40, cooldown: 8, range: 180, icon: '⚡', iconColor: '#facc15',
    descUk: 'Повільна сфера електрики, що пульсує розрядами по всіх ворогах поруч.',
    descEn: 'Slow-moving electrical orb shocking all nearby enemies repeatedly.'
  },
  {
    id: 'mag_blink', class: 'Mage', type: 'magic',
    nameUk: 'Телепортація (Blink)', nameEn: 'Blink',
    costType: 'mana', cost: 25, cooldown: 8, range: 160, icon: '✨', iconColor: '#c084fc',
    descUk: 'Миттєве переміщення мага на 8 клітинок вперед у напрямку погляду.',
    descEn: 'Instantly teleports the mage 8 tiles forward.'
  },
  {
    id: 'mag_wall_of_fire', class: 'Mage', type: 'magic',
    nameUk: 'Стіна вогню', nameEn: 'Wall of Fire',
    costType: 'mana', cost: 45, cooldown: 18, range: 150, icon: '🔥', iconColor: '#f97316',
    descUk: 'Створює палаючу лінію на землі на 8 сек, крізь яку вороги горять.',
    descEn: 'Creates a blazing wall of fire igniting any who pass through.'
  },
  {
    id: 'mag_blizzard', class: 'Mage', type: 'magic',
    nameUk: 'Хуртовина', nameEn: 'Blizzard',
    costType: 'mana', cost: 55, cooldown: 25, range: 220, icon: '🌨️', iconColor: '#7dd3fc',
    descUk: 'Крижаний шторм у зоні, що постійно завдає шкоди та сповільнює.',
    descEn: 'Summons a blizzard freezing and damaging foes in a wide area.'
  },
  {
    id: 'mag_magic_missiles', class: 'Mage', type: 'magic',
    nameUk: 'Чародійні стріли', nameEn: 'Magic Missiles',
    costType: 'mana', cost: 22, cooldown: 3, range: 200, icon: '✨', iconColor: '#d8b4fe',
    descUk: 'Запуск 5 самонавідних енергетичних снарядів у найближчих ворогів.',
    descEn: 'Fires 5 homing arcane darts seeking nearby enemies.'
  },
  {
    id: 'mag_gravity_singularity', class: 'Mage', type: 'magic',
    nameUk: 'Гравітаційний колодязь', nameEn: 'Gravity Singularity',
    costType: 'mana', cost: 50, cooldown: 30, range: 200, icon: '🕳️', iconColor: '#6b21a8',
    descUk: 'Створює чорну діру, яка затягує всіх ворогів до центру.',
    descEn: 'Creates a gravitational rift pulling all nearby enemies to its center.'
  },
  {
    id: 'mag_thunderstorm', class: 'Mage', type: 'magic',
    nameUk: 'Грозовий шквал', nameEn: 'Thunderstorm',
    costType: 'mana', cost: 65, cooldown: 40, range: 250, icon: '🌩️', iconColor: '#f59e0b',
    descUk: 'Викликає точкові удари блискавок по ворогах у великому радіусі.',
    descEn: 'Calls down thunderbolts striking all enemies across the battlefield.'
  },
  {
    id: 'mag_prismatic_burst', class: 'Mage', type: 'magic',
    nameUk: 'Призматичний спалах', nameEn: 'Prismatic Burst',
    costType: 'mana', cost: 30, cooldown: 5, range: 180, icon: '🌈', iconColor: '#ec4899',
    descUk: 'Вибух випадкової стихії (вогонь, лід або блискавка) з додатковим ефектом.',
    descEn: 'Triggers a tri-elemental burst of fire, ice, and lightning.'
  },
  {
    id: 'mag_mirror_image', class: 'Mage', type: 'magic',
    nameUk: 'Дзеркальне відображення', nameEn: 'Mirror Image',
    costType: 'mana', cost: 40, cooldown: 35, range: 0, icon: '👥', iconColor: '#a855f7',
    descUk: 'Створює 3 копії мага, які відволікають ворогів і кастують слабкі стріли.',
    descEn: 'Spawns 3 illusory clones distracting enemies and casting weak bolts.'
  },
  {
    id: 'mag_disintegrate', class: 'Mage', type: 'magic',
    nameUk: 'Знищення матерії', nameEn: 'Disintegrate',
    costType: 'mana', cost: 45, cooldown: 12, range: 180, icon: '⚡', iconColor: '#e11d48',
    descUk: 'Руйнівний промінь, що розчиняє ворогів із низьким рівнем HP.',
    descEn: 'Devastating ray instantly vaporizing weakened enemies.'
  },
  {
    id: 'mag_blast_wave', class: 'Mage', type: 'magic',
    nameUk: 'Вибухова хвиля', nameEn: 'Blast Wave',
    costType: 'mana', cost: 28, cooldown: 10, range: 120, icon: '💥', iconColor: '#f97316',
    descUk: 'Вогняне кільце, що розбігається від мага і збиває ворогів з ніг.',
    descEn: 'Radial wave of flame knocking back and dazing nearby foes.'
  },
  {
    id: 'mag_deep_comet', class: 'Mage', type: 'magic',
    nameUk: 'Комета глибин', nameEn: 'Deep Comet',
    costType: 'mana', cost: 50, cooldown: 20, range: 220, icon: '☄️', iconColor: '#38bdf8',
    descUk: 'Величезна крижана брила, що падає з неба та оглушає епіцентр вибуху на 2 сек.',
    descEn: 'Massive glacier comet crushing target area and stunning for 2s.'
  },
  {
    id: 'mag_overload_discharge', class: 'Mage', type: 'magic',
    nameUk: 'Електро-шторм', nameEn: 'Overload Discharge',
    costType: 'mana', cost: 35, cooldown: 8, range: 140, icon: '⚡', iconColor: '#eab308',
    descUk: 'Випускає нагромаджену електричну енергію конусом перед собою.',
    descEn: 'Discharges stored electrical potential in a devastating frontal cone.'
  },
  {
    id: 'mag_temporal_warp', class: 'Mage', type: 'magic',
    nameUk: 'Хроно-вибух', nameEn: 'Temporal Warp',
    costType: 'mana', cost: 40, cooldown: 45, range: 0, icon: '⏳', iconColor: '#6366f1',
    descUk: 'Створює часовий розрив: через 3 сек повертає позицію і HP мага до попереднього значення.',
    descEn: 'Anchors current position and HP, rewinding back after 3s.'
  },

  // Mage Buffs
  {
    id: 'mag_mana_shield', class: 'Mage', type: 'buff',
    nameUk: 'Щит мани', nameEn: 'Mana Shield',
    costType: 'mana', cost: 0, cooldown: 5, range: 0, icon: '🛡️', iconColor: '#818cf8',
    descUk: '70% отримуваної шкоди знімається з мани замість здоров\'я.',
    descEn: 'Absorbs 70% of incoming damage directly from mana instead of health.'
  },
  {
    id: 'mag_ice_armor', class: 'Mage', type: 'buff',
    nameUk: 'Крижаний панцир', nameEn: 'Ice Armor',
    costType: 'mana', cost: 30, cooldown: 30, range: 0, icon: '❄️', iconColor: '#38bdf8',
    descUk: 'Збільшує захист та сповільнює кожного ворога, який б\'є мага у ближньому бою.',
    descEn: 'Increases defense and chills any attacker who strikes in melee.'
  },
  {
    id: 'mag_immolation_aura', class: 'Mage', type: 'buff',
    nameUk: 'Палаюча аура', nameEn: 'Immolation Aura',
    costType: 'mana', cost: 35, cooldown: 25, range: 80, icon: '🔥', iconColor: '#ea580c',
    descUk: 'Огортає мага полум\'ям, що завдає постійної шкоди всім ворогам в радіусі 2 клітинок.',
    descEn: 'Surrounds mage in flame damaging all nearby enemies continuously.'
  },
  {
    id: 'mag_haste', class: 'Mage', type: 'buff',
    nameUk: 'Прискорення часу', nameEn: 'Haste',
    costType: 'mana', cost: 25, cooldown: 30, range: 0, icon: '⏩', iconColor: '#facc15',
    descUk: 'Збільшує швидкість бігу та касту заклинань на 35% на 10 сек.',
    descEn: 'Increases movement and casting speed by 35% for 10s.'
  },
  {
    id: 'mag_arcane_brilliance', class: 'Mage', type: 'buff',
    nameUk: 'Чародійний інтелект', nameEn: 'Arcane Brilliance',
    costType: 'mana', cost: 40, cooldown: 60, range: 120, icon: '🧠', iconColor: '#c084fc',
    descUk: 'Збільшує силу заклинань (Spell Power) на 25% та максимальну ману на 20%.',
    descEn: 'Increases spell power by 25% and maximum mana by 20% for 30m.'
  },
  {
    id: 'mag_mana_surge', class: 'Mage', type: 'buff',
    nameUk: 'Медитація припливу', nameEn: 'Mana Surge',
    costType: 'mana', cost: 0, cooldown: 60, range: 0, icon: '🌊', iconColor: '#3b82f6',
    descUk: 'Миттєво відновлює 40% загального запасу мани.',
    descEn: 'Instantly restores 40% of maximum mana.'
  },
  {
    id: 'mag_elemental_focus', class: 'Mage', type: 'buff',
    nameUk: 'Елементальне фокусування', nameEn: 'Elemental Focus',
    costType: 'mana', cost: 20, cooldown: 25, range: 0, icon: '🎯', iconColor: '#f43f5e',
    descUk: 'Наступні 3 заклинання мають 100% шанс критичного попадання.',
    descEn: 'Grants 100% critical strike chance on the next 3 spells.'
  },
  {
    id: 'mag_spell_ward', class: 'Mage', type: 'buff',
    nameUk: 'Захисна сфера', nameEn: 'Spell Ward',
    costType: 'mana', cost: 30, cooldown: 35, range: 0, icon: '🔮', iconColor: '#a855f7',
    descUk: 'Поглинає наступні 2 магічні атаки ворогів без шкоди.',
    descEn: 'Completely absorbs the next 2 hostile magical attacks.'
  },
  {
    id: 'mag_ethereal_form', class: 'Mage', type: 'buff',
    nameUk: 'Ефірний стан', nameEn: 'Ethereal Form',
    costType: 'mana', cost: 35, cooldown: 40, range: 0, icon: '👻', iconColor: '#93c5fd',
    descUk: 'Маг стає невразливим до фізичної шкоди на 3.5 сек, але не може бити фізично.',
    descEn: 'Immune to physical damage for 3.5s; cannot perform physical attacks.'
  },
  {
    id: 'mag_empower_elements', class: 'Mage', type: 'buff',
    nameUk: 'Посилення стихій', nameEn: 'Empower Elements',
    costType: 'mana', cost: 30, cooldown: 30, range: 0, icon: '✨', iconColor: '#fb923c',
    descUk: 'Додає 30% додаткової шкоди вогнем/холодом/блискавкою на 15 сек.',
    descEn: 'Increases all elemental damage dealt by 30% for 15s.'
  },

  // Mage Debuffs
  {
    id: 'mag_arcane_vulnerability', class: 'Mage', type: 'debuff',
    nameUk: 'Опромінення чарами', nameEn: 'Arcane Vulnerability',
    costType: 'mana', cost: 20, cooldown: 12, range: 180, icon: '🟣', iconColor: '#a855f7',
    descUk: 'Збільшує магічну шкоду по цілі на 30% на 10 сек.',
    descEn: 'Increases magic damage taken by target by 30% for 10s.'
  },
  {
    id: 'mag_deep_chill', class: 'Mage', type: 'debuff',
    nameUk: 'Глибока заморозка', nameEn: 'Deep Chill',
    costType: 'mana', cost: 25, cooldown: 15, range: 160, icon: '🧊', iconColor: '#0284c7',
    descUk: 'Знижує швидкість касту і пересування ворога на 60% на 6 сек.',
    descEn: 'Slows movement and casting speed of target by 60% for 6s.'
  },
  {
    id: 'mag_scorched_flesh', class: 'Mage', type: 'debuff',
    nameUk: 'Опік третього ступеня', nameEn: 'Scorched Flesh',
    costType: 'mana', cost: 22, cooldown: 10, range: 180, icon: '🔥', iconColor: '#b91c1c',
    descUk: 'Знижує опір вогню на 40% і наносить DoT-шкоду.',
    descEn: 'Reduces fire resistance by 40% and burns over 8s.'
  },
  {
    id: 'mag_silence', class: 'Mage', type: 'debuff',
    nameUk: 'Німота', nameEn: 'Silence',
    costType: 'mana', cost: 25, cooldown: 20, range: 160, icon: '🤫', iconColor: '#64748b',
    descUk: 'Забороняє ворогу використовувати будь-які магічні заклинання на 4 сек.',
    descEn: 'Silences enemy spellcaster for 4s.'
  },
  {
    id: 'mag_polymorph', class: 'Mage', type: 'debuff',
    nameUk: 'Поліморф', nameEn: 'Polymorph',
    costType: 'mana', cost: 35, cooldown: 30, range: 160, icon: '🐑', iconColor: '#f1f5f9',
    descUk: 'Перетворює ворога на вівцю на 5 сек (розбивається при отриманні шкоди).',
    descEn: 'Transforms enemy into a harmless sheep for 5s.'
  },
  {
    id: 'mag_static_charge', class: 'Mage', type: 'debuff',
    nameUk: 'Статичний заряд', nameEn: 'Static Charge',
    costType: 'mana', cost: 20, cooldown: 8, range: 180, icon: '⚡', iconColor: '#eab308',
    descUk: 'Ворог отримує подвійну шкоду від блискавок та б\'є струмом своїх союзників.',
    descEn: 'Causes target to take double shock damage and discharge arcs to allies.'
  },
  {
    id: 'mag_slow_field', class: 'Mage', type: 'debuff',
    nameUk: 'Часове сповільнення', nameEn: 'Slow Field',
    costType: 'mana', cost: 40, cooldown: 25, range: 180, icon: '⏱️', iconColor: '#6366f1',
    descUk: 'Створює купол, в якому ворожі снаряди і вороги рухаються на 70% повільніше.',
    descEn: 'Time warp dome slowing enemies and incoming projectiles by 70%.'
  },
  {
    id: 'mag_mana_burn', class: 'Mage', type: 'debuff',
    nameUk: 'Витік мани', nameEn: 'Mana Burn',
    costType: 'mana', cost: 25, cooldown: 14, range: 160, icon: '🔥', iconColor: '#9333ea',
    descUk: 'Спалює ману у ворога та завдає шкоди, еквівалентної спаленій мані.',
    descEn: 'Burns enemy mana and deals direct damage equal to mana drained.'
  },
  {
    id: 'mag_flash_blind', class: 'Mage', type: 'debuff',
    nameUk: 'Сліпуче світло', nameEn: 'Flash Blind',
    costType: 'mana', cost: 20, cooldown: 15, range: 120, icon: '☀️', iconColor: '#fde047',
    descUk: 'Осліплює ворогів у конусі на 3 сек, через що їхні атаки промахуються.',
    descEn: 'Blinds enemies in a frontal cone causing 80% miss chance for 3s.'
  },
  {
    id: 'mag_elemental_hex', class: 'Mage', type: 'debuff',
    nameUk: 'Стихійна ентропія', nameEn: 'Elemental Hex',
    costType: 'mana', cost: 30, cooldown: 18, range: 150, icon: '🌀', iconColor: '#c084fc',
    descUk: 'Зменшує всі стихійні резисти ворогів навколо на 25% на 12 сек.',
    descEn: 'Lowers all elemental resistances of surrounding enemies by 25% for 12s.'
  },

  // =========================================================================
  // 3. MONK (Монах) — 50 skills
  // =========================================================================
  {
    id: 'mnk_wind_palm', class: 'Monk', type: 'melee',
    nameUk: 'Удар долонею вітру', nameEn: 'Wind Palm',
    costType: 'mana', cost: 8, cooldown: 2, range: 45, icon: '✋', iconColor: '#38bdf8',
    descUk: 'Швидкий удар відкритою долонею, що наносить шкоду та відштовхує ворога.',
    descEn: 'Swift open palm strike knocking the target back.'
  },
  {
    id: 'mnk_dragon_kick', class: 'Monk', type: 'melee',
    nameUk: 'Удар дракона з розвороту', nameEn: 'Dragon Kick',
    costType: 'mana', cost: 15, cooldown: 6, range: 55, icon: '🦶', iconColor: '#f97316',
    descUk: 'Потужний удар ногою в стрибку, що оглушає ціль на 1.5 сек.',
    descEn: 'Flying roundhouse kick stunning the target for 1.5s.'
  },
  {
    id: 'mnk_pressure_point_strike', class: 'Monk', type: 'melee',
    nameUk: 'Удар у нервові вузли', nameEn: 'Pressure Point Strike',
    costType: 'mana', cost: 18, cooldown: 8, range: 40, icon: '🎯', iconColor: '#a855f7',
    descUk: 'Точковий удар пальцями, що блокує можливість ворога атакувати на 2.5 сек.',
    descEn: 'Precision nerve strike pacifying enemy from attacking for 2.5s.'
  },
  {
    id: 'mnk_twin_serpent_strike', class: 'Monk', type: 'melee',
    nameUk: 'Подвійний серп', nameEn: 'Twin Serpent Strike',
    costType: 'mana', cost: 10, cooldown: 3, range: 40, icon: '🐍', iconColor: '#10b981',
    descUk: 'Два блискавичних послідовних удари руками, які відновлюють ману монаха.',
    descEn: 'Two rapid serpent strikes that restore mana on contact.'
  },
  {
    id: 'mnk_tiger_claw', class: 'Monk', type: 'melee',
    nameUk: 'Тигрячий кіготь', nameEn: 'Tiger Claw',
    costType: 'mana', cost: 14, cooldown: 4, range: 40, icon: '🐅', iconColor: '#ea580c',
    descUk: 'Роздираючий удар кулаком, що викликає кровотечу та пробиває броню.',
    descEn: 'Rending claw strike shredding armor and inflicting deep bleed.'
  },
  {
    id: 'mnk_five_element_combo', class: 'Monk', type: 'melee',
    nameUk: 'Удар п\'яти стихій', nameEn: 'Five Element Combo',
    costType: 'mana', cost: 25, cooldown: 8, range: 45, icon: '✨', iconColor: '#ec4899',
    descUk: 'Серія з 5 ударів кулаками за 1 секунду з комбінованим стихійним уроном.',
    descEn: 'Flurry of 5 lightning-fast elemental strikes.'
  },
  {
    id: 'mnk_hundred_fists', class: 'Monk', type: 'melee',
    nameUk: 'Кулак сотні тіней', nameEn: 'Hundred Fists',
    costType: 'mana', cost: 30, cooldown: 12, range: 60, icon: '👊', iconColor: '#f59e0b',
    descUk: 'Монах стоїть на місці та наносить шквал ударів по конусу перед собою.',
    descEn: 'Channeled frontal cone barrage of a hundred shadow punches.'
  },
  {
    id: 'mnk_falling_star', class: 'Monk', type: 'melee',
    nameUk: 'Падіння метеорного кулака', nameEn: 'Falling Star',
    costType: 'mana', cost: 28, cooldown: 10, range: 160, icon: '☄️', iconColor: '#fbbf24',
    descUk: 'Стрибок високо в повітря з приземленням на ворога кулаком.',
    descEn: 'Leaps high into the sky and crashes down on target with crater impact.'
  },
  {
    id: 'mnk_mantis_strike', class: 'Monk', type: 'melee',
    nameUk: 'Удар богомола', nameEn: 'Mantis Strike',
    costType: 'mana', cost: 12, cooldown: 5, range: 45, icon: '🦗', iconColor: '#84cc16',
    descUk: 'Швидкий колючий випад пальцями в очі, що дезорієнтує ворога.',
    descEn: 'Blinding precision thrust disorienting the opponent.'
  },
  {
    id: 'mnk_dragon_tail_sweep', class: 'Monk', type: 'melee',
    nameUk: 'Підсічка хвостом дракона', nameEn: 'Dragon Tail Sweep',
    costType: 'mana', cost: 16, cooldown: 7, range: 50, icon: '🐉', iconColor: '#f97316',
    descUk: 'Круговий удар ногою по низу, що збиває ворогів у радіусі з ніг.',
    descEn: 'Low sweeping sweep knocking down all surrounding foes.'
  },
  {
    id: 'mnk_iron_palm', class: 'Monk', type: 'melee',
    nameUk: 'Удар залізної долоні', nameEn: 'Iron Palm',
    costType: 'mana', cost: 20, cooldown: 6, range: 40, icon: '🛡️', iconColor: '#94a3b8',
    descUk: 'Удар, який розбиває захисні бар\'єри та броню супротивника.',
    descEn: 'Heavy hardened palm strike shattering shields and barriers.'
  },
  {
    id: 'mnk_exploding_palm', class: 'Monk', type: 'melee',
    nameUk: 'Вибуховий контакт', nameEn: 'Exploding Palm',
    costType: 'mana', cost: 22, cooldown: 8, range: 45, icon: '💥', iconColor: '#ef4444',
    descUk: 'Накладає внутрішню мітку; якщо ворог помирає під міткою — він вибухає.',
    descEn: 'Marks target with internal resonance; detonates violently on target death.'
  },
  {
    id: 'mnk_crane_beak', class: 'Monk', type: 'melee',
    nameUk: 'Кулак журавля', nameEn: 'Crane Beak',
    costType: 'mana', cost: 10, cooldown: 8, range: 45, icon: '🪶', iconColor: '#e2e8f0',
    descUk: 'Точний удар у горло з перериванням ворожого заклинання.',
    descEn: 'Crane strike to throat interrupting enemy spellcasting.'
  },
  {
    id: 'mnk_tidal_sweep', class: 'Monk', type: 'melee',
    nameUk: 'Удар припливної хвилі', nameEn: 'Tidal Sweep',
    costType: 'mana', cost: 18, cooldown: 6, range: 60, icon: '🌊', iconColor: '#0ea5e9',
    descUk: 'Розмашистий удар ногою, що створює водну хвилю перед монахом.',
    descEn: 'Sweeping kick launching a crescent wave of water.'
  },
  {
    id: 'mnk_spinning_crane_kick', class: 'Monk', type: 'melee',
    nameUk: 'Вихор монаха', nameEn: 'Spinning Crane Kick',
    costType: 'mana', cost: 25, cooldown: 8, range: 55, icon: '🌪️', iconColor: '#38bdf8',
    descUk: 'Монах крутиться в повітрі, завдаючи шкоди всім навколо протягом 2 сек.',
    descEn: 'Spins through the air dealing continuous damage to all nearby enemies.'
  },
  {
    id: 'mnk_zen_strike', class: 'Monk', type: 'melee',
    nameUk: 'Удар просвітлення', nameEn: 'Zen Strike',
    costType: 'mana', cost: 30, cooldown: 10, range: 40, icon: '🧘', iconColor: '#facc15',
    descUk: 'Удар кулаком, що наносить 250% шкоди, якщо у монаха повна мана.',
    descEn: 'Delivers 250% damage if executed at full mana.'
  },
  {
    id: 'mnk_joint_lock', class: 'Monk', type: 'melee',
    nameUk: 'Дробарка суглобів', nameEn: 'Joint Lock',
    costType: 'mana', cost: 15, cooldown: 12, range: 35, icon: '🔒', iconColor: '#64748b',
    descUk: 'Захват у ближньому бою, що паралізує ворога на 2 сек.',
    descEn: 'Grapples opponent in an arm lock, immobilizing and pacifying for 2s.'
  },
  {
    id: 'mnk_echo_palm', class: 'Monk', type: 'melee',
    nameUk: 'Удар дзеркального духу', nameEn: 'Echo Palm',
    costType: 'mana', cost: 20, cooldown: 7, range: 45, icon: '👥', iconColor: '#a78bfa',
    descUk: 'Удар, після якого фантом монаха повторює ту саму атаку через 1 сек.',
    descEn: 'Strikes foe, causing a spectral echo to repeat the strike 1s later.'
  },
  {
    id: 'mnk_ego_crusher', class: 'Monk', type: 'melee',
    nameUk: 'Знищення его', nameEn: 'Ego Crusher',
    costType: 'mana', cost: 22, cooldown: 14, range: 40, icon: '🧠', iconColor: '#c084fc',
    descUk: 'Удар по лобі, що спалює ману та знімає один позитивний баф з цілі.',
    descEn: 'Forehead strike burning enemy mana and dispelling one positive buff.'
  },
  {
    id: 'mnk_flowing_strike', class: 'Monk', type: 'melee',
    nameUk: 'Атака нескінченного потоку', nameEn: 'Flowing Strike',
    costType: 'mana', cost: 12, cooldown: 4, range: 50, icon: '🌊', iconColor: '#06b6d4',
    descUk: 'Монах робить удар і миттєво робить перекат за спину ворога.',
    descEn: 'Strikes through target, tumbling immediately behind their back.'
  },

  // Monk Magic & Chi
  {
    id: 'mnk_chi_wave', class: 'Monk', type: 'magic',
    nameUk: 'Хвиля Ці', nameEn: 'Chi Wave',
    costType: 'mana', cost: 25, cooldown: 8, range: 180, icon: '🌊', iconColor: '#10b981',
    descUk: 'Сфера духовної енергії, яка скаче між союзниками (лікує) та ворогами (ранить).',
    descEn: 'Bounces between allies (healing) and enemies (harming).'
  },
  {
    id: 'mnk_jade_serpent_beam', class: 'Monk', type: 'magic',
    nameUk: 'Промінь нефритового змія', nameEn: 'Jade Serpent Beam',
    costType: 'mana', cost: 20, cooldown: 0, range: 200, icon: '🐉', iconColor: '#059669',
    descUk: 'Потік зеленої духовної енергії, що наносить постійну магічну шкоду.',
    descEn: 'Channels a soothing or destructive stream of jade dragon energy.'
  },
  {
    id: 'mnk_sphere_of_harmony', class: 'Monk', type: 'magic',
    nameUk: 'Сфера гармонії', nameEn: 'Sphere of Harmony',
    costType: 'mana', cost: 30, cooldown: 10, range: 160, icon: '🔮', iconColor: '#34d399',
    descUk: 'Запускає повільну енергетичну сферу, що вибухає при повторному натисканні.',
    descEn: 'Fires slow-moving orb of equilibrium detonatable on reactivation.'
  },
  {
    id: 'mnk_spirit_burst', class: 'Monk', type: 'magic',
    nameUk: 'Духовний вибух', nameEn: 'Spirit Burst',
    costType: 'mana', cost: 24, cooldown: 8, range: 80, icon: '✨', iconColor: '#fbbf24',
    descUk: 'Вивільнення енергії Ці навколо монаха, що осліплює ворогів спалахом світла.',
    descEn: 'Radial burst of pure Chi blinding and staggering nearby foes.'
  },
  {
    id: 'mnk_zen_bell_resonance', class: 'Monk', type: 'magic',
    nameUk: 'Дзвін спокою', nameEn: 'Zen Bell Resonance',
    costType: 'mana', cost: 35, cooldown: 20, range: 120, icon: '🔔', iconColor: '#f59e0b',
    descUk: 'Викликає фантомний магічний дзвін, звук якого ранить ворогів щосекунди.',
    descEn: 'Summons a spectral temple bell chiming harmonic waves of damage.'
  },
  {
    id: 'mnk_mist_walk', class: 'Monk', type: 'magic',
    nameUk: 'Стрибок крізь туман', nameEn: 'Mist Walk',
    costType: 'mana', cost: 20, cooldown: 10, range: 180, icon: '🌫️', iconColor: '#a7f3d0',
    descUk: 'Телепортація до союзника чи ворога з накладанням захисного туману.',
    descEn: 'Dashes through mist to ally or enemy, shielding the destination.'
  },
  {
    id: 'mnk_leaf_storm', class: 'Monk', type: 'magic',
    nameUk: 'Вихор листя', nameEn: 'Leaf Storm',
    costType: 'mana', cost: 28, cooldown: 14, range: 100, icon: '🍃', iconColor: '#16a34a',
    descUk: 'Потік духовного вітру, що відштовхує ворожі магічні снаряди назад.',
    descEn: 'Spins a gale of leaves deflecting incoming enemy projectiles.'
  },
  {
    id: 'mnk_dragons_breath', class: 'Monk', type: 'magic',
    nameUk: 'Вогняне дихання дракона', nameEn: 'Dragon\'s Breath',
    costType: 'mana', cost: 30, cooldown: 10, range: 120, icon: '🔥', iconColor: '#ea580c',
    descUk: 'Монах видихає потік полум\'я Ці перед собою.',
    descEn: 'Exhales an intense plume of Chi fire in a wide frontal cone.'
  },
  {
    id: 'mnk_astral_projection', class: 'Monk', type: 'magic',
    nameUk: 'Астральна проекція', nameEn: 'Astral Projection',
    costType: 'mana', cost: 40, cooldown: 45, range: 200, icon: '👤', iconColor: '#818cf8',
    descUk: 'Відокремлює дух від тіла на 5 сек, дозволяючи бити ворогів на відстані.',
    descEn: 'Projects spirit form forward to fight remotely for 5s.'
  },
  {
    id: 'mnk_heavenly_discharge', class: 'Monk', type: 'magic',
    nameUk: 'Небесний розряд', nameEn: 'Heavenly Discharge',
    costType: 'mana', cost: 45, cooldown: 25, range: 180, icon: '⚡', iconColor: '#facc15',
    descUk: 'Вертикальний стовп світла Ці, що б\'є в цільову область.',
    descEn: 'Calls down a beam of celestial lightning from the heavens.'
  },

  // Monk Buffs
  {
    id: 'mnk_fast_mana_aura', class: 'Monk', type: 'buff',
    nameUk: 'Аура відновлення мани', nameEn: 'Fast Mana Aura',
    costType: 'mana', cost: 0, cooldown: 0, range: 120, icon: '🧘', iconColor: '#38bdf8',
    descUk: 'Пасивно/активно збільшує регенерацію мани для себе і групи на 100%.',
    descEn: 'Aura doubling mana regeneration rate for monk and nearby party.'
  },
  {
    id: 'mnk_jade_body', class: 'Monk', type: 'buff',
    nameUk: 'Тіло з нефриту', nameEn: 'Jade Body',
    costType: 'mana', cost: 25, cooldown: 30, range: 0, icon: '🟢', iconColor: '#059669',
    descUk: 'Зменшує отримувану магічну шкоду на 40% на 10 сек.',
    descEn: 'Hardens skin into jade, cutting magical damage taken by 40% for 10s.'
  },
  {
    id: 'mnk_drunken_brawler_stance', class: 'Monk', type: 'buff',
    nameUk: 'Стійка п\'яного майстра', nameEn: 'Drunken Brawler Stance',
    costType: 'mana', cost: 15, cooldown: 5, range: 0, icon: '🍶', iconColor: '#d97706',
    descUk: 'Стійка: +35% шанс ухилення; при кожному ухиленні наносить удар у відповідь.',
    descEn: 'Stance granting +35% dodge chance and automatic counter-strikes on dodge.'
  },
  {
    id: 'mnk_inner_peace', class: 'Monk', type: 'buff',
    nameUk: 'Внутрішній спокій', nameEn: 'Inner Peace',
    costType: 'mana', cost: 20, cooldown: 35, range: 0, icon: '🕊️', iconColor: '#f1f5f9',
    descUk: 'Знімає всі негативні ефекти і відновлює 30% здоров\'я за 3 сек.',
    descEn: 'Purges all debuffs and channels 30% max health restoration over 3s.'
  },
  {
    id: 'mnk_tiger_stance', class: 'Monk', type: 'buff',
    nameUk: 'Стійка тигра', nameEn: 'Tiger Stance',
    costType: 'mana', cost: 10, cooldown: 5, range: 0, icon: '🐯', iconColor: '#f97316',
    descUk: 'Збільшує швидкість пересування на 25% та швидкість атаки на 30%.',
    descEn: 'Increases movement speed by 25% and attack speed by 30%.'
  },
  {
    id: 'mnk_touch_of_life', class: 'Monk', type: 'buff',
    nameUk: 'Дотик життя', nameEn: 'Touch of Life',
    costType: 'mana', cost: 35, cooldown: 20, range: 80, icon: '💖', iconColor: '#ec4899',
    descUk: 'Миттєве лікування союзника або себе на велику кількість HP.',
    descEn: 'Instant powerful single-target healing burst.'
  },
  {
    id: 'mnk_diamond_skin', class: 'Monk', type: 'buff',
    nameUk: 'Алмазна шкіра', nameEn: 'Diamond Skin',
    costType: 'mana', cost: 30, cooldown: 40, range: 0, icon: '💎', iconColor: '#e0e7ff',
    descUk: 'Поглинає наступні 500 одиниць будь-якої шкоди.',
    descEn: 'Envelops monk in diamond barrier absorbing next 500 damage.'
  },
  {
    id: 'mnk_zen_focus', class: 'Monk', type: 'buff',
    nameUk: 'Дзен-фокус', nameEn: 'Zen Focus',
    costType: 'mana', cost: 15, cooldown: 25, range: 0, icon: '🧘', iconColor: '#c084fc',
    descUk: 'Заклинання і вміння монаха не можуть бути перервані протягом 8 сек.',
    descEn: 'Uninterruptible casting and actions for 8s.'
  },
  {
    id: 'mnk_wind_blessing', class: 'Monk', type: 'buff',
    nameUk: 'Благословення вітру', nameEn: 'Wind Blessing',
    costType: 'mana', cost: 25, cooldown: 30, range: 120, icon: '🍃', iconColor: '#67e8f9',
    descUk: 'Дає всій групі +20% до швидкості бігу на 15 сек.',
    descEn: 'Grants entire party +20% movement speed for 15s.'
  },
  {
    id: 'mnk_karma_redirection', class: 'Monk', type: 'buff',
    nameUk: 'Перенаправлення енергії (Карма)', nameEn: 'Karma Redirection',
    costType: 'mana', cost: 40, cooldown: 50, range: 0, icon: '☯️', iconColor: '#a855f7',
    descUk: '50% шкоди, яку отримує монах, дзеркально повертається атакуючому.',
    descEn: 'Reflects 50% of all incoming damage back to attackers.'
  },

  // Monk Debuffs
  {
    id: 'mnk_chakra_block', class: 'Monk', type: 'debuff',
    nameUk: 'Блокування чакр', nameEn: 'Chakra Block',
    costType: 'mana', cost: 20, cooldown: 18, range: 60, icon: '🛑', iconColor: '#ef4444',
    descUk: 'Ворог не може регенерувати ману чи здоров\'я протягом 8 сек.',
    descEn: 'Completely seals enemy mana and health regeneration for 8s.'
  },
  {
    id: 'mnk_paralysis_touch', class: 'Monk', type: 'debuff',
    nameUk: 'Паралізуючий дотик', nameEn: 'Paralysis Touch',
    costType: 'mana', cost: 22, cooldown: 20, range: 45, icon: '⚡', iconColor: '#eab308',
    descUk: 'Заморожує ворога на місці на 4 сек (розбивається шкодою).',
    descEn: 'Paralyzes foe for 4s; breaks on heavy incoming damage.'
  },
  {
    id: 'mnk_karmic_burden', class: 'Monk', type: 'debuff',
    nameUk: 'Тягар карми', nameEn: 'Karmic Burden',
    costType: 'mana', cost: 18, cooldown: 14, range: 120, icon: '⚖️', iconColor: '#64748b',
    descUk: 'Знижує швидкість атаки і пересування ворога на 40%.',
    descEn: 'Weighs enemy down reducing movement and attack speed by 40%.'
  },
  {
    id: 'mnk_winded', class: 'Monk', type: 'debuff',
    nameUk: 'Розрив дихання', nameEn: 'Winded',
    costType: 'mana', cost: 16, cooldown: 12, range: 45, icon: '💨', iconColor: '#94a3b8',
    descUk: 'Збільшує вартість використання здібностей ворога на 50% на 8 сек.',
    descEn: 'Knocks wind out of target, raising ability costs by 50% for 8s.'
  },
  {
    id: 'mnk_spirit_blindness', class: 'Monk', type: 'debuff',
    nameUk: 'Сліпота духу', nameEn: 'Spirit Blindness',
    costType: 'mana', cost: 20, cooldown: 15, range: 100, icon: '👁️', iconColor: '#475569',
    descUk: 'Знижує дальність огляду і радіус атак супротивника на 60%.',
    descEn: 'Blinds enemy vision and shortens attack range by 60%.'
  },
  {
    id: 'mnk_disorienting_palm', class: 'Monk', type: 'debuff',
    nameUk: 'Збентеження', nameEn: 'Disorienting Palm',
    costType: 'mana', cost: 14, cooldown: 10, range: 40, icon: '💫', iconColor: '#f59e0b',
    descUk: 'Змушує ворога безладно блукати протягом 3 сек.',
    descEn: 'Confuses opponent causing erratic wandering for 3s.'
  },
  {
    id: 'mnk_weakened_flesh', class: 'Monk', type: 'debuff',
    nameUk: 'Знесилення плоті', nameEn: 'Weakened Flesh',
    costType: 'mana', cost: 18, cooldown: 12, range: 50, icon: '💔', iconColor: '#be123c',
    descUk: 'Збільшує отримувану ворогом фізичну шкоду на 25% на 10 сек.',
    descEn: 'Increases physical damage taken by target by 25% for 10s.'
  },
  {
    id: 'mnk_off_balance', class: 'Monk', type: 'debuff',
    nameUk: 'Порушення рівноваги', nameEn: 'Off-Balance',
    costType: 'mana', cost: 12, cooldown: 8, range: 45, icon: '🤼', iconColor: '#d97706',
    descUk: 'Кожен удар по ворогу збиває його з ніг із шансом 25%.',
    descEn: 'Attacks against this foe have a 25% chance to knock down.'
  },
  {
    id: 'mnk_echo_of_pain', class: 'Monk', type: 'debuff',
    nameUk: 'Відлуння страждання', nameEn: 'Echo of Pain',
    costType: 'mana', cost: 24, cooldown: 16, range: 60, icon: '🔔', iconColor: '#9333ea',
    descUk: 'Через 4 сек ворог отримує 40% від усієї шкоди, нанесеної йому за цей час.',
    descEn: 'Reverberates after 4s dealing 40% of all damage sustained during the interval.'
  },
  {
    id: 'mnk_muffle', class: 'Monk', type: 'debuff',
    nameUk: 'Стишення голосу', nameEn: 'Muffle',
    costType: 'mana', cost: 15, cooldown: 14, range: 50, icon: '🔇', iconColor: '#334155',
    descUk: 'Ворог не може кричати або застосовувати командні аури.',
    descEn: 'Muffles opponent silencing warcries and aura skills.'
  },

  // =========================================================================
  // 4. CULTIST (Культист) — 50 skills (Casts with Life!)
  // =========================================================================
  {
    id: 'cul_sacrificial_stab', class: 'Cultist', type: 'melee',
    nameUk: 'Жертовний кинджал', nameEn: 'Sacrificial Stab',
    costType: 'hp', cost: 15, cooldown: 1, range: 40, icon: '🗡️', iconColor: '#991b1b',
    descUk: 'Витрачає 15 HP, завдає 200% шкоди темрявою та краде 10% здоров\'я ворога.',
    descEn: 'Costs 15 HP to strike for 200% shadow damage, leeching 10% target health.'
  },
  {
    id: 'cul_blood_scythe', class: 'Cultist', type: 'melee',
    nameUk: 'Кривава коса', nameEn: 'Blood Scythe',
    costType: 'hp', cost: 25, cooldown: 5, range: 60, icon: '🩸', iconColor: '#dc2626',
    descUk: 'Широкий півкруглий удар косою, що накладає глибоку криваву рану на всіх ворогів.',
    descEn: 'Semi-circular scythe sweep inflicting heavy bleed on all targets hit.'
  },
  {
    id: 'cul_heartstopper', class: 'Cultist', type: 'melee',
    nameUk: 'Удар серцебиття', nameEn: 'Heartstopper',
    costType: 'hp', cost: 30, cooldown: 8, range: 35, icon: '🫀', iconColor: '#7f1d1d',
    descUk: 'Удар рукою в груди ворога, що викликає сильний мікро-стан на 1 сек.',
    descEn: 'Gripping strike at the heart stunning target for 1s.'
  },
  {
    id: 'cul_flesh_siphon_strike', class: 'Cultist', type: 'melee',
    nameUk: 'Випивання плоті', nameEn: 'Flesh Siphon Strike',
    costType: 'hp', cost: 20, cooldown: 6, range: 40, icon: '🥩', iconColor: '#b91c1c',
    descUk: 'Удар пазурами, який виліковує культиста на повну суму нанесеної шкоди.',
    descEn: 'Claw rake restoring 100% of damage dealt as cultist health.'
  },
  {
    id: 'cul_vein_ripper', class: 'Cultist', type: 'melee',
    nameUk: 'Розрив судин', nameEn: 'Vein Ripper',
    costType: 'hp', cost: 18, cooldown: 4, range: 40, icon: '🩸', iconColor: '#e11d48',
    descUk: 'Удар, який завдає додаткової шкоди за кожен ефект кровотечі на ворогу.',
    descEn: 'Strikes target dealing massive bonus damage per active bleed stack.'
  },
  {
    id: 'cul_spike_of_agony', class: 'Cultist', type: 'melee',
    nameUk: 'Чорний шип з долоні', nameEn: 'Spike of Agony',
    costType: 'hp', cost: 22, cooldown: 5, range: 45, icon: '🦴', iconColor: '#334155',
    descUk: 'Пронизуючий удар шипом із кістки, що пробиває броню ворога наскрізь.',
    descEn: 'Bone spike protruding from palm piercing through all enemy armor.'
  },
  {
    id: 'cul_corpse_cleave', class: 'Cultist', type: 'melee',
    nameUk: 'Трупне розсікання', nameEn: 'Corpse Cleave',
    costType: 'hp', cost: 20, cooldown: 7, range: 50, icon: '⚰️', iconColor: '#451a03',
    descUk: 'Удар по ворогу; якщо поруч є трупи, вони вибухають додатковою шкодою.',
    descEn: 'Melee cleave detonating any nearby corpses for bonus area damage.'
  },
  {
    id: 'cul_martyrs_flail', class: 'Cultist', type: 'melee',
    nameUk: 'Кара мученика', nameEn: 'Martyr\'s Flail',
    costType: 'hp', cost: 28, cooldown: 6, range: 55, icon: '⛓️', iconColor: '#881337',
    descUk: 'Удар ланцюгом: чим менше HP у культиста, тим більшої шкоди завдає удар.',
    descEn: 'Spiked flail strike scaling in damage inversely with cultist current HP.'
  },
  {
    id: 'cul_vampiric_bite', class: 'Cultist', type: 'melee',
    nameUk: 'Вампіричний укус', nameEn: 'Vampiric Bite',
    costType: 'hp', cost: 10, cooldown: 10, range: 30, icon: '🧛', iconColor: '#991b1b',
    descUk: 'Ближній укус у шию, що паралізує ціль на 1.5 сек і лікує культиста.',
    descEn: 'Bites target neck, paralyzing for 1.5s and healing cultist.'
  },
  {
    id: 'cul_defiled_strike', class: 'Cultist', type: 'melee',
    nameUk: 'Проклятий розпил', nameEn: 'Defiled Strike',
    costType: 'hp', cost: 20, cooldown: 8, range: 45, icon: '☣️', iconColor: '#4c1d95',
    descUk: 'Melee удар, що переносить усі дебафи з культиста на атакованого ворога.',
    descEn: 'Transfers all active debuffs from cultist onto the struck enemy.'
  },

  // Cultist Blood & Dark Magic
  {
    id: 'cul_blood_orb', class: 'Cultist', type: 'magic',
    nameUk: 'Кривава куля', nameEn: 'Blood Orb',
    costType: 'hp', cost: 30, cooldown: 2, range: 180, icon: '🔴', iconColor: '#dc2626',
    descUk: 'Випускає сферу киплячої крові, що вибухає кров\'яним душем.',
    descEn: 'Hurls boiling orb of blood exploding in a bloody shower.'
  },
  {
    id: 'cul_blood_lance', class: 'Cultist', type: 'magic',
    nameUk: 'Спис із крові', nameEn: 'Blood Lance',
    costType: 'hp', cost: 35, cooldown: 4, range: 220, icon: '💉', iconColor: '#b91c1c',
    descUk: 'Швидкий довгий спис, що пробиває лінію ворогів.',
    descEn: 'Conjures a piercing lance of crystallized blood piercing a line.'
  },
  {
    id: 'cul_blood_boil', class: 'Cultist', type: 'magic',
    nameUk: 'Кипіння крові', nameEn: 'Blood Boil',
    costType: 'hp', cost: 40, cooldown: 12, range: 120, icon: '🩸', iconColor: '#ef4444',
    descUk: 'Змушує кров усіх ворогів навколо закипати, наносячи сильний DoT.',
    descEn: 'Causes blood of all surrounding enemies to boil for heavy DoT.'
  },
  {
    id: 'cul_corpse_explosion', class: 'Cultist', type: 'magic',
    nameUk: 'Вибух трупа', nameEn: 'Corpse Explosion',
    costType: 'hp', cost: 15, cooldown: 3, range: 180, icon: '💥', iconColor: '#7f1d1d',
    descUk: 'Підриває труп ворога, наносячи 30% від його максимального HP як AoE.',
    descEn: 'Detonates a target corpse dealing 30% of its max HP as area damage.'
  },
  {
    id: 'cul_sanguine_pool', class: 'Cultist', type: 'magic',
    nameUk: 'Кривавий вир', nameEn: 'Sanguine Pool',
    costType: 'hp', cost: 45, cooldown: 20, range: 0, icon: '🩸', iconColor: '#991b1b',
    descUk: 'Культист розчиняється в калюжу крові на 3 сек, стаючи невразливим.',
    descEn: 'Dissolves into untargetable pool of blood damaging enemies above for 3s.'
  },
  {
    id: 'cul_bone_storm', class: 'Cultist', type: 'magic',
    nameUk: 'Злива кісток', nameEn: 'Bone Storm',
    costType: 'hp', cost: 50, cooldown: 30, range: 100, icon: '🌪️', iconColor: '#e2e8f0',
    descUk: 'Вихор із гострих уламків кісток навколо культиста на 6 сек.',
    descEn: 'Whirlwind of bone shards orbiting the cultist shredding nearby foes.'
  },
  {
    id: 'cul_shadow_grasp', class: 'Cultist', type: 'magic',
    nameUk: 'Хватка мороку', nameEn: 'Shadow Grasp',
    costType: 'hp', cost: 25, cooldown: 10, range: 160, icon: '🖐️', iconColor: '#312e81',
    descUk: 'Руки тіні тягнуться із землі у вказаній точці, утримуючи ворогів на 3 сек.',
    descEn: 'Shadowy hands erupt from ground rooting enemies in area for 3s.'
  },
  {
    id: 'cul_abyssal_beam', class: 'Cultist', type: 'magic',
    nameUk: 'Пекельний потік', nameEn: 'Abyssal Beam',
    costType: 'hp', cost: 12, cooldown: 0, range: 200, icon: '🟣', iconColor: '#581c87',
    descUk: 'Безперервний потік темного полум\'я, що спалює здоров\'я ворогів.',
    descEn: 'Channels continuous dark fire ray consuming health per tick.'
  },
  {
    id: 'cul_summon_blood_golem', class: 'Cultist', type: 'magic',
    nameUk: 'Призов кривавого голема', nameEn: 'Summon Blood Golem',
    costType: 'hp', cost: 80, cooldown: 60, range: 80, icon: '🗿', iconColor: '#b91c1c',
    descUk: 'Витрачає здоров\'я для створення голема з крові, який б\'ється за культиста.',
    descEn: 'Constructs a hulking golem from cultist blood to fight alongside.'
  },
  {
    id: 'plague_globule', class: 'Cultist', type: 'magic',
    nameUk: 'Згусток чуми', nameEn: 'Plague Globule',
    costType: 'hp', cost: 25, cooldown: 4, range: 180, icon: '☣️', iconColor: '#15803d',
    descUk: 'Снаряд отрути та нежиті, що заражає ворогів інфекцією.',
    descEn: 'Toxic projectile infecting target and spreading upon target death.'
  },
  {
    id: 'cul_soul_drain', class: 'Cultist', type: 'magic',
    nameUk: 'Витягування душі', nameEn: 'Soul Drain',
    costType: 'hp', cost: 10, cooldown: 6, range: 160, icon: '👻', iconColor: '#6b21a8',
    descUk: 'Магічний канал, що безперервно викачує HP з ворога на відстані.',
    descEn: 'Channeled soul tether continuously leeching life from target.'
  },
  {
    id: 'cul_dark_star_fall', class: 'Cultist', type: 'magic',
    nameUk: 'Падіння темної зірки', nameEn: 'Dark Star Fall',
    costType: 'hp', cost: 70, cooldown: 35, range: 220, icon: '🖤', iconColor: '#0f172a',
    descUk: 'Сфера безодні падає з неба, завдаючи величезної шкоди темрявою.',
    descEn: 'Summons an abyssal black star crushing large area.'
  },
  {
    id: 'cul_circle_of_agony', class: 'Cultist', type: 'magic',
    nameUk: 'Кільце агонії', nameEn: 'Circle of Agony',
    costType: 'hp', cost: 35, cooldown: 18, range: 160, icon: '⭕', iconColor: '#701a75',
    descUk: 'Проклята зона на землі: вороги всередині втрачають 5% HP щосекунди.',
    descEn: 'Desecrated ground draining 5% max HP per second from occupants.'
  },
  {
    id: 'cul_bone_spear', class: 'Cultist', type: 'magic',
    nameUk: 'Кістяне списометання', nameEn: 'Bone Spear',
    costType: 'hp', cost: 30, cooldown: 3, range: 200, icon: '🦴', iconColor: '#f1f5f9',
    descUk: 'Вистрілює трьома гострими кістками віялом.',
    descEn: 'Launches a fan of 3 sharp bone spears piercing foes.'
  },
  {
    id: 'cul_minion_sacrifice', class: 'Cultist', type: 'magic',
    nameUk: 'Жертвоприношення міньйона', nameEn: 'Minion Sacrifice',
    costType: 'hp', cost: 0, cooldown: 20, range: 120, icon: '🩸', iconColor: '#be123c',
    descUk: 'Підриває свого кривавого голема для масивного лікування культиста.',
    descEn: 'Sacrifices summoned minion to heal cultist to full.'
  },
  {
    id: 'cul_death_decay', class: 'Cultist', type: 'magic',
    nameUk: 'Смертельний розпад', nameEn: 'Death Decay',
    costType: 'hp', cost: 35, cooldown: 15, range: 150, icon: '☠️', iconColor: '#166534',
    descUk: 'Створює калюжу гнилі, що розчиняє захисні ефекти ворогів.',
    descEn: 'Pool of rot stripping shields and rotting enemy armor.'
  },
  {
    id: 'cul_black_sun', class: 'Cultist', type: 'magic',
    nameUk: 'Чорне сонце', nameEn: 'Black Sun',
    costType: 'hp', cost: 60, cooldown: 45, range: 200, icon: '☀️', iconColor: '#1e1b4b',
    descUk: 'Заряджає темну кулю над головою, яка б\'є променями у всіх ворогів на екрані.',
    descEn: 'Black sun over cultist shooting dark rays at all on-screen foes.'
  },
  {
    id: 'cul_tentacles_of_the_deep', class: 'Cultist', type: 'magic',
    nameUk: 'Криваві щупальця', nameEn: 'Tentacles of the Deep',
    costType: 'hp', cost: 40, cooldown: 18, range: 140, icon: '🐙', iconColor: '#4a044e',
    descUk: 'Викликає щупальця безодні, що б\'ють ворогів і притягують їх до культиста.',
    descEn: 'Abyssal tentacles erupting from earth pulling enemies in.'
  },
  {
    id: 'cul_wave_of_torment', class: 'Cultist', type: 'magic',
    nameUk: 'Хвиля страждання', nameEn: 'Wave of Torment',
    costType: 'hp', cost: 30, cooldown: 10, range: 120, icon: '🌊', iconColor: '#581c87',
    descUk: 'Розбіжна хвиля темряви, яка дезорієнтує ворогів на 2 сек.',
    descEn: 'Expanding wave of suffering disorienting foes in area.'
  },
  {
    id: 'cul_final_rite', class: 'Cultist', type: 'magic',
    nameUk: 'Останній ритуал', nameEn: 'Final Rite',
    costType: 'hp', cost: 100, cooldown: 90, range: 150, icon: '💀', iconColor: '#881337',
    descUk: 'Витрачає 50% поточного HP, щоб нанести 500% шкоди всім ворогам навколо.',
    descEn: 'Sacrifices 50% current HP to inflict 500% apocalyptic dark damage around.'
  },

  // Cultist Buffs
  {
    id: 'cul_blood_pact', class: 'Cultist', type: 'buff',
    nameUk: 'Кривавий договір', nameEn: 'Blood Pact',
    costType: 'hp', cost: 0, cooldown: 0, range: 0, icon: '📜', iconColor: '#b91c1c',
    descUk: 'Збільшує максимальний запас здоров\'я на 40% та силу заклинань темряви на 25%.',
    descEn: 'Passive aura increasing max HP by 40% and dark spell power by 25%.'
  },
  {
    id: 'cul_bone_armor', class: 'Cultist', type: 'buff',
    nameUk: 'Броня з кісток', nameEn: 'Bone Armor',
    costType: 'hp', cost: 30, cooldown: 30, range: 0, icon: '🦴', iconColor: '#e2e8f0',
    descUk: 'Оточує культиста щитом із 3 кісток, які поглинають наступні 3 удари.',
    descEn: 'Orbiting bones absorbing the next 3 incoming hits completely.'
  },
  {
    id: 'cul_fanatic_frenzy', class: 'Cultist', type: 'buff',
    nameUk: 'Фанатичне безумство', nameEn: 'Fanatic Frenzy',
    costType: 'hp', cost: 20, cooldown: 25, range: 0, icon: '🩸', iconColor: '#ef4444',
    descUk: 'Чим менше у культиста HP, тим вища його швидкість атаки і касту (до +100%).',
    descEn: 'Grants up to +100% attack and cast speed scaling inversely with HP.'
  },
  {
    id: 'cul_vampiric_embrace', class: 'Cultist', type: 'buff',
    nameUk: 'Регенерація вампіра', nameEn: 'Vampiric Embrace',
    costType: 'hp', cost: 25, cooldown: 30, range: 0, icon: '🦇', iconColor: '#7f1d1d',
    descUk: '30% усієї шкоди, нанесеної культистом, перетворюється на лікування на 15 сек.',
    descEn: 'Converts 30% of all damage dealt into health for 15s.'
  },
  {
    id: 'cul_undead_resilience', class: 'Cultist', type: 'buff',
    nameUk: 'Стійкість мерця', nameEn: 'Undead Resilience',
    costType: 'hp', cost: 0, cooldown: 60, range: 0, icon: '🧟', iconColor: '#334155',
    descUk: 'Знижує всю отримувану шкоду на 50%, коли HP культиста падає нижче 30%.',
    descEn: 'Reduces all damage taken by 50% whenever HP drops below 30%.'
  },
  {
    id: 'cul_dark_blessing', class: 'Cultist', type: 'buff',
    nameUk: 'Чорне благословення', nameEn: 'Dark Blessing',
    costType: 'hp', cost: 20, cooldown: 40, range: 0, icon: '✨', iconColor: '#6b21a8',
    descUk: 'Дає імунітет до проклять та отрут на 30 сек.',
    descEn: 'Grants immunity to curses and poison effects for 30s.'
  },
  {
    id: 'cul_martyrdom_aura', class: 'Cultist', type: 'buff',
    nameUk: 'Еліксир мученика', nameEn: 'Martyrdom Aura',
    costType: 'hp', cost: 0, cooldown: 0, range: 120, icon: '🩸', iconColor: '#e11d48',
    descUk: 'Союзники отримують +15% шкоди за кожні 20% втраченого культистом HP.',
    descEn: 'Nearby allies gain +15% damage for every 20% health missing on cultist.'
  },
  {
    id: 'cul_life_transfusion', class: 'Cultist', type: 'buff',
    nameUk: 'Переливання життя', nameEn: 'Life Transfusion',
    costType: 'hp', cost: 50, cooldown: 15, range: 140, icon: '💉', iconColor: '#be123c',
    descUk: 'Культист жертвує 20% свого HP, щоб повністю зцілити обраного союзника.',
    descEn: 'Transfuses 20% cultist HP to completely heal selected ally.'
  },
  {
    id: 'cul_abyssal_cloak', class: 'Cultist', type: 'buff',
    nameUk: 'Покрив безодні', nameEn: 'Abyssal Cloak',
    costType: 'hp', cost: 20, cooldown: 25, range: 0, icon: '🥷', iconColor: '#1e1b4b',
    descUk: 'Робить культиста напівневидимим і збільшує швидкість бігу на 40% на 8 сек.',
    descEn: 'Cloaks cultist in shadows granting +40% move speed and partial stealth.'
  },
  {
    id: 'cul_blood_rebirth', class: 'Cultist', type: 'buff',
    nameUk: 'Переродження у крові', nameEn: 'Blood Rebirth',
    costType: 'hp', cost: 0, cooldown: 180, range: 0, icon: '🩸', iconColor: '#dc2626',
    descUk: 'При смерті культист вибухає і воскресає з 40% HP (кд 3 хв).',
    descEn: 'Upon death, detonates in blood and revives with 40% HP (3m CD).'
  },

  // Cultist Debuffs
  {
    id: 'cul_curse_of_frailty', class: 'Cultist', type: 'debuff',
    nameUk: 'Прокляття слабкості', nameEn: 'Curse of Frailty',
    costType: 'hp', cost: 20, cooldown: 15, range: 160, icon: '🥀', iconColor: '#a855f7',
    descUk: 'Зменшує фізичну та магічну шкоду цілі на 35% на 12 сек.',
    descEn: 'Curses target reducing its physical and spell damage by 35% for 12s.'
  },
  {
    id: 'cul_curse_of_doom', class: 'Cultist', type: 'debuff',
    nameUk: 'Прокляття приреченості', nameEn: 'Curse of Doom',
    costType: 'hp', cost: 30, cooldown: 20, range: 160, icon: '⌛', iconColor: '#450a0a',
    descUk: 'Через 10 сек після накладання наносить колосальну шкоду темрявою.',
    descEn: 'After 10s delay, detonates for apocalyptic shadow damage.'
  },
  {
    id: 'cul_curse_of_vulnerability', class: 'Cultist', type: 'debuff',
    nameUk: 'Прокляття вразливості', nameEn: 'Curse of Vulnerability',
    costType: 'hp', cost: 25, cooldown: 12, range: 160, icon: '💔', iconColor: '#701a75',
    descUk: 'Знижує опір до темряви та фізичної шкоди на 40% на 10 сек.',
    descEn: 'Lowers shadow and physical resistance of target by 40% for 10s.'
  },
  {
    id: 'cul_hemophilia', class: 'Cultist', type: 'debuff',
    nameUk: 'Гемофілія', nameEn: 'Hemophilia',
    costType: 'hp', cost: 18, cooldown: 10, range: 140, icon: '🩸', iconColor: '#dc2626',
    descUk: 'Збільшує тривалість та шкоду всіх кровотеч на цілі втричі.',
    descEn: 'Triples bleed duration and bleed tick damage on target.'
  },
  {
    id: 'cul_black_plague', class: 'Cultist', type: 'debuff',
    nameUk: 'Чорна чума', nameEn: 'Black Plague',
    costType: 'hp', cost: 25, cooldown: 14, range: 150, icon: '🐀', iconColor: '#14532d',
    descUk: 'Інфекційний дебаф, що передається на сусідніх ворогів при контакті.',
    descEn: 'Contagious plague infecting target and jumping to nearby allies.'
  },
  {
    id: 'cul_mind_rot', class: 'Cultist', type: 'debuff',
    nameUk: 'Гниття розуму', nameEn: 'Mind Rot',
    costType: 'hp', cost: 20, cooldown: 16, range: 140, icon: '🧠', iconColor: '#581c87',
    descUk: 'Збільшує час перезарядки скілів ворога на 3 сек.',
    descEn: 'Increases all target active cooldowns by 3s.'
  },
  {
    id: 'cul_shadow_veil', class: 'Cultist', type: 'debuff',
    nameUk: 'Сліпота темряви', nameEn: 'Shadow Veil',
    costType: 'hp', cost: 18, cooldown: 12, range: 150, icon: '🌑', iconColor: '#1e293b',
    descUk: 'Огортає ворога мороком, знижуючи його шанс попадання на 50%.',
    descEn: 'Shrouds target in darkness reducing their hit chance by 50%.'
  },
  {
    id: 'cul_curse_of_aging', class: 'Cultist', type: 'debuff',
    nameUk: 'Прокляття старіння', nameEn: 'Curse of Aging',
    costType: 'hp', cost: 22, cooldown: 15, range: 160, icon: '⏳', iconColor: '#78716c',
    descUk: 'Сповільнює швидкість пересування та атаки ворога на 45%.',
    descEn: 'Wedges target in decrepit aging, slowing attack and move speed by 45%.'
  },
  {
    id: 'cul_horror_of_the_void', class: 'Cultist', type: 'debuff',
    nameUk: 'Жах безодні', nameEn: 'Horror of the Void',
    costType: 'hp', cost: 35, cooldown: 25, range: 100, icon: '😱', iconColor: '#4a044e',
    descUk: 'Накладає панічний страх (Fear) на групу ворогів на 3 сек.',
    descEn: 'Unleashes void terror causing all nearby enemies to flee in fear for 3s.'
  },
  {
    id: 'cul_sacrificial_brand', class: 'Cultist', type: 'debuff',
    nameUk: 'Стигма жертви', nameEn: 'Sacrificial Brand',
    costType: 'hp', cost: 25, cooldown: 20, range: 160, icon: '🔥', iconColor: '#991b1b',
    descUk: '20% шкоди, яку отримує культист, дзеркально наноситься позначеному ворогу.',
    descEn: 'Brands target: 20% of damage taken by cultist is echoed to target.'
  },

  // =========================================================================
  // 5. ARCHER (Лучник) — 50 skills
  // =========================================================================
  {
    id: 'arc_kidney_strike', class: 'Archer', type: 'melee',
    nameUk: 'Удар кинджалом у печінку', nameEn: 'Kidney Strike',
    costType: 'stamina', cost: 15, cooldown: 8, range: 35, icon: '🗡️', iconColor: '#f59e0b',
    descUk: 'Швидкий колючий удар у ближньому бою, що паралізує ворога на 2 сек.',
    descEn: 'Short dagger jab paralyzing target in melee for 2s.'
  },
  {
    id: 'arc_vault', class: 'Archer', type: 'melee',
    nameUk: 'Акробатичний стрибок назад', nameEn: 'Vault',
    costType: 'stamina', cost: 20, cooldown: 6, range: 50, icon: '🤸', iconColor: '#38bdf8',
    descUk: 'Стрибок відштовхуванням від ворога назад на 6 клітинок із вистрілом стріли.',
    descEn: 'Kicks off enemy chest leaping 6 tiles back while firing an arrow.'
  },
  {
    id: 'arc_fan_of_knives', class: 'Archer', type: 'melee',
    nameUk: 'Розсікаючий віяловий ніж', nameEn: 'Fan of Knives',
    costType: 'stamina', cost: 25, cooldown: 6, range: 60, icon: '🗡️', iconColor: '#e2e8f0',
    descUk: 'Метляє 8 ножів навколо себе, завдаючи шкоди всім у радіусі 2 клітинок.',
    descEn: 'Hurls 8 spinning daggers radially around the archer.'
  },
  {
    id: 'arc_bow_bash', class: 'Archer', type: 'melee',
    nameUk: 'Удар дугою лука', nameEn: 'Bow Bash',
    costType: 'stamina', cost: 12, cooldown: 5, range: 35, icon: '🏹', iconColor: '#b45309',
    descUk: 'Удар луком по обличчю ворога, що відкидає його на 3 клітинки і збиває з ніг.',
    descEn: 'Smacks target in face with bow stave, knocking back 3 tiles.'
  },
  {
    id: 'arc_shadowstep', class: 'Archer', type: 'melee',
    nameUk: 'Тіньовий крок', nameEn: 'Shadowstep',
    costType: 'stamina', cost: 22, cooldown: 12, range: 140, icon: '👤', iconColor: '#6366f1',
    descUk: 'Миттєве переміщення за спину ворога з нанесенням критичного удару кинджалом.',
    descEn: 'Teleports behind target back and delivers guaranteed critical stab.'
  },
  {
    id: 'arc_hunters_trip', class: 'Archer', type: 'melee',
    nameUk: 'Підсічка мисливця', nameEn: 'Hunter\'s Trip',
    costType: 'stamina', cost: 14, cooldown: 6, range: 40, icon: '🩼', iconColor: '#a1a1aa',
    descUk: 'Підсікає ноги ворога, знерухомлюючи його на 2.5 сек.',
    descEn: 'Trips enemy legs immobilizing them for 2.5s.'
  },
  {
    id: 'arc_throat_slit', class: 'Archer', type: 'melee',
    nameUk: 'Колотий випад у горло', nameEn: 'Throat Slit',
    costType: 'stamina', cost: 25, cooldown: 15, range: 35, icon: '🩸', iconColor: '#991b1b',
    descUk: 'Атака зі спини, що завдає 300% шкоди та накладає німоту (Silence).',
    descEn: 'Backstab attack dealing 300% damage and silencing target.'
  },
  {
    id: 'arc_tumble', class: 'Archer', type: 'melee',
    nameUk: 'Швидкісний відскок', nameEn: 'Tumble',
    costType: 'stamina', cost: 12, cooldown: 4, range: 100, icon: '🔄', iconColor: '#10b981',
    descUk: 'Перекат у вказаному напрямку, що скидає всі ефекти уповільнення.',
    descEn: 'Acrobatic roll breaking all active slows and roots.'
  },
  {
    id: 'arc_disengage_slash', class: 'Archer', type: 'melee',
    nameUk: 'Вибивання з рівноваги', nameEn: 'Disengage Slash',
    costType: 'stamina', cost: 16, cooldown: 7, range: 45, icon: '⚔️', iconColor: '#f97316',
    descUk: 'Удар ножем із миттєвим розривом дистанції на 4 клітинки.',
    descEn: 'Quick dagger swipe instantly leaping 4 tiles backwards.'
  },
  {
    id: 'arc_whirling_blades', class: 'Archer', type: 'melee',
    nameUk: 'Круговий поріз', nameEn: 'Whirling Blades',
    costType: 'stamina', cost: 20, cooldown: 5, range: 50, icon: '🗡️', iconColor: '#ef4444',
    descUk: 'Кругова атака двома клинками, що накладає кровотечу на всіх довкола.',
    descEn: 'Spins dual daggers applying bleed to all surrounding enemies.'
  },
  {
    id: 'arc_poison_shiv', class: 'Archer', type: 'melee',
    nameUk: 'Укол отруєним лезом', nameEn: 'Poison Shiv',
    costType: 'stamina', cost: 15, cooldown: 4, range: 40, icon: '🧪', iconColor: '#16a34a',
    descUk: 'Удар кинджалом, що впорскує смертельну отруту сповільненої дії.',
    descEn: 'Shivs target with potent delayed neurotoxic poison.'
  },
  {
    id: 'arc_pocket_sand', class: 'Archer', type: 'melee',
    nameUk: 'Сліпучий пісок', nameEn: 'Pocket Sand',
    costType: 'stamina', cost: 10, cooldown: 10, range: 45, icon: '⏳', iconColor: '#eab308',
    descUk: 'Кидок піску в очі впритул, що осліплює ворога на 3 сек.',
    descEn: 'Throws sand into enemy eyes blinding them for 3s.'
  },
  {
    id: 'arc_riposte_roll', class: 'Archer', type: 'melee',
    nameUk: 'Контратака перекатом', nameEn: 'Riposte Roll',
    costType: 'stamina', cost: 18, cooldown: 8, range: 50, icon: '↩️', iconColor: '#06b6d4',
    descUk: 'Ухиляється від атаки і автоматично завдає удару у відкриту спину ворога.',
    descEn: 'Dodges incoming attack and automatically retaliates from the rear.'
  },
  {
    id: 'arc_chin_jab', class: 'Archer', type: 'melee',
    nameUk: 'Удар ефесом у підборіддя', nameEn: 'Chin Jab',
    costType: 'stamina', cost: 14, cooldown: 6, range: 35, icon: '👊', iconColor: '#71717a',
    descUk: 'Дезорієнтує ворога на 2 сек, знижуючи його броню.',
    descEn: 'Disorients target with swift chin bash, reducing armor.'
  },
  {
    id: 'arc_ambush_flurry', class: 'Archer', type: 'melee',
    nameUk: 'Засадний розтин', nameEn: 'Ambush Flurry',
    costType: 'stamina', cost: 26, cooldown: 14, range: 40, icon: '🥷', iconColor: '#881337',
    descUk: '3 блискавичні удари кинджалом, якщо лучник атакував із невидимості.',
    descEn: '3 critical dagger strikes executed from stealth.'
  },

  // Archer Ranged & Magic Arrows
  {
    id: 'arc_aimed_shot', class: 'Archer', type: 'magic',
    nameUk: 'Прицільний постріл', nameEn: 'Aimed Shot',
    costType: 'stamina', cost: 25, cooldown: 4, range: 260, icon: '🎯', iconColor: '#ef4444',
    descUk: 'Потужний постріл із підвищеним шансом криту (+40%) та 250% шкоди.',
    descEn: 'Carefully aimed sniper shot with +40% crit chance and 250% damage.'
  },
  {
    id: 'arc_barrage', class: 'Archer', type: 'magic',
    nameUk: 'Шквал стріл', nameEn: 'Barrage',
    costType: 'stamina', cost: 35, cooldown: 8, range: 220, icon: '🏹', iconColor: '#f97316',
    descUk: 'Вистрілює конус із 12 стріл перед собою за 1.5 секунди.',
    descEn: 'Rapidly unloads a 12-arrow barrage in a forward cone.'
  },
  {
    id: 'arc_lightning_arrow', class: 'Archer', type: 'magic',
    nameUk: 'Громова стріла', nameEn: 'Lightning Arrow',
    costType: 'mana', cost: 25, cooldown: 5, range: 240, icon: '⚡', iconColor: '#eab308',
    descUk: 'Стріла б\'є блискавкою в ціль і вражає до 4 сусідніх ворогів струмом.',
    descEn: 'Electrified arrow shocking primary target and 4 adjacent foes.'
  },
  {
    id: 'arc_explosive_arrow', class: 'Archer', type: 'magic',
    nameUk: 'Вогняна вибухова стріла', nameEn: 'Explosive Arrow',
    costType: 'mana', cost: 30, cooldown: 6, range: 220, icon: '💥', iconColor: '#dc2626',
    descUk: 'Застрягає у ворогу та детонує через 1.5 сек, завдаючи AoE вогнем.',
    descEn: 'Fires explosive charge arrow detonating after 1.5s delay.'
  },
  {
    id: 'arc_frost_arrow', class: 'Archer', type: 'magic',
    nameUk: 'Крижана стріла скорботи', nameEn: 'Frost Arrow',
    costType: 'mana', cost: 20, cooldown: 3, range: 230, icon: '❄️', iconColor: '#38bdf8',
    descUk: 'Заморожує ціль та залишає льодову стежку на землі.',
    descEn: 'Freezing arrow chilling target and coating the path in slick ice.'
  },
  {
    id: 'arc_piercing_shot', class: 'Archer', type: 'magic',
    nameUk: 'Пронизуючий постріл', nameEn: 'Piercing Shot',
    costType: 'stamina', cost: 22, cooldown: 5, range: 280, icon: '🏹', iconColor: '#cbd5e1',
    descUk: 'Стріла летить крізь усіх ворогів на прямій лінії на 15 клітинок.',
    descEn: 'High-velocity arrow piercing straight through all enemies in path.'
  },
  {
    id: 'arc_rain_of_arrows', class: 'Archer', type: 'magic',
    nameUk: 'Град стріл', nameEn: 'Rain of Arrows',
    costType: 'stamina', cost: 40, cooldown: 18, range: 220, icon: '🌧️', iconColor: '#94a3b8',
    descUk: 'Запускає залп у небо, що обрушується дощем стріл на площу 5х5 клітинок.',
    descEn: 'Fires salvo high into the air raining down over target 5x5 area.'
  },
  {
    id: 'arc_shadow_shot', class: 'Archer', type: 'magic',
    nameUk: 'Тіньова стріла', nameEn: 'Shadow Shot',
    costType: 'mana', cost: 25, cooldown: 10, range: 200, icon: '🌑', iconColor: '#6366f1',
    descUk: 'Прив\'язує враженого ворога темними путами до землі на 3 сек.',
    descEn: 'Tethers target to ground with shadow tendrils preventing movement.'
  },
  {
    id: 'arc_venom_arrow', class: 'Archer', type: 'magic',
    nameUk: 'Отруйна стріла кобри', nameEn: 'Venom Arrow',
    costType: 'stamina', cost: 18, cooldown: 2, range: 220, icon: '🐍', iconColor: '#16a34a',
    descUk: 'Накладає сильний отруйний DoT на 8 сек, який можна стакати до 5 разів.',
    descEn: 'Poison arrow stacking deadly venom up to 5 times.'
  },
  {
    id: 'arc_ricochet_shot', class: 'Archer', type: 'magic',
    nameUk: 'Стріла рикошету', nameEn: 'Ricochet Shot',
    costType: 'stamina', cost: 22, cooldown: 5, range: 220, icon: '🔄', iconColor: '#facc15',
    descUk: 'Стріла відскакує від стін та ворогів до 4 разів.',
    descEn: 'Bouncing arrow ricocheting off obstacles and foes up to 4 times.'
  },
  {
    id: 'arc_gale_arrow', class: 'Archer', type: 'magic',
    nameUk: 'Стріла вітрогону', nameEn: 'Gale Arrow',
    costType: 'mana', cost: 30, cooldown: 12, range: 240, icon: '🌪️', iconColor: '#0ea5e9',
    descUk: 'Вистрілює стрілу, оточену торнадо, що засмоктує ворогів по шляху.',
    descEn: 'Gale-force arrow sucking in and pulling enemies along its flight.'
  },
  {
    id: 'arc_heartseeker', class: 'Archer', type: 'magic',
    nameUk: 'Постріл у серце', nameEn: 'Heartseeker',
    costType: 'stamina', cost: 30, cooldown: 10, range: 300, icon: '💘', iconColor: '#e11d48',
    descUk: 'Завдає тим більше шкоди, чим далі лучник знаходиться від цілі.',
    descEn: 'Long-range arrow scaling in damage the farther it travels.'
  },
  {
    id: 'arc_scattershot', class: 'Archer', type: 'magic',
    nameUk: 'Дробовий залп', nameEn: 'Scattershot',
    costType: 'stamina', cost: 24, cooldown: 6, range: 120, icon: '💥', iconColor: '#ea580c',
    descUk: 'Постріл з лука 5 стрілами віялом на коротку дистанцію.',
    descEn: 'Fires a tight spread of 5 arrows at close range.'
  },
  {
    id: 'arc_marker_arrow', class: 'Archer', type: 'magic',
    nameUk: 'Стріла маркування', nameEn: 'Marker Arrow',
    costType: 'stamina', cost: 15, cooldown: 12, range: 240, icon: '🎯', iconColor: '#fbbf24',
    descUk: 'Всі наступні атаки по цілі від будь-кого стають критичними на 5 сек.',
    descEn: 'Marks target ensuring all incoming hits are guaranteed criticals for 5s.'
  },
  {
    id: 'arc_starfall_arrow', class: 'Archer', type: 'magic',
    nameUk: 'Священна зоряна стріла', nameEn: 'Starfall Arrow',
    costType: 'mana', cost: 45, cooldown: 35, range: 250, icon: '⭐', iconColor: '#fef08a',
    descUk: 'Викликає стовп зоряного світла у місці падіння стріли.',
    descEn: 'Calls down radiant stellar pillar where the arrow impacts.'
  },

  // Archer Buffs & Traps
  {
    id: 'arc_rapid_fire', class: 'Archer', type: 'buff',
    nameUk: 'Швидкострільність', nameEn: 'Rapid Fire',
    costType: 'stamina', cost: 25, cooldown: 25, range: 0, icon: '⚡', iconColor: '#eab308',
    descUk: 'Збільшує швидкість атаки лучника на 70% на 8 сек.',
    descEn: 'Increases archer attack speed by 70% for 8s.'
  },
  {
    id: 'arc_eagle_eye', class: 'Archer', type: 'buff',
    nameUk: 'Орлине око', nameEn: 'Eagle Eye',
    costType: 'stamina', cost: 20, cooldown: 30, range: 0, icon: '🦅', iconColor: '#38bdf8',
    descUk: 'Збільшує дальність стрільби на 4 клітинки та шанс криту на 20%.',
    descEn: 'Increases shooting range by 4 tiles and crit chance by 20% for 20s.'
  },
  {
    id: 'arc_camouflage', class: 'Archer', type: 'buff',
    nameUk: 'Маскування (Невидимість)', nameEn: 'Camouflage',
    costType: 'stamina', cost: 30, cooldown: 35, range: 0, icon: '🌿', iconColor: '#15803d',
    descUk: 'Лучник стає невидимим на 6 сек (перший постріл гарантовано критує).',
    descEn: 'Enters stealth for 6s; first attack from stealth is an automatic critical.'
  },
  {
    id: 'arc_cheetah_stride', class: 'Archer', type: 'buff',
    nameUk: 'Спритність гепарда', nameEn: 'Cheetah Stride',
    costType: 'stamina', cost: 20, cooldown: 25, range: 0, icon: '🐆', iconColor: '#f97316',
    descUk: 'Збільшує швидкість пересування на 45% на 12 сек.',
    descEn: 'Increases movement speed by 45% for 12s.'
  },
  {
    id: 'arc_bear_trap', class: 'Archer', type: 'buff',
    nameUk: 'Капкан на ведмедя', nameEn: 'Bear Trap',
    costType: 'stamina', cost: 20, cooldown: 12, range: 80, icon: '🪤', iconColor: '#78716c',
    descUk: 'Встановлює капкан; ворог, що наступив, іммобілізується на 4 сек.',
    descEn: 'Deploys steel trap dealing damage and clamping target for 4s.'
  },
  {
    id: 'arc_explosive_trap', class: 'Archer', type: 'buff',
    nameUk: 'Вибухова міна', nameEn: 'Explosive Trap',
    costType: 'stamina', cost: 25, cooldown: 15, range: 80, icon: '💣', iconColor: '#dc2626',
    descUk: 'Пастка детонує при наближенні ворога, підкидаючи його в повітря.',
    descEn: 'Proximity mine detonating in explosive fire and knocking airborne.'
  },
  {
    id: 'arc_tar_trap', class: 'Archer', type: 'buff',
    nameUk: 'Смоляна пастка', nameEn: 'Tar Trap',
    costType: 'stamina', cost: 20, cooldown: 16, range: 90, icon: '🛢️', iconColor: '#27272a',
    descUk: 'Створює калюжу смоли на землі, яка сповільнює ворогів на 75%.',
    descEn: 'Coats area in sticky tar slowing all moving enemies by 75%.'
  },
  {
    id: 'arc_hunters_instinct', class: 'Archer', type: 'buff',
    nameUk: 'Мисливський інстинкт', nameEn: 'Hunter\'s Instinct',
    costType: 'stamina', cost: 15, cooldown: 40, range: 0, icon: '🐾', iconColor: '#a855f7',
    descUk: 'Лучник бачить невидимих ворогів та ворогів крізь туман війни на 20 сек.',
    descEn: 'Reveals stealth units and illuminates targets through fog of war.'
  },
  {
    id: 'arc_tailwind_aura', class: 'Archer', type: 'buff',
    nameUk: 'Благословення лісового вітру', nameEn: 'Tailwind Aura',
    costType: 'stamina', cost: 0, cooldown: 0, range: 120, icon: '🍃', iconColor: '#4ade80',
    descUk: 'Дає лучнику та союзникам +15% до швидкості бігу та ухилення.',
    descEn: 'Passive party aura giving +15% move speed and dodge chance.'
  },
  {
    id: 'arc_sniper_stance', class: 'Archer', type: 'buff',
    nameUk: 'Фокус стрільця', nameEn: 'Sniper Stance',
    costType: 'stamina', cost: 15, cooldown: 10, range: 0, icon: '🔭', iconColor: '#64748b',
    descUk: 'Лучник завмирає: кожна секунда стояння дає +10% до шкоди (до +50%).',
    descEn: 'Stationary stance ramping up ranged damage by 10% per second (up to +50%).'
  },

  // Archer Debuffs
  {
    id: 'arc_hunters_mark', class: 'Archer', type: 'debuff',
    nameUk: 'Мітка мисливця', nameEn: 'Hunter\'s Mark',
    costType: 'stamina', cost: 15, cooldown: 10, range: 240, icon: '🎯', iconColor: '#ef4444',
    descUk: 'Знижує ухилення ворога до 0 та збільшує весь урон по ньому на 20%.',
    descEn: 'Reduces target dodge to 0% and increases all damage taken by 20% for 15s.'
  },
  {
    id: 'arc_crippling_shot', class: 'Archer', type: 'debuff',
    nameUk: 'Пробите коліно', nameEn: 'Crippling Shot',
    costType: 'stamina', cost: 18, cooldown: 8, range: 220, icon: '🦿', iconColor: '#b45309',
    descUk: 'Знижує швидкість пересування ворога на 60% на 6 сек.',
    descEn: 'Shots target in knee slowing movement by 60% for 6s.'
  },
  {
    id: 'arc_blinding_shot', class: 'Archer', type: 'debuff',
    nameUk: 'Осліплюючий постріл', nameEn: 'Blinding Shot',
    costType: 'stamina', cost: 16, cooldown: 12, range: 200, icon: '🕶️', iconColor: '#facc15',
    descUk: 'Стріла потрапляє в шолом/очі, через що ворог промахується у 70% атак.',
    descEn: 'Causes enemy attacks to miss 70% of the time for 4s.'
  },
  {
    id: 'arc_rend_armor', class: 'Archer', type: 'debuff',
    nameUk: 'Розривна рана', nameEn: 'Rend Armor',
    costType: 'stamina', cost: 20, cooldown: 10, range: 220, icon: '🛡️', iconColor: '#dc2626',
    descUk: 'Знижує показник броні ворога на 30% на 10 сек.',
    descEn: 'Armor-piercing shot degrading enemy armor by 30% for 10s.'
  },
  {
    id: 'arc_neurotoxin', class: 'Archer', type: 'debuff',
    nameUk: 'Нейротоксин', nameEn: 'Neurotoxin',
    costType: 'stamina', cost: 18, cooldown: 14, range: 200, icon: '🧪', iconColor: '#84cc16',
    descUk: 'Сповільнює швидкість атаки і касту ворога на 40% на 8 сек.',
    descEn: 'Paralytic venom slowing enemy attack and casting cadence by 40%.'
  },
  {
    id: 'arc_entangling_net', class: 'Archer', type: 'debuff',
    nameUk: 'Заплутуюча сітка', nameEn: 'Entangling Net',
    costType: 'stamina', cost: 20, cooldown: 15, range: 140, icon: '🕸️', iconColor: '#71717a',
    descUk: 'Кидок сітки, що зв\'язує ворога і блокує переміщення на 3.5 сек.',
    descEn: 'Weighted net ensnaring and rooting target for 3.5s.'
  },
  {
    id: 'arc_expose_weakness', class: 'Archer', type: 'debuff',
    nameUk: 'Смертельна вразливість', nameEn: 'Expose Weakness',
    costType: 'stamina', cost: 15, cooldown: 6, range: 220, icon: '🔍', iconColor: '#ec4899',
    descUk: 'Кожен удар лучника знімає з ворога 5% захисту (стакається до 6 разів).',
    descEn: 'Exposes flaws in defense stripping 5% resist per hit (up to 6 stacks).'
  },
  {
    id: 'arc_concussive_shot', class: 'Archer', type: 'debuff',
    nameUk: 'Постріл страху (Оглушення)', nameEn: 'Concussive Shot',
    costType: 'stamina', cost: 22, cooldown: 14, range: 200, icon: '💫', iconColor: '#eab308',
    descUk: 'Оглушає ціль на 2 сек при влучанні важкої стріли в голову.',
    descEn: 'Blunt concussive arrow stunning target for 2s.'
  },
  {
    id: 'arc_enfeebling_poison', class: 'Archer', type: 'debuff',
    nameUk: 'Отрута безсилля', nameEn: 'Enfeebling Poison',
    costType: 'stamina', cost: 18, cooldown: 12, range: 200, icon: '☣️', iconColor: '#15803d',
    descUk: 'Зменшує фізичну та магічну шкоду ворога на 25% на 10 сек.',
    descEn: 'Enfeebles target weakening all outgoing damage by 25% for 10s.'
  },
  {
    id: 'arc_preys_dread', class: 'Archer', type: 'debuff',
    nameUk: 'Стигма здобичі', nameEn: 'Prey\'s Dread',
    costType: 'stamina', cost: 20, cooldown: 20, range: 250, icon: '😱', iconColor: '#4c1d95',
    descUk: 'Ворог отримує паніку (Fear) на 2 сек при далекому критичному влучанні.',
    descEn: 'Induces panic causing distant targets to flee for 2s on critical hit.'
  },

  // =========================================================================
  // 6. DRUID (Друїд) — 50 skills (Bear, Hawk, Wolf & Nature Magic)
  // =========================================================================
  // Bear / Wolf / Hawk Melee
  {
    id: 'dru_maul', class: 'Druid', type: 'melee',
    nameUk: 'Удар ведмежою лапою', nameEn: 'Bear Maul',
    costType: 'mana', cost: 18, cooldown: 3, range: 45, icon: '🐻', iconColor: '#78350f',
    descUk: '[Ведмідь] Потужний удар важкою лапою, що наносить 220% шкоди та оглушає на 1 сек.',
    descEn: '[Bear] Crushing heavy paw strike dealing 220% damage and stunning for 1s.'
  },
  {
    id: 'dru_feral_bite', class: 'Druid', type: 'melee',
    nameUk: 'Лютий укус вовка', nameEn: 'Wolf Bite',
    costType: 'mana', cost: 15, cooldown: 2, range: 40, icon: '🐺', iconColor: '#64748b',
    descUk: '[Вовк] Швидкий укус іклами вовка, що викликає сильну кровотечу на 6 сек.',
    descEn: '[Wolf] Ferocious wolf bite inflicting vicious bleed over 6s.'
  },
  {
    id: 'dru_hawk_dive_slash', class: 'Druid', type: 'melee',
    nameUk: 'Пікірування яструба', nameEn: 'Hawk Dive Slash',
    costType: 'mana', cost: 16, cooldown: 4, range: 100, icon: '🦅', iconColor: '#0284c7',
    descUk: '[Яструб] Блискавичне пікірування з повітря кігтями, що розтинає ворога.',
    descEn: '[Hawk] High-speed aerial dive slicing target with sharp talons.'
  },
  {
    id: 'dru_bear_slam', class: 'Druid', type: 'melee',
    nameUk: 'Нищівний розчавлювач', nameEn: 'Bear Slam',
    costType: 'mana', cost: 24, cooldown: 6, range: 50, icon: '🐾', iconColor: '#92400e',
    descUk: '[Ведмідь] Важкий удар двома лапами об землю, що збиває ворогів з ніг.',
    descEn: '[Bear] Overhead two-paw slam knocking down all foes in front.'
  },
  {
    id: 'dru_wolf_flurry', class: 'Druid', type: 'melee',
    nameUk: 'Шквал вовчих лап', nameEn: 'Wolf Flurry',
    costType: 'mana', cost: 20, cooldown: 5, range: 40, icon: '🐾', iconColor: '#475569',
    descUk: '[Вовк] 4 блискавичні послідовні удари пазурами вовка по одній цілі.',
    descEn: '[Wolf] 4 lightning-fast claw swipes tearing at a single foe.'
  },
  {
    id: 'dru_hawk_talon_strike', class: 'Druid', type: 'melee',
    nameUk: 'Удар кігтями яструба', nameEn: 'Hawk Talon Strike',
    costType: 'mana', cost: 14, cooldown: 3, range: 45, icon: '🦅', iconColor: '#0ea5e9',
    descUk: '[Яструб] Подвійний удар кігтями яструба по очах, що знижує влучність цілі.',
    descEn: '[Hawk] Precision talon swipe at the eyes blinding target for 2s.'
  },
  {
    id: 'dru_bear_charge', class: 'Druid', type: 'melee',
    nameUk: 'Ведмежий таран', nameEn: 'Bear Charge',
    costType: 'mana', cost: 22, cooldown: 10, range: 140, icon: '🐻', iconColor: '#b45309',
    descUk: '[Ведмідь] Ривок тушею вперед, що врізається у ворогів і відкидає їх.',
    descEn: '[Bear] Unstoppable heavy charge bowling over all enemies in path.'
  },
  {
    id: 'dru_wolf_pounce', class: 'Druid', type: 'melee',
    nameUk: 'Стрибок хижого вовка', nameEn: 'Wolf Pounce',
    costType: 'mana', cost: 18, cooldown: 8, range: 120, icon: '🐺', iconColor: '#334155',
    descUk: '[Вовк] Стрибок на спину ворога з притисканням до землі на 2 сек.',
    descEn: '[Wolf] Leaps upon enemy back pinning them to ground for 2s.'
  },
  {
    id: 'dru_hawk_feather_flurry', class: 'Druid', type: 'melee',
    nameUk: 'Криловий шторм яструба', nameEn: 'Hawk Wing Flurry',
    costType: 'mana', cost: 20, cooldown: 6, range: 60, icon: '🪶', iconColor: '#38bdf8',
    descUk: '[Яструб] Удар крилами з утворенням ріжучого повітряного вихору навколо.',
    descEn: '[Hawk] Wing buffet generating a razor-sharp wind cyclone around the hawk.'
  },
  {
    id: 'dru_bear_mangle', class: 'Druid', type: 'melee',
    nameUk: 'Калічащий розрив ведмедя', nameEn: 'Bear Mangle',
    costType: 'mana', cost: 20, cooldown: 7, range: 45, icon: '🐻', iconColor: '#78350f',
    descUk: '[Ведмідь] Калічить ворога, знижуючи його атаку на 30% та посилюючи кровотечі.',
    descEn: '[Bear] Mangles target reducing attack power and amplifying bleed damage.'
  },
  {
    id: 'dru_wolf_throat_rip', class: 'Druid', type: 'melee',
    nameUk: 'Перегризання горла', nameEn: 'Wolf Throat Rip',
    costType: 'mana', cost: 25, cooldown: 14, range: 40, icon: '🐺', iconColor: '#881337',
    descUk: '[Вовк] Добиваючий укус, що наносить потрійну шкоду цілям з низьким HP.',
    descEn: '[Wolf] Execution bite dealing 300% damage to targets below 30% HP.'
  },
  {
    id: 'dru_hawk_wind_slash', class: 'Druid', type: 'melee',
    nameUk: 'Вітровий поріз яструба', nameEn: 'Hawk Wind Slash',
    costType: 'mana', cost: 15, cooldown: 4, range: 80, icon: '💨', iconColor: '#7dd3fc',
    descUk: '[Яструб] Змах крилами, що випускає дві вітрові коси вперед.',
    descEn: '[Hawk] Flaps wings launching twin crescent wind scythes.'
  },
  {
    id: 'dru_bear_earth_stomp', class: 'Druid', type: 'melee',
    nameUk: 'Земляний тупіт ведмедя', nameEn: 'Bear Earth Stomp',
    costType: 'mana', cost: 30, cooldown: 14, range: 70, icon: '🐾', iconColor: '#92400e',
    descUk: '[Ведмідь] Б\'є передніми лапами по землі, оглушаючи всіх навколо на 2 сек.',
    descEn: '[Bear] Heavy foot stomp stunning all surrounding enemies for 2s.'
  },
  {
    id: 'dru_wolf_rend', class: 'Druid', type: 'melee',
    nameUk: 'Вовчий розпил', nameEn: 'Wolf Rend',
    costType: 'mana', cost: 14, cooldown: 3, range: 40, icon: '🐺', iconColor: '#dc2626',
    descUk: '[Вовк] Подвійний поріз пазурами, що розриває броню ворога на 20%.',
    descEn: '[Wolf] Quick claw rend peeling 20% armor off target.'
  },
  {
    id: 'dru_hawk_aerial_evade_strike', class: 'Druid', type: 'melee',
    nameUk: 'Удар зі злету', nameEn: 'Hawk Soaring Strike',
    costType: 'mana', cost: 18, cooldown: 8, range: 90, icon: '🦅', iconColor: '#0284c7',
    descUk: '[Яструб] Злітає вгору, ухиляючись від усіх атак, і завдає удару зверху.',
    descEn: '[Hawk] Soars into the air dodging all attacks then dives down.'
  },
  {
    id: 'dru_thorn_staff_strike', class: 'Druid', type: 'melee',
    nameUk: 'Удар тернистим посохом', nameEn: 'Thorn Staff Strike',
    costType: 'mana', cost: 10, cooldown: 2, range: 50, icon: '🌿', iconColor: '#15803d',
    descUk: '[Гуманоїд] Удар палицею друїда, що пронизує ворога отруйними шипами.',
    descEn: '[Humanoid] Staff strike embedding poisonous bramble thorns.'
  },
  {
    id: 'dru_bear_frenzy', class: 'Druid', type: 'melee',
    nameUk: 'Лють грізлі', nameEn: 'Grizzly Frenzy',
    costType: 'mana', cost: 28, cooldown: 16, range: 45, icon: '🐻', iconColor: '#ea580c',
    descUk: '[Ведмідь] Серія з 5 потужних ударів лапами з відновленням HP за удар.',
    descEn: '[Bear] 5-hit berserk claw combination restoring HP per hit.'
  },
  {
    id: 'dru_wolf_pack_strike', class: 'Druid', type: 'melee',
    nameUk: 'Зграйний випад вовка', nameEn: 'Wolf Pack Strike',
    costType: 'mana', cost: 22, cooldown: 10, range: 45, icon: '🐺', iconColor: '#475569',
    descUk: '[Вовк] Створює 2 примарні копії вовка, які атакують разом із друїдом.',
    descEn: '[Wolf] Summons 2 spectral wolves mirroring the attack simultaneously.'
  },
  {
    id: 'dru_hawk_razor_feathers', class: 'Druid', type: 'melee',
    nameUk: 'Гострі пір\'я яструба', nameEn: 'Hawk Razor Feathers',
    costType: 'mana', cost: 20, cooldown: 6, range: 120, icon: '🪶', iconColor: '#38bdf8',
    descUk: '[Яструб] Вистрілює віялом із 6 гострих пір\'їн на відстань.',
    descEn: '[Hawk] Launches a fan of 6 razor-sharp steel feathers.'
  },
  {
    id: 'dru_ursocs_wrath', class: 'Druid', type: 'melee',
    nameUk: 'Гнів прадавнього ведмедя', nameEn: 'Ursoc\'s Wrath',
    costType: 'mana', cost: 35, cooldown: 25, range: 60, icon: '🐻', iconColor: '#b45309',
    descUk: '[Ведмідь] Нищівний землетрус лапами, що завдає 300% AoE шкоди.',
    descEn: '[Bear] Apocalyptic slam creating an earthquake dealing 300% AoE damage.'
  },

  // Druid Nature Magic & Charms
  {
    id: 'dru_wrath', class: 'Druid', type: 'magic',
    nameUk: 'Гнів природи', nameEn: 'Wrath',
    costType: 'mana', cost: 18, cooldown: 1.5, range: 200, icon: '☀️', iconColor: '#facc15',
    descUk: 'Згусток зеленої сонячної енергії, що наносить шкоду природі/сонцю.',
    descEn: 'Hurls a ball of pure solar nature energy at target.'
  },
  {
    id: 'dru_moonfire', class: 'Druid', type: 'magic',
    nameUk: 'Місячний вогонь', nameEn: 'Moonfire',
    costType: 'mana', cost: 20, cooldown: 2, range: 220, icon: '🌙', iconColor: '#818cf8',
    descUk: 'Миттєвий стовп місячного світла з неба, що наносить шкоду та вішає DoT на 12 сек.',
    descEn: 'Instant lunar beam burning target and ticking damage over 12s.'
  },
  {
    id: 'dru_starfall', class: 'Druid', type: 'magic',
    nameUk: 'Зоряний спалах', nameEn: 'Starfall',
    costType: 'mana', cost: 55, cooldown: 35, range: 240, icon: '⭐', iconColor: '#c084fc',
    descUk: 'Викликає зорепад, який обрушує хвилі падаючих зірок на всіх ворогів.',
    descEn: 'Calls down waves of falling stars battering all nearby enemies.'
  },
  {
    id: 'dru_charm_creature', class: 'Druid', type: 'magic',
    nameUk: 'Приручення істоти (Charm)', nameEn: 'Charm Creature',
    costType: 'mana', cost: 40, cooldown: 30, range: 140, icon: '💖', iconColor: '#ec4899',
    descUk: 'Друїд підкорює розум дикої істоти, змушуючи її битися на своєму боці.',
    descEn: 'Charms a wild creature or beast to fight alongside the druid.'
  },
  {
    id: 'dru_summon_wolfpack', class: 'Druid', type: 'magic',
    nameUk: 'Призов зграї вовків', nameEn: 'Summon Wolfpack',
    costType: 'mana', cost: 45, cooldown: 40, range: 80, icon: '🐺', iconColor: '#64748b',
    descUk: 'Викликає 2 примарних вовків на 25 сек для допомоги в бою.',
    descEn: 'Summons 2 loyal spirit wolves to hunt down enemies for 25s.'
  },
  {
    id: 'dru_summon_treant', class: 'Druid', type: 'magic',
    nameUk: 'Призов древня-захисника', nameEn: 'Summon Treant',
    costType: 'mana', cost: 50, cooldown: 50, range: 80, icon: '🌲', iconColor: '#15803d',
    descUk: 'Прикликає могутнє ходяче дерево, яке танчить і провокує ворогів.',
    descEn: 'Summons a sturdy treant guardian to taunt and tank enemies.'
  },
  {
    id: 'dru_cyclone', class: 'Druid', type: 'magic',
    nameUk: 'Вихор торнадо', nameEn: 'Cyclone',
    costType: 'mana', cost: 30, cooldown: 18, range: 160, icon: '🌪️', iconColor: '#38bdf8',
    descUk: 'Підіймає ворога у повітряний смерч на 4 сек (ворог не може діяти).',
    descEn: 'Tosses enemy into an impenetrable cyclone whirlwind for 4s.'
  },
  {
    id: 'dru_storm_lightning', class: 'Druid', type: 'magic',
    nameUk: 'Блискавка бурі', nameEn: 'Storm Lightning',
    costType: 'mana', cost: 32, cooldown: 8, range: 200, icon: '🌩️', iconColor: '#eab308',
    descUk: 'Викликає удар природної грозової блискавки з неба.',
    descEn: 'Strikes target area with natural storm lightning.'
  },
  {
    id: 'dru_bramble_burst', class: 'Druid', type: 'magic',
    nameUk: 'Кореневий вибух', nameEn: 'Bramble Burst',
    costType: 'mana', cost: 26, cooldown: 7, range: 150, icon: '🎋', iconColor: '#16a34a',
    descUk: 'Вибух із шипів і коріння, що розкидає отруйні голки в усі боки.',
    descEn: 'Detonates brambles launching sharp thorn spikes radially.'
  },
  {
    id: 'dru_solar_beam', class: 'Druid', type: 'magic',
    nameUk: 'Сонцестояння', nameEn: 'Solar Beam',
    costType: 'mana', cost: 35, cooldown: 25, range: 180, icon: '☀️', iconColor: '#fbbf24',
    descUk: 'Сфокусований сонячний промінь, що наносить шкоду та накладає Silence у зоні.',
    descEn: 'Solar beam scorching and silencing all enemies in target area.'
  },

  // Druid 3 Key Transformations & Buffs
  {
    id: 'dru_bear_form', class: 'Druid', type: 'buff',
    nameUk: 'Трансформація у ведмедя', nameEn: 'Bear Form',
    costType: 'mana', cost: 20, cooldown: 2, range: 0, icon: '🐻', iconColor: '#92400e',
    descUk: '[Трансформація] Перетворення на ведмедя (переваги Воїна): +60% HP, +100% броні, нищівний ближній бій.',
    descEn: '[Transformation] Shifts into Bear Form (Warrior traits): +60% max HP, +100% armor, crushing melee.'
  },
  {
    id: 'dru_hawk_form', class: 'Druid', type: 'buff',
    nameUk: 'Трансформація в яструба', nameEn: 'Hawk Form',
    costType: 'mana', cost: 20, cooldown: 2, range: 0, icon: '🦅', iconColor: '#0284c7',
    descUk: '[Трансформація] Перетворення на яструба (переваги Лучника): +45% швидкість бігу, +35% ухилення, далекобійні пікірування.',
    descEn: '[Transformation] Shifts into Hawk Form (Archer traits): +45% move speed, +35% evasion, swift ranged diving.'
  },
  {
    id: 'dru_wolf_form', class: 'Druid', type: 'buff',
    nameUk: 'Трансформація у вовка', nameEn: 'Wolf Form',
    costType: 'mana', cost: 20, cooldown: 2, range: 0, icon: '🐺', iconColor: '#475569',
    descUk: '[Трансформація] Перетворення на вовка (гібрид Воїна та Лучника): +35% швидкість атаки, +25% крит, кровотечі та зграйний бій.',
    descEn: '[Transformation] Shifts into Wolf Form (Warrior/Archer hybrid): +35% attack speed, +25% crit chance, vicious bleeds.'
  },
  {
    id: 'dru_mark_of_the_wild', class: 'Druid', type: 'buff',
    nameUk: 'Знак дикої природи', nameEn: 'Mark of the Wild',
    costType: 'mana', cost: 35, cooldown: 60, range: 120, icon: '🐾', iconColor: '#10b981',
    descUk: 'Збільшує всі основні характеристики друїда та його групи на 15% на 30 хв.',
    descEn: 'Buffs all primary attributes of druid and party by 15% for 30m.'
  },
  {
    id: 'dru_rejuvenation', class: 'Druid', type: 'buff',
    nameUk: 'Омолодження', nameEn: 'Rejuvenation',
    costType: 'mana', cost: 25, cooldown: 6, range: 120, icon: '🌿', iconColor: '#4ade80',
    descUk: 'Накладає сильне періодичне зцілення (HoT) на 12 сек.',
    descEn: 'Heals target ally over 12s with continuous rejuvenating energy.'
  },
  {
    id: 'dru_barkskin', class: 'Druid', type: 'buff',
    nameUk: 'Шкіра дуба', nameEn: 'Barkskin',
    costType: 'mana', cost: 20, cooldown: 30, range: 0, icon: '🪵', iconColor: '#78350f',
    descUk: 'Тіло вкривається дубовою корою, знижуючи весь отримуваний урон на 30% на 10 сек.',
    descEn: 'Hardens skin into oak bark reducing all damage taken by 30% for 10s.'
  },
  {
    id: 'dru_tranquility', class: 'Druid', type: 'buff',
    nameUk: 'Спокій', nameEn: 'Tranquility',
    costType: 'mana', cost: 60, cooldown: 90, range: 180, icon: '🌸', iconColor: '#f472b6',
    descUk: 'Друїд каналізує лікувальний дощ, що масивно відновлює HP усім союзникам.',
    descEn: 'Channels celestial healing rain rapidly restoring health to all nearby allies.'
  },
  {
    id: 'dru_thorns_aura', class: 'Druid', type: 'buff',
    nameUk: 'Шипи відплати', nameEn: 'Thorns Aura',
    costType: 'mana', cost: 0, cooldown: 0, range: 120, icon: '🌵', iconColor: '#16a34a',
    descUk: 'Вороги, які б\'ють друїда або союзників, отримують 20% шкоди назад шипами.',
    descEn: 'Reflects 20% of incoming physical damage back to attackers as nature thorns.'
  },
  {
    id: 'dru_natures_swiftness', class: 'Druid', type: 'buff',
    nameUk: 'Природне відновлення', nameEn: 'Nature\'s Swiftness',
    costType: 'mana', cost: 15, cooldown: 45, range: 0, icon: '⚡', iconColor: '#facc15',
    descUk: 'Наступне заклинання кастується миттєво і має подвійну силу.',
    descEn: 'Makes next nature spell instant-cast and 100% more effective.'
  },
  {
    id: 'dru_healing_touch', class: 'Druid', type: 'buff',
    nameUk: 'Цілющий дотик', nameEn: 'Healing Touch',
    costType: 'mana', cost: 30, cooldown: 10, range: 140, icon: '💚', iconColor: '#22c55e',
    descUk: 'Пряме зцілення на велику кількість здоров\'я.',
    descEn: 'Direct single-target heavy heal.'
  },

  // Druid Debuffs
  {
    id: 'dru_entangling_roots', class: 'Druid', type: 'debuff',
    nameUk: 'Обплітаючі корені', nameEn: 'Entangling Roots',
    costType: 'mana', cost: 25, cooldown: 12, range: 160, icon: '🌱', iconColor: '#15803d',
    descUk: 'Коріння виривається з землі та приковує ворога на місці на 5 сек.',
    descEn: 'Roots target to ground preventing movement for 5s.'
  },
  {
    id: 'dru_hibernate', class: 'Druid', type: 'debuff',
    nameUk: 'Сплячка', nameEn: 'Hibernate',
    costType: 'mana', cost: 30, cooldown: 25, range: 160, icon: '💤', iconColor: '#93c5fd',
    descUk: 'Занурює звіра або монстра в глибокий сон на 12 сек (розбивається шкодою).',
    descEn: 'Puts target creature to sleep for 12s; breaks on damage.'
  },
  {
    id: 'dru_demoralizing_roar', class: 'Druid', type: 'debuff',
    nameUk: 'Рев залякування', nameEn: 'Demoralizing Roar',
    costType: 'mana', cost: 20, cooldown: 15, range: 100, icon: '🦁', iconColor: '#92400e',
    descUk: 'Ведмідь видає страшний рев, що знижує фізичну атаку ворогів на 30%.',
    descEn: 'Terrifying roar lowering enemy attack power by 30% for 10s.'
  },
  {
    id: 'dru_poison_ivy', class: 'Druid', type: 'debuff',
    nameUk: 'Отрута плюща', nameEn: 'Poison Ivy',
    costType: 'mana', cost: 20, cooldown: 8, range: 160, icon: '🌿', iconColor: '#16a34a',
    descUk: 'Накладає отруйний DoT, який сповільнює регенерацію HP ворога на 80%.',
    descEn: 'Toxic ivy DoT cutting enemy health regeneration by 80%.'
  },
  {
    id: 'dru_insect_swarm', class: 'Druid', type: 'debuff',
    nameUk: 'Рої комах', nameEn: 'Insect Swarm',
    costType: 'mana', cost: 24, cooldown: 10, range: 160, icon: '🐝', iconColor: '#ca8a04',
    descUk: 'Хмара бджіл/мошок атакує ворога, завдаючи шкоди та знижуючи його влучність на 35%.',
    descEn: 'Swarm of wasps stinging target and lowering their hit chance by 35%.'
  },
  {
    id: 'dru_rot_wood', class: 'Druid', type: 'debuff',
    nameUk: 'Гниття кори', nameEn: 'Rot Wood',
    costType: 'mana', cost: 22, cooldown: 12, range: 150, icon: '🪵', iconColor: '#451a03',
    descUk: 'Знижує опір до магії природи та фізичний захист ворога на 25%.',
    descEn: 'Lowers nature and physical resistance of target by 25% for 10s.'
  },
  {
    id: 'dru_spore_cloud', class: 'Druid', type: 'debuff',
    nameUk: 'Спори галюцинацій', nameEn: 'Spore Cloud',
    costType: 'mana', cost: 35, cooldown: 20, range: 140, icon: '🍄', iconColor: '#a855f7',
    descUk: 'Змушує ворогів у хмарі атакувати випадкові цілі навколо на 3.5 сек.',
    descEn: 'Hallucinogenic spores causing enemies to attack random nearby targets.'
  },
  {
    id: 'dru_natures_curse', class: 'Druid', type: 'debuff',
    nameUk: 'Прокляття виснаження лісу', nameEn: 'Nature\'s Curse',
    costType: 'mana', cost: 25, cooldown: 15, range: 160, icon: '🥀', iconColor: '#14532d',
    descUk: 'Ворог отримує подвійну шкоду від будь-яких ефектів отрути та кровотечі.',
    descEn: 'Causes target to take 100% increased damage from all bleeds and poisons.'
  },
  {
    id: 'dru_paralytic_spores', class: 'Druid', type: 'debuff',
    nameUk: 'Пил паралічу', nameEn: 'Paralytic Spores',
    costType: 'mana', cost: 28, cooldown: 18, range: 140, icon: '💨', iconColor: '#84cc16',
    descUk: 'Спори грибів поступово сповільнюють ворога аж до повного заціпеніння на 2 сек.',
    descEn: 'Progressively slows target ending in full paralysis for 2s.'
  },
  {
    id: 'dru_constricting_vines', class: 'Druid', type: 'debuff',
    nameUk: 'Стиснення ліан', nameEn: 'Constricting Vines',
    costType: 'mana', cost: 26, cooldown: 14, range: 140, icon: '🎋', iconColor: '#15803d',
    descUk: 'Ліани душать ворога, не даючи йому атакувати руками протягом 3 сек.',
    descEn: 'Choking vines disarming and suffocating target for 3s.'
  }
];

export const SKILLS_BY_CLASS = {
  Warrior: SKILLS.filter(s => s.class === 'Warrior'),
  Mage: SKILLS.filter(s => s.class === 'Mage'),
  Monk: SKILLS.filter(s => s.class === 'Monk'),
  Cultist: SKILLS.filter(s => s.class === 'Cultist'),
  Archer: SKILLS.filter(s => s.class === 'Archer'),
  Druid: SKILLS.filter(s => s.class === 'Druid'),
};

export const SKILLS_BY_ID = new Map(SKILLS.map(s => [s.id, s]));

export function getSkillsForClass(className) {
  if (!className || className === 'all' || className === 'All') return SKILLS;
  return SKILLS_BY_CLASS[className] || [];
}

export function getSkillById(id) {
  return SKILLS_BY_ID.get(id) || null;
}

export function getRequiredForm(skill) {
  if (!skill) return null;
  if (skill.requiredForm) return skill.requiredForm;
  if (skill.class !== 'Druid') return null;
  // Transformation skills don't require a form to cast -- they ACTIVATE the form
  if (isTransformationSkill(skill)) return null;

  const text = `${skill.id} ${skill.nameEn} ${skill.descEn} ${skill.descUk}`.toLowerCase();
  if (text.includes('[bear]') || text.includes('[ведмідь]') || skill.id.startsWith('dru_bear_') || text.includes('ursoc') || text.includes('grizzly')) return 'bear';
  if (text.includes('[hawk]') || text.includes('[яструб]') || skill.id.startsWith('dru_hawk_')) return 'hawk';
  if (text.includes('[wolf]') || text.includes('[вовк]') || skill.id.startsWith('dru_wolf_') || text.includes('feral_bite')) return 'wolf';
  return null;
}

export function isTransformationSkill(skill) {
  if (!skill) return null;
  if (skill.id === 'dru_bear_form') return 'bear';
  if (skill.id === 'dru_hawk_form') return 'hawk';
  if (skill.id === 'dru_wolf_form') return 'wolf';
  return null;
}

export function isDruidExclusiveSkill(skill) {
  if (!skill) return false;
  if (skill.class === 'Druid') {
    if (isTransformationSkill(skill) || getRequiredForm(skill)) return true;
  }
  return false;
}
