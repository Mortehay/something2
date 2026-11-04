const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// SOMET-429. lib.sh is the transport and reporting layer every pi-* target
// runs on, and its failure behaviour is the part that matters: a step wrapper
// that swallows the board's stderr, or a summary that exits 0 after a failed
// step, turns a broken deploy into a silent one.
//
// These run REAL bash subprocesses against the real file. Asserting on the
// script's text would prove only that the source contains some words; a
// deploy script is only worth what it does when a step fails, so every test
// here makes a step actually fail.

const SCRIPTS = path.join(__dirname, '..', '..', 'compose', 'orangepi', 'scripts');
const LIB = path.join(SCRIPTS, 'lib.sh');
const toPosix = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p);

// Runs a snippet with lib.sh sourced, in a scratch REPO_ROOT holding a
// controlled .env -- never the developer's real one, whose values would make
// these results depend on whose machine they ran on.
function runWithLib(snippet, { env = {}, envFile = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lib-'));
  fs.writeFileSync(path.join(root, '.env'), envFile);
  const script = `set -euo pipefail\nREPO_ROOT=${JSON.stringify(toPosix(root))}\n. ${JSON.stringify(toPosix(LIB))}\n${snippet}\n`;
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env, PATH: process.env.PATH },
  });
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

test('every script parses under bash -n', () => {
  for (const file of fs.readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh'))) {
    // A syntax error in a deploy script is discovered on the board, halfway
    // through, if it is not discovered here.
    execFileSync('bash', ['-n', path.join(SCRIPTS, file)]);
  }
});

test('require_env names every missing variable, not just the first', () => {
  const result = runWithLib('require_env ALPHA BRAVO CHARLIE; echo "should not reach"', {
    envFile: 'BRAVO=present\n',
  });
  assert.notStrictEqual(result.status, 0, 'a missing variable must fail the run');
  assert.match(result.stderr, /ALPHA/);
  assert.match(result.stderr, /CHARLIE/);
  // Reporting one variable per run turns a three-variable gap into three
  // failed runs -- the whole point is to name them all at once.
  assert.doesNotMatch(result.stderr, /^\s*BRAVO\s*$/m, 'a variable that IS set must not be reported missing');
  assert.doesNotMatch(result.stdout, /should not reach/);
});

test('require_env treats an empty value as missing', () => {
  // `ORANGEPI_PASSWORD=` in .env is a documented, intentional state. An empty
  // ORANGEPI_ADDRESS is not, and `[ -n ]` rather than `[ -v ]` is what
  // separates the two.
  const result = runWithLib('require_env ORANGEPI_ADDRESS', { envFile: 'ORANGEPI_ADDRESS=\n' });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /ORANGEPI_ADDRESS/);
});

test('a failed step prints the captured output and is counted', () => {
  const result = runWithLib(
    `run_step "explodes" bash -c 'echo "docker: no such image" >&2; exit 7' || true
     echo "STEP_FAILED=$STEP_FAILED"`
  );
  // The remote stderr is the difference between knowing something broke and
  // being able to fix it.
  assert.match(result.stderr, /docker: no such image/);
  assert.match(result.stdout + result.stderr, /FAILED/);
  assert.match(result.stdout, /STEP_FAILED=1/);
});

test('a successful step stays quiet but is still recorded', () => {
  const result = runWithLib(
    `run_step "quiet" bash -c 'echo noise on stdout'
     echo "STEP_FAILED=$STEP_FAILED"`
  );
  assert.strictEqual(result.status, 0);
  // Twelve steps each spilling docker progress output buries the one line
  // that matters, so successful steps report status only.
  assert.doesNotMatch(result.stdout, /noise on stdout/);
  assert.match(result.stdout, /ok/);
  assert.match(result.stdout, /STEP_FAILED=0/);
});

test('PI_VERBOSE shows the output of successful steps', () => {
  const result = runWithLib(`run_step "loud" bash -c 'echo noise on stdout'`, {
    env: { PI_VERBOSE: '1' },
  });
  assert.match(result.stdout, /noise on stdout/);
});

test('finish exits non-zero when any step failed', () => {
  const result = runWithLib(
    `run_step "ok one" true
     run_step "breaks" false || true
     run_step "ok two" true
     finish "summary"`
  );
  // The exit code is what a CI gate and `make pi-deploy && next-thing` both
  // read; a summary that prints FAILED and exits 0 lies to everything except
  // a human.
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /ok one/);
  assert.match(result.stdout, /breaks/);
  assert.match(result.stderr, /1 step\(s\) failed/);
});

test('finish exits zero when every step passed', () => {
  const result = runWithLib(`run_step "a" true; run_step "b" true; finish "summary"`);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /all 2 step\(s\) ok/);
});

test('a step reports its duration', () => {
  const result = runWithLib(`run_step "slow" sleep 1`);
  // Durations are how an operator notices the on-board build path was taken
  // (ten minutes) instead of the image pull (under one).
  assert.match(result.stdout, /\(1\.\d+s\)/);
});

test('pi_ssh never blocks on an interactive password prompt', () => {
  // BatchMode=yes is load-bearing: a make target that stops at a password
  // prompt in a non-interactive run is indistinguishable from a network
  // stall, for as long as you let it sit there.
  const text = fs.readFileSync(LIB, 'utf8');
  assert.match(text, /BatchMode=yes/);
  // `no` would silently accept a SUBSTITUTED host key; accept-new trusts an
  // unknown host once and still refuses a changed one.
  assert.match(text, /StrictHostKeyChecking=accept-new/);
  assert.doesNotMatch(text, /StrictHostKeyChecking=no/);
});

test('the board-side compose command reads the board .env from the data dir', () => {
  const result = runWithLib('pi_compose_cmd', {
    envFile: 'ORANGEPI_APP_DIR=/app\nORANGEPI_DATA_DIR=/srv/something2\n',
  });
  // Provisioning EMPTIES the app dir. An .env kept there would be destroyed
  // on every re-provision, taking POSTGRES_PASSWORD with it and locking the
  // operator out of a perfectly healthy database.
  assert.match(result.stdout, /--env-file \/srv\/something2\/\.env/);
  assert.match(result.stdout, /-f compose\/orangepi\/docker-compose\.yml/);
});

test('the environment wins over .env', () => {
  // dotenv semantics, which this repository already relies on elsewhere. The
  // original `set -a; . .env` had the file win, so
  // `ORANGEPI_ADDRESS=other make pi-status` silently talked to the address in
  // .env -- and CI and the deploy hook pass values exactly this way, with no
  // .env present to reveal the mistake.
  const result = runWithLib('echo "ADDR=$ORANGEPI_ADDRESS"', {
    envFile: 'ORANGEPI_ADDRESS=from-dot-env\n',
    env: { ORANGEPI_ADDRESS: 'from-environment' },
  });
  assert.match(result.stdout, /ADDR=from-environment/);
});

test('.env values are read, not executed', () => {
  // An .env is data. `source`ing it runs whatever it contains -- and this one
  // is edited by hand, copied between machines, and pasted from chat logs.
  const result = runWithLib('echo "VAL=$SOME_VALUE"', {
    envFile: 'SOME_VALUE=$(touch /tmp/pi-lib-should-not-exist)\n',
  });
  assert.match(result.stdout, /VAL=\$\(touch/);
  assert.strictEqual(fs.existsSync('/tmp/pi-lib-should-not-exist'), false);
});

test('pi-status reports an unreachable board instead of hanging', () => {
  // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): guaranteed not routable, so this
  // exercises the timeout path rather than depending on any real host being
  // absent. The bound comes from ConnectTimeout in lib.sh.
  const started = Date.now();
  const result = spawnSync('bash', [path.join(SCRIPTS, 'status.sh')], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      ORANGEPI_ADDRESS: '192.0.2.1',
      ORANGEPI_LOGIN: 'nobody',
      ORANGEPI_DATA_DIR: '/srv/something2',
    },
  });
  const elapsed = Date.now() - started;
  assert.notStrictEqual(result.status, 0, 'an unreachable board is not a healthy stack');
  assert.match(result.stderr, /BOARD UNREACHABLE/);
  // The failure mode that matters is a board that is switched off. A status
  // command that blocks on it forever looks like a broken command rather than
  // an absent board.
  assert.ok(elapsed < 45000, `pi-status took ${elapsed}ms on an unreachable board`);
});

