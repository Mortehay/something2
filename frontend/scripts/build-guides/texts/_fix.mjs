import fs from 'node:fs';
let s = fs.readFileSync('mage.mjs', 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 50)); s = s.replace(a, b); };
rep("pair it with Arcane Brilliance.', '+30% завданої шкоди на коротке вікно: поєднуйте з «Чародійним сяйвом».'", "pair it with {mag_arcane_brilliance}.', '+30% завданої шкоди на коротке вікно: поєднуйте з «{mag_arcane_brilliance}».'");
rep("use Blink and Spell Ward early.', 'Мало здоров\'я та слабкий фізичний захист: тримайте дистанцію й вмикайте «Ривок» і «Захист від чарів» завчасно.'", "use {mag_blink} and {mag_spell_ward} early.', 'Мало здоров\'я та слабкий фізичний захист: тримайте дистанцію й вмикайте «{mag_blink}» і «{mag_spell_ward}» завчасно.'");
fs.writeFileSync('mage.mjs', s);
console.log('ok');
