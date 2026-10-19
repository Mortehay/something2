// SOMET-641 (Plan 4a, Task 4). The seed-sync Maps group: an ADAPTER group
// (registry `adapter: 'maps'`). Its unit of sync is a .map.json spec file, not
// a DB row:
//   - git side: the manifest <SEED_SYNC_DIR>/maps.json
//       { header, specs: [{ name, sha256 }], entry_world }
//     and the spec files <SEED_MAPS_DIR>/<name>.map.json it lists, applied in
//     manifest order. A spec's identity is sha256(canonicalSpecJson(spec))
//     (mapSpecState.specHash): the file's own text is never trusted for it.
//   - this PC: map_spec_state (applied / exported hash and base_spec, the
//     canonical text of the version last applied or exported here).
//   - the DB side of a spec: specFromDb (services/mapSpecExport.js), the
//     writer's output for the current database.
// It answers diffGroup / previewSeed / applySeed / exportGroup with the
// shapes the routes, the CLI and the Seed/Export tab already consume; one row
// per spec: { table: 'map_specs', key: <spec name>, syncUuid:
// md5uuid('s2sync:map_specs:'+name), kind, defaultDecision, blockedReason,
// allowedDecisions, fields: [{ name: <world name>, local, git }] }.
//
// Status of one spec (plan decision 5). B = the base (base_spec), G = git's
// spec, W = specFromDb(B) for the current DB:
//   new          in git, never applied or exported here, and none of its
//                worlds is in the DB (git only)
//   in_sync      G == B and W == B (not a row)
//   git_newer    G != B, W == B
//   edited_here  G == B, W != B (a hand edit in the World Map Editor)
//   conflict     G != B and W != B (red: no default)
//   only_here    applied here, gone from git (keep only; never deletes)
// "W != B" compares canonical texts. Without a base_spec (a state row written
// before base_spec existed): when its hash equals G's, B = G and the spec is
// adopted (base_spec back-filled by the next seed / export); otherwise there
// is no copy of B, so W is computed from G and any difference is BOTH an edit
// and a git change, i.e. a conflict -- the admin decides; the row carries
// blockedReason 'no_baseline' and a note, and stays red. The same rule holds
// for a spec never tracked here whose worlds ARE in the DB (a PC that built
// them before seed sync; "here" = the writer's seed-aware match): W == G is
// a `baseline` row (group status baseline_pending, the only decision records
// base = G -- no map data changes), recorded by the next seed or export under
// the lock -- status never writes; W != G (or
// only some of its worlds here) is a conflict, and Keep local makes it an
// edit of G that export writes back.
//
// Seed and export run as background jobs (registry `job`). Export reads the
// DB in one REPEATABLE READ snapshot, never under table locks.
//
// Never deletes a world: a spec removed from git is only_here, and Keep local
// just stops tracking it (its worlds then show as "not in any map spec").
const fs = require('node:fs');
const path = require('node:path');
const { deterministicUuid } = require('./canonical.js');
const { SyncFileError, SyncRefused } = require('./errors.js');
const { pcLabel, schemaVersion, startRun, finishRun } = require('./runs.js');
const { beginLocked, mapLockError, rollback } = require('./txn.js');
const { syncDir } = require('./exportGroup.js');
const {
  specHash, textHash, recordApplied, recordExported, forget, readStates,
} = require('./mapSpecState.js');
const { specFromDb, canonicalSpecJson, compassSlots } = require('../mapSpecExport.js');
const { validateMapSpec } = require('../../../seeds/mapSpec.js');
const { oppositeEdge } = require('../mapService.js');
const { setEntryWorldByName } = require('../entryWorld.js');
const { pushToBox: pushSpecs, boxNote, boxProblems } = require('./mapsBoxPush.js');

const GROUP_ID = 'maps';
const TABLE = 'map_specs';
const MANIFEST = `${GROUP_ID}.json`;
const HEADER_FIELDS = ['group', 'exported_at', 'exported_by', 'schema_version', 'spec_count'];
// `baseline`: a spec in sync whose base is not recorded here yet; its only
// decision records it (no map data changes).
const DEFAULTS = {
  new: 'git', git_newer: 'git', edited_here: 'local', conflict: null, only_here: 'local', baseline: 'local',
};
// A new spec has nothing local to keep; a spec gone from git is never deleted.
const ALLOWED = {
  new: ['git'], git_newer: ['git', 'local'], edited_here: ['git', 'local'], conflict: ['git', 'local'], only_here: ['local'],
  baseline: ['local'],
};
const BASELINE_HINT = 'Seed Maps once to record this PC\'s baseline — no map data changes';
const KINDS = Object.keys(DEFAULTS);
const LOCAL_EDIT_KINDS = ['edited_here', 'conflict'];
const GIT_CHANGE_KINDS = ['new', 'git_newer', 'conflict'];
// Export never writes over a spec git changed (or this PC never seeded).
const EXPORT_BLOCKING = new Set(['new', 'git_newer', 'conflict']);

let tmpCounter = 0;

