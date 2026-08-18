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