test('pi-keygen never regenerates an existing key', () => {
  // Silently replacing the workstation key locks the operator out of the
  // board -- the new public half is not in authorized_keys and the old
  // private half is gone -- and it does so at the exact moment they are
  // trying to fix access. The board here is unreachable (TEST-NET-1), so the
  // run fails at the install step; the key must still be exactly as it was.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-keygen-'));
  const keyPath = path.join(dir, 'existing_key');
  fs.writeFileSync(keyPath, 'PRETEND PRIVATE KEY\n');
  fs.writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAA pretend\n');
  const before = fs.readFileSync(keyPath, 'utf8');

  const result = spawnSync('bash', [path.join(SCRIPTS, 'keygen.sh')], {
    encoding: 'utf8',
    timeout: 90000,
    env: {
      ...process.env,
      ORANGEPI_ADDRESS: '192.0.2.1',
      ORANGEPI_LOGIN: 'nobody',
      ORANGEPI_SSH_KEY: keyPath,
      ORANGEPI_PASSWORD: '',
      ORANGEPI_DATA_DIR: '/srv/something2',
      // Without an isolated REPO_ROOT these read the developer's REAL .env --
      // which supplies a real ORANGEPI_PASSWORD, sends ssh-copy-id at the
      // unreachable test address, and turns a 10-second assertion into a
      // multi-minute hang whose cause is invisible from the test name.
      REPO_ROOT: dir,
    },
  });

  assert.strictEqual(fs.readFileSync(keyPath, 'utf8'), before, 'the existing key was modified');
  // The operator must be able to SEE which of the two happened on a normal
  // run, not only infer it from the file surviving.
  assert.match(result.stdout, /keeping the existing one \(never regenerated\)/);
  assert.doesNotMatch(result.stdout, /generating a new/);
  // A run that could not install the key must not report success.
  assert.notStrictEqual(result.status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pi-keygen says what to do when it cannot authenticate at all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-keygen-'));
  const keyPath = path.join(dir, 'existing_key');
  fs.writeFileSync(keyPath, 'PRETEND PRIVATE KEY\n');
  fs.writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAA pretend\n');
  const result = spawnSync('bash', [path.join(SCRIPTS, 'keygen.sh')], {
    encoding: 'utf8',
    timeout: 90000,
    env: {
      ...process.env,
      ORANGEPI_ADDRESS: '192.0.2.1',
      ORANGEPI_LOGIN: 'nobody',
      ORANGEPI_SSH_KEY: keyPath,
      ORANGEPI_PASSWORD: '',
      ORANGEPI_DATA_DIR: '/srv/something2',
      // Without an isolated REPO_ROOT these read the developer's REAL .env --
      // which supplies a real ORANGEPI_PASSWORD, sends ssh-copy-id at the
      // unreachable test address, and turns a 10-second assertion into a
      // multi-minute hang whose cause is invisible from the test name.
      REPO_ROOT: dir,
    },
  });
  // "permission denied" is not an actionable message for the one step in this
  // module that genuinely needs a password.
  assert.match(result.stderr, /ORANGEPI_PASSWORD is empty|ssh-copy-id/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The states a status command exists for are the bad ones, and they are
// exactly the states that are expensive to produce on a live board. Feeding
// render_status a report is how they get exercised for real without stopping
// a running stack to see what stopping it looks like.
function renderStatus(report) {
  // %b, not %s: JSON.stringify writes newlines and tabs as backslash escapes,
  // and %s would hand render_status one long line with no sections in it --
  // which is a very convincing way to make every one of these tests pass or
  // fail for the wrong reason.
  return runWithLib(`printf '%b' ${JSON.stringify(report)} | render_status`);
}

const REPORT_UP = [
  '###CONTAINERS',
  'something2-orangepi-caddy-1\tUp 2 hours',
  'something2-orangepi-backend-1\tUp 2 hours (healthy)',
  '###HEALTH',
  '200',
  '###DISK',
  '/dev/mmcblk0p1  57G  3.5G  53G  7% /',
  '###MEMORY',
  '3920 MB total, 574 MB used, 3346 MB available',
  '###UPTIME',
  'up 6 hours',
  '###COMMIT',
  'abc1234 some commit',
  '###END',
  '',
].join('\n');

test('pi-status reports a serving stack and exits zero', () => {
  const result = renderStatus(REPORT_UP);
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /something2-orangepi-caddy-1/);
  assert.match(result.stdout, /HTTP 200/);
  // The last section is the one a naive sed range silently truncates.
  assert.match(result.stdout, /commit\s+abc1234 some commit/);
});

test('pi-status reports a stopped stack as DOWN, and does not exit zero', () => {
  const result = renderStatus(
    ['###CONTAINERS', '###HEALTH', '000', '###DISK', 'x', '###MEMORY', 'y', '###UPTIME', 'z',
     '###COMMIT', 'abc1234 c', '###END', ''].join('\n')
  );
  assert.match(result.stdout, /STACK DOWN/);
  assert.match(result.stdout, /DOWN\s+\(nothing answering/);
  // A status command that prints a red DOWN and exits 0 lies to everything
  // except a human reader -- including the CI gate that calls it.
  assert.notStrictEqual(result.status, 0);
  // The board is still reachable in this state, so the numbers that tell you
  // WHY it will not start must still be printed.
  assert.match(result.stdout, /disk/);
  assert.match(result.stdout, /memory/);
});

test('pi-status distinguishes a wrong answer from no answer', () => {
  // 502 means Caddy is up and the backend is not: a different fault from
  // "nothing is listening", and it needs a different first move.
  const result = renderStatus(REPORT_UP.replace('\n200\n', '\n502\n'));
  assert.match(result.stdout, /HTTP 502/);
  assert.match(result.stdout, /caddy answered, but not with 200/);
  assert.notStrictEqual(result.status, 0);
});

test('pi-status flags an unhealthy container rather than calling it up', () => {
  const result = renderStatus(REPORT_UP.replace('Up 2 hours (healthy)', 'Up 2 hours (unhealthy)'));
  assert.match(result.stdout, /unhealthy/);
});

// --- The data-safety rule (SOMET-425) --------------------------------------
//
// Provisioning EMPTIES the app directory. Everything below is what keeps that
// from taking the game's data with it. The resolver is exercised against REAL
// symlinks: the interesting case is a data directory that only looks separate
// until a link is followed, and a string comparison waves exactly that
// through.

function resolvePaths(app, data) {
  const result = runWithLib(
    `APP=${JSON.stringify(app)} DATA=${JSON.stringify(data)} bash -c "$PATH_RESOLVE_SCRIPT"`
  );
  assert.strictEqual(result.status, 0, result.stderr);
  const [appReal, dataReal] = result.stdout.trim().split('\n');
  return { appReal, dataReal };
}

function isInside(app, data) {
  const result = runWithLib(
    `if data_dir_is_inside_app_dir ${JSON.stringify(app)} ${JSON.stringify(data)}; then echo INSIDE; else echo outside; fi`
  );
  return result.stdout.trim() === 'INSIDE';
}

test('the guard refuses a data directory inside the app directory', () => {
  assert.strictEqual(isInside('/app', '/app/pgdata'), true);
  assert.strictEqual(isInside('/app', '/app/data/postgres'), true);
});

test('the guard refuses the two being the same directory', () => {
  // Equal paths are the worst case, not an edge case: provisioning would
  // empty the data directory itself.
  assert.strictEqual(isInside('/app', '/app'), true);
  assert.strictEqual(isInside('/app/', '/app'), true);
});

test('the guard allows a sibling whose name merely shares a prefix', () => {
  // /srv/something2-data is NOT inside /srv/something2. A guard that refuses
  // this cries wolf, and a guard that cries wolf gets switched off.
  assert.strictEqual(isInside('/srv/something2', '/srv/something2-data'), false);
  assert.strictEqual(isInside('/app', '/srv/something2'), false);
});

test('the resolver follows a symlink that hides the nesting', () => {
  // The case the ticket calls out by name. /tmp/x/data -> /tmp/x/app/pgdata
  // looks separate and is not, and only resolution tells them apart.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-safety-'));
  const appDir = path.join(base, 'app');
  fs.mkdirSync(path.join(appDir, 'pgdata'), { recursive: true });
  const link = path.join(base, 'data');
  fs.symlinkSync(path.join(appDir, 'pgdata'), link);

  const { appReal, dataReal } = resolvePaths(appDir, link);
  assert.strictEqual(
    isInside(appReal, dataReal),
    true,
    'a symlinked data directory inside the app directory must still be refused'
  );
  fs.rmSync(base, { recursive: true, force: true });
});

test('the resolver handles directories that do not exist yet', () => {
  // A bare board has neither directory. `readlink -f` on a missing path
  // resolves it literally, which would silently skip the symlink check the
  // guard exists for -- so resolution walks up to the deepest existing
  // ancestor instead.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-safety-')));
  const { appReal, dataReal } = resolvePaths(
    path.join(base, 'not-created-yet', 'app'),
    path.join(base, 'not-created-yet', 'data')
  );
  assert.strictEqual(appReal, path.join(base, 'not-created-yet', 'app'));
  assert.strictEqual(isInside(appReal, dataReal), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('the resolver sees through a symlinked ANCESTOR', () => {
  // /link/data where /link -> /real/app: the nesting is one level above
  // either path, so comparing the strings as given finds nothing wrong.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-safety-')));
  const real = path.join(base, 'real-app');
  fs.mkdirSync(real, { recursive: true });
  const link = path.join(base, 'link');
  fs.symlinkSync(real, link);

  const { appReal, dataReal } = resolvePaths(real, path.join(link, 'pgdata'));
  assert.strictEqual(isInside(appReal, dataReal), true);
  fs.rmSync(base, { recursive: true, force: true });
});

// --- pi-reset's confirmation guard (SOMET-430) -----------------------------

function runReset(env) {
  return spawnSync('bash', [path.join(SCRIPTS, 'reset.sh')], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ORANGEPI_ADDRESS: '10.0.0.5',
      ORANGEPI_LOGIN: 'pi',
      ORANGEPI_DATA_DIR: '/srv/something2',
      REPO_ROOT: os.tmpdir(),
      ...env,
    },
  });
}

test('pi-reset refuses without CONFIRM', () => {
  const result = runReset({ CONFIRM: '' });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /refusing to reset/);
  // The message must name the board, so the confirmation is a decision rather
  // than a copy-paste of whatever the error suggested.
  assert.match(result.stderr, /CONFIRM=10\.0\.0\.5/);
});

test('pi-reset refuses when CONFIRM names a different board', () => {
  const result = runReset({ CONFIRM: '10.0.0.6' });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /does not match/);
  assert.match(result.stderr, /nothing was touched/);
});

test('pi-reset cannot reach a local database under any argument', () => {
  // Structural, not careful: every command in reset.sh runs through pi_ssh or
  // remote.sh, so there is no branch that can talk to a local docker or a
  // local psql whatever CONFIRM says. A reviewer on this project has already
  // wiped the shared development catalog once with an unguarded delete.
  const text = fs.readFileSync(path.join(SCRIPTS, 'reset.sh'), 'utf8');
  const commandLines = text
    .split('\n')
    .filter((line) => /^\s*(run_step|bash|docker|psql)/.test(line))
    .filter((line) => !line.trim().startsWith('#'));
  for (const line of commandLines) {
    if (/docker|psql/.test(line)) {
      assert.match(
        line,
        /REMOTE_SH|remote\.sh|pi_ssh/,
        `every docker/psql command must go through the remote transport: ${line.trim()}`
      );
    }
  }
});

// --- remote.sh (SOMET-428) -------------------------------------------------

test('remote.sh has no path to the local stack', () => {
  const text = fs.readFileSync(path.join(SCRIPTS, 'remote.sh'), 'utf8');
  const invocations = text
    .split('\n')
    .filter((line) => /docker compose|psql/.test(line) && !line.trim().startsWith('#'));
  // Not "there are none" -- there are, and they are the point of the file.
  // The invariant is that each one is handed to the REMOTE transport, so no
  // argument to this script can make it act on the workstation's stack.
  assert.ok(invocations.length > 0, 'the fixture is wrong if remote.sh runs nothing');
  for (const line of invocations) {
    assert.match(
      line,
      /pi_ssh|pi_ssh_tty|\$COMPOSE/,
      `remote.sh must reach the board, never a local daemon: ${line.trim()}`
    );
  }
  // The counterpart: the local targets must not gain a board path either.
  const makefile = fs.readFileSync(path.join(__dirname, '..', '..', 'Makefile'), 'utf8');
  const localTargets = makefile.match(/^(?!pi-)[a-z-]+:\n(\t.*\n)+/gm) || [];
  // Scoped to the REMOTE scripts, not to compose/orangepi as a whole:
  // `make verify-routing` legitimately runs verify-routing.sh, which spins up
  // throwaway containers on THIS machine to test the Caddyfile. The rule is
  // that no un-prefixed target reaches the board.
  const REMOTE_SCRIPTS = /(remote|status|deploy|provision|reset|keygen)\.sh/;
  for (const target of localTargets) {
    assert.doesNotMatch(target, REMOTE_SCRIPTS, `a local target must not drive the board: ${target.split('\n')[0]}`);
  }
});

test('every pi-* make target routes through the orangepi scripts', () => {
  const makefile = fs.readFileSync(path.join(__dirname, '..', '..', 'Makefile'), 'utf8');
  const targets = [...makefile.matchAll(/^(pi-[a-z-]+):\n((?:\t.*\n|\#.*\n)+)/gm)];
  // Named explicitly rather than counted: a target that silently disappears
  // from the Makefile would otherwise pass a count-based assertion by
  // lowering the count.
  const expected = [
    'pi-keygen', 'pi-provision', 'pi-deploy', 'pi-up', 'pi-down', 'pi-restart',
    'pi-logs', 'pi-status', 'pi-tunnel-url', 'pi-migrate-up', 'pi-migrate-status',
    'pi-seed-catalogs', 'pi-seed-map', 'pi-reseed-map', 'pi-shell', 'pi-db-shell',
    'pi-hook-secret', 'pi-hook-register', 'pi-reset',
  ];
  const found = targets.map(([, name]) => name);
  for (const name of expected) {
    assert.ok(found.includes(name), `${name} is missing from the Makefile`);
  }
  // These start/stop/inspect the local Pi helper process on the workstation; by design they never reach the board themselves.
  const LOCAL_HELPER = new Set(['pi-helper', 'pi-helper-stop', 'pi-helper-status']);
  for (const [, name, body] of targets) {
    if (LOCAL_HELPER.has(name)) continue;
    assert.match(body, /compose\/orangepi\/scripts\//, `${name} must run through the orangepi scripts`);
  }
});

test('the seeding targets reuse the local require-spec guard', () => {
  const makefile = fs.readFileSync(path.join(__dirname, '..', '..', 'Makefile'), 'utf8');
  for (const name of ['pi-seed-map', 'pi-reseed-map']) {
    const body = new RegExp(`^${name}:\\n((?:\\t.*\\n)+)`, 'm').exec(makefile)[1];
    // Rejected on the WORKSTATION, before anything reaches the network: the
    // spec files live in the host checkout, so a misspelling is knowable
    // without an ssh connection.
    assert.match(body, /\$\(require-spec\)/, `${name} must reject a bad SPEC before connecting`);
  }
});

// --- The board-side (PI_LOCAL) path ----------------------------------------
//
// deploy.sh runs in two places: an operator's workstation over ssh, and the
// deploy hook ON the board. The second is the one CI uses and the one nobody
// watches, and it has a different environment -- no ORANGEPI_LOGIN, no
// ORANGEPI_ADDRESS, because there is nothing to reach. Under `set -u` a bare
// reference to either kills the deploy one line in, which is exactly how the
// hook's first working run died.

test('deploy.sh runs on the board without the ssh variables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-local-'));
  fs.writeFileSync(path.join(dir, '.env'), '');
  const result = spawnSync('bash', [path.join(SCRIPTS, 'deploy.sh')], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      PI_LOCAL: '1',
      REPO_ROOT: dir,
      ORANGEPI_DATA_DIR: dir,
      ORANGEPI_APP_DIR: path.join(dir, 'no-such-app'),
      GIT_REPOSITORY: 'https://github.com/example/repo.git',
      ORANGEPI_BRANCH: 'orangepi',
      ORANGEPI_LOGIN: undefined,
      ORANGEPI_ADDRESS: undefined,
    },
  });
  const output = result.stdout + result.stderr;
  // It is expected to FAIL here -- there is no clone at that path. What it
  // must not do is fail for the wrong reason, before reaching any real work.
  assert.doesNotMatch(output, /unbound variable/, output.slice(0, 400));
  assert.match(output, /on the board itself/);
});

test('an image prefix that cannot be derived is reported, not guessed', () => {
  // A nonsense prefix makes every pull fail and every deploy take the
  // twenty-minute board build -- working, but slow for a reason nothing on
  // screen explains.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-local-'));
  fs.writeFileSync(path.join(dir, '.env'), '');
  const result = spawnSync('bash', [path.join(SCRIPTS, 'deploy.sh')], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      PI_LOCAL: '1',
      REPO_ROOT: dir,
      ORANGEPI_DATA_DIR: dir,
      ORANGEPI_APP_DIR: dir,
      GIT_REPOSITORY: 'https://gitlab.example.com/team/repo.git',
      ORANGEPI_BRANCH: 'orangepi',
    },
  });
  assert.match(result.stderr, /not a github\.com url/);
  assert.match(result.stderr, /ORANGEPI_IMAGE_PREFIX/);
});

test('step durations survive both shapes of missing nanosecond support', () => {
  // `date +%s%N` is a GNU extension, and busybox handles its absence in two
  // different ways. The deploy-hook container -- what every CI deploy runs in
  // -- SILENTLY DROPS %N and returns a plain seconds stamp, which is all
  // digits and therefore looks valid; other builds append a literal "N".
  //
  // Both are stubbed here because the first version of this test stubbed only
  // the "N" case, passed, and left the board still reporting every step as
  // 0.0s. A fix verified against the wrong failure mode is not a fix.
  const variants = {
    'drops %N (returns seconds)': 'printf "%s\\n" "$(/bin/date +%s)"',
    'appends a literal N': 'printf "%sN\\n" "$(/bin/date +%s)"',
  };
  for (const [label, body] of Object.entries(variants)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-busybox-'));
    fs.writeFileSync(
      path.join(dir, 'date'),
      `#!/usr/bin/env bash\nif [ "$1" = "+%s%N" ]; then ${body}; else exec /bin/date "$@"; fi\n`
    );
    fs.chmodSync(path.join(dir, 'date'), 0o755);
    const result = runWithLib('run_step "one second" sleep 1', {
      env: { PATH: `${dir}:${process.env.PATH}` },
    });
    assert.doesNotMatch(result.stdout, /\(0\.0s\)/, `${label}: a one-second step reported 0.0s`);
    assert.match(result.stdout, /\(1(\.\d+)?s\)/, `${label}: expected roughly one second`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a deploy never restarts the tunnel or the hook', () => {
  // Both are stateful in a way the game containers are not. Restarting
  // cloudflared rotates the public URL -- which changes the address players
  // hold AND invalidates the DEPLOY_HOOK_URL that CI posts to, so the next
  // push fails against a hostname that no longer exists. Restarting the hook
  // kills the very deploy that is running inside it.
  const text = fs.readFileSync(path.join(SCRIPTS, 'deploy.sh'), 'utf8');
  const stopLine = /run_step "stop the serving containers".*\n?.*/.exec(text)[0];
  const services = /SERVICES="([^"]+)"/.exec(text)[1].split(/\s+/);
  assert.ok(services.includes('backend') && services.includes('caddy'));
  assert.ok(!services.includes('cloudflared'), 'restarting the tunnel rotates the public URL');
  assert.ok(!services.includes('deploy-hook'), 'restarting the hook kills the deploy running inside it');
  assert.doesNotMatch(stopLine, /cloudflared|deploy-hook/);
  // Both are still brought UP if absent, with --no-recreate so a running one
  // is left exactly as it is.
  // The tunnels are brought up by pi_ensure_tunnels (lib.sh), which honours a
  // tunnel the operator switched off; the hook is started inline.
  assert.match(text, /pi_ensure_tunnels /);
  const lib = fs.readFileSync(LIB, 'utf8');
  assert.match(lib, /up -d --no-deps --no-recreate \$\{services# \}/);
  assert.match(text, /up -d[^"]*--no-recreate deploy-hook/);
});

test('pi-restart restarts the game, not the tunnel', () => {
  // Same reason a deploy leaves cloudflared alone: restarting it takes a new
  // random hostname, which changes the URL players hold and invalidates the
  // deploy hook's registered URL. Found by running `make pi-restart` and
  // watching the public URL move.
  const makefile = fs.readFileSync(path.join(__dirname, '..', '..', 'Makefile'), 'utf8');
  const body = /^pi-restart:\n((?:\t.*\n)+)/m.exec(makefile)[1];
  assert.match(body, /restart backend caddy/);
  assert.doesNotMatch(body, /restart\s*$/m, 'a bare `compose restart` bounces every service');
});

// --- The stable front door (SOMET-440) -------------------------------------
//
// A quick tunnel takes a new random hostname whenever cloudflared starts, and
// the old one is gone for good. The page these tests cover is the one address
// players are given, so what matters is that it points somewhere real and
// says so even when the redirect fails.

function renderFrontDoor(target, stamp = '2026-08-20 12:00 UTC') {
  return runWithLib(`render_front_door_page ${JSON.stringify(target)} ${JSON.stringify(stamp)}`);
}

test('the front door redirects three ways and shows the address', () => {
  const target = 'https://example-tunnel.trycloudflare.com';
  const page = renderFrontDoor(target).stdout;
  // Meta refresh for a browser with JavaScript disabled...
  assert.match(page, new RegExp(`<meta http-equiv="refresh" content="0; url=${target}">`));
  // ...script for an immediate hop...
  assert.match(page, /location\.replace\(/);
  // ...and a visible link plus the raw address, so a visitor whose redirect
  // is blocked can still get there by hand instead of staring at a blank page.
  assert.match(page, new RegExp(`href="${target}"`));
  assert.match(page, new RegExp(`<code>${target}</code>`));
});

test('the front door is not offered to search engines', () => {
  // It points at a staging box with open registration. Being reachable by
  // anyone with the link is the accepted trade; being indexed is not.
  assert.match(renderFrontDoor('https://x.trycloudflare.com').stdout, /name="robots" content="noindex, nofollow"/);
});

test('the front door page cannot be broken out of by the hostname', () => {
  // The hostname comes from a log line on the board rather than from a
  // person, but it lands inside a <script> tag, and "it came from our own
  // machine" is exactly the reasoning that puts injections into production.
  const page = renderFrontDoor(`https://evil.example.com'); alert('x`).stdout;
  assert.doesNotMatch(page, /\); alert\('x'\);/);
  assert.match(page, /location\.replace\('https:\/\/evil\.example\.com'\\''\); alert\('\\''x'\)/);
});

test('front_door_state names all three cases', () => {
  const state = (published, live) =>
    runWithLib(`front_door_state ${JSON.stringify(published)} ${JSON.stringify(live)}`).stdout.trim();
  assert.strictEqual(state('', 'https://a.trycloudflare.com'), 'missing');
  assert.strictEqual(state('https://a.trycloudflare.com', 'https://a.trycloudflare.com'), 'current');
  // The case that matters: everything else still reports healthy while every
  // link anyone holds points at a hostname that no longer exists.
  assert.strictEqual(state('https://old.trycloudflare.com', 'https://new.trycloudflare.com'), 'stale');
});

test('durations are readable at a glance', () => {
  const fmt = (seconds) => runWithLib(`format_duration ${seconds}`).stdout.trim();
  assert.strictEqual(fmt(45), '45s');
  assert.strictEqual(fmt(600), '10m');
  assert.strictEqual(fmt(4 * 3600 + 12 * 60), '4h 12m');
  assert.strictEqual(fmt(2 * 86400 + 3 * 3600), '2d 3h');
});

test('a deploy publishes the front door only when one already exists', () => {
  // Same rule as the CI hook URL: a deploy keeps working what is already set
  // up, and never opens a public address for a board whose operator never
  // asked for one.
  const text = fs.readFileSync(path.join(SCRIPTS, 'deploy.sh'), 'utf8');
  assert.match(text, /ls-remote --exit-code --heads origin/);
  const guarded = /ls-remote --exit-code --heads origin[\s\S]{0,400}?publish-url\.sh/.test(text);
  assert.ok(guarded, 'publish-url.sh must run inside the branch-exists guard');
  // And only from the workstation: the board has no gh and no credentials,
  // which is a property worth keeping.
  assert.match(text, /if \[ -z "\$\{PI_LOCAL:-\}" \][\s\S]*publish-url\.sh/);
});

test('publishing refuses when there is no tunnel to point at', () => {
  // A page pointing at a dead hostname looks like a broken game; a page that
  // is not updated at least still names the last address that worked.
  const text = fs.readFileSync(path.join(SCRIPTS, 'publish-url.sh'), 'utf8');
  assert.match(text, /no tunnel is running on the board, so there is nothing to publish/);
});

test('the health probe targets a different address in each transport', () => {
  // This cost five CI deploys a false failure. Over ssh, 127.0.0.1:8080 is
  // the BOARD's loopback, where Caddy publishes. Under PI_LOCAL the same
  // script runs inside the deploy-hook container, where 127.0.0.1 is that
  // container's own loopback and nothing is listening -- so the probe could
  // never succeed, and reported a working deploy as broken. Caddy is
  // reachable by service name on the compose network instead.
  const overSsh = runWithLib('pi_health_url').stdout.trim();
  const onBoard = runWithLib('pi_health_url', { env: { PI_LOCAL: '1' } }).stdout.trim();
  assert.strictEqual(overSsh, 'http://127.0.0.1:8080/api/health');
  assert.strictEqual(onBoard, 'http://caddy:80/api/health');
  assert.notStrictEqual(overSsh, onBoard);
});

test('the deploy health wait uses the transport-aware url', () => {
  const text = fs.readFileSync(path.join(SCRIPTS, 'deploy.sh'), 'utf8');
  assert.match(text, /pi_health_url/);
  // A hardcoded loopback anywhere in the wait is the bug returning.
  const waitBlock = /wait_for_health\(\) \{[\s\S]*?\n\}/.exec(text)[0];
  assert.doesNotMatch(waitBlock, /127\.0\.0\.1:8080/);
});

test('a failed health wait shows the backend log, not just a verdict', () => {
  // "the stack did not answer" is a verdict. What broke is in the container
  // output, and fetching it by hand means another ssh round trip at the
  // worst moment.
  const text = fs.readFileSync(path.join(SCRIPTS, 'deploy.sh'), 'utf8');
  const waitBlock = /wait_for_health\(\) \{[\s\S]*?\nREMOTE\n\}/.exec(text)[0];
  assert.match(waitBlock, /docker logs --tail \d+ something2-orangepi-backend-1/);
  assert.match(waitBlock, /docker ps --filter name=something2-orangepi/);
});

test('a broken or empty front door page is never published', () => {
  // This is the exact failure that reached production: a rename left the
  // render call pointing at a function that no longer existed, bash created
  // the file by redirection, the command then failed, and the EMPTY result
  // was committed and pushed over a working page -- reporting success,
  // because run_step disables errexit for the step function it calls.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-page-'));
  const url = 'https://live.trycloudflare.com';
  const check = (file) =>
    runWithLib(`front_door_page_is_sane ${JSON.stringify(file)} ${JSON.stringify(url)} && echo SANE || echo REJECTED`).stdout.trim();

  const empty = path.join(dir, 'empty.html');
  fs.writeFileSync(empty, '');
  assert.strictEqual(check(empty), 'REJECTED');

  const stale = path.join(dir, 'stale.html');
  fs.writeFileSync(stale, '<html><body><a href="https://old.trycloudflare.com">go</a></body></html>');
  assert.strictEqual(check(stale), 'REJECTED', 'a page pointing somewhere else is not this page');

  const notHtml = path.join(dir, 'junk.html');
  fs.writeFileSync(notHtml, `some error text mentioning ${url}`);
  assert.strictEqual(check(notHtml), 'REJECTED');

  const good = path.join(dir, 'good.html');
  fs.writeFileSync(good, `<!doctype html><html><body><a href="${url}">play</a></body></html>`);
  assert.strictEqual(check(good), 'SANE');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the publisher checks the page before committing it', () => {
  const text = fs.readFileSync(path.join(SCRIPTS, 'publish-url.sh'), 'utf8');
  const sanityIndex = text.indexOf('front_door_page_is_sane');
  const commitIndex = text.indexOf('commit --quiet');
  assert.ok(sanityIndex > 0 && commitIndex > sanityIndex, 'the check must come before the commit');
  // And it must render through the function that actually exists.
  assert.match(text, /render_front_door_page "\$url"/);
  assert.doesNotMatch(text, /^\s*render_page /m);
});

// --- Self-healing the public URL (SOMET-441) --------------------------------

test('the reconciler does nothing, quietly, when the board is unreachable', () => {
  // A board that is off is the normal state of a machine at home, not a fault
  // to report. A timer that complains nightly gets masked, and then it is not
  // there on the morning it matters.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reconcile-'));
  fs.writeFileSync(path.join(dir, '.env'), '');
  const result = spawnSync('bash', [path.join(SCRIPTS, 'reconcile-url.sh')], {
    encoding: 'utf8',
    timeout: 90000,
    env: {
      ...process.env,
      REPO_ROOT: dir,
      ORANGEPI_ADDRESS: '192.0.2.1',
      ORANGEPI_LOGIN: 'nobody',
      ORANGEPI_DATA_DIR: '/srv/something2',
      GIT_REPOSITORY: 'https://github.com/example/repo.git',
    },
  });
  assert.strictEqual(result.status, 0, 'an absent board is not an error');
  assert.strictEqual(result.stdout.trim(), '', `expected silence, got: ${result.stdout}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the reconciler never publishes a hostname it has not confirmed', () => {
  // Cloudflare answers for a hostname whose origin is down, so "the tunnel
  // exists" is not the same as "the game is there". Pointing players at a
  // URL that does not serve looks like a broken game rather than a moved one.
  const text = fs.readFileSync(path.join(SCRIPTS, 'reconcile-url.sh'), 'utf8');
  const healthCheck = text.indexOf('/api/health');
  const publishCall = text.indexOf('publish-url.sh');
  assert.ok(healthCheck > 0 && publishCall > healthCheck, 'health must be confirmed before publishing');
  assert.match(text, /not publishing it/);
});

test('the reconciler leaves an unpublished front door alone', () => {
  // Publishing opens a public address. A background timer doing that unasked
  // is a surprise of exactly the wrong kind.
  const text = fs.readFileSync(path.join(SCRIPTS, 'reconcile-url.sh'), 'utf8');
  const missingBranch = /missing\)([\s\S]*?);;/.exec(text)[1];
  assert.doesNotMatch(missingBranch, /publish-url\.sh/);
  assert.match(missingBranch, /leaving it alone/);
});

test('the timer unit runs the reconciler and survives a suspended laptop', () => {
  const text = fs.readFileSync(path.join(SCRIPTS, 'watch-install.sh'), 'utf8');
  assert.match(text, /ExecStart=.*reconcile-url\.sh/);
  // Persistent= catches up a pass a sleeping laptop missed -- but ONLY on an
  // OnCalendar timer (man systemd.timer). Asserting the line alone is what let
  // a monotonic timer ship claiming a catch-up it never performed.
  assert.match(text, /^Persistent=true$/m);
  assert.match(text, /^OnCalendar=\$\{CALENDAR\}$/m);
  // OnUnitActiveSec= has nothing to count from until the service has run once
  // under the timer, which left a freshly reinstalled timer with no next
  // elapse at all. It must not come back as the schedule.
  assert.doesNotMatch(text, /^OnUnitActiveSec=/m);
  // A user timer: this needs the workstation's own gh credentials and ssh
  // key, and nothing here should touch root or /etc.
  assert.match(text, /systemctl --user/);
  assert.doesNotMatch(text, /sudo|\/etc\/systemd/);
  // And it must be removable.
  assert.match(text, /uninstall\)/);
});

// SOMET-442. The timer above was installed from an agent's throwaway worktree
// under /tmp, and so was the board's ssh key. Both work perfectly until the
// machine reboots; then the self-healer fails every ten minutes against a path
// that is gone, and the only way onto the board is gone with it. These pin the
// guards, because the failure is invisible exactly when it starts.

test('path_is_ephemeral knows which paths a reboot takes away', () => {
  const cases = [
    ['/tmp/claude-1000/x/scratchpad/wt/pi', true],
    ['/var/tmp/build', true],
    ['/home/someone/worker/repo/scratchpad/wt/pi', true],
    ['/home/someone/worker/repo', false],
    ['/srv/something2', false],
  ];
  for (const [candidate, ephemeral] of cases) {
    const result = runWithLib(`path_is_ephemeral ${JSON.stringify(candidate)} && echo yes || echo no`);
    assert.strictEqual(result.stdout.trim(), ephemeral ? 'yes' : 'no', candidate);
  }
});

test('durable_repo_root refuses rather than falling back to the temporary one', () => {
  // A real worktree under /tmp whose main checkout is ALSO under /tmp: there
  // is no durable answer, and inventing one would reinstate the bug.
  const result = runWithLib(
    'out="$(durable_repo_root "$REPO_ROOT")"; echo "[${out}]"',
    { env: { TMPDIR: os.tmpdir() } },
  );
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout.trim(), '[]');
});

test('durable_repo_root keeps a root that already survives a reboot', () => {
  const result = runWithLib(`durable_repo_root ${JSON.stringify(os.homedir())}`);
  assert.strictEqual(result.stdout.trim(), os.homedir());
});

test('watch-install refuses an ephemeral install root instead of installing a doomed unit', (t) => {
  if (spawnSync('command', ['-v', 'systemctl'], { shell: true }).status !== 0) {
    t.skip('no systemd here');
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-watch-'));
  const doomed = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-repo-'));
  fs.mkdirSync(path.join(doomed, 'compose', 'orangepi', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(doomed, 'compose', 'orangepi', 'scripts', 'reconcile-url.sh'), '');
  const result = spawnSync('bash', [path.join(SCRIPTS, 'watch-install.sh')], {
    encoding: 'utf8',
    env: { ...process.env, PI_WATCH_REPO: doomed, XDG_CONFIG_HOME: home },
  });
  fs.rmSync(doomed, { recursive: true, force: true });
  const units = fs.existsSync(path.join(home, 'systemd', 'user'))
    ? fs.readdirSync(path.join(home, 'systemd', 'user'))
    : [];
  fs.rmSync(home, { recursive: true, force: true });
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /does not survive a reboot/);
  assert.deepStrictEqual(units, [], 'no unit may be written when the root is doomed');
});

test('the timer schedule is a calendar spec systemd can actually parse', () => {
  // A malformed OnCalendar= is not rejected at install time by anything else
  // here; systemd simply never fires the unit.
  const text = fs.readFileSync(path.join(SCRIPTS, 'watch-install.sh'), 'utf8');
  const spec = /^CALENDAR="(.+)"$/m.exec(text)[1].replace('${INTERVAL}', '10');
  const parsed = spawnSync('systemd-analyze', ['calendar', spec], { encoding: 'utf8' });
  if (parsed.error) return; // no systemd-analyze here; the assertions above still hold
  assert.strictEqual(parsed.status, 0, parsed.stderr);
  assert.match(parsed.stdout, /Next elapse:/);
});

test('an interval that cannot divide an hour is refused, not silently mangled', () => {
  for (const bad of ['0', '45', 'hourly', '-5']) {
    const result = spawnSync('bash', [path.join(SCRIPTS, 'watch-install.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PI_WATCH_INTERVAL: bad, XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-int-')) },
    });
    assert.notStrictEqual(result.status, 0, `PI_WATCH_INTERVAL=${bad} should be refused`);
    assert.match(result.stderr, /PI_WATCH_INTERVAL must be/);
  }
});

// --- The dump guard (SOMET-485) ---------------------------------------------
//
// backup.sh and restore.sh both refuse to touch a dump that does not look like
// a dump. Both expressed that as
//
//     gzip -dc "$f" | head -c 200000 | grep -q 'CREATE TABLE'
//
// under `set -o pipefail`, and both were therefore wrong: `grep -q` quits at
// its first match, `gzip` is still writing, takes SIGPIPE, exits 141, and
// pipefail hands that 141 back as the pipeline's status. A VALID dump read as
// "contains no CREATE TABLE" -- the restore refused, the backup deleted.
//
// It only misfires when gzip still has output pending when grep quits, i.e.
// when the dump is big, i.e. when it holds real data. That is why the fixture
// below is megabytes rather than the couple of kilobytes a toy dump produces:
// a small fixture leaves this bug completely undetected, which is how it
// survived. Every test here runs the real scripts.
const GUARD = path.join(SCRIPTS, 'dump-guard.sh');
const RESTORE_SH = path.join(SCRIPTS, 'restore.sh');

let dumpFixtures = null;
function fixtures() {
  if (dumpFixtures) return dumpFixtures;
  const zlib = require('node:zlib');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dump-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

  // Shaped like pg_dump's output: schema first, then a long data section. The
  // CREATE TABLE is near the TOP, so the guard finds it immediately and quits
  // immediately -- which is exactly the moment the old pipeline broke.
  const lines = ['SET statement_timeout = 0;', 'DROP TABLE IF EXISTS public.bulk;',
    'CREATE TABLE public.bulk (id integer NOT NULL, note text);'];
  for (let i = 0; i < 400000; i += 1) lines.push(`INSERT INTO public.bulk VALUES (${i}, 'row ${i} of the data section');`);
  const plain = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  assert.ok(plain.length > 4 * 1024 * 1024,
    'the fixture must be multi-megabyte or it cannot exercise the SIGPIPE window at all');

  const big = path.join(dir, 'big.sql.gz');
  fs.writeFileSync(big, zlib.gzipSync(plain));

  // A dump that decompresses fine and simply is not one.
  const noSchema = path.join(dir, 'no-create-table.sql.gz');
  fs.writeFileSync(noSchema, zlib.gzipSync(Buffer.from('SELECT 1;\n', 'utf8')));

  // Not a gzip stream at all.
  const notGzip = path.join(dir, 'not-gzip.sql.gz');
  fs.writeFileSync(notGzip, 'this is not gzip');

  // A real gzip stream cut off partway -- the shape an interrupted transfer
  // leaves behind, and the one that looks most like a good backup.
  const truncated = path.join(dir, 'truncated.sql.gz');
  fs.writeFileSync(truncated, fs.readFileSync(big).subarray(0, 300000));

  // Valid gzip of BINARY. Rejected for the same reason as any other non-dump,
  // but it is also the input that makes bash complain about null bytes if the
  // guard forgets to strip them.
  const binary = path.join(dir, 'binary.sql.gz');
  fs.writeFileSync(binary, zlib.gzipSync(Buffer.alloc(500000, 0)));

  dumpFixtures = { dir, big, noSchema, notGzip, truncated, binary, plainBytes: plain.length };
  return dumpFixtures;
}

// restore.sh runs the guard BEFORE it looks at the mode, so invoking it with no
// mode separates the two outcomes cleanly: 65 means the guard refused the
// dump, 64 means the guard passed it and usage() took over. Nothing is
// restored either way, so this needs no database.
function restoreGuardStatus(dump) {
  return spawnSync('bash', [RESTORE_SH, dump], { encoding: 'utf8' }).status;
}

test('a valid multi-megabyte dump passes the guard 100 times out of 100', () => {
  const f = fixtures();
  // ONE bash process running the loop: 100 node spawns would spend more time
  // in node than in the thing under test. The counts come back on stdout.
  const loop = `
    pass=0; refuse=0; other=0
    for i in $(seq 1 100); do
      bash ${JSON.stringify(toPosix(RESTORE_SH))} ${JSON.stringify(toPosix(f.big))} >/dev/null 2>&1
      case $? in
        64) pass=$((pass+1)) ;;
        65) refuse=$((refuse+1)) ;;
        *) other=$((other+1)) ;;
      esac
    done
    echo "$pass $refuse $other"`;
  const result = spawnSync('bash', ['-c', loop], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  const [pass, refuse, other] = result.stdout.trim().split(/\s+/).map(Number);
  // Once is not evidence: the broken pipeline passed small dumps every time and
  // failed this one every time, and a rate-dependent bug needs a rate to show.
  assert.strictEqual(refuse, 0, `the guard refused a valid dump ${refuse}/100 times`);
  assert.strictEqual(other, 0, `unexpected exit statuses in ${other}/100 runs`);
  assert.strictEqual(pass, 100);
});

test('the guard function itself accepts the same dump 100 times out of 100', () => {
  // backup.sh reaches the guard only after ssh-ing to a board, so its call is
  // exercised here at the function level -- under the same `set -euo pipefail`
  // both scripts run with, because pipefail is the whole defect.
  const f = fixtures();
  const loop = `
    set -euo pipefail
    . ${JSON.stringify(toPosix(GUARD))}
    ok=0
    for i in $(seq 1 100); do
      if dump_has_create_table ${JSON.stringify(toPosix(f.big))}; then ok=$((ok+1)); fi
    done
    echo "$ok"`;
  const result = spawnSync('bash', ['-c', loop], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(Number(result.stdout.trim()), 100,
    'dump_has_create_table must not depend on how much of the stream gzip had left');
});

test('the guard still refuses a dump that carries no schema', () => {
  const f = fixtures();
  // The fix must not become "always pass". A false acceptance on a recovery
  // path is worse than the false refusal it replaced: it drops a live database
  // and puts nothing back.
  const result = spawnSync('bash', [RESTORE_SH, f.noSchema], { encoding: 'utf8' });
  assert.strictEqual(result.status, 65);
  assert.match(result.stderr, /no CREATE TABLE/);
});

test('the guard still refuses a truncated dump and a file that is not gzip', () => {
  const f = fixtures();
  for (const bad of [f.truncated, f.notGzip, f.binary]) {
    assert.strictEqual(restoreGuardStatus(bad), 65, `${path.basename(bad)} must be refused`);
  }
});

test('rejecting a binary dump does not spray bash warnings over the operator', () => {
  // Reading the head into a shell variable is what removed the SIGPIPE window;
  // NULs in that head are what bash complains about while still reaching the
  // right verdict. The verdict is not enough -- a recovery transcript full of
  // "ignored null byte in input" hides the line that matters.
  const f = fixtures();
  const result = spawnSync('bash', [RESTORE_SH, f.binary], { encoding: 'utf8' });
  assert.strictEqual(result.status, 65);
  assert.doesNotMatch(result.stderr, /null byte/);
});

test('both scripts share one guard instead of each keeping the broken pipeline', () => {
  // The identical racy pipeline lived in two files. Two copies is how one gets
  // fixed and the other does not.
  for (const name of ['restore.sh', 'backup.sh']) {
    const text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
    assert.doesNotMatch(text, /gzip -dc [^\n]*\|[^\n]*grep -q/,
      `${name} must not pipe gzip into grep -q; under pipefail that reads SIGPIPE as failure`);
    assert.match(text, /dump_has_create_table/, `${name} must use the shared guard`);
    assert.match(text, /dump-guard\.sh/, `${name} must source the shared guard`);
  }
});

// --- Tunnel choice, remembered on the board (SOMET-715) ---------------------
//
// Real bash against the real scripts, PI_LOCAL=1 so "the board" is a scratch
// directory, with `docker` and `curl` replaced by stubs on PATH. The stub
// docker records every call and answers `inspect` / `logs` from files the test
// controls, so each test sets the board's state and reads back what was run.

function tunnelRig({ files = {}, logs = '', started = '', curlCode = '200', envFile = '', boardToken = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tunnel-'));
  const data = path.join(dir, 'data');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(data);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(data, '.env'), `POSTGRES_PASSWORD=x\n${boardToken ? 'NGROK_AUTHTOKEN=old\n' : ''}`);
  fs.writeFileSync(path.join(dir, '.env'), envFile);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(data, name), content);
  fs.writeFileSync(path.join(dir, 'logs'), logs);
  const write = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  };
  write('docker', `echo "docker $*" >> "${dir}/docker.log"
case "$1" in
  inspect) printf '%s\\n' "${started}" ;;
  logs) cat "${dir}/logs" ;;
esac
exit 0`);
  write('curl', `echo "curl $*" >> "${dir}/curl.log"; printf '%s' "${curlCode}"`);
  // A stand-in ssh that records every argument, then runs the remote command
  // locally: lets a test see exactly what a workstation would put on argv.
  write('ssh', `echo "ssh $*" >> "${dir}/ssh.log"; for last; do :; done; exec bash -c "$last"`);
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  const run = (args, { local = true, env = {} } = {}) =>
    spawnSync('bash', [path.join(SCRIPTS, 'tunnel.sh'), ...args], {
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REPO_ROOT: dir,
        ORANGEPI_DATA_DIR: data,
        ORANGEPI_APP_DIR: dir,
        TUNNEL_WAIT_SECS: '2',
        TUNNEL_POLL_SECS: '1',
        ...(local ? { PI_LOCAL: '1' } : { ORANGEPI_ADDRESS: 'board.invalid', ORANGEPI_LOGIN: 'pi' }),
        ...env,
      },
    });
  const profiles = (env = {}) => {
    const r = spawnSync(
      'bash',
      ['-c', `set -euo pipefail\n. ${JSON.stringify(LIB)}\npi_profiles`],
      { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPO_ROOT: dir, ORANGEPI_DATA_DIR: data, PI_LOCAL: '1', ...env } },
    );
    return r.stdout;
  };
  return { dir, data, read, run, profiles, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const STARTED = '2026-11-04T10:00:00.123456789Z';

test('pi_profiles omits tunnel when cloudflare is marked off, includes it otherwise', () => {
  const on = tunnelRig();
  assert.match(on.profiles(), /--profile tunnel/);
  on.cleanup();
  const off = tunnelRig({ files: { 'tunnel-cloudflare.off': '' } });
  assert.doesNotMatch(off.profiles(), /--profile tunnel/);
  off.cleanup();
});

test('pi_profiles includes the ngrok profile only when tunnel-ngrok.on exists', () => {
  const without = tunnelRig();
  assert.doesNotMatch(without.profiles(), /ngrok/);
  without.cleanup();
  const withFile = tunnelRig({ files: { 'tunnel-ngrok.on': '' } });
  assert.match(withFile.profiles(), /--profile ngrok/);
  assert.match(withFile.profiles(), /--profile tunnel/);
  withFile.cleanup();
});

test('deploy leaves a stopped cloudflare stopped', () => {
  const run = (files) => {
    const rig = tunnelRig({ files });
    const r = spawnSync(
      'bash',
      ['-c', `set -euo pipefail\n. ${JSON.stringify(LIB)}\npi_ensure_tunnels "" "$(pi_compose_cmd)" "$(pi_profiles)"`],
      { encoding: 'utf8', env: { ...process.env, PATH: `${path.join(rig.dir, 'bin')}:${process.env.PATH}`, REPO_ROOT: rig.dir, ORANGEPI_DATA_DIR: rig.data, ORANGEPI_APP_DIR: rig.dir, PI_LOCAL: '1' } },
    );
    const log = rig.read('docker.log');
    rig.cleanup();
    return { r, log };
  };
  const stopped = run({ 'tunnel-cloudflare.off': '' });
  assert.strictEqual(stopped.r.status, 0, stopped.r.stderr);
  assert.doesNotMatch(stopped.log, /up .*cloudflared/);
  // And the control: with no state file the same call does bring it up.
  const normal = run({});
  assert.match(normal.log, /up .*cloudflared/);
  // ngrok alongside it only when switched on.
  const both = run({ 'tunnel-ngrok.on': '' });
  assert.match(both.log, /up .*cloudflared ngrok/);
});

test('tunnel.sh stop removes the container and remembers the choice', () => {
  const rig = tunnelRig();
  const r = rig.run(['stop', 'cloudflare']);
  assert.strictEqual(r.status, 0, r.stderr);
  // pi_tunnel_url reads a STOPPED container's old logs, so stop alone would
  // keep reporting a dead address.
  assert.match(rig.read('docker.log'), /rm -sf cloudflared/);
  assert.ok(fs.existsSync(path.join(rig.data, 'tunnel-cloudflare.off')));
  rig.cleanup();

  const ngrok = tunnelRig({ files: { 'tunnel-ngrok.on': '' } });
  const n = ngrok.run(['stop', 'ngrok']);
  assert.strictEqual(n.status, 0, n.stderr);
  assert.match(ngrok.read('docker.log'), /rm -sf ngrok/);
  assert.ok(!fs.existsSync(path.join(ngrok.data, 'tunnel-ngrok.on')));
  ngrok.cleanup();
});

test('tunnel.sh start ngrok with no token fails without touching docker', () => {
  const rig = tunnelRig();
  const r = rig.run(['start', 'ngrok'], { env: { NGROK_AUTHTOKEN: '' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^error=no_token$/m);
  assert.strictEqual(rig.read('docker.log'), '');
  assert.ok(!fs.existsSync(path.join(rig.data, 'tunnel-ngrok.on')), 'nothing remembered for a start that never began');
  rig.cleanup();
});

test('tunnel.sh start ngrok reports the ngrok error code', () => {
  const rig = tunnelRig({
    started: STARTED,
    logs: 't=1 lvl=eror msg="failed to start tunnel" err="ERR_NGROK_334: endpoint is already online"\n',
  });
  const r = rig.run(['start', 'ngrok'], { env: { NGROK_AUTHTOKEN: 'tok' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^error=ERR_NGROK_334$/m);
  assert.doesNotMatch(r.stdout, /^url=/m);
  rig.cleanup();
});

test('a failed ngrok start clears tunnel-ngrok.on and removes the container', () => {
  const cases = {
    ERR_NGROK_334: { logs: 'msg="failed" err="ERR_NGROK_334: online"\n', curlCode: '200', expect: 'ERR_NGROK_334' },
    no_url: { logs: 'nothing useful\n', curlCode: '200', expect: 'no_url' },
    not_answering: { logs: 'msg="started tunnel" url=https://abc.ngrok-free.app\n', curlCode: '502', expect: 'not_answering' },
  };
  for (const [label, c] of Object.entries(cases)) {
    const rig = tunnelRig({ started: STARTED, logs: c.logs, curlCode: c.curlCode });
    const r = rig.run(['start', 'ngrok'], { env: { NGROK_AUTHTOKEN: 'tok' } });
    assert.strictEqual(r.status, 1, label);
    assert.match(r.stdout, new RegExp(`^error=${c.expect}$`, 'm'), label);
    assert.ok(!fs.existsSync(path.join(rig.data, 'tunnel-ngrok.on')), `${label}: must not stay wanted`);
    assert.match(rig.read('docker.log'), /rm -sf ngrok/, label);
    rig.cleanup();
  }
});

test('a failed compose up for ngrok clears tunnel-ngrok.on', () => {
  const rig = tunnelRig({ started: STARTED });
  fs.writeFileSync(path.join(rig.dir, 'bin', 'docker'), `#!/usr/bin/env bash
echo "docker $*" >> "${rig.dir}/docker.log"
case "$*" in *" up "*) exit 1 ;; esac
exit 0
`, { mode: 0o755 });
  const r = rig.run(['start', 'ngrok'], { env: { NGROK_AUTHTOKEN: 'tok' } });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^error=compose_up_failed$/m);
  assert.ok(!fs.existsSync(path.join(rig.data, 'tunnel-ngrok.on')), 'must not stay wanted');
  assert.match(rig.read('docker.log'), /rm -sf ngrok/);
  rig.cleanup();
});

test('writing the ngrok token keeps the other keys, the mode and leaves no temp file', () => {
  const rig = tunnelRig({
    started: STARTED,
    logs: 'msg="started tunnel" url=https://abc.ngrok-free.app\n',
  });
  const envPath = path.join(rig.data, '.env');
  fs.writeFileSync(envPath, 'POSTGRES_PASSWORD=pw\nNGROK_AUTHTOKEN=old\nJWT_SECRET=jj\n');
  fs.chmodSync(envPath, 0o640);
  const r = rig.run(['start', 'ngrok'], { env: { NGROK_AUTHTOKEN: 'new-tok' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(envPath, 'utf8'), 'POSTGRES_PASSWORD=pw\nJWT_SECRET=jj\nNGROK_AUTHTOKEN=new-tok\n');
  assert.strictEqual(fs.statSync(envPath).mode & 0o777, 0o640);
  assert.deepStrictEqual(fs.readdirSync(rig.data).filter((f) => f.includes('.tmp')), []);
  rig.cleanup();
});

test('an unreadable .env is left untouched', () => {
  const rig = tunnelRig({ started: STARTED });
  const envPath = path.join(rig.data, '.env');
  const before = 'POSTGRES_PASSWORD=pw\nJWT_SECRET=jj\n';
  fs.writeFileSync(envPath, before);
  // grep fails the way it does on an unreadable file (exit 2). A stub, not mode 000, so root behaves the same.
  fs.writeFileSync(path.join(rig.dir, 'bin', 'grep'), '#!/usr/bin/env bash\necho "grep: .env: Permission denied" >&2\nexit 2\n', { mode: 0o755 });
  const r = rig.run(['start', 'ngrok'], { env: { NGROK_AUTHTOKEN: 'tok' } });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^error=env_write_failed$/m);
  assert.strictEqual(fs.readFileSync(envPath, 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(rig.data).filter((f) => f.includes('.tmp')), []);
  assert.ok(!fs.existsSync(path.join(rig.data, 'tunnel-ngrok.on')), 'a start that never began is not remembered');
  assert.doesNotMatch(rig.read('docker.log'), /up -d/);
  rig.cleanup();
});

test('a missing board .env also fails the token write without creating one', () => {
  const rig = tunnelRig({ started: STARTED });
  fs.rmSync(path.join(rig.data, '.env'));
  const r = rig.run(['start', 'ngrok'], { env: { NGROK_AUTHTOKEN: 'tok' } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^error=env_write_failed$/m);
  assert.ok(!fs.existsSync(path.join(rig.data, '.env')));
  rig.cleanup();
});

test('a failed cloudflare start leaves it wanted', () => {
  for (const [logs, curlCode, expect] of [
    ['nothing\n', '200', 'no_url'],
    ['https://quiet-fox-1.trycloudflare.com\n', '502', 'not_answering'],
  ]) {
    const rig = tunnelRig({ started: STARTED, logs, curlCode });
    const r = rig.run(['start', 'cloudflare']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, new RegExp(`^error=${expect}$`, 'm'));
    assert.ok(!fs.existsSync(path.join(rig.data, 'tunnel-cloudflare.off')), 'cloudflare stays on by default');
    assert.doesNotMatch(rig.read('docker.log'), /rm -sf/);
    rig.cleanup();
  }
});

test('tunnel.sh start ngrok writes the token into the board .env and reports the url', () => {
  const rig = tunnelRig({
    boardToken: true,
    started: STARTED,
    logs: 't=1 lvl=info msg="started tunnel" obj=tunnels name=command_line addr=http://caddy:80 url=https://abc-123.ngrok-free.app\n',
  });
  const r = rig.run(['start', 'ngrok'], { env: { NGROK_AUTHTOKEN: 'SECRET-tok-1' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^url=https:\/\/abc-123\.ngrok-free\.app$/m);
  const env = fs.readFileSync(path.join(rig.data, '.env'), 'utf8');
  // Replaced, not appended, and the neighbouring key survives.
  assert.strictEqual(env, 'POSTGRES_PASSWORD=x\nNGROK_AUTHTOKEN=SECRET-tok-1\n');
  assert.ok(fs.existsSync(path.join(rig.data, 'tunnel-ngrok.on')));
  assert.match(rig.read('docker.log'), /up -d --no-deps --no-recreate ngrok/);
  // Health is probed through the public address, from here, with the header
  // that gets past ngrok's interstitial.
  assert.match(rig.read('curl.log'), /ngrok-skip-browser-warning: 1 https:\/\/abc-123\.ngrok-free\.app\/api\/health/);
  rig.cleanup();
});

test('tunnel.sh shows no url when health fails through the tunnel', () => {
  const rig = tunnelRig({
    started: STARTED,
    curlCode: '502',
    logs: 'Your quick Tunnel has been created! https://quiet-fox-1.trycloudflare.com\n',
  });
  const r = rig.run(['start', 'cloudflare']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^error=not_answering$/m);
  assert.doesNotMatch(r.stdout, /url=/);
  rig.cleanup();
});

test('tunnel.sh start cloudflare succeeds and a failing reconcile is only a note', () => {
  const rig = tunnelRig({
    files: { 'tunnel-cloudflare.off': '' },
    started: STARTED,
    logs: 'https://quiet-fox-1.trycloudflare.com\n',
  });
  // No GIT_REPOSITORY, so reconcile-url.sh refuses to run.
  const r = rig.run(['start', 'cloudflare'], { env: { GIT_REPOSITORY: '' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^url=https:\/\/quiet-fox-1\.trycloudflare\.com$/m);
  assert.match(r.stdout, /^note=reconcile-url\.sh failed/m);
  assert.ok(!fs.existsSync(path.join(rig.data, 'tunnel-cloudflare.off')), 'start clears the off mark');
  rig.cleanup();
});

test('tunnel.sh status reports off with a blank url when the container is absent', () => {
  const rig = tunnelRig({ started: '' });
  const r = rig.run(['status', 'ngrok']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, 'state=off\nurl=\nverified=no\nage=\n');
  rig.cleanup();
});

test('tunnel.sh status reports url, verified and age for a running tunnel', () => {
  const started = new Date(Date.now() - 125 * 1000).toISOString().replace(/\.\d+Z$/, '.123456789Z');
  const up = tunnelRig({ started, logs: 'https://quiet-fox-1.trycloudflare.com\n' });
  const r = up.run(['status', 'cloudflare']);
  assert.match(r.stdout, /^state=on$/m);
  assert.match(r.stdout, /^url=https:\/\/quiet-fox-1\.trycloudflare\.com$/m);
  assert.match(r.stdout, /^verified=yes$/m);
  const age = Number(/^age=(\d+)$/m.exec(r.stdout)[1]);
  assert.ok(age >= 120 && age <= 135, `age ${age}`);
  up.cleanup();
  const bad = tunnelRig({ started, curlCode: '502', logs: 'https://quiet-fox-1.trycloudflare.com\n' });
  assert.match(bad.run(['status', 'cloudflare']).stdout, /^verified=no$/m);
  bad.cleanup();
});

test('the ngrok token never reaches argv', () => {
  const token = 'SECRET-tok-ARGV-9';
  const rig = tunnelRig({
    started: STARTED,
    logs: 'msg="started tunnel" url=https://abc-123.ngrok-free.app\n',
  });
  // Non-local, so the stand-in ssh sees what a real ssh would be given.
  const r = rig.run(['start', 'ngrok'], { local: false, env: { NGROK_AUTHTOKEN: token } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(rig.read('ssh.log').length > 0, 'the ssh stand-in must actually have been used');
  assert.doesNotMatch(rig.read('ssh.log'), new RegExp(token));
  assert.doesNotMatch(rig.read('docker.log'), new RegExp(token));
  assert.doesNotMatch(rig.read('curl.log'), new RegExp(token));
  // ...while it did arrive.
  assert.match(fs.readFileSync(path.join(rig.data, '.env'), 'utf8'), new RegExp(`NGROK_AUTHTOKEN=${token}`));
  rig.cleanup();
});

// --- One deploy at a time (SOMET-715) ----------------------------------------
//
// Real deploy.sh, PI_LOCAL=1, against a real scratch git origin and clone, with
// stub docker/curl. The stub curl answers from a file so a test can say "the
// stack is healthy" or not, and a stub `docker ... up` flips it healthy, so a
// deploy that really restarts also really finishes its health wait.

// marker: contents of the deployed-sha file. Default: the app's HEAD when atTarget (a finished deploy
// of it), none otherwise. null = no marker. hook: what the hook container's status call prints.
function deployRig({ atTarget = false, health = '200', failStop = false, marker, hook, failOn } = {}) {
  const rig = tunnelRig();
  const git = (cwd, ...args) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  const origin = path.join(rig.dir, 'origin.git');
  const seed = path.join(rig.dir, 'seed');
  const app = path.join(rig.dir, 'app');
  git(rig.dir, 'init', '-q', '--bare', '-b', 'orangepi', origin);
  git(rig.dir, 'clone', '-q', origin, seed);
  fs.writeFileSync(path.join(seed, 'f'), '1');
  git(seed, 'add', 'f');
  git(seed, 'commit', '-qm', 'one');
  git(seed, 'push', '-q', 'origin', 'HEAD:orangepi');
  git(rig.dir, 'clone', '-q', '-b', 'orangepi', origin, app);
  if (!atTarget) {
    fs.writeFileSync(path.join(seed, 'f'), '2');
    git(seed, 'commit', '-qam', 'two');
    git(seed, 'push', '-q', 'origin', 'HEAD:orangepi');
  }
  const bin = path.join(rig.dir, 'bin');
  fs.writeFileSync(path.join(rig.dir, 'curlcode'), health);
  const write = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  };
  write('curl', `echo "curl $*" >> "${rig.dir}/curl.log"; printf '%s' "$(cat "${rig.dir}/curlcode")"`);
  if (failStop) fs.writeFileSync(path.join(rig.dir, 'failstop'), '1');
  if (failOn) fs.writeFileSync(path.join(rig.dir, 'failon'), failOn);
  if (hook) fs.writeFileSync(path.join(rig.dir, 'hookout'), hook);
  write('docker', `echo "docker $*" >> "${rig.dir}/docker.log"
[ -f "${rig.dir}/failon" ] && grep -qE "$(cat "${rig.dir}/failon")" <<<"$*" && { echo "stub failure" >&2; exit 1; }
case "$*" in
  "exec something2-orangepi-deploy-hook-1 "*) [ -f "${rig.dir}/hookout" ] && { cat "${rig.dir}/hookout"; exit 0; }; exit 1 ;;
  *" stop "*) [ -f "${rig.dir}/failstop" ] && { echo boom >&2; exit 1; }; true ;;
  *" up "*) [ -f "${rig.dir}/norecover" ] || printf 200 > "${rig.dir}/curlcode" ;;
  "pull "*) exit 1 ;;