function mapsDir() {
  return process.env.SEED_MAPS_DIR || path.join(__dirname, '../../../seeds/maps');
}
const manifestFile = () => path.join(syncDir(), MANIFEST);
const specFile = (name) => path.join(mapsDir(), `${name}.map.json`);
const uuidOf = (name) => deterministicUuid(TABLE, name);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ---- git side -----------------------------------------------------------------

async function readText(file) {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// One spec file: parsed, named like its stem (the manifest entry, the file
// stem and spec.name are the one name otherSpecWorlds and the state use).
async function readSpecFile(name, listedIn) {
  const base = `${name}.map.json`;
  const text = await readText(specFile(name));
  if (text === null) throw new SyncFileError(`${listedIn}: lists spec ${name}, but ${base} is missing`, base);
  let spec;
  try { spec = JSON.parse(text); } catch (e) { throw new SyncFileError(`${base}: invalid JSON`, base); }
  if (!isObj(spec) || !Array.isArray(spec.worlds)) throw new SyncFileError(`${base}: not a map spec (no worlds)`, base);
  if (spec.name !== name) {
    throw new SyncFileError(`${base}: spec name ${JSON.stringify(spec.name)} differs from its file stem "${name}"`, base);
  }
  return { name, spec, text: canonicalSpecJson(spec), hash: specHash(spec) };
}

// World name -> spec name over `specs`; throws when one world is in two specs.
function worldOwners(specs, file) {
  const owner = new Map();
  for (const s of specs) {
    for (const w of s.spec.worlds) {
      if (owner.has(w.name) && owner.get(w.name) !== s.name) {
        throw new SyncFileError(`${file}: world ${JSON.stringify(w.name)} is in specs ${owner.get(w.name)} and ${s.name}`, file);
      }
      owner.set(w.name, s.name);
    }
  }
  return owner;
}

// The manifest and every spec it lists, validated; null when there is no
// manifest. SyncFileError (-> bad_file) on anything that cannot be trusted.
async function readGit() {
  const text = await readText(manifestFile());
  if (text === null) return null;
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new SyncFileError(`${MANIFEST}: invalid JSON`, MANIFEST); }
  if (!isObj(doc) || !isObj(doc.header) || !Array.isArray(doc.specs)) {
    throw new SyncFileError(`${MANIFEST}: missing header or specs`, MANIFEST);
  }
  if (doc.header.group !== GROUP_ID) {
    throw new SyncFileError(`${MANIFEST}: header names group ${JSON.stringify(doc.header.group)}, expected ${GROUP_ID}`, MANIFEST);
  }
  const seen = new Set();
  doc.specs.forEach((e, i) => {
    if (!isObj(e) || typeof e.name !== 'string' || !SAFE_NAME.test(e.name) || typeof e.sha256 !== 'string') {
      throw new SyncFileError(`${MANIFEST}: specs[${i}] needs a plain name and a sha256`, MANIFEST);
    }
    if (seen.has(e.name)) throw new SyncFileError(`${MANIFEST}: spec ${e.name} is listed twice`, MANIFEST);
    seen.add(e.name);
  });
  if (typeof doc.entry_world !== 'string' || !doc.entry_world) {
    throw new SyncFileError(`${MANIFEST}: entry_world must name exactly one world`, MANIFEST);
  }
  const specs = [];
  for (const e of doc.specs) specs.push({ ...(await readSpecFile(e.name, MANIFEST)), manifestSha: e.sha256 });
  const owner = worldOwners(specs, MANIFEST);
  if (!owner.has(doc.entry_world)) {
    throw new SyncFileError(`${MANIFEST}: entry_world ${JSON.stringify(doc.entry_world)} names no world of any listed spec`, MANIFEST);
  }
  const header = {};
  for (const k of HEADER_FIELDS) header[k] = doc.header[k] === undefined ? null : doc.header[k];
  return { header, specs, entryWorld: doc.entry_world, owner };
}

