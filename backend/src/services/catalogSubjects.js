const { SKILLS } = require('../../seeds/data/skills.js');
const { composeBiomePrompt } = require('./biomePrompt.js');
const { loadBiomes } = require('./biomes.js');
const { resolveGenerationTarget } = require('./generationTarget.js');

// SOMET-535. The subject vocabulary for art generation: what can be drawn,
// what to say about it, and where its image goes when it exists.
//
// bulkImageRegeneration already knows tiles and entities. This adds the three
// that had no art path at all -- items (including the merchant's stones),
// class skills, and passive-tree labels -- in one place, so adding a fourth is
// an entry here rather than an edit in four files.
//
// SCOPE (widened by SOMET-538): all five kinds now live here. Tiles and
// entities were deliberately left out at first -- their loaders carry biome
// prompts and per-type provider pins that only the bulk tool used, and moving
// them to prove a point would have risked ~300 working images for no behaviour
// change. The console needs one table over everything, so they moved, keeping
// both of those properties rather than dropping them:
//
//   * `composePrompt` is per kind. A tile's prompt is its base plus its biome's
//     palette/style/exclusions (composeBiomePrompt, reused not reimplemented);
//     an object's is the isolated-object wrapper.
//   * `pinnedProvider` reads the type's own ai_provider_mode/ai_provider_id, so
//     enqueueing a pinned type keeps its provider instead of silently taking
//     whichever one the batch was started with.
//
// GENERATION KIND IS NOT SUBJECT KIND. `generationKind` is 'tile' or 'object'
// and decides framing, size and which guards apply. Getting it backwards is
// expensive in both directions: an object rendered as a tile comes back a
// sprite sheet, and a tile checked as an object is refused for being opaque --
// which it correctly is.
//
// THE PROMPT RULE, learned the hard way: `basePrompt` is a PLAIN SUBJECT and
// nothing else. Both generators wrap it -- sprite-gen's build_object_prompt
// appends the isometric/isolated/pixel-art framing, and the entity script's
// buildObjectPrompt leads with "only X and nothing else" plus a magenta
// backdrop that the cutout step keys on. A base carrying its own styling
// fights that wrapper and produces contradictory output (measured: a fully
// styled base for "war hammer" returned a heraldic crest).