esac
exit 0`);
  fs.mkdirSync(path.join(rig.data, 'locks'));
  // A board that already has its object-storage password; the tests about a board that lacks one rewrite .env.
  fs.appendFileSync(path.join(rig.data, '.env'), 'MINIO_ROOT_PASSWORD=existing-test-key\n');
  const lock = path.join(rig.data, 'locks', 'deploy.lock');
  const markerFile = path.join(rig.data, 'locks', 'deployed-sha');
  const appHead = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: app, encoding: 'utf8' }).trim();
  const want = marker === undefined ? (atTarget ? appHead() : null) : marker;
  if (want !== null) fs.writeFileSync(markerFile, `${want}\n`);
  const deploy = (env = {}) =>
    spawnSync('bash', [path.join(SCRIPTS, 'deploy.sh')], {
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REPO_ROOT: rig.dir,
        ORANGEPI_DATA_DIR: rig.data,
        ORANGEPI_APP_DIR: app,
        GIT_REPOSITORY: 'https://github.com/o/r.git',
        ORANGEPI_BRANCH: 'orangepi',
        PI_LOCAL: '1',
        ...env,
      },
    });
  const readMarker = () => (fs.existsSync(markerFile) ? fs.readFileSync(markerFile, 'utf8').trim() : null);
  return { ...rig, lock, deploy, markerFile, readMarker, appHead, app };
}

test('a second deploy exits 75 and stops nothing', () => {
  const rig = deployRig();
  fs.mkdirSync(rig.lock);
  const r = rig.deploy();
  assert.strictEqual(r.status, 75, r.stdout + r.stderr);
  assert.match(r.stderr, /another deploy is running/i);
  assert.doesNotMatch(rig.read('docker.log'), /stop/);
  // It must not remove the lock it never took.
  assert.ok(fs.existsSync(rig.lock));
  rig.cleanup();
});

test('the lock is taken during a deploy and released when it finishes', () => {
  const rig = deployRig();
  const r = rig.deploy();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(rig.read('docker.log'), /stop/);
  assert.ok(!fs.existsSync(rig.lock));
  rig.cleanup();
});

test('the lock is released when a step fails', () => {
  const rig = deployRig({ failStop: true });
  const r = rig.deploy();
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(rig.read('docker.log'), /stop/);
  assert.ok(!fs.existsSync(rig.lock));
  rig.cleanup();
});

test('a stale lock is taken over', () => {
  const rig = deployRig();
  fs.mkdirSync(rig.lock);
  const old = new Date(Date.now() - 46 * 60 * 1000);
  fs.utimesSync(rig.lock, old, old);
  const r = rig.deploy();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(rig.read('docker.log'), /stop/);
  assert.ok(!fs.existsSync(rig.lock));
  rig.cleanup();
});

test('a lock younger than 45 minutes is not taken over', () => {
  const rig = deployRig();
  fs.mkdirSync(rig.lock);
  const recent = new Date(Date.now() - 40 * 60 * 1000);
  fs.utimesSync(rig.lock, recent, recent);
  assert.strictEqual(rig.deploy().status, 75);
  rig.cleanup();
});

test('skip-if-current does nothing when settled', () => {
  const rig = deployRig({ atTarget: true });
  const r = rig.deploy({ PI_SKIP_IF_CURRENT: '1' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(rig.read('docker.log'), /stop/);
  assert.ok(!fs.existsSync(rig.lock));
  rig.cleanup();
});

test('a settled board skips and keeps its marker', () => {
  const rig = deployRig({ atTarget: true });
  const before = rig.readMarker();
  assert.strictEqual(rig.deploy({ PI_SKIP_IF_CURRENT: '1' }).status, 0);
  assert.strictEqual(rig.readMarker(), before);
  assert.strictEqual(before, rig.appHead());
  rig.cleanup();
});

test('no marker means not settled: skip-if-current redeploys and then records one', () => {
  const rig = deployRig({ atTarget: true, marker: null });
  const r = rig.deploy({ PI_SKIP_IF_CURRENT: '1' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(rig.read('docker.log'), /stop/);
  assert.strictEqual(rig.readMarker(), rig.appHead());
  rig.cleanup();
});

test('a marker naming another commit is not settled', () => {
  const rig = deployRig({ atTarget: true, marker: 'f'.repeat(40) });
  assert.strictEqual(rig.deploy({ PI_SKIP_IF_CURRENT: '1' }).status, 0);
  assert.match(rig.read('docker.log'), /stop/);
  rig.cleanup();
});

test('a successful deploy writes the marker (the full sha) and leaves no temp file', () => {
  const rig = deployRig();
  const r = rig.deploy();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(rig.readMarker(), /^[0-9a-f]{40}$/);
  assert.strictEqual(rig.readMarker(), rig.appHead());
  assert.deepStrictEqual(fs.readdirSync(path.dirname(rig.markerFile)).filter((f) => f.includes('.tmp')), []);
  rig.cleanup();
});

test('a failed deploy leaves no marker, even when one existed', () => {
  const rig = deployRig({ failStop: true, marker: 'c'.repeat(40) });
  const r = rig.deploy();
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.strictEqual(rig.readMarker(), null);
  rig.cleanup();
});

test('a failed soft step leaves no marker, and a retry redeploys and re-runs it', () => {
  const rig = deployRig({ failOn: 'seed-passive-tree', marker: 'c'.repeat(40) });
  const r = rig.deploy();
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.strictEqual(rig.readMarker(), null);
  assert.match(r.stderr, /not recording the deployed commit/);
  // The retry: the soft step works now. Not "already settled" -- it deploys in full.
  fs.rmSync(path.join(rig.dir, 'failon'));
  const before = rig.read('docker.log');
  const again = rig.deploy({ PI_SKIP_IF_CURRENT: '1' });
  assert.strictEqual(again.status, 0, again.stdout + again.stderr);
  assert.doesNotMatch(again.stdout, /nothing to deploy/);
  const added = rig.read('docker.log').slice(before.length);
  assert.match(added, /seed-passive-tree\.js --force/);
  assert.strictEqual(rig.readMarker(), rig.appHead());
  rig.cleanup();
});

test('a failed soft step ends the output with failed-steps and stack=up', () => {
  const rig = deployRig({ failOn: 'seed-passive-tree' });
  const r = rig.deploy();
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  const lines = (r.stdout + r.stderr).split('\n').filter(Boolean);
  assert.ok(lines.includes('failed-steps=reseed the passive tree (--force)'), lines.join('\n'));
  assert.ok(lines.includes('stack=up'));
  rig.cleanup();
});

test('a migration abort prints failed-steps without stack=up', () => {
  const rig = deployRig({ failOn: 'migrate:up' });
  const r = rig.deploy();
  const lines = (r.stdout + r.stderr).split('\n').filter(Boolean);
  assert.ok(lines.includes('failed-steps=run migrations'), lines.join('\n'));
  assert.ok(!lines.includes('stack=up'));
  rig.cleanup();
});

test('a migration abort leaves no marker', () => {
  const rig = deployRig({ failOn: 'migrate:up', marker: 'c'.repeat(40) });
  const r = rig.deploy();
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /aborted by a failed migration/);
  assert.strictEqual(rig.readMarker(), null);
  rig.cleanup();
});

test('a failure in wait_for_health leaves no marker', () => {
  const rig = deployRig({ health: '502', marker: 'c'.repeat(40) });
  fs.writeFileSync(path.join(rig.dir, 'norecover'), '1');
  fs.writeFileSync(path.join(rig.dir, 'bin', 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const r = rig.deploy();
  assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /did not answer/);
  assert.strictEqual(rig.readMarker(), null);
  rig.cleanup();
});

test('a restart of the old version does not fake settled', () => {
  // The deploy fails after its reset: HEAD is at the target, the old stack serves, no marker.
  const rig = deployRig({ failStop: true });
  assert.strictEqual(rig.deploy().status, 1);
  assert.strictEqual(rig.readMarker(), null);
  fs.rmSync(path.join(rig.dir, 'failstop'));
  // "The old backend restarts" (restart button, reboot): nothing the state reads changes.
  const st = stateOf(rig);
  assert.strictEqual(st.head, rig.appHead());
  assert.strictEqual(st.deployed, '');
  assert.strictEqual(st.health, '200');
  // The next update redeploys instead of skipping.
  const before = rig.read('docker.log').split('stop').length;
  const r = rig.deploy({ PI_SKIP_IF_CURRENT: '1' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(rig.read('docker.log').split('stop').length > before, 'deploy.sh stopped the containers');
  assert.strictEqual(rig.readMarker(), rig.appHead());
  rig.cleanup();
});

test('skip-if-current still deploys when at target but unhealthy', () => {
  const rig = deployRig({ atTarget: true, health: '502' });
  const r = rig.deploy({ PI_SKIP_IF_CURRENT: '1' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(rig.read('docker.log'), /stop/);
  rig.cleanup();
});

test('skip-if-current still deploys when the board is behind the target', () => {
  const rig = deployRig({ atTarget: false });
  const r = rig.deploy({ PI_SKIP_IF_CURRENT: '1' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(rig.read('docker.log'), /stop/);
  rig.cleanup();
});

test('PI_LOCAL implies skip-if-current, and without it a deploy always redeploys', () => {
  const local = deployRig({ atTarget: true });
  assert.strictEqual(local.deploy().status, 0);
  assert.doesNotMatch(local.read('docker.log'), /stop/);
  local.cleanup();
  // Plain `make pi-deploy` over ssh (stand-in ssh on PATH): always redeploys.
  const remote = deployRig({ atTarget: true });
  const r = remote.deploy({
    PI_LOCAL: '',
    ORANGEPI_ADDRESS: 'board.invalid',
    ORANGEPI_LOGIN: 'pi',
  });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(remote.read('docker.log'), /stop/);
  remote.cleanup();
});

test('a lock directory that cannot be created is not reported as another deploy', () => {
  const rig = deployRig();
  // A regular file where the locks directory belongs: mkdir fails even as root.
  fs.rmSync(path.join(rig.data, 'locks'), { recursive: true });
  fs.writeFileSync(path.join(rig.data, 'locks'), '');
  const r = rig.deploy();
  assert.notStrictEqual(r.status, 75, r.stdout + r.stderr);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /not writable/);
  assert.match(r.stderr, /deploy\.lock/);
  assert.match(r.stderr, /make pi-up/);
  assert.doesNotMatch(rig.read('docker.log'), /stop/);
  rig.cleanup();
});

// --- pi_deploy_state (SOMET-717) ---------------------------------------------

function stateOf(rig, env = {}) {
  const r = spawnSync('bash', [path.join(SCRIPTS, 'remote.sh'), 'deploy-state'], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${path.join(rig.dir, 'bin')}:${process.env.PATH}`,
      REPO_ROOT: rig.dir,
      ORANGEPI_DATA_DIR: rig.data,
      ORANGEPI_APP_DIR: path.join(rig.dir, 'app'),
      GIT_REPOSITORY: 'https://github.com/o/r.git',
      ORANGEPI_BRANCH: 'orangepi',
      PI_LOCAL: '1',
      ...env,
    },
  });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  return Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