// Spec files in the maps dir (names, sorted); [] when the dir is missing.
async function dirSpecNames() {
  let names;
  try { names = await fs.promises.readdir(mapsDir()); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter((n) => n.endsWith('.map.json')).map((n) => n.slice(0, -'.map.json'.length))
    .filter((n) => SAFE_NAME.test(n)).sort(cmp);
}

// `specs` ordered so a spec comes after every spec its to_name links target
// (apply resolves to_name from the database). Ties and cycles: input order.
function dependencyOrder(specs) {
  const owner = new Map();
  for (const s of specs) for (const w of s.spec.worlds) owner.set(w.name, s.name);
  const needs = new Map(specs.map((s) => [s.name, new Set((s.spec.links || [])
    .filter((l) => l.to_name !== undefined && owner.has(l.to_name) && owner.get(l.to_name) !== s.name)
    .map((l) => owner.get(l.to_name)))]));
  const out = [];
  const left = [...specs];
  while (left.length) {
    let i = left.findIndex((s) => [...needs.get(s.name)].every((n) => out.some((o) => o.name === n)));
    if (i < 0) i = 0;
    out.push(left.splice(i, 1)[0]);
  }
  return out;
}

// ---- cross-spec inputs (from spec files, never from the DB) --------------------

// specFromDb's inputs for `self`: every OTHER spec's worlds (name -> spec name)
// and compass slots.
function writerInputs(all, self) {
  const otherSpecWorlds = new Map();
  const keepSlots = [];
  for (const s of all) {
    if (s.name === self.name) continue;
    for (const w of s.spec.worlds) otherSpecWorlds.set(w.name, s.name);
    keepSlots.push(...compassSlots(s.spec));
  }
  return { otherSpecWorlds, keepSlots };
}

// spec name -> Set of its world keys that a cross-spec (to_name) link touches,
// either end: links are bidirectional, so the target world is reached from
// the other spec, and the source world reaches (and is reached from) it.
function reachFromFiles(all) {
  const owner = new Map();
  for (const s of all) for (const w of s.spec.worlds) owner.set(w.name, s);
  const out = new Map(all.map((s) => [s.name, new Set()]));
  for (const s of all) {
    for (const l of s.spec.links || []) {
      if (l.to_name === undefined) continue;
      const t = owner.get(l.to_name);
      if (!t || t.name === s.name) continue;
      const tw = t.spec.worlds.find((w) => w.name === l.to_name);
      out.get(t.name).add(tw.key);
      out.get(s.name).add(l.from);
    }
  }
  return out;
}

// Two specs claiming one (world, edge) doorway slot for different targets: a
// to_name compass mirror would silently rewrite a slot another spec owns.
// Checked from the spec files, before any write. [{ slot, message }].
function slotConflicts(all) {
  const claims = new Map(); // 'world:edge' -> [{ spec, target }]
  const claim = (slot, spec, target) => {
    if (!claims.has(slot)) claims.set(slot, []);
    claims.get(slot).push({ spec, target });
  };
  for (const s of all) {
    const nameOf = new Map(s.spec.worlds.map((w) => [w.key, w.name]));
    for (const l of s.spec.links || []) {
      if (l.kind === 'portal' || !nameOf.has(l.from) || !l.edge) continue;
      const from = nameOf.get(l.from);
      const to = l.to_name !== undefined ? l.to_name : nameOf.get(l.to);
      if (to === undefined) continue;
      claim(`${from}:${l.edge}`, s.name, to);
      claim(`${to}:${oppositeEdge(l.edge)}`, s.name, from);
    }
  }
  const out = [];
  for (const [slot, cs] of [...claims].sort(([a], [b]) => cmp(a, b))) {
    const specs = [...new Set(cs.map((c) => c.spec))];
    const targets = new Set(cs.map((c) => c.target));
    if (specs.length < 2 || targets.size < 2) continue;
    const who = cs.filter((c, i) => cs.findIndex((x) => x.spec === c.spec && x.target === c.target) === i)
      .map((c) => `"${c.spec}" (to ${c.target})`).join(' and ');
    out.push({ code: 'slot_conflict', slot, specs, message: `doorway slot ${slot} is claimed by specs ${who}` });
  }
  return out;
}

// ---- status ---------------------------------------------------------------------

// Names of the worlds whose entry or outgoing links differ between two
// versions of a spec, in `to`'s world order (then worlds only `from` has).
function changedWorlds(from, to) {
  const linksOf = (spec, key) => JSON.stringify((spec.links || []).filter((l) => l.from === key));
  const byKey = (spec) => new Map((spec.worlds || []).map((w) => [w.key, w]));
  const a = byKey(from);
  const b = byKey(to);
  const out = [];
  for (const [k, w] of b) {
    if (JSON.stringify(a.get(k)) !== JSON.stringify(w) || linksOf(from, k) !== linksOf(to, k)) out.push(w.name);
  }
  for (const [k, w] of a) if (!b.has(k)) out.push(w.name);
  return out;
}

function fieldsOf(localNames, gitNames, order) {
  const all = [...new Set([...order.filter((n) => localNames.includes(n) || gitNames.includes(n)), ...localNames, ...gitNames])];
  return all.map((name) => ({
    name,
    local: localNames.includes(name) ? 'edited here' : null,
    git: gitNames.includes(name) ? 'changed in git' : null,
  }));
}

const laterHash = (st) => {
  if (st.applied_sha256 && st.exported_sha256) {
    return (st.exported_at && st.applied_at && st.exported_at > st.applied_at) ? st.exported_sha256 : st.applied_sha256;
  }
  return st.applied_sha256 || st.exported_sha256;
};

function makeRow(name, kind, fields) {
  return {
    table: TABLE, syncUuid: uuidOf(name), key: name, keyParts: [name], kind,
    defaultDecision: DEFAULTS[kind], blockedReason: null, fields,
  };
}

// One spec's status on this PC (see the header). `inputs` from writerInputs.
// `adopt: true` marks a spec whose base_spec is not recorded here although git's
// version is known to be the base or to match the DB: a PC that built its
// worlds before seed sync (no state row, DB == git), or a legacy state row
// whose hash is git's. Seed and export record base = git for it, under the
// lock -- status itself never writes.
const NO_BASELINE = 'no_baseline';
const NO_BASELINE_MESSAGE = 'No baseline on this PC — the two sides can\'t be told apart. '
  + 'Take git unless you made these edits here.';
async function specStatus(db, g, st, inputs) {
  const worldNames = g.spec.worlds.map((w) => w.name);
  const tracked = st && (st.applied_sha256 || st.exported_sha256);
  let baseText = tracked ? st.base_spec : null;
  let adopt = false;
  if (tracked && baseText == null && laterHash(st) === g.hash) {
    // Legacy row (hashes only) whose hash is git's: git IS the base; back-fill it.
    baseText = g.text;
    adopt = true;
  }
  if (baseText == null) {
    // No copy of the base (never tracked here, or a legacy row whose hash is
    // not git's): compare the DB with git. Which worlds are here comes from
    // the writer's seed-aware match, so a spec whose worlds were all renamed
    // is not "new" (a seed would build them a second time).
    const w = await specFromDb(db, g.spec, inputs);
    const matched = w.matchedWorlds.length;
    if (!tracked && matched === 0) {
      return { kind: 'new', fields: fieldsOf([], worldNames, worldNames), notes: [], outNames: [] };
    }
    // Equal -> in sync (adopt); different -> both sides may have changed, a
    // conflict with no default. Some of its worlds missing is a conflict too
    // (the writer keeps a missing world as the spec has it, so equality would
    // not prove anything).
    const outText = canonicalSpecJson(w.spec);
    const changed = outText !== g.text || matched < worldNames.length;
    const names = changed ? changedWorlds(g.spec, w.spec) : [];
    return {
      kind: changed ? 'conflict' : null, adopt: !changed, noBaseline: changed,
      fields: fieldsOf(names, names, worldNames), notes: w.notes,
      outNames: w.spec.worlds.map((x) => x.name), outText,
    };
  }
  const base = JSON.parse(baseText);
  const w = await specFromDb(db, base, inputs);
  const outText = canonicalSpecJson(w.spec);
  const edited = outText !== baseText;
  const gitNewer = textHash(baseText) !== g.hash;
  const kind = edited && gitNewer ? 'conflict' : edited ? 'edited_here' : gitNewer ? 'git_newer' : null;
  return {
    kind,
    adopt,
    fields: fieldsOf(edited ? changedWorlds(base, w.spec) : [], gitNewer ? changedWorlds(base, g.spec) : [], worldNames),
    notes: w.notes,
    outNames: w.spec.worlds.map((x) => x.name),
    outText,
  };
}

function zeroCounts() {
  return Object.fromEntries(KINDS.map((k) => [k, 0]));
}

// The full status: { git, diff (diffGroup's summary shape), signature }.
// Pushes the exported specs' edits to the GPU box (mapsBoxPush.js).
const pushToBox = (db, names, deps, opts = {}) => pushSpecs(db, names, deps, {
  readSpec: (name) => JSON.parse(fs.readFileSync(specFile(name), 'utf8')), ...opts,
});

const boxNoteOf = (states, specs) => boxNote(boxProblems(states, specs.map((g) => g.name)));

async function computeStatus(db) {
  const git = await readGit();
  const dbVersion = await schemaVersion(db);
  const states = await readStates(db);
  if (!git) {
    const { rows: ex } = await db.query(
      `SELECT EXISTS (SELECT 1 FROM seed_export_runs WHERE group_id = $1 AND action = 'export' AND status = 'ok') AS x`,
      [GROUP_ID]);
    return {
      git: null,
      dbVersion,
      adopt: [],
      details: new Map(),
      diff: {
        groupId: GROUP_ID, header: null, status: ex[0].x ? 'file_missing' : 'never_exported', counts: zeroCounts(),
        localEdits: 0, gitChanges: 0, tokensMissing: 0, tables: [{ table: TABLE, counts: zeroCounts() }], warnings: [], rows: [],
      },
    };
  }
  const rows = [];
  const warnings = [];
  const details = new Map();
  const inSpec = new Set(git.owner.keys());
  for (const g of git.specs) {
    if (g.manifestSha !== g.hash) {
      warnings.push({ code: 'manifest_stale', key: g.name, message: `${g.name}.map.json changed since maps.json was written` });
    }
    const s = await specStatus(db, g, states.get(g.name), writerInputs(git.specs, g));
    details.set(g.name, { g, ...s });
    for (const n of s.outNames) inSpec.add(n);
    // The writer's notes (a world matched by seed as a rename, a doorway no
    // spec owns, ...): never blocking, shown so the admin can confirm.
    for (const message of s.notes) warnings.push({ code: 'map_note', key: g.name, message });
    if (s.kind) {
      const row = makeRow(g.name, s.kind, s.fields);
      // A legacy/no-base conflict: red, with a note on why (no default).
      if (s.noBaseline) Object.assign(row, { blockedReason: NO_BASELINE, blockedMessage: NO_BASELINE_MESSAGE });
      rows.push(row);
    } else if (s.adopt) {
      rows.push({ ...makeRow(g.name, 'baseline', []), blockedMessage: BASELINE_HINT });
    }
  }
  const gitNames = new Set(git.specs.map((g) => g.name));
  for (const [name, st] of states) {
    if (gitNames.has(name) || !(st.applied_sha256 || st.exported_sha256)) continue;
    rows.push(makeRow(name, 'only_here', []));
  }
  warnings.push(...slotConflicts(git.specs));
  // Git decides the entry world: say so when this PC's has drifted (e.g. a
  // `make seed-map` moved it). The next Maps seed puts it back.
  const { rows: entryRows } = await db.query('SELECT name FROM worlds WHERE is_entry ORDER BY name');
  const entryHere = entryRows.map((r) => r.name);
  if (entryHere.length !== 1 || entryHere[0] !== git.entryWorld) {
    warnings.push({
      code: 'entry_world_drift', key: git.entryWorld, here: entryHere,
      message: `entry world here is ${entryHere.length ? entryHere.map((n) => `"${n}"`).join(', ') : 'none'}; `
        + `git says "${git.entryWorld}" (a Maps seed sets it)`,
    });
  }
  const { rows: worlds } = await db.query('SELECT name FROM worlds ORDER BY name');
  for (const { name } of worlds) {
    if (inSpec.has(name)) continue;
    warnings.push({
      code: 'world_not_in_spec', key: name,
      message: `${name}: not in any map spec — not synced; create it through Generated Worlds`,
    });
  }
  const counts = zeroCounts();
  for (const r of rows) counts[r.kind] += 1;
  const localEdits = LOCAL_EDIT_KINDS.reduce((n, k) => n + counts[k], 0);
  const gitChanges = GIT_CHANGE_KINDS.reduce((n, k) => n + counts[k], 0);
  const fileVersion = git.header.schema_version != null ? String(git.header.schema_version) : '';
  let status = 'in_sync';
  if (fileVersion > dbVersion) status = 'schema_newer';
  else if (localEdits > 0) status = 'local_edits';
  else if (gitChanges > 0) status = 'git_newer';
  else if (counts.baseline > 0) status = 'baseline_pending';
  const diff = {
    groupId: GROUP_ID, header: git.header, status, counts, localEdits, gitChanges, tokensMissing: 0,
    tables: [{ table: TABLE, counts }], warnings, rows,
    // A baseline still to record (any status): the tab says so.
    ...(counts.baseline > 0 ? { hint: BASELINE_HINT } : {}),
    // Specs the GPU box was not updated for (mapsBoxPush.js): the tab shows it.
    ...(boxNoteOf(states, git.specs) ? { note: boxNoteOf(states, git.specs) } : {}),
  };
  // What a preview showed: the manifest, every row's kind/default and the git
  // and DB-side texts behind it. Apply recomputes it under the lock.
  const parts = rows.map((r) => {
    const d = details.get(r.key);
    return `${r.key}:${r.kind}:${r.defaultDecision}:${d ? d.g.hash : ''}:${d && d.outText ? textHash(d.outText) : ''}`;
  }).sort();
  // Specs without a recorded base whose base is git: seed / export adopt them.
  const adopt = git.specs.filter((g) => details.get(g.name).adopt).map((g) => g.name);
  const signature = textHash(`${git.header.exported_at}\n${git.entryWorld}\n${parts.join('\n')}\nadopt:${adopt.join(',')}`);
  return { git, dbVersion, details, diff, signature, adopt };
}

const withAllowed = (rows) => rows.map((r) => ({ ...r, allowedDecisions: ALLOWED[r.kind] }));

async function status(db) {
  return (await computeStatus(db)).diff;
}

async function preview(pool) {
  const cs = await computeStatus(pool);
  const schemaWarnings = cs.git && String(cs.git.header.schema_version || '') < cs.dbVersion ? [{ code: 'schema_older' }] : [];
  return { ...cs.diff, rows: withAllowed(cs.diff.rows), warnings: [...schemaWarnings, ...cs.diff.warnings], signature: cs.signature || '' };
}

// ---- apply ----------------------------------------------------------------------

function planDecisions(cs, decisions) {
  if (decisions === null || decisions === undefined) decisions = {};
  if (typeof decisions !== 'object' || Array.isArray(decisions)) {
    throw new SyncRefused('invalid_decision', 'decisions must be an object keyed by sync_uuid', { uuids: [] });
  }
  const byUuid = new Map(cs.diff.rows.map((r) => [r.syncUuid, r]));
  const stale = Object.keys(decisions).filter((u) => !byUuid.has(u));
  if (stale.length) throw new SyncRefused('stale_preview', 'the diff changed since the preview; preview again', { uuids: stale });
  const invalid = Object.keys(decisions).filter((u) => !ALLOWED[byUuid.get(u).kind].includes(decisions[u]));
  if (invalid.length) {
    throw new SyncRefused('invalid_decision', 'decision not allowed for this spec', {
      uuids: invalid, rows: invalid.map((u) => ({ table: TABLE, key: byUuid.get(u).key })),
    });
  }
  const steps = cs.diff.rows.map((row) => ({
    row, decision: Object.prototype.hasOwnProperty.call(decisions, row.syncUuid) ? decisions[row.syncUuid] : row.defaultDecision,
  }));
  const undecided = steps.filter((s) => s.decision === null);
  if (undecided.length) {
    throw new SyncRefused('undecided', 'specs edited on this PC need a decision', {
      uuids: undecided.map((s) => s.row.syncUuid), rows: undecided.map((s) => ({ table: TABLE, key: s.row.key })),
    });
  }
  return steps;
}

// Seeds the specs decided 'git' in manifest order, spec by spec: applyMapSpec
// runs its own transaction per spec (it reads catalogs and resolves to_name
// through the pool, outside it), so a seed is NOT one transaction. Each
// spec's applied hash is recorded right after it commits; a failure stops the
// seed with SyncRefused('partial_apply', { applied, failed, step, error }). The
// seed_sync advisory lock is held (on its own connection) for the whole run,
// so no other seed or export interleaves. Then the manifest's entry world.
async function apply(pool, decisions, opts = {}) {
  const { signature } = opts;
  if (opts.signal && opts.signal.aborted) throw new SyncRefused('cancelled', 'cancelled');
  const { applyMapSpec } = require('../../../scripts/seed-map.js');
  const lock = await pool.connect();
  let runId = null;
  let releaseErr;
  let result;
  try {
    await beginLocked(lock);
    const cs = await computeStatus(pool);
    if (!cs.git) throw new SyncRefused('no_export', `no export file for ${GROUP_ID}`);
    const fileVersion = String(cs.git.header.schema_version || '');
    if (fileVersion > cs.dbVersion) {
      throw new SyncRefused('schema_newer', 'run migrations first', { fileVersion, dbVersion: cs.dbVersion });
    }
    if (typeof signature !== 'string' || signature !== cs.signature) {
      throw new SyncRefused('stale_preview', 'the diff changed since the preview; preview again', { uuids: [] });
    }
    const steps = planDecisions(cs, decisions);
    const clashes = slotConflicts(cs.git.specs);
    if (clashes.length) {
      throw new SyncRefused('slot_conflict', clashes.map((c) => c.message).join('; '), { conflicts: clashes });
    }
    const decisionOf = new Map(steps.map((s) => [s.row.key, s.decision]));
    const toApply = cs.git.specs.filter((g) => decisionOf.get(g.name) === 'git');
    // The entry world must exist once the seed is done.
    const entry = cs.git.entryWorld;
    const entryExists = (await pool.query('SELECT 1 FROM worlds WHERE name = $1', [entry])).rowCount > 0;
    if (!entryExists && !toApply.some((g) => g.spec.worlds.some((w) => w.name === entry))) {
      throw new SyncRefused('entry_missing',
        `entry world "${entry}" does not exist here; seed its spec (${cs.git.owner.get(entry)}) too`, { entryWorld: entry });
    }

    // A cancel queued while this job waited for the lock still counts.
    if (opts.signal && opts.signal.aborted) throw new SyncRefused('cancelled', 'cancelled');
    runId = await startRun(pool, GROUP_ID, 'seed');
    const reach = reachFromFiles(cs.git.specs);
    const gitOf = new Map(cs.git.specs.map((g) => [g.name, g]));
    const applied = [];
    let failed = null;
    // The step that was running: adopt | apply (failed names the spec) |
    // keep_local | entry. partial_apply reports it.
    let step = 'adopt';
    let kept = 0;
    let forgotten = 0;
    try {
      // In sync without a base here (first adoption): base = git, no decision.
      for (const name of cs.adopt) await recordApplied(pool, name, gitOf.get(name).spec);
      step = 'apply';
      for (const g of toApply) {
        failed = g.name;
        const { keepSlots } = writerInputs(cs.git.specs, g);
        await applyMapSpec(pool, g.spec, { moveEntry: false, keepSlots, externallyReachable: reach.get(g.name) });
        await recordApplied(pool, g.name, g.spec);
        applied.push(g.name);
        failed = null;
      }
      step = 'keep_local';
      if (opts._afterSpecs) await opts._afterSpecs(); // test hook: a failure after every spec applied
      // Keep local: git's version is acknowledged (as applied, the base), so
      // the next status reads the DB as a local edit of it -- export then
      // writes it. A spec gone from git just stops being tracked; its worlds stay.
      for (const { row, decision } of steps) {
        if (decision !== 'local' || row.kind === 'baseline') continue; // baseline: adopted above
        kept += 1;
        if (row.kind === 'only_here') { await forget(pool, row.key); forgotten += 1; } else if (row.kind !== 'edited_here') {
          await recordApplied(pool, row.key, gitOf.get(row.key).spec);
        }
      }
      // Git decides the entry world (plan decision 4); one atomic statement.
      step = 'entry';
      await setEntryWorldByName(pool, entry);
      const { rows: entries } = await pool.query('SELECT name FROM worlds WHERE is_entry ORDER BY name');
      if (entries.length !== 1 || entries[0].name !== entry) {
        throw new Error(`entry world: expected exactly "${entry}", found ${JSON.stringify(entries.map((r) => r.name))}`);
      }
    } catch (e) {
      // Specs before the failure are committed and recorded: keep "exactly
      // one entry world" true (a fresh PC has none until git's exists), then
      // report what was applied.
      try {
        if ((await pool.query('SELECT 1 FROM worlds WHERE name = $1', [entry])).rowCount) await setEntryWorldByName(pool, entry);
      } catch (ee) {
        console.error('seed-sync: maps seed could not set the entry world after a failure:', ee.message);
      }
      const done = applied.length ? `applied ${applied.join(', ')}; ` : 'nothing applied; ';
      const what = failed ? `${failed} failed` : `the ${step} step failed`;
      throw new SyncRefused('partial_apply', `${done}${what}: ${e.message}`,
        { applied: [...applied], failed, step, error: e.message });
    }
    await lock.query('COMMIT');
    // updated/created/deleted/adopted: the counts the tab's Seed all toast
    // prints for every group (a spec is created when it was new here).
    const created = applied.filter((n) => decisionOf.has(n) && cs.diff.rows.find((r) => r.key === n).kind === 'new').length;
    result = {
      runId,
      summary: {
        applied, kept, forgotten, entryWorld: entry, updated: applied.length - created, created, deleted: 0,
        adopted: cs.adopt.length,
      },
    };
  } catch (err) {
    const e = mapLockError(err);
    releaseErr = await rollback(lock);
    if (runId !== null) await finishRun(pool, runId, { status: 'failed', error: e.message, summary: e.details || {} }).catch(() => {});
    throw e;
  } finally {
    lock.release(releaseErr);
  }
  await finishRun(pool, runId, { status: 'ok', summary: result.summary })
    .catch((e) => console.error(`seed-sync: maps seed run ${runId} committed but not marked ok:`, e.message));
  return result;
}

// ---- export ---------------------------------------------------------------------

async function writeAtomic(file, text) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    await fs.promises.writeFile(tmp, text);
    await fs.promises.rename(tmp, file);
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw e;
  }
}

