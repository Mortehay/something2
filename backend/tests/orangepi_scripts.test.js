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

// Runs a snippet with lib.sh sourced, in a scratch REPO_ROOT holding a
// controlled .env -- never the developer's real one, whose values would make
// these results depend on whose machine they ran on.
function runWithLib(snippet, { env = {}, envFile = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lib-'));
  fs.writeFileSync(path.join(root, '.env'), envFile);
  const script = `set -euo pipefail\nREPO_ROOT=${JSON.stringify(root)}\n. ${JSON.stringify(LIB)}\n${snippet}\n`;
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
  for (const [, name, body] of targets) {
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