test('deploy-state prints head, deployed, health, lock and hook_deploying', () => {
  const rig = deployRig({ atTarget: true, hook: 'no\n' });
  const st = stateOf(rig);
  assert.deepStrictEqual(Object.keys(st), ['head', 'deployed', 'health', 'lock', 'hook_deploying']);
  assert.strictEqual(st.head, rig.appHead());
  assert.strictEqual(st.deployed, rig.appHead());
  assert.strictEqual(st.health, '200');
  assert.strictEqual(st.lock, 'no');
  assert.strictEqual(st.hook_deploying, 'no');
  rig.cleanup();
});

test('deploy-state: absent marker, absent hook, held, stale and unreadable lock', () => {
  const rig = deployRig({ atTarget: true, marker: null, health: '503' });
  const st = stateOf(rig);
  assert.strictEqual(st.deployed, '');
  assert.strictEqual(st.health, '503');
  assert.strictEqual(st.hook_deploying, 'unknown'); // docker exec fails: container absent
  fs.mkdirSync(rig.lock);
  assert.strictEqual(stateOf(rig).lock, 'yes');
  const old = new Date(Date.now() - 46 * 60 * 1000);
  fs.utimesSync(rig.lock, old, old);
  assert.strictEqual(stateOf(rig).lock, 'no'); // deploy.sh would take a stale lock over
  // A lock that exists but cannot be stat'ed reads yes, as pi_deploy_lock treats it.
  fs.writeFileSync(path.join(rig.dir, 'bin', 'stat'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  assert.strictEqual(stateOf(rig).lock, 'yes');
  fs.rmSync(path.join(rig.dir, 'bin', 'stat'));
  fs.writeFileSync(path.join(rig.dir, 'hookout'), 'yes\n');
  assert.strictEqual(stateOf(rig).hook_deploying, 'yes');
  fs.writeFileSync(path.join(rig.dir, 'hookout'), 'garbage');
  assert.strictEqual(stateOf(rig).hook_deploying, 'unknown');
  rig.cleanup();
});

test('pi_state_settled: each condition, with ignore_hook unset and set', () => {
  const sha = 'a'.repeat(40);
  const other = 'b'.repeat(40);
  const state = (o = {}) => {
    const v = { head: sha, deployed: sha, health: '200', lock: 'no', hook_deploying: 'no', ...o };
    return Object.entries(v).map(([k, x]) => `${k}=${x}`).join('\n');
  };
  const settled = (st, target = sha, ignore = '') => {
    const r = runWithLib(`state=$(cat <<'EOS'\n${st}\nEOS\n)\nif pi_state_settled "$state" ${JSON.stringify(target)} ${JSON.stringify(ignore)}; then echo SETTLED; else echo NOT; fi`);
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim() === 'SETTLED';
  };
  assert.strictEqual(settled(state()), true);
  assert.strictEqual(settled(state({ hook_deploying: 'unknown' })), true);
  assert.strictEqual(settled(state({ head: other })), false, 'head is not the target');
  assert.strictEqual(settled(state(), ''), false, 'no target');
  assert.strictEqual(settled(state({ deployed: '' })), false, 'no marker');
  assert.strictEqual(settled(state({ deployed: other })), false, 'marker names another commit');
  assert.strictEqual(settled(state({ health: '502' })), false);
  assert.strictEqual(settled(state({ health: '' })), false);
  // The hook check: with ignore_hook unset yes is not settled; inside the hook it is ignored.
  assert.strictEqual(settled(state({ hook_deploying: 'yes' })), false);
  assert.strictEqual(settled(state({ hook_deploying: 'yes' }), sha, '1'), true);
  // The lock is not part of the shell definition: deploy.sh holds it by then.
  assert.strictEqual(settled(state({ lock: 'yes' })), true);
});

// --- Deploys give compose the images they pulled (SOMET-719) -------------------
//
// Seen on the real board: over ssh the command was `A=x B=y cd /app && docker
// compose ...`, so the variables reached `cd` alone and compose ran the stale
// `:local` image. Only PI_LOCAL, which inherits exports, happened to work. The
// stub ssh here REALLY executes the remote command in a shell (as sshd does),
// and the stub docker logs the image value it was handed, so the test sees what
// compose would have seen.

function imageRig({ pull = true, failOn, ssh = true } = {}) {
  const rig = deployRig({ failOn });
  const bin = path.join(rig.dir, 'bin');
  const write = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  };
  write('docker', `echo "docker $* | backend=\${ORANGEPI_BACKEND_IMAGE-UNSET} frontend=\${ORANGEPI_FRONTEND_IMAGE-UNSET}" >> "${rig.dir}/docker.log"
[ -f "${rig.dir}/failon" ] && grep -qE "$(cat "${rig.dir}/failon")" <<<"$*" && { echo "stub failure" >&2; exit 1; }
case "$*" in
  "exec something2-orangepi-deploy-hook-1 "*) exit 1 ;;
  *" up "*) printf 200 > "${rig.dir}/curlcode" ;;
  "pull "*) ${pull ? 'exit 0' : 'exit 1'} ;;
esac
exit 0`);
  // Runs the remote command string in a login-less shell: ssh [-o v | -i v | -x]... host cmd
  write('ssh', `while [ $# -gt 0 ]; do case "$1" in -o|-i) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift
# sshd does not hand the client's environment to the command, and that is the whole bug.
exec env -u ORANGEPI_BACKEND_IMAGE -u ORANGEPI_FRONTEND_IMAGE bash -c "$*"`);
  const deploy = (env = {}) =>
    rig.deploy(ssh ? { PI_LOCAL: '', ORANGEPI_ADDRESS: 'board.invalid', ORANGEPI_LOGIN: 'pi', ...env } : env);
  const images = path.join(rig.data, 'locks', 'deployed-images.env');
  return { ...rig, deploy, images };
}

const GHCR_BACKEND = /backend=ghcr\.io\/o\/r-backend:[0-9a-f]{40}/;

function composeLines(log, re) {
  return log.split('\n').filter((l) => re.test(l));
}

test('an ssh deploy gives compose the pulled image', () => {
  const rig = imageRig();
  const r = rig.deploy();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const log = rig.read('docker.log');
  const wanted = composeLines(log, /^docker .*(\brun\b|\bup\b|\bstop\b)/).filter((l) => !/^docker pull/.test(l));
  assert.ok(wanted.filter((l) => / run /.test(l)).length >= 3, 'migrate and both seeds ran: ' + log);
  assert.ok(wanted.filter((l) => / up /.test(l)).length >= 1, 'up ran: ' + log);
  for (const line of wanted) assert.match(line, GHCR_BACKEND, `compose got the pulled image: ${line}`);
  assert.match(log, /frontend=ghcr\.io\/o\/r-caddy:/);
  assert.doesNotMatch(composeLines(log, /^docker compose/).join('\n'), /backend=UNSET/);
  rig.cleanup();
});

test('a hook deploy gives compose the pulled image', () => {
  const rig = imageRig({ ssh: false });
  const r = rig.deploy({ PI_LOCAL: '1' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const wanted = composeLines(rig.read('docker.log'), /^docker .*( run | up | stop )/);
  assert.ok(wanted.length >= 5);
  for (const line of wanted) assert.match(line, GHCR_BACKEND, line);
  rig.cleanup();
});

test('a finished deploy records its images', () => {
  const rig = imageRig();
  const r = rig.deploy();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const sha = rig.appHead();
  assert.strictEqual(
    fs.readFileSync(rig.images, 'utf8'),
    `ORANGEPI_BACKEND_IMAGE=ghcr.io/o/r-backend:${sha}\nORANGEPI_FRONTEND_IMAGE=ghcr.io/o/r-caddy:${sha}\n`
  );
  assert.deepStrictEqual(fs.readdirSync(path.dirname(rig.images)).filter((f) => f.includes('.tmp.')), []);
  rig.cleanup();
});

test('a board build records none and removes an old record', () => {
  const rig = imageRig({ pull: false });
  fs.writeFileSync(rig.images, 'ORANGEPI_BACKEND_IMAGE=old\nORANGEPI_FRONTEND_IMAGE=old\n');
  const r = rig.deploy();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(rig.images));
  const log = rig.read('docker.log');
  assert.match(log, /build/);
  // Nothing exported: compose keeps its own default for a board build.
  assert.doesNotMatch(composeLines(log, /^docker .* run /).join('\n'), /ghcr|backend=old/);
  rig.cleanup();
});

test('a failed step records none', () => {
  const rig = imageRig({ failOn: ' run .*seed-passive-tree' });
  const r = rig.deploy();
  assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(rig.images));
  assert.strictEqual(rig.readMarker(), null);
  rig.cleanup();
});

test('pi_compose_cmd adds the images file only when it exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cc-'));
  const data = path.join(dir, 'data dir');
  fs.mkdirSync(path.join(data, 'locks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'));
  // Emulates compose's documented precedence: shell env beats --env-file, later file beats earlier.
  fs.writeFileSync(
    path.join(dir, 'bin', 'docker'),
    `#!/usr/bin/env bash
v="\${ORANGEPI_BACKEND_IMAGE-}"
files=()
while [ $# -gt 0 ]; do [ "$1" = --env-file ] && files+=("$2"); shift; done
if [ -z "$v" ]; then for f in "\${files[@]}"; do l=$(grep '^ORANGEPI_BACKEND_IMAGE=' "$f" | tail -1); [ -n "$l" ] && v="\${l#*=}"; done; fi
echo "files=\${#files[@]} image=\${v:-LOCAL}" >> "${dir}/log"
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(data, '.env'), 'X=1\n');
  // The string is built once and run twice, like a long-lived caller would.
  const script = `COMPOSE="$(pi_compose_cmd)"; bash -c "$COMPOSE up -d"`;
  const run = (extra = '') =>
    runWithLib(`export PATH=${JSON.stringify(path.join(dir, 'bin'))}:$PATH\n${extra}\n${script}`, {
      env: { ORANGEPI_APP_DIR: dir, ORANGEPI_DATA_DIR: data },
    });
  const last = () => fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n').slice(-1);
  let r = run();
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(last(), ['files=1 image=LOCAL']);
  fs.writeFileSync(path.join(data, 'locks', 'deployed-images.env'), 'ORANGEPI_BACKEND_IMAGE=ghcr.io/o/r-backend:abc\n');
  // A later `compose up` with no exports: the file, passed as a second --env-file, is the only carrier.
  // (the data dir path holds a space, so this also proves it stays one argument)
  r = run();
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(last(), ['files=2 image=ghcr.io/o/r-backend:abc']);
  // A deploy's own export beats the recorded file.
  r = run('export ORANGEPI_BACKEND_IMAGE=ghcr.io/o/r-backend:new');
  assert.deepStrictEqual(last(), ['files=2 image=ghcr.io/o/r-backend:new']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// SOMET-719. The deploy hook runs as root, so its `git fetch` leaves root-owned
// files in /app/.git and the login user's next deploy dies unpacking objects.
// fetch_and_reset is lifted out of deploy.sh and run for real (PI_LOCAL, a real
// temp clone). A real root-owned file is not possible in a test, so `find`,
// `sudo`, `id` and `chown` are PATH stubs that record what they were asked.
function fetchResetHarness({ fakeUid = '1000', unwritable = false, sudoMode = 'nopasswd', pw = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-fetch-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  git(dir, 'init', '-q', '--bare', '-b', 'orangepi', origin);
  git(dir, 'clone', '-q', origin, seed);
  git(seed, 'config', 'user.email', 't@t');
  git(seed, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(seed, 'a'), '1');
  git(seed, 'add', 'a');
  git(seed, 'commit', '-q', '-m', 'one');
  git(seed, 'push', '-q', 'origin', 'HEAD:orangepi');
  const app = path.join(dir, 'app');
  git(dir, 'clone', '-q', '-b', 'orangepi', origin, app);
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'calls.log');
  fs.mkdirSync(bin);
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub('find', `if [ "$1" = .git ]; then [ -n "${unwritable ? 1 : ''}" ] && echo .git/objects/aa; exit 0; fi\nexec /usr/bin/find "$@"`);
  stub('id', `if [ "$1" = -u ]; then echo ${fakeUid}; else exec /usr/bin/id "$@"; fi`);
  stub('chown', `echo "chown $*" >> ${log}`);
  stub('sudo', [
    'if [ "$1" = -n ]; then',
    sudoMode === 'nopasswd' ? '  exit 0' : '  exit 1',
    'fi',
    `echo "sudo $*" >> ${log}`,
    sudoMode === 'none' ? 'exit 1' : '[ "$1" = -S ] && cat >/dev/null; exit 0',
  ].join('\n'));
  const src = fs.readFileSync(path.join(SCRIPTS, 'deploy.sh'), 'utf8');
  const fn = src.slice(src.indexOf('fetch_and_reset() {'), src.indexOf('run_step "fetch and reset'));
  const script = `set -euo pipefail\n. ${JSON.stringify(toPosix(LIB))}\n${fn}\nfetch_and_reset\n`;
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PI_LOCAL: '1',
      REPO_ROOT: dir,
      APP: app,
      ORANGEPI_BRANCH: 'orangepi',
      ORANGEPI_LOGIN: 'pi',
      ORANGEPI_PASSWORD: pw,
    },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { result, calls, output: result.stdout + result.stderr, app };
}

test('a root-owned checkout is repaired before fetching', () => {
  const r = fetchResetHarness({ unwritable: true, sudoMode: 'nopasswd' });
  assert.strictEqual(r.result.status, 0, r.output);
  assert.match(r.calls, /^sudo chown -R \d+:\d+ \S+app$/m, r.calls);
  assert.match(r.output, /repairing ownership/);
  assert.match(r.output, /now at /, 'the fetch and reset still ran');
  assert.doesNotMatch(r.calls, /^chown/m, 'a non-root deploy does not chown on its own');
});

test('a writable checkout is left alone', () => {
  const r = fetchResetHarness({ unwritable: false });
  assert.strictEqual(r.result.status, 0, r.output);
  assert.strictEqual(r.calls, '');
});

test('when it cannot be repaired the sentence says what to run', () => {
  const r = fetchResetHarness({ unwritable: true, sudoMode: 'none', pw: '' });
  assert.notStrictEqual(r.result.status, 0);
  assert.match(r.output, /has files this user cannot write, and sudo is not available: run chown -R pi \S+app on the board\./);
  assert.doesNotMatch(r.output, /now at /, 'it stops before fetching');
});

test('a root deploy hands the checkout back to its owner', () => {
  const r = fetchResetHarness({ fakeUid: '0', unwritable: true });
  assert.strictEqual(r.result.status, 0, r.output);
  assert.match(r.calls, /^chown -R \d+:\d+ \S+app$/m, r.calls);
  assert.doesNotMatch(r.calls, /sudo/, 'root repairs nothing through sudo');
});

test('the password never appears in output', () => {
  const pw = 'hunter2-s3cret';
  const r = fetchResetHarness({ unwritable: true, sudoMode: 'password', pw });
  assert.strictEqual(r.result.status, 0, r.output);
  assert.match(r.calls, /sudo -S -p  ?chown -R/, 'the password path was really taken');
  assert.doesNotMatch(r.output, new RegExp(pw));
  assert.doesNotMatch(r.calls, new RegExp(pw));
  const failing = fetchResetHarness({ unwritable: true, sudoMode: 'none', pw });
  assert.doesNotMatch(failing.output, new RegExp(pw));
});

// --- Object storage on the board (SOMET-722) ----------------------------------
//
// The board's .env needs a random MINIO_ROOT_PASSWORD before minio can start.
// A board provisioned long ago has none, so the deploy adds it -- once, before
// compose starts anything, atomically, and never printed.

const MINIO_KEY = /^MINIO_ROOT_PASSWORD=([0-9a-f]{32,})$/m;

// Logs, before every docker call, whether the board's .env already had the key.
function watchKeyAtDockerCalls(rig) {
  const bin = path.join(rig.dir, 'bin');
  fs.renameSync(path.join(bin, 'docker'), path.join(bin, 'docker.real'));
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
echo "key=$(grep -c '^MINIO_ROOT_PASSWORD=.' "${rig.data}/.env")" >> "${rig.dir}/keystate.log"
exec "${bin}/docker.real" "$@"
`, { mode: 0o755 });
  return () => fs.readFileSync(path.join(rig.dir, 'keystate.log'), 'utf8').split('\n').filter(Boolean);
}

