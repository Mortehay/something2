// Using items and magic stones from the inventory (systems/itemActions.js, Game.js), and the
// server's refusals for those requests.
export default {
  // buttons and hints
  "Use": "Використати",
  "Socket": "Вставити",
  "Take out": "Витягти",
  "Sure? 10% lost": "Точно? 10% втрата",
  "Socketed: {name}": "Вставлено: {name}",
  "Socketed into: {name}": "Вставлено в: {name}",
  "Drag onto a weapon to socket it": "Перетягніть на зброю, щоб вставити",
  "Double-click to use: a guarded chest appears in this world": "Подвійний клік — використати: у цьому світі з'явиться скриня з охоронцем",

  // toasts
  "Equip a weapon first, or drag the stone onto one": "Спочатку візьміть зброю в руки або перетягніть камінь на неї",
  "Taking a stone out can destroy it (10%). Click again to confirm.": "Камінь може зламатися при витягуванні (10%). Натисніть ще раз, щоб підтвердити.",
  "A guarded chest appeared: {tiles} tiles to the {dir}": "З'явилась скриня з охоронцем: {tiles} клітинок на {dir}",
  "A guarded chest appeared nearby": "Скриня з охоронцем з'явилась поруч",
  "Socketed {stone} into {host}": "Камінь «{stone}» вставлено в «{host}»",
  "The stone shattered as it came out": "Камінь розбився при витягуванні",
  "The stone is back in your bag": "Камінь повернувся до сумки",

  // compass directions (the screen's, not the world axes')
  "north": "північ",
  "north-east": "північний схід",
  "east": "схід",
  "south-east": "південний схід",
  "south": "південь",
  "south-west": "південний захід",
  "west": "захід",
  "north-west": "північний захід",

  // why a socketing or use request cannot happen
  "That is not a magic stone": "Це не магічний камінь",
  "Drop the stone onto a weapon": "Киньте камінь на зброю",
  "A stone cannot be socketed into itself": "Камінь не можна вставити сам у себе",
  "That stone is already socketed": "Цей камінь уже вставлено",
  "That stone does not fit this item": "Цей камінь не підходить до цього предмета",
  "That item already has a stone: take it out first": "У цьому предметі вже є камінь: спершу витягніть його",

  // the server's own refusals
  "stone not found": "камінь не знайдено",
  "stone is already socketed": "камінь уже вставлено",
  "host item not found": "предмет для каменя не знайдено",
  "host already has a socketed stone": "у цьому предметі вже є камінь",
  "stone is not compatible with this item": "камінь не підходить до цього предмета",
  "stone not found or not socketed": "камінь не знайдено або він не вставлений",
  "unsocketing requires explicit confirmation": "для витягування потрібне підтвердження",
  "this item has no use action": "цей предмет не можна використати",
  "unrecognized consumable": "невідомий витратний предмет",
  "no legal spot for a chest right now": "зараз немає місця для скрині",
  "cannot use a stacked item": "не можна використати стос предметів",
};
