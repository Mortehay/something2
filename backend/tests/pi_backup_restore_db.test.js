// SOMET-400. "The restore is tested, not merely documented. An untested
// restore is an assumption."
//
// This drives the REAL round trip -- pg_dump with the flags backup.sh uses,
// then restore.sh's own --into-local path -- against scratch databases, and
// compares the data afterwards. What it is protecting is not the ssh
// transport (that reuses pi_ssh, which the whole pi-* family already depends
// on) but the part that actually silently goes wrong: dump flags, format,
// ownership, extensions, and whether the restored database really contains
// what the original did.
//
// Needs TEST_DATABASE_URL and a reachable psql/pg_dump. Skipped otherwise, in
// the same shape as the project's other DB tests.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;

function have(cmd) {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// The dump is taken INSIDE the database container, exactly as backup.sh does
// it, because that is the only way the pg_dump major version matches the
// server's. Taking it with the host's pg_dump produced a dump this very test
// could not restore: host pg_dump 18 emits `SET transaction_timeout`, which a
// 15 server rejects outright. That is a real failure mode for anyone who
// "just runs pg_dump" from their workstation, and the reason backup.sh goes
// through the container.
// Found by name rather than through `docker compose`, which would need the
// project's .env -- gitignored, and absent from a worktree.
const DB_CONTAINER = process.env.PG_TEST_CONTAINER || 'something2-db-1';
function containerPgDump() {
  try {
    execFileSync('docker', ['exec', DB_CONTAINER, 'pg_dump', '--version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

const skip = !url
  ? 'no TEST_DATABASE_URL'
  : !have('psql')
    ? 'psql not on PATH'
    : !containerPgDump()
      ? `container ${DB_CONTAINER} not available (the dump must be taken with the server-matched pg_dump)`
      : false;

const RESTORE = path.join(__dirname, '..', '..', 'compose', 'orangepi', 'scripts', 'restore.sh');

test('a dump taken the way backup.sh takes one restores with its data intact', { skip }, async (t) => {
  const base = url.slice(0, url.lastIndexOf('/'));
  const srcName = `bk400_src_${process.pid}`;
  const dstName = `bk400_dst_${process.pid}`;
  const admin = new Pool({ connectionString: `${base}/postgres` });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk400-'));

  const sql = (db, statement) => execFileSync('psql', [`${base}/${db}`, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', statement], { encoding: 'utf8' }).trim();

  t.after(async () => {
    for (const db of [srcName, dstName]) {
      await admin.query(`DROP DATABASE IF EXISTS ${db}`).catch(() => {});
    }
    await admin.end();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await admin.query(`DROP DATABASE IF EXISTS ${srcName}`);
  await admin.query(`CREATE DATABASE ${srcName}`);

  // Content with the shapes that actually break a naive dump/restore: a
  // sequence whose value must survive, a NULL, unicode, and an FK.
  sql(srcName, `
    CREATE TABLE worlds_like (id serial PRIMARY KEY, name text NOT NULL, note text);
    CREATE TABLE children (id serial PRIMARY KEY, world_id int REFERENCES worlds_like(id), qty int);
    INSERT INTO worlds_like (name, note) VALUES ('Vale Crossing', NULL), ('Frozen Ossuary Heart ❄', 'unicode');
    INSERT INTO children (world_id, qty) VALUES (1, 42), (2, 7);
    SELECT setval(pg_get_serial_sequence('worlds_like','id'), 500);
  `);

  // SOMET-485. THE SIZE OF THIS TABLE IS LOAD-BEARING, not incidental bulk.
  //
  // restore.sh's "does this dump contain a CREATE TABLE?" guard used to be
  // `gzip -dc "$DUMP" | head -c 200000 | grep -q 'CREATE TABLE'` under
  // pipefail. grep -q quits at its first match and closes the pipe; if gzip
  // still has output pending it takes SIGPIPE, exits 141, and pipefail turns
  // that into "this dump has no schema" -- a VALID backup refused, on the
  // disaster-recovery path, precisely because it had real data in it.
  //
  // A four-row database dumps to a couple of kilobytes: gzip is finished long
  // before grep quits, the race never opens, and this whole test file went
  // green against the broken script for as long as it existed. The rows below
  // push the dump past the 200 kB head window by a wide margin so the restore
  // being exercised is the one an operator would actually run.
  sql(srcName, `
    CREATE TABLE bulk (id integer PRIMARY KEY, note text);
    INSERT INTO bulk SELECT g, 'row ' || g || ' of the data section' FROM generate_series(1, 400000) g;
  `);

  const before = {
    worlds: sql(srcName, 'SELECT count(*) FROM worlds_like'),
    children: sql(srcName, 'SELECT count(*) FROM children'),
    unicode: sql(srcName, "SELECT name FROM worlds_like WHERE note = 'unicode'"),
    nullNote: sql(srcName, 'SELECT count(*) FROM worlds_like WHERE note IS NULL'),
    seq: sql(srcName, "SELECT pg_sequence_last_value(pg_get_serial_sequence('worlds_like','id')::regclass)"),
    bulk: sql(srcName, 'SELECT count(*) FROM bulk'),
    bulkSum: sql(srcName, 'SELECT sum(id) FROM bulk'),
    bulkLast: sql(srcName, 'SELECT note FROM bulk ORDER BY id DESC LIMIT 1'),
  };

  // Exactly the pipeline backup.sh runs on the board: pg_dump inside the
  // container (so its version matches the server), gzipped there, streamed out.
  const dump = path.join(tmp, 'something2-test.sql.gz');
  const dumped = execFileSync('docker', [
    'exec', DB_CONTAINER, 'sh', '-c',
    `pg_dump -U user -d ${srcName} --clean --if-exists | gzip -c`,
  ], { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' });
  fs.writeFileSync(dump, dumped);

  assert.ok(fs.statSync(dump).size > 0, 'the dump must not be empty');
  // The same two integrity checks backup.sh applies before keeping a file.
  execFileSync('gzip', ['-t', dump]);
  const head = execFileSync('sh', ['-c', `gzip -dc "${dump}" | head -c 200000`], { encoding: 'utf8' });
  assert.match(head, /CREATE TABLE/, 'the dump must contain schema');

  // SOMET-485. Guard the guard's own precondition: if this dump ever shrinks
  // back under the 200 kB head window, every check below still passes while
  // testing nothing about the SIGPIPE race that made restore.sh refuse real
  // backups. Do not "fix" a failure here by relaxing the number.
  const plainBytes = Number(execFileSync('sh', ['-c', `gzip -dc "${dump}" | wc -c`], { encoding: 'utf8' }).trim());
  assert.ok(plainBytes > 4 * 1024 * 1024,
    `the dump decompresses to ${plainBytes} bytes; it must dwarf the guard's 200000-byte head window`);

  await t.test('restore.sh --into-local rebuilds the database from the dump', () => {
    // The destination starts EMPTY, so anything present afterwards came from
    // the dump and not from the source database still being there.
    execFileSync('psql', [`${base}/postgres`, '-c', `DROP DATABASE IF EXISTS ${dstName}`]);
    execFileSync('psql', [`${base}/postgres`, '-c', `CREATE DATABASE ${dstName}`]);

    execFileSync('bash', [RESTORE, dump, '--into-local', dstName], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });

    const after = {
      worlds: sql(dstName, 'SELECT count(*) FROM worlds_like'),
      children: sql(dstName, 'SELECT count(*) FROM children'),
      unicode: sql(dstName, "SELECT name FROM worlds_like WHERE note = 'unicode'"),
      nullNote: sql(dstName, 'SELECT count(*) FROM worlds_like WHERE note IS NULL'),
      seq: sql(dstName, "SELECT pg_sequence_last_value(pg_get_serial_sequence('worlds_like','id')::regclass)"),
      bulk: sql(dstName, 'SELECT count(*) FROM bulk'),
      bulkSum: sql(dstName, 'SELECT sum(id) FROM bulk'),
      bulkLast: sql(dstName, 'SELECT note FROM bulk ORDER BY id DESC LIMIT 1'),
    };
    assert.deepEqual(after, before, 'the restored database must match the original');
  });

  await t.test('the guard passes this real dump every single time, not most of the time', () => {
    // SOMET-485 was rate-dependent, so once proves nothing: the broken guard
    // refused a dump this size 100 times out of 100, and a dump a hundredth of
    // this size 0 times out of 100. Run it against the REAL pg_dump output.
    //
    // restore.sh checks the dump BEFORE it reads the mode, so with no mode at
    // all: 65 means the guard refused, 64 means it passed and usage() ran.
    // Nothing is restored, so the loop cannot touch a database.
    const loop = `
      pass=0; refuse=0; other=0
      for i in $(seq 1 100); do
        bash ${JSON.stringify(RESTORE)} ${JSON.stringify(dump)} >/dev/null 2>&1
        case $? in
          64) pass=$((pass+1)) ;;
          65) refuse=$((refuse+1)) ;;
          *) other=$((other+1)) ;;
        esac
      done
      echo "$pass $refuse $other"`;
    const counts = execFileSync('bash', ['-c', loop], { encoding: 'utf8' }).trim();
    assert.strictEqual(counts, '100 0 0',
      `expected "100 0 0" (pass refuse other) from 100 guard runs, got "${counts}"`);
  });

  await t.test('the restore is idempotent — running it twice is not an error', () => {
    // --clean --if-exists exists precisely so a restore onto a populated
    // database works. If this ever fails, a real recovery attempt onto a
    // half-restored database would fail too, at the worst possible moment.
    execFileSync('bash', [RESTORE, dump, '--into-local', dstName], {
      env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8',
    });
    assert.equal(sql(dstName, 'SELECT count(*) FROM worlds_like'), before.worlds,
      'a second restore must leave the same data, not doubled rows');
  });

  await t.test('a corrupt dump is refused BEFORE anything is dropped', () => {
    // The dangerous case: restoring rubbish over a working database turns a
    // recoverable situation into an unrecoverable one.
    const bad = path.join(tmp, 'corrupt.sql.gz');
    fs.writeFileSync(bad, 'this is not gzip');
    assert.throws(() => execFileSync('bash', [RESTORE, bad, '--into-local', dstName], {
      env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe',
    }));
    // ...and the database it would have replaced is untouched.
    assert.equal(sql(dstName, 'SELECT count(*) FROM worlds_like'), before.worlds);
  });

  await t.test('a valid gzip that is not a dump is also refused', () => {
    const empty = path.join(tmp, 'empty.sql.gz');
    execFileSync('sh', ['-c', `printf 'SELECT 1;' | gzip -c > "${empty}"`]);
    assert.throws(() => execFileSync('bash', [RESTORE, empty, '--into-local', dstName], {
      env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe',
    }));
    assert.equal(sql(dstName, 'SELECT count(*) FROM worlds_like'), before.worlds);
  });

  await t.test('restoring onto the board refuses without the explicit flag', () => {
    assert.throws(() => execFileSync('bash', [RESTORE, dump, '--into-board'], {
      env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe',
    }), 'the board path must not run without --yes-really-replace-live-data');
  });
});