test('an ssh deploy adds a random MINIO_ROOT_PASSWORD to a board that lacks one, before compose runs', () => {
  const rig = imageRig();
  const envPath = path.join(rig.data, '.env');
  fs.writeFileSync(envPath, 'POSTGRES_PASSWORD=pw\nJWT_SECRET=jj\n');
  fs.chmodSync(envPath, 0o600);
  const states = watchKeyAtDockerCalls(rig);
  const r = rig.deploy();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const text = fs.readFileSync(envPath, 'utf8');
  const m = MINIO_KEY.exec(text);
  assert.ok(m, text);
  assert.ok(text.startsWith('POSTGRES_PASSWORD=pw\nJWT_SECRET=jj\n'), 'the other keys are kept');
  assert.strictEqual(fs.statSync(envPath).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(rig.data).filter((f) => f.includes('.tmp')), []);
  const seen = states();
  assert.ok(seen.length > 0 && seen.every((s) => s === 'key=1'), `compose ran with the key present: ${seen.join(',')}`);
  // Never printed, never on an argv.
  for (const where of [r.stdout, r.stderr, rig.read('docker.log'), rig.read('curl.log')]) assert.ok(!where.includes(m[1]));
  rig.cleanup();
});

test('two boards get different MINIO_ROOT_PASSWORD values', () => {
  const values = [];
  for (let i = 0; i < 2; i += 1) {
    const rig = imageRig();
    fs.writeFileSync(path.join(rig.data, '.env'), 'POSTGRES_PASSWORD=pw\n');
    assert.strictEqual(rig.deploy().status, 0);
    values.push(MINIO_KEY.exec(fs.readFileSync(path.join(rig.data, '.env'), 'utf8'))[1]);
    rig.cleanup();
  }
  assert.notStrictEqual(values[0], values[1]);
});

