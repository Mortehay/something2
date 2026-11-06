// SOMET-591 (game audio slice 2). `make audio-export` / `make audio-seed`.
//
// Same problem as SOMET-572's artSeed.js: a generated clip lives in two
// places git cannot see -- the object store holds the bytes and audio_clips
// holds a job-scoped storage_key pointing at them, and audio_bindings points
// a subject (a world, a biome) at a clip id. Clone the repo and you get
// neither the bytes nor the wiring.
//
// This mirrors artSeed's shape (export pulls bound clips + their bindings out
// of the store/DB into the repo; seed replays them) but audio has no per-kind
// SEED_POLICY: there is one clip shape and one binding shape, kind only picks
// which subdirectory a clip's file lives under. matchOwner and readObject are
// reused from artSeed rather than copied (see that module for why: the export
// runs as root inside the backend container onto a bind mount, and without
// re-chowning to whatever owns backend/seeds every file lands owned by root).
//
// ONLY CLIPS WITH A BINDING ARE EXPORTED. An unbound clip is either mid-review
// in the admin library or genuinely orphaned; either way nothing would use a
// seeded copy of it, so exporting it would just grow the repo for no reader.
//
// STABLE IDS. A seeded clip keeps the id it was exported with -- seedAudio
// writes its own INSERT (see below) rather than going through
// audioLibrary.storeClip, specifically so it can put the manifest's id
// straight into the row. A binding row points at a clip_id, and that has to
// resolve after a reseed instead of dangling on a freshly generated uuid.

const fs = require('fs');
const path = require('path');
const { matchOwner, readObject, safeName } = require('./artSeed.js');
const { existingSubjects } = require('./audioSubjects.js');
const { sha1Of } = require('./audioLibrary.js');
const audioPrompts = require('./audioPrompts');

const AUDIO_SEEDS_ROOT = path.resolve(__dirname, '../../seeds/audio');
const AUDIO_KINDS = ['music', 'ambience', 'sfx'];