const sameInputs = (a, b) => JSON.stringify([[...a.otherSpecWorlds].sort(), [...a.keepSlots].sort()])
  === JSON.stringify([[...b.otherSpecWorlds].sort(), [...b.keepSlots].sort()]);

// Writer outputs for every spec, with otherSpecWorlds / keepSlots taken from
// the specs as they will be WRITTEN (a renamed world counts under its new
// name): one pass from the files, and one more if that changed any input.
async function writerOutputs(db, specs) {
  const asFiles = specs.map((s) => ({ name: s.name, spec: s.spec }));
  const run = async (from) => {
    const out = [];
    for (const s of specs) {
      const inputs = writerInputs(from, s);
      out.push({ name: s.name, inputs, ...(await specFromDb(db, s.spec, inputs)) });
    }
    return out;
  };
  let outs = await run(asFiles);
  const next = outs.map((o) => ({ name: o.name, spec: o.spec }));
  if (outs.some((o) => !sameInputs(o.inputs, writerInputs(next, o)))) outs = await run(next);
  return outs;
}

// Writes every spec edited here (the writer's output, validated first), then
// the manifest, then the exported hashes. Refuses while git holds a change
// (new / git_newer / conflict): seed first. Under the seed_sync lock; the DB is
// read in one repeatable-read snapshot (no table locks).
async function exportMaps(pool, opts = {}) {
  if (opts.signal && opts.signal.aborted) throw new SyncRefused('cancelled', 'cancelled');
  const { loadSpecCatalogs } = require('../../../scripts/seed-map.js');
  const client = await pool.connect();
  let runId = null;
  let releaseErr;
  let result;
  const allSpecNames = new Set();
  try {
    await beginLocked(client);
    // Every DB read in ONE repeatable-read, read-only snapshot on its own
    // connection: the specs describe one moment without table locks (a SHARE
    // lock on worlds / world_chests would stall chest opens during play). The
    // seed_sync advisory lock (held above) keeps seeds and exports single-file.
    // Files and state are written after the snapshot closes.
    const snap = await pool.connect();
    let snapErr;
    let cs; let specs; let entryWorld; let writes; let finalSpecs; let notes;
    try {
      await snap.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      cs = await computeStatus(snap);
      if (cs.git && String(cs.git.header.schema_version || '') > cs.dbVersion) {
        throw new SyncRefused('schema_newer', 'run migrations first', {
          fileVersion: cs.git.header.schema_version, dbVersion: cs.dbVersion,
        });
      }
      const blocking = cs.diff.rows.filter((r) => EXPORT_BLOCKING.has(r.kind));
      if (blocking.length) {
        throw new SyncRefused('git_newer', 'seed (preview) first', {
          gitChanges: blocking.length, rows: blocking.map((r) => ({ table: TABLE, key: r.key, kind: r.kind })),
        });
      }
      // The manifest's specs, plus spec files it does not list yet (appended in
      // dependency order). A first export lists every spec file.
      const listed = cs.git ? cs.git.specs : [];
      const extra = [];
      for (const name of await dirSpecNames()) {
        if (!listed.some((s) => s.name === name)) extra.push(await readSpecFile(name, 'maps dir'));
      }
      specs = [...listed, ...dependencyOrder(extra)];
      for (const sp of specs) allSpecNames.add(sp.name);
      if (!specs.length) throw new SyncRefused('no_specs', `no map spec files in ${mapsDir()}`);
      const owner = worldOwners(specs, 'maps dir');
      entryWorld = cs.git ? cs.git.entryWorld : null;
      if (!entryWorld) {
        // First export: this PC's entry world when a spec holds it, else the one
        // world the specs declare is_entry.
        const { rows } = await snap.query('SELECT name FROM worlds WHERE is_entry');
        const declared = specs.flatMap((s) => s.spec.worlds.filter((w) => w.is_entry).map((w) => w.name));
        if (rows.length === 1 && owner.has(rows[0].name)) entryWorld = rows[0].name;
        else if (declared.length === 1) entryWorld = declared[0];
        else throw new SyncRefused('no_entry', 'cannot tell the entry world: make one world of a map spec the entry first');
      }

      // Write only specs whose base is git's file (in sync or edited here).
      const states = await readStates(snap);
      const outs = await writerOutputs(snap, specs);
      const finals = new Map(specs.map((s) => [s.name, s.spec]));
      writes = [];
      notes = [];
      for (const o of outs) {
        const s = specs.find((x) => x.name === o.name);
        const st = states.get(o.name);
        const base = st && (st.base_spec != null ? st.base_spec : (laterHash(st) === s.hash ? s.text : null));
        notes.push(...o.notes.map((message) => ({ key: o.name, message })));
        if (base !== s.text) continue;
        if (canonicalSpecJson(o.spec) === s.text) continue;
        writes.push(o);
        finals.set(o.name, o.spec);
      }
      // Validate before writing anything: the specs as they will be in git.
      finalSpecs = specs.map((s) => ({ name: s.name, spec: finals.get(s.name) }));
      const reach = reachFromFiles(finalSpecs);
      const catalogs = await loadSpecCatalogs(snap);
      const invalid = [];
      for (const o of writes) {
        const externallyReachable = new Set([...o.externallyReachable, ...reach.get(o.name)]);
        const errors = validateMapSpec(o.spec, { ...catalogs, externallyReachable });
        if (errors.length) invalid.push({ spec: o.name, errors });
      }
      if (invalid.length) {
        throw new SyncRefused('invalid_spec',
          invalid.map((v) => `${v.name || v.spec}: ${v.errors.join('; ')}`).join(' | '), { specs: invalid });
      }
      const clashes = slotConflicts(finalSpecs);
      if (clashes.length) throw new SyncRefused('slot_conflict', clashes.map((c) => c.message).join('; '), { conflicts: clashes });
      await snap.query('COMMIT');
    } catch (e) {
      snapErr = await rollback(snap);
      throw e;
    } finally {
      snap.release(snapErr);
    }

    // A cancel queued while this job waited for the lock still counts.
    if (opts.signal && opts.signal.aborted) throw new SyncRefused('cancelled', 'cancelled');
    runId = await startRun(pool, GROUP_ID, 'export');
    // Spec files first, then the manifest, then this PC's state: a failure
    // after a file is written reads as "git changed" (safe), never as a sync
    // that did not happen.
    for (const o of writes) await writeAtomic(specFile(o.name), canonicalSpecJson(o.spec));
    const doc = {
      header: {
        group: GROUP_ID,
        exported_at: new Date().toISOString(),
        exported_by: pcLabel(),
        schema_version: cs.dbVersion,
        spec_count: specs.length,
      },
      specs: finalSpecs.map((s) => ({ name: s.name, sha256: specHash(s.spec) })),
      entry_world: entryWorld,
    };
    await writeAtomic(manifestFile(), `${JSON.stringify(doc, null, 2)}\n`);
    for (const o of writes) await recordExported(client, o.name, o.spec);
    // In sync without a base here (first adoption): base = git.
    for (const name of cs.adopt) await recordApplied(client, name, cs.details.get(name).g.spec);
    await client.query('COMMIT');
    result = {
      runId, rowCount: writes.length, rowCounts: { [TABLE]: writes.length }, written: writes.map((o) => o.name), notes,
    };
  } catch (err) {
    const e = mapLockError(err);
    releaseErr = await rollback(client);
    if (runId !== null) await finishRun(pool, runId, { status: 'failed', error: e.message }).catch(() => {});
    throw e;
  } finally {
    client.release(releaseErr);
  }
  await finishRun(pool, runId, { status: 'ok', summary: { rowCount: result.rowCount, written: result.written } })
    .catch((e) => console.error(`seed-sync: maps export run ${runId} committed but not marked ok:`, e.message));
  // The export is done and the lock is released. The box can be slow (20s per
  // call), so its push comes last and can never fail the export.
  if (opts.pushToBox) {
    try {
      const retry = [];
      for (const [name, st] of await readStates(pool)) if (st.box_error && !result.written.includes(name)) retry.push(name);
      const names = [...result.written, ...retry].filter((n) => allSpecNames.has(n));
      result.box = await pushToBox(pool, names, opts.boxDeps || {}, {
        signal: opts.signal, onProgress: opts.onProgress,
      });
    } catch (e) {
      console.error('seed-sync: maps export committed but the GPU box push failed:', e.message);
      result.box = [];
    }
  }
  return result;
}

module.exports = {
  status, preview, apply, export: exportMaps, pushToBox,
  // internals, for tests
  _boxNote: boxNote, _slotConflicts: slotConflicts, _reachFromFiles: reachFromFiles, _dependencyOrder: dependencyOrder, DEFAULTS, ALLOWED,
};