test('an existing MINIO_ROOT_PASSWORD is never changed or rewritten', () => {
  const rig = imageRig();
  const envPath = path.join(rig.data, '.env');
  fs.writeFileSync(envPath, 'POSTGRES_PASSWORD=pw\nMINIO_ROOT_PASSWORD=keep-this-one\n');
  const before = fs.statSync(envPath);
  assert.strictEqual(rig.deploy().status, 0);
  assert.strictEqual(fs.readFileSync(envPath, 'utf8'), 'POSTGRES_PASSWORD=pw\nMINIO_ROOT_PASSWORD=keep-this-one\n');
  assert.strictEqual(fs.statSync(envPath).ino, before.ino, 'the file was not replaced');
  rig.cleanup();
});

test('an empty MINIO_ROOT_PASSWORD= line counts as missing and is replaced once', () => {
  const rig = imageRig();
  const envPath = path.join(rig.data, '.env');
  fs.writeFileSync(envPath, 'MINIO_ROOT_PASSWORD=\nPOSTGRES_PASSWORD=pw\n');
  assert.strictEqual(rig.deploy().status, 0);
  const text = fs.readFileSync(envPath, 'utf8');
  assert.match(text, MINIO_KEY);
  assert.strictEqual((text.match(/^MINIO_ROOT_PASSWORD=/gm) || []).length, 1);
  rig.cleanup();
});

