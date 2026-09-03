const { SKILLS } = require('../../seeds/data/skills.js');

// SOMET-535. The subject vocabulary for art generation: what can be drawn,
// what to say about it, and where its image goes when it exists.
//
// bulkImageRegeneration already knows tiles and entities. This adds the three
// that had no art path at all -- items (including the merchant's stones),
// class skills, and passive-tree labels -- in one place, so adding a fourth is
// an entry here rather than an edit in four files.
//
// SCOPE, stated so the next reader is not surprised: tiles and entities are
// deliberately NOT moved here yet. Their loaders carry biome prompts and
// per-type provider pins that only the bulk tool uses, and rewriting them to
// prove a point would risk 300 working images for no behaviour change. The
// shape below is the one they would adopt.
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
    async hasArt(db) {
      const { rows } = await db.query(
        "SELECT name FROM item_types WHERE icon IS NOT NULL AND icon <> ''",
      );
      return new Set(rows.map((r) => r.name));
    },
  },

  // 300 class skills, from the static catalog. Keyed by skill id, which is
  // authored and stable.
  skill: {
    kind: 'skill',
    async list() {
      return SKILLS.map((s) => ({
        kind: 'skill', key: s.id, name: s.nameEn, basePrompt: skillPrompt(s), row: s,
      }));
    },
    write: (db, key, image, providerId) => writeCatalogArt(db, 'skill', key, image, providerId),
    hasArt: (db) => catalogArtKeys(db, 'skill'),
  },

  // 128 distinct labels across 1852 nodes. Keyed by the label text: art is
  // per label by design, and the key survives a --force reseed that renumbers
  // node ids.
  passive_label: {
    kind: 'passive_label',
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
    hasArt: (db) => catalogArtKeys(db, 'passive_label'),
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

async function catalogArtKeys(db, kind) {
  const { rows } = await db.query(
    'SELECT subject_key FROM catalog_art WHERE subject_kind = $1', [kind],
  );
  return new Set(rows.map((r) => r.subject_key));
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
  const [subjects, withArt] = await Promise.all([reg.list(db), reg.hasArt(db)]);
  return subjects.map((s) => ({ ...s, hasArt: withArt.has(s.key) }));
}

module.exports = {
  SUBJECTS, subjectKinds, registryFor, listWithArtState,
  deslug, labelSubject, itemPrompt, skillPrompt, writeCatalogArt,
};
