#!/usr/bin/env node
// Generates the client's skill catalog from the server's.
//
// WHY. The 300-skill catalog used to exist twice: backend/seeds/data/skills.js (the
// authority -- it prices, gates and resolves every cast) and a hand-copied
// frontend/.../core/skillsData.js. The copy drifted: eleven descriptions, three
// cost/cooldown pairs and a name disagreed, so the tooltip promised a price the
// server then charged differently. A parity test could notice that; it could not
// stop it. Now the data is one file, and this script is the only thing that writes
// the client's copy.
//
// USAGE
//   node scripts/generate-skills-catalog.mjs           rewrite the generated file
//   node scripts/generate-skills-catalog.mjs --check   exit 1 if it is out of date (CI)
//
// The paths resolve relative to THIS file, so it works from the host checkout
// (frontend/scripts -> ../../backend) and inside the frontend container
// (/app/scripts -> /backend) alike.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const SERVER_CATALOG = path.resolve(HERE, '../../backend/seeds/data/skills.js');
export const OUT_FILE = path.resolve(HERE, '../src/games/something2/src/js/core/skillsCatalog.generated.js');

const HEADER = `// GENERATED FILE -- DO NOT EDIT.
//
// The client's copy of the skill catalog, written from backend/seeds/data/skills.js
// by frontend/scripts/generate-skills-catalog.mjs (\`npm run skills:generate\`, or
// \`make skills-sync\`). Edit the server catalog and regenerate; a hand edit here is
// overwritten, and skillsCatalogParity.test.js fails if the two ever disagree.
`;

// Pure: the exact text of the generated file for a given catalog.
export function renderCatalog(skills) {
  return `${HEADER}\nexport const SKILLS = ${JSON.stringify(skills, null, 2)};\n`;
}

export function loadServerSkills() {
  // A fresh require each call, so a long-lived process (a test) sees edits.
  delete require.cache[require.resolve(SERVER_CATALOG)];
  return require(SERVER_CATALOG).SKILLS;
}

function main() {
  const text = renderCatalog(loadServerSkills());
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
    if (current !== text) {
      console.error('skillsCatalog.generated.js is out of date -- run `npm run skills:generate`.');
      process.exitCode = 1;
      return;
    }
    console.log('skillsCatalog.generated.js is up to date.');
    return;
  }
  fs.writeFileSync(OUT_FILE, text);
  console.log(`wrote ${path.relative(process.cwd(), OUT_FILE)} (${text.length} bytes)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