test('a failed .env rewrite aborts the deploy before anything is touched', () => {
  const rig = imageRig();
  const envPath = path.join(rig.data, '.env');
  const before = 'POSTGRES_PASSWORD=pw\n';
  fs.writeFileSync(envPath, before);
  fs.writeFileSync(path.join(rig.dir, 'bin', 'grep'), '#!/usr/bin/env bash\nexit 2\n', { mode: 0o755 });
  const r = rig.deploy();
  assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /MINIO_ROOT_PASSWORD/);
  assert.strictEqual(fs.readFileSync(envPath, 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(rig.data).filter((f) => f.includes('.tmp')), []);
  assert.doesNotMatch(rig.read('docker.log'), /\b(stop|up|run)\b/);
  assert.ok(!fs.existsSync(rig.lock), 'the lock is released');
  rig.cleanup();
});

test('a hook deploy (PI_LOCAL) with the key present skips quietly even though the data dir is read-only', (t) => {
  if (process.getuid && process.getuid() === 0) { t.skip('root ignores directory modes'); return; }
  const rig = deployRig({ atTarget: false });
  const envPath = path.join(rig.data, '.env');
  fs.writeFileSync(envPath, 'POSTGRES_PASSWORD=pw\nMINIO_ROOT_PASSWORD=already\n');
  fs.chmodSync(envPath, 0o444);
  fs.chmodSync(rig.data, 0o555); // the hook mounts the data dir read-only; locks/ stays writable
  try {
    const r = rig.deploy();
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /MINIO_ROOT_PASSWORD/);
  } finally { fs.chmodSync(rig.data, 0o755); }
  rig.cleanup();
});