// item_types.name is a slug -- `crude-blade`, `tempered-greaves`,
// `stone_of_flame staff`. Sent verbatim a model reads the punctuation as part
// of the subject, so it becomes words first.
function deslug(name) {
  return String(name || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A passive label is not always a clean subject phrase: the generator writes
// some as "Arcane Conduit — +20 INT and +60 maximum mana", and the stat tail
// is the last thing that should reach an image model. Everything from the
// first em-dash (or " - ") onward is description, not subject.
function labelSubject(label) {
  return String(label || '')
    .split(/\s+[—–-]\s+/)[0]
    .trim();
}

// Items have no prompt column, so the subject is composed from what the row
// does carry. Category is included because "crude blade" alone is ambiguous
// and "a fantasy weapon" is the honest amount of extra context we actually
// have -- inventing "a broadsword with a leather grip" would be authoring art
// direction from a slug.
function itemPrompt(row) {
  const subject = deslug(row.name);
  // Currency is a mass noun -- "a gold" is wrong and reads as a typo to a
  // model as much as to a person. It is one row in the catalog, but a prompt
  // that starts with a grammatical error is a bad first token to spend.
  if (row.category === 'currency') return `a pile of ${subject}`;
  const parts = [`a ${subject}`];
  if (row.category) parts.push(`a fantasy ${row.category}`);
  if (row.element) parts.push(`${row.element} element`);
  return parts.join(', ');
}

// A skill's subject is its English name. The emoji it currently renders as is
// a hand-authored hint (🔨 for Crushing Blow) and would be a better prompt
// seed, but 300 skills share only 132 emoji, so mapping them would make
// different skills draw the same thing -- the opposite of the point. Class and
// type ride along as context rather than as the subject.
function skillPrompt(skill) {
  const bits = [skill.nameEn];
  if (skill.class && skill.type) bits.push(`a ${skill.class} ${skill.type} ability`);
  return bits.join(', ');
}

const SUBJECTS = Object.freeze({
  // The merchant's goods, and the one subject that renders as literally
  // nothing today: item_types.icon is empty on all 189 rows.
  item: {
    kind: 'item',
    generationKind: 'object',
    async list(db) {
      const { rows } = await db.query(
        `SELECT id, name, category, element FROM item_types ORDER BY name`,
      );
      return rows.map((row) => ({
        kind: 'item', key: row.name, name: row.name, basePrompt: itemPrompt(row), row,
      }));
    },
    async write(db, key, image) {
      const { rows } = await db.query(
        `UPDATE item_types SET icon = $1, updated_at = now()
          WHERE name = $2 RETURNING name`,
        [image, key],
      );
      return rows[0] || null;
    },
    async artIndex(db) {
      const { rows } = await db.query(
        `SELECT name, icon AS image, updated_at FROM item_types
          WHERE icon IS NOT NULL AND icon <> ''`,
      );
      return indexArt(rows);
    },
  },

  // 300 class skills, from the static catalog. Keyed by skill id, which is
  // authored and stable.
  skill: {
    kind: 'skill',
    generationKind: 'object',
    async list() {
      return SKILLS.map((s) => ({
        kind: 'skill', key: s.id, name: s.nameEn, basePrompt: skillPrompt(s), row: s,
      }));
    },
    write: (db, key, image, providerId) => writeCatalogArt(db, 'skill', key, image, providerId),
    artIndex: (db) => catalogArtIndex(db, 'skill'),
  },

  // 128 distinct labels across 1852 nodes. Keyed by the label text: art is
  // per label by design, and the key survives a --force reseed that renumbers
  // node ids.
  passive_label: {
    kind: 'passive_label',
    generationKind: 'object',
    async list(db) {
      const { rows } = await db.query(
        'SELECT DISTINCT label FROM passive_nodes WHERE label <> \'\' ORDER BY label',
      );
      return rows.map((r) => ({
        kind: 'passive_label',
        key: r.label,
        name: r.label,
        basePrompt: labelSubject(r.label),
        row: r,
      }));
    },
    write: (db, key, image, providerId) => writeCatalogArt(db, 'passive_label', key, image, providerId),
    artIndex: (db) => catalogArtIndex(db, 'passive_label'),
  },
  // --- SOMET-538: the two that already had art paths ---------------------
  //
  // Keyed by NAME rather than id, like every other kind here, and for the same
  // reason: a key has to survive a reseed. The bulk tool addresses these rows
  // by id, which is why its UPDATE statements are not reused verbatim below.

  tile: {
    kind: 'tile',
    // Seamless ground texture: no cutout, correctly opaque, and 512 is fine.
    // The object guards (1024 minimum, transparency floor) must NOT reach it.
    generationKind: 'tile',
    async list(db) {
      const { rows } = await db.query(
        `SELECT id, name, prompt, art_biome, image, ai_provider_mode, ai_provider_id
           FROM tile_types ORDER BY name`,
      );
      return rows.map((row) => ({
        kind: 'tile',
        key: row.name,
        name: row.name,
        // The PLAIN base. Biome styling is applied by composePrompt, which
        // needs a database round-trip and so cannot happen during list().
        basePrompt: row.prompt || row.name,
        biome: row.art_biome || null,
        row,
      }));
    },
    async composePrompt(db, subject) {
      const [biome] = subject.biome ? await loadBiomes(db, [subject.biome]) : [];
      return composeBiomePrompt(subject.basePrompt, biome || null);
    },
    async write(db, key, image) {
      const { rows } = await db.query(
        `UPDATE tile_types SET image = $1, updated_at = CURRENT_TIMESTAMP
          WHERE name = $2 RETURNING name`,
        [image, key],
      );
      return rows[0] || null;
    },
    async artIndex(db) {
      const { rows } = await db.query(
        `SELECT name, image, updated_at FROM tile_types
          WHERE image IS NOT NULL AND image <> ''`);
      return indexArt(rows);
    },
  },

  entity: {
    kind: 'entity',
    generationKind: 'object',
    async list(db) {
      const { rows } = await db.query(
        `SELECT id, name, prompt, render_mode, image, ai_provider_mode, ai_provider_id
           FROM entity_types ORDER BY name`,
      );
      // 'rect' types are INCLUDED here, unlike in the bulk tool where they are
      // opt-in. This is a console: hiding rows would make "which subjects have
      // art" wrong. Whether to generate one is the admin's selection to make,
      // and `render_mode` is reported so the choice is informed.
      return rows.map((row) => ({
        kind: 'entity', key: row.name, name: row.name,
        basePrompt: row.prompt || row.name, row,
      }));
    },
    // render_mode moves rect -> static: a type carrying an image that still
    // draws as a colour box would show none of the art just paid for. Lifted
    // from the bulk tool's CATALOG_UPDATE, which states the same reason.
    async write(db, key, image) {
      const { rows } = await db.query(
        `UPDATE entity_types SET image = $1, render_mode = 'static',
                updated_at = CURRENT_TIMESTAMP
          WHERE name = $2 RETURNING name`,
        [image, key],
      );
      return rows[0] || null;
    },
    async artIndex(db) {
      const { rows } = await db.query(
        `SELECT name, image, updated_at FROM entity_types
          WHERE image IS NOT NULL AND image <> ''`);
      return indexArt(rows);
    },
  },
});

// Upsert, not insert: regenerating a subject replaces its art. The object
// store keeps every version under its own job key, so nothing is lost by the
// pointer moving.
async function writeCatalogArt(db, kind, key, image, providerId = null) {
  const { rows } = await db.query(
    `INSERT INTO catalog_art (subject_kind, subject_key, image, provider_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (subject_kind, subject_key)
     DO UPDATE SET image = EXCLUDED.image,
                   provider_id = EXCLUDED.provider_id,
                   updated_at = now()
     RETURNING subject_key`,
    [kind, key, image, providerId],
  );
  return rows[0] || null;
}

async function catalogArtIndex(db, kind) {
  const { rows } = await db.query(
    'SELECT subject_key AS name, image, updated_at FROM catalog_art WHERE subject_kind = $1',
    [kind],
  );
  return indexArt(rows);
}

function indexArt(rows) {
  return new Map(rows.map((r) => [r.name, { image: r.image, updatedAt: r.updated_at }]));
}

// Turn a console selection into rows the queue can take, resolving each
// subject's PROVIDER PIN (SOMET-538).
//
// tile_types and entity_types carry ai_provider_mode/ai_provider_id. A type
// pinned to a particular provider was pinned for a reason -- a terrain LoRA for
// ground, say -- and sending it to whatever provider the batch was started with
// would silently retarget it. The result would look like the model had changed
// rather than like the pin having been ignored, which is a hard thing to
// diagnose from the finished art.
//
// A key that is no longer in the catalogue is reported back rather than
// dropped: "I selected 100 and 97 were queued" needs an explanation.
async function subjectsForEnqueue(db, kind, keys, { active = null, fallbackProviderId = null } = {}) {
  const reg = registryFor(kind);
  if (!reg) throw new Error(`unknown subject kind: ${kind}`);
  const byKey = new Map((await reg.list(db)).map((s) => [s.key, s]));

  const subjects = [];
  const unknown = [];
  for (const key of keys) {
    const s = byKey.get(key);
    if (!s) { unknown.push(key); continue; }
    subjects.push({ kind, key, providerId: pinnedProviderId(s, active, fallbackProviderId) });
  }
  return { subjects, unknown };
}

// null means "generate this one locally" -- a type pinned to 'local' asked for
// the local service by name and is left alone, exactly as the bulk tool's
// resolveProviderId does. Only a type that made NO choice takes the fallback.
function pinnedProviderId(subject, active, fallbackProviderId) {
  const row = subject.row || {};
  if (row.ai_provider_mode === undefined && row.ai_provider_id === undefined) {
    return fallbackProviderId;                 // this kind has no pin column
  }
  const target = resolveGenerationTarget({
    request: {},
    type: { ai_provider_mode: row.ai_provider_mode, ai_provider_id: row.ai_provider_id },
    active,
  });
  if (target.source === 'remote') return target.providerId;
  if (row.ai_provider_mode === 'local') return null;
  return fallbackProviderId;
}

function subjectKinds() {
  return Object.keys(SUBJECTS);
}

function registryFor(kind) {
  return SUBJECTS[kind] || null;
}

// Every subject of a kind, annotated with whether it already has art -- which
// is what the console's "missing art only" filter is built on, and what makes
// a 617-subject batch resumable without a separate progress counter.
async function listWithArtState(db, kind) {
  const reg = registryFor(kind);
  if (!reg) throw new Error(`unknown subject kind: ${kind}`);
  const [subjects, art, jobs] = await Promise.all([
    reg.list(db), reg.artIndex(db), latestJobByKey(db, kind),
  ]);
  return subjects.map((s) => {
    const a = art.get(s.key) || null;
    const j = jobs.get(s.key) || null;
    return {
      ...s,
      hasArt: Boolean(a),
      image: a ? a.image : null,
      updatedAt: a ? a.updatedAt : null,
      jobState: j ? j.state : null,
      jobError: j ? j.lastError : null,
    };
  });
}

// The most recent job per subject, so a FAILED subject is visible as failed
// with its reason instead of merely being absent from the missing-art page --
// "it did not work and here is why" rather than a row that quietly never
// changes. DISTINCT ON takes the newest row per key in one query rather than
// one per subject.
async function latestJobByKey(db, kind) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (subject_key) subject_key, state, last_error
       FROM art_jobs WHERE subject_kind = $1
      ORDER BY subject_key, id DESC`,
    [kind],
  );
  return new Map(rows.map((r) => [r.subject_key, { state: r.state, lastError: r.last_error }]));
}

module.exports = {
  SUBJECTS, subjectKinds, registryFor, listWithArtState,
  subjectsForEnqueue, pinnedProviderId,
  deslug, labelSubject, itemPrompt, skillPrompt, writeCatalogArt,
};