function readManifest(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

// Same location rule as artSeed.js and spriteSeed.js.
function defaultSyncFile() {
  return path.join(process.env.SEED_SYNC_DIR || path.resolve(AUDIO_SEEDS_ROOT, '../sync'), 'audio.json');
}

const defaultSyncFor = (root) => (root === AUDIO_SEEDS_ROOT ? defaultSyncFile() : null);

function bindingKey(b) {
  return `${b.subject_kind}\u0000${b.subject_key}\u0000${b.slot}\u0000${b.clip_id}`;
}

const promptKey = (p) => `${p.subject_kind}\u0000${p.subject_key}\u0000${p.slot}`;

// SOMET-722. The Seed/Export tab commits the .ogg files and seeds/sync/audio.json, and does not touch clips.json,
// bindings.json or prompts.json, so those three alone are an incomplete list: the Orange Pi got 4,944 of 7,202 sounds
// and nothing said so, because a clip no list names cannot be counted as missing. So read both, as a union.
// The sync row wins for the same clip, binding or prompt, because the tab is the export in use and never updates the
// legacy files (art's reverse rule exists only because its manifest alone carries needs_regen). With two writers and
// no timestamps one must lose: an edit sent through `make audio-export` alone, with no tab export after it, is
// overridden by the older sync row until the tab exports it. A union also cannot see a deletion: a row removed from
// the sync file but still in the legacy files is seeded. The legacy files are read for what only they name.
function audioSeedLists({ root = AUDIO_SEEDS_ROOT, syncFile = defaultSyncFor(root) } = {}) {
  const clips = readManifest(path.join(root, 'clips.json'));
  const bindings = readManifest(path.join(root, 'bindings.json'));
  const prompts = readManifest(path.join(root, 'prompts.json'));
  if (!syncFile || !fs.existsSync(syncFile)) return { clips, bindings, prompts };

  const tables = JSON.parse(fs.readFileSync(syncFile, 'utf8')).tables || {};
  // A sync row's identity is its sync_uuid, and its file is relative to seeds/, not seeds/audio/.
  const syncClips = (tables.audio_clips || [])
    .filter((r) => r.storage_key && r.storage_key.file)
    .map(({ storage_key: stored, sync_uuid: id, ...row }) => ({ ...row, id, file: stored.file.replace(/^audio\//, '') }));
  const syncBindings = tables.audio_bindings || [];
  const syncPrompts = tables.audio_prompts || [];
  const clipIds = new Set(syncClips.map((c) => c.id));
  const bindingKeys = new Set(syncBindings.map(bindingKey));
  const promptKeys = new Set(syncPrompts.map(promptKey));
  return {
    clips: [...syncClips, ...clips.filter((c) => !clipIds.has(c.id))],
    bindings: [...syncBindings, ...bindings.filter((b) => !bindingKeys.has(bindingKey(b)))],
    prompts: [...syncPrompts, ...prompts.filter((p) => !promptKeys.has(promptKey(p)))],
  };
}

// .ogg files of these kinds that no list names. They would never reach a board, so the seed says so.
function unlistedAudioFiles(root, clips, kinds) {
  const listed = new Set(clips.map((c) => c.file));
  return kinds.flatMap((kind) => {
    const dir = path.join(root, kind);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.ogg')).map((f) => `${kind}/${f}`).filter((f) => !listed.has(f));
  });
}

// The row a list entry means. A list's id is the clip's git identity: on a machine where the Seed/Export tab applied
// audio, the row has a local id and holds that identity in sync_uuid; everywhere else the two are equal. A clip exported
// from such a machine by `make audio-export` is listed under its local id, hence the id match as well.
const CLIP_ROWS_SQL = 'SELECT id, sync_uuid, storage_key FROM audio_clips WHERE sync_uuid = ANY($1) OR id = ANY($1)';

// What seedAudio would copy right now, for the Orange Pi's seed dialog. One query and one listing of the store rather
// than the seed's per-clip query and stat, which take minutes on the board. Its rules are the seed's: no row, or a row
// whose object is gone, is copied, unless the file is not on disk (the seed reports that as missing).
async function planAudio({
  db, store, root = AUDIO_SEEDS_ROOT, kinds = AUDIO_KINDS, syncFile = defaultSyncFor(root),
}) {
  const wanted = audioSeedLists({ root, syncFile }).clips.filter((c) => kinds.includes(c.kind));
  const { rows } = await db.query(CLIP_ROWS_SQL, [wanted.map((c) => c.id)]);
  const byIdentity = new Map(rows.map((r) => [r.sync_uuid, r]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const keys = new Set(await store.listObjectKeys());
  const pending = wanted.filter((c) => {
    const row = byIdentity.get(c.id) || byId.get(c.id);
    return !(row && keys.has(row.storage_key)) && fs.existsSync(path.join(root, c.file));
  });
  return { total: wanted.length, pending: pending.length };
}

// Collapse to one entry per (subject_kind, subject_key, slot, clip_id),
// keeping the first occurrence. Used as a final safety net on the merged
// bindings list -- see the comment above its call site.
function dedupeBindings(list) {
  const seen = new Set();
  const out = [];
  for (const b of list) {
    const key = bindingKey(b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

// Copy every bound clip's bytes out of the object store into
// seeds/audio/<kind>/ and (re)write clips.json + bindings.json. With `only`
// (subject names), just those subjects' bound clips are re-exported and the
// rest of both manifests is kept -- the same merge-not-truncate rule
// exportArt uses, for the same reason: a full export is the only one allowed
// to drop stale entries, because it alone has seen everything there is.
async function exportAudio({
  db, store, root = AUDIO_SEEDS_ROOT, kinds = AUDIO_KINDS, only = null, log = console.log,
}) {
  fs.mkdirSync(root, { recursive: true });
  const owner = path.dirname(root);
  matchOwner(root, owner);

  const results = {};
  const freshClips = [];
  let totalBytes = 0;

  for (const kind of kinds) {
    const outDir = path.join(root, kind);
    fs.mkdirSync(outDir, { recursive: true });

    const params = [kind];
    let subjectFilter = '';
    if (only) { params.push(only); subjectFilter = 'AND b.subject_key = ANY($2)'; }
    const { rows } = await db.query(
      `SELECT DISTINCT c.* FROM audio_clips c
         JOIN audio_bindings b ON b.clip_id = c.id
        WHERE c.kind = $1 ${subjectFilter}
        ORDER BY c.id`,
      params,
    );

    const missing = [];
    let kindBytes = 0;
    for (const r of rows) {
      try {
        const buf = await readObject(store, r.storage_key);
        const file = `${kind}/${safeName(r.label)}-${r.id.slice(0, 8)}.ogg`;
        const dest = path.join(root, file);
        fs.writeFileSync(dest, buf);
        matchOwner(dest, owner);
        kindBytes += buf.length;
        freshClips.push({
          id: r.id,
          kind: r.kind,
          label: r.label,
          file,
          bytes: buf.length,
          duration_ms: r.duration_ms,
          loopable: r.loopable,
          loop_start_ms: r.loop_start_ms,
          loop_end_ms: r.loop_end_ms,
          prompt: r.prompt,
          style_or_cue: r.style_or_cue,
          engine: r.engine,
          seed: r.seed,
        });
        log(`  ${r.label}: ${(buf.length / 1024).toFixed(0)} KB`);
      } catch (err) {
        // A row pointing at a key the store no longer has is worth
        // reporting, not crashing on: it means that clip needs re-generating.
        log(`  ${r.label}: FAILED ${err.message}`);
        missing.push(r.id);
      }
    }
    matchOwner(outDir, owner);
    totalBytes += kindBytes;
    results[kind] = { exported: rows.length - missing.length, bytes: kindBytes, missing };
  }

  // bindings.json records how every clip touched by THIS run is bound, not
  // just the ones matching `only` -- a clip found via one subject's binding
  // may carry others, and dropping those on an `only` export would silently
  // unbind them the next time someone seeds from a fresh manifest.
  const clipIds = freshClips.map((c) => c.id);
  let freshBindings = [];
  if (clipIds.length) {
    const { rows } = await db.query(
      `SELECT subject_kind, subject_key, slot, clip_id, volume, weight, sort
         FROM audio_bindings WHERE clip_id = ANY($1)
        ORDER BY subject_kind, subject_key, slot, clip_id`,
      [clipIds],
    );
    freshBindings = rows;
  }

  const clipsPath = path.join(root, 'clips.json');
  const bindingsPath = path.join(root, 'bindings.json');
  const oldClips = readManifest(clipsPath);
  const oldBindings = readManifest(bindingsPath);

  // MERGE, not truncate: a run that only asked for some kinds (KIND=music)
  // or some subjects (ONLY=Vale) has NOT seen the rest of the catalogue, and
  // must not act like it has. `touchedKinds` is exactly the set of kinds this
  // run queried -- for those, this run has seen every currently-bound clip
  // (subject-scoped or not), so a stale entry of a touched kind is either
  // superseded by `freshClips`/`freshBindings` or genuinely gone; an entry of
  // an untouched kind was never looked at and must survive untouched.
  const touchedKinds = new Set(kinds);
  const freshClipIds = new Set(clipIds);

  // A clip whose kind we touched but that is not in `freshClips` this run is
  // either stale-and-replaced (no `only`: this run saw every bound clip of
  // that kind, so its absence means it lost its last binding) or, with
  // `only`, simply untouched by the subjects named this run -- kept for now,
  // resolved below once bindingsManifest is final.
  let clipsManifest = oldClips
    .filter((c) => !touchedKinds.has(c.kind) || (only && !freshClipIds.has(c.id)))
    .concat(freshClips);

  // Bindings: drop an OLD binding when either (a) its clip was re-exported
  // this run -- `freshBindings` already carries that clip's COMPLETE current
  // binding set (it is fetched by clip_id, not by subject), so keeping any
  // of its old entries around would duplicate one the concat is about to add
  // back -- or (b) its clip falls in a touched kind and, when `only` is set,
  // `only` names its subject: an only-export has seen every CURRENT binding
  // of those subjects, so an old one that is not in `freshBindings` (e.g. the
  // admin unbound it since the last export) must not survive the merge, or
  // `audio-seed` would silently recreate it. Without `only`, the whole kind
  // was seen, so every old binding for that kind is superseded outright.
  //
  // (a) alone is not redundant with (b): a clip bound to several subjects and
  // re-exported via just one of them (only=[worldA] on a clip also bound to
  // worldB) needs ALL of its old bindings dropped, including the worldB one
  // `only` never named -- otherwise the untouched worldB entry survives from
  // oldBindings AND arrives again in freshBindings (which is clip-scoped, not
  // subject-scoped), duplicating it, worse on every repeated only-export.
  const clipKindById = new Map();
  for (const c of oldClips) clipKindById.set(c.id, c.kind);
  for (const c of freshClips) clipKindById.set(c.id, c.kind);
  const shouldDropOldBinding = (b) => {
    if (freshClipIds.has(b.clip_id)) return true;
    const clipKind = clipKindById.get(b.clip_id);
    if (!touchedKinds.has(clipKind)) return false;
    return only ? only.includes(b.subject_key) : true;
  };
  // DEDUPE as a safety net, not just a consequence of the filter above: it
  // also heals a manifest that a prior, buggier run already polluted with
  // duplicates, which the drop logic alone cannot undo.
  const bindingsManifest = dedupeBindings(
    oldBindings.filter((b) => !shouldDropOldBinding(b)).concat(freshBindings),
  );

  // Now that bindings.json is final, a clip in a touched kind that no
  // binding references any more (the case above deferred) is dead weight --
  // prune it rather than leaving an orphaned entry that nothing points at.
  if (only) {
    const referencedClipIds = new Set(bindingsManifest.map((b) => b.clip_id));
    clipsManifest = clipsManifest.filter((c) => !(touchedKinds.has(c.kind) && !referencedClipIds.has(c.id)));
  }

  clipsManifest.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  bindingsManifest.sort((a, b) => bindingKey(a).localeCompare(bindingKey(b)));

  // Spec 2026-09-30 §4: prompts travel with the audio. ALWAYS the full active
  // set -- a kind/only-filtered prompts.json would overwrite the other kinds'
  // prompts, the merge-by-kind trap slice 2 already hit with bindings.json.
  const promptRows = (await audioPrompts.listAllActive(db)).map((p) => ({
    subject_kind: p.subject_kind, subject_key: p.subject_key, slot: p.slot, style: p.style, text: p.text,
    source_input: p.source_input, hint: p.hint, model: p.model, via: p.via,
  }));
  const promptsPath = path.join(root, 'prompts.json');
  fs.writeFileSync(promptsPath, `${JSON.stringify(promptRows, null, 2)}\n`);
  matchOwner(promptsPath, owner);

  fs.writeFileSync(clipsPath, `${JSON.stringify(clipsManifest, null, 2)}\n`);
  fs.writeFileSync(bindingsPath, `${JSON.stringify(bindingsManifest, null, 2)}\n`);
  matchOwner(clipsPath, owner);
  matchOwner(bindingsPath, owner);

  log(`wrote ${(totalBytes / 1024).toFixed(0)} KB of audio to seeds/audio/`);
  return results;
}

// Replay the committed clips into the object store and re-link their
// bindings. Clip ids are STABLE across a reseed (see above), which is what
// lets a binding row -- keyed by clip_id -- survive one.
async function seedAudio({
  db, store, root = AUDIO_SEEDS_ROOT, kinds = AUDIO_KINDS, only = null, force = false, log = console.log,
  syncFile = defaultSyncFor(root),
}) {
  const clipsPath = path.join(root, 'clips.json');
  if (!fs.existsSync(clipsPath) && !(syncFile && fs.existsSync(syncFile))) {
    throw new Error(`no manifest at ${clipsPath} -- run \`make audio-export\` first`);
  }
  const { clips: clipsManifest, bindings: bindingsManifest, prompts: allPrompts } = audioSeedLists({ root, syncFile });
  // A scoped run adds no prompt slot prompts.json does not hold, unless --only named its subject: it was not asked about
  // the others, and a slot only the sync file names could replace an edit made on this machine.
  const legacyPromptKeys = new Set(readManifest(path.join(root, 'prompts.json')).map(promptKey));
  const scoped = only || AUDIO_KINDS.some((k) => !kinds.includes(k));
  const promptsManifest = scoped
    ? allPrompts.filter((p) => legacyPromptKeys.has(promptKey(p)) || (only && only.includes(p.subject_key)))
    : allPrompts;

  let wantedClips = clipsManifest.filter((c) => kinds.includes(c.kind));
  if (only) {
    const relevantClipIds = new Set(
      bindingsManifest.filter((b) => only.includes(b.subject_key)).map((b) => b.clip_id),
    );
    wantedClips = wantedClips.filter((c) => relevantClipIds.has(c.id));
  }

  const unlisted = unlistedAudioFiles(root, clipsManifest, kinds);
  for (const f of unlisted) log(`  ${f}: NOT LISTED, so it is not seeded`);
  const clipStats = { linked: 0, skipped: 0, missingFile: 0, dangling: 0, unlisted: unlisted.length };
  const present = new Map(); // list id -> the row's id, which is what a binding must point at

  for (const c of wantedClips) {
    // eslint-disable-next-line no-await-in-loop
    const found = (await db.query(`${CLIP_ROWS_SQL} ORDER BY sync_uuid = $2 DESC LIMIT 1`, [[c.id], c.id])).rows[0];
    let existing = found;
    const rowId = found ? found.id : c.id;
    // SOMET-722. A row is a pointer; after the storage volume is lost every row still says "present" and
    // every clip stays 404. Same check as artSeed's dangling branch: one objectExists (a stat, no bytes)
    // per row that would otherwise be skipped. A row whose object is gone is treated as bare and re-seeded.
    if (existing && !force && existing.storage_key && !(await store.objectExists(existing.storage_key))) {
      log(`  ${c.label}: object ${existing.storage_key} is not in the store -- re-seeding`);
      clipStats.dangling += 1;
      existing = null;
    }
    if (existing && !force) {
      clipStats.skipped += 1;
      present.set(c.id, rowId);
      log(`  ${c.label}: already present`);
      continue;
    }
    const file = path.join(root, c.file);
    if (!fs.existsSync(file)) {
      log(`  ${c.label}: FAILED ${c.file} is in the manifest but not on disk`);
      clipStats.missingFile += 1;
      // The row (if any) is untouched by this failed attempt -- it is still
      // there from before, so its bindings are still fair game below.
      if (existing) present.set(c.id, rowId);
      continue;
    }
    const buffer = fs.readFileSync(file);
    const key = `audio/${c.kind}/${c.id}.ogg`;
    // eslint-disable-next-line no-await-in-loop
    await store.putObject(key, buffer, 'audio/ogg');
    // eslint-disable-next-line no-await-in-loop
    await db.query(
      `INSERT INTO audio_clips (id, kind, label, storage_key, bytes, duration_ms, loopable,
         loop_start_ms, loop_end_ms, source, prompt, style_or_cue, engine, seed, sha1)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'seeded',$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind, label = EXCLUDED.label, storage_key = EXCLUDED.storage_key,
         bytes = EXCLUDED.bytes, duration_ms = EXCLUDED.duration_ms, loopable = EXCLUDED.loopable,
         loop_start_ms = EXCLUDED.loop_start_ms, loop_end_ms = EXCLUDED.loop_end_ms, source = 'seeded',
         prompt = EXCLUDED.prompt, style_or_cue = EXCLUDED.style_or_cue, engine = EXCLUDED.engine,
         seed = EXCLUDED.seed, sha1 = EXCLUDED.sha1`,
      [rowId, c.kind, c.label, key, buffer.length, c.duration_ms, c.loopable,
        c.loop_start_ms ?? null, c.loop_end_ms ?? null, c.prompt ?? null, c.style_or_cue ?? null,
        c.engine ?? null, c.seed ?? null, sha1Of(buffer)],
    );
    clipStats.linked += 1;
    present.set(c.id, rowId);
    log(`  ${c.label}: seeded`);
  }

  let wantedBindings = bindingsManifest.filter((b) => present.has(b.clip_id));
  if (only) wantedBindings = wantedBindings.filter((b) => only.includes(b.subject_key));

  const known = await existingBindingSubjects(db, wantedBindings);

  const bindingStats = { bound: 0, skipped: 0, missingSubject: [] };
  for (const b of wantedBindings) {
    if (!known.has(`${b.subject_kind}/${b.subject_key}/${b.slot}`)) {
      const label = `${b.subject_kind}/${b.subject_key}/${b.slot}`;
      log(`  ${label}: SKIP (subject does not exist)`);
      bindingStats.missingSubject.push(label);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const r = await db.query(
      `INSERT INTO audio_bindings (subject_kind, subject_key, slot, clip_id, volume, weight, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (subject_kind, subject_key, slot, clip_id) DO NOTHING
       RETURNING id`,
      [b.subject_kind, b.subject_key, b.slot, present.get(b.clip_id), b.volume, b.weight, b.sort],
    );
    if (r.rowCount > 0) {
      bindingStats.bound += 1;
      log(`  ${b.subject_kind}/${b.subject_key}/${b.slot}: bound`);
    } else {
      bindingStats.skipped += 1;
    }
  }

  // Idempotent: only a missing or different (style, text) becomes a new
  // version, so re-running a seed never piles up history rows.
  for (const p of promptsManifest) {
    // eslint-disable-next-line no-await-in-loop
    const cur = await audioPrompts.getActive(db, p.subject_kind, p.subject_key, p.slot);
    if (cur && cur.text === p.text && (cur.style || null) === (p.style || null)) continue;
    // eslint-disable-next-line no-await-in-loop
    await audioPrompts.save(db, p.subject_kind, p.subject_key, p.slot, {
      style: p.style, text: p.text, sourceInput: p.source_input, hint: p.hint, model: p.model, via: p.via,
    });
  }

  return { clips: clipStats, bindings: bindingStats };
}

// Flags the Makefile passes: --kind=a,b --only=x,y --force
function parseArgs(argv) {
  const out = { kinds: [...AUDIO_KINDS], only: null, force: false };
  for (const arg of argv) {
    const [flag, value = ''] = arg.split('=');
    if (flag === '--kind' && value) {
      out.kinds = value.split(',').map((s) => s.trim()).filter(Boolean);
      for (const k of out.kinds) if (!AUDIO_KINDS.includes(k)) throw new Error(`unknown kind: ${k} (expected one of ${AUDIO_KINDS.join(', ')})`);
    } else if (flag === '--only' && value) {
      out.only = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (flag === '--force') {
      out.force = true;
    }
  }
  return out;
}

// SOMET-605: which manifest bindings point at a subject that exists AND
// carries that slot (a boss slot needs a boss_tier row). One query per
// (kind, slot) pair rather than per binding.
async function existingBindingSubjects(db, bindings) {
  const groups = new Map();
  for (const b of bindings) {
    const id = `${b.subject_kind}\u0000${b.slot}`;
    if (!groups.has(id)) groups.set(id, { kind: b.subject_kind, slot: b.slot, keys: new Set() });
    groups.get(id).keys.add(b.subject_key);
  }
  const out = new Set();
  for (const g of groups.values()) {
    // eslint-disable-next-line no-await-in-loop
    for (const key of await existingSubjects(db, g.kind, [...g.keys], g.slot)) out.add(`${g.kind}/${key}/${g.slot}`);
  }
  return out;
}

module.exports = {
  AUDIO_SEEDS_ROOT, AUDIO_KINDS, exportAudio, seedAudio, planAudio, audioSeedLists, parseArgs, existingBindingSubjects,
};