test('a hook deploy (PI_LOCAL) without the key fails plainly and changes nothing', () => {
  const rig = deployRig({ atTarget: false });
  const envPath = path.join(rig.data, '.env');
  fs.writeFileSync(envPath, 'POSTGRES_PASSWORD=pw\n');
  const marker = rig.readMarker();
  const r = rig.deploy();
  assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /MINIO_ROOT_PASSWORD is not in the board's \.env/);
  assert.match(r.stderr, /make pi-deploy/);
  assert.doesNotMatch(fs.readFileSync(envPath, 'utf8'), /MINIO_ROOT_PASSWORD/);
  assert.doesNotMatch(rig.read('docker.log'), /\b(stop|up|run)\b/);
  assert.strictEqual(rig.readMarker(), marker, 'the settled marker is untouched');
  assert.ok(!fs.existsSync(rig.lock));
  rig.cleanup();
});

test('a deploy starts minio with the stack, without recreating it, and never stops it', () => {
  const rig = imageRig();
  fs.appendFileSync(path.join(rig.data, '.env'), 'MINIO_ROOT_PASSWORD=x\n');
  assert.strictEqual(rig.deploy().status, 0);
  const log = rig.read('docker.log');
  assert.match(log, /up -d --no-deps --no-recreate minio\b/);
  for (const line of composeLines(log, /^docker .* (stop|restart|rm|down) /)) assert.doesNotMatch(line, /minio/, line);
  assert.match(composeLines(log, /--no-recreate minio/)[0], /backend=ghcr/, 'compose got the pulled images');
  rig.cleanup();
});

test('a minio that cannot start is reported but does not stop the game from deploying', () => {
  const rig = deployRig({ failOn: 'recreate minio' });
  const r = rig.deploy();
  assert.match(rig.read('docker.log'), /up -d --no-deps db backend caddy/);
  assert.match(r.stdout + r.stderr, /object storage/);
  assert.notStrictEqual(r.status, 0, 'a failed step still fails the deploy');
  assert.strictEqual(rig.readMarker() === rig.appHead(), false, 'and does not mark the board settled');
  rig.cleanup();
});

test('provisioning generates MINIO_ROOT_PASSWORD with the other secrets', () => {
  const text = fs.readFileSync(path.join(SCRIPTS, 'provision.sh'), 'utf8');
  assert.match(text, /^ensure_key MINIO_ROOT_PASSWORD "\$\(openssl rand -hex 24\)"$/m);
});

test('the .env rewrite is one shared helper, not a copy in tunnel.sh', () => {
  const lib = fs.readFileSync(LIB, 'utf8');
  const tunnel = fs.readFileSync(path.join(SCRIPTS, 'tunnel.sh'), 'utf8');
  const deploy = fs.readFileSync(path.join(SCRIPTS, 'deploy.sh'), 'utf8');
  assert.match(lib, /^pi_env_write_key\(\) \{/m);
  assert.match(tunnel, /pi_env_write_key NGROK_AUTHTOKEN replace/);
  assert.match(deploy, /pi_env_write_key MINIO_ROOT_PASSWORD ensure-random/);
  assert.doesNotMatch(tunnel, /mv -f/, 'tunnel.sh no longer carries its own atomic rewrite');
});
