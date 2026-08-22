const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// SOMET-424. The remote-operation scripts (compose/orangepi/scripts/*.sh) are
// driven entirely by .env, and .env is gitignored -- so .env.example is the
// only place an operator can learn which variables exist. A variable a script
// reads but nobody documented fails at the worst possible moment: partway
// through provisioning a board, with the previous steps already applied.
//
// These assertions are about the CONTRACT, never about values. The one value
// rule enforced here is the inverse: the committed example must not carry a
// usable credential, because this repository is public.

const ROOT = path.join(__dirname, '..', '..');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const GITIGNORE = path.join(ROOT, '.gitignore');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

// Returns the assigned value for `name`, or undefined when the variable is
// not documented at all. Deliberately distinguishes "absent" from "documented
// as empty": an empty DEPLOY_HOOK_SECRET is correct, an absent one is a bug.
function documented(text, name) {
  const match = new RegExp(`^${name}=(.*)$`, 'm').exec(text);
  return match ? match[1] : undefined;
}

// Every variable the workstation scripts read. Spec:
// docs/superpowers/specs/2026-08-17-orangepi-staging-design.md, "Configuration".
const REMOTE_OPS_VARS = [
  'ORANGEPI_ADDRESS',
  'ORANGEPI_LOGIN',
  'ORANGEPI_PASSWORD',
  'ORANGEPI_SSH_KEY',
  'ORANGEPI_APP_DIR',
  'ORANGEPI_DATA_DIR',
  'ORANGEPI_BRANCH',
  'GIT_REPOSITORY',
  'DEPLOY_HOOK_SECRET',
];

test('.env.example documents every remote-operation variable', () => {
  const text = read(ENV_EXAMPLE);
  for (const name of REMOTE_OPS_VARS) {
    assert.notStrictEqual(
      documented(text, name),
      undefined,
      `${name} is read by the pi-* scripts but is not documented in .env.example`
    );
  }
});

test('.env.example ships no usable credential for the board', () => {
  const text = read(ENV_EXAMPLE);
  // Both are secrets on a public repository. Empty is the only safe committed
  // value: ORANGEPI_PASSWORD is meant to be blanked after bootstrap anyway,
  // and an example DEPLOY_HOOK_SECRET would be a working signing key for
  // anyone who deployed without changing it.
  assert.strictEqual(documented(text, 'ORANGEPI_PASSWORD'), '');
  assert.strictEqual(documented(text, 'DEPLOY_HOOK_SECRET'), '');
});

test('the documented clone url carries no embedded credential', () => {
  const url = documented(read(ENV_EXAMPLE), 'GIT_REPOSITORY');
  assert.match(url, /^https:\/\//, 'the board clones anonymously over https');
  // https://user:token@github.com/... is the shape that leaks a credential
  // into the board's git config, which is exactly what cloning a PUBLIC
  // repository anonymously avoids. Documenting that shape would teach it.
  assert.doesNotMatch(url, /^https:\/\/[^/@]*@/, 'no credential in the clone url');
});

test('generated key material is gitignored', () => {
  const ignore = read(GITIGNORE);
  assert.match(
    ignore,
    /^compose\/orangepi\/secrets\/$/m,
    'compose/orangepi/secrets/ holds the generated workstation key and must never be committed'
  );
});

test('the workstation key defaults outside any tracked path', () => {
  const keyPath = documented(read(ENV_EXAMPLE), 'ORANGEPI_SSH_KEY');
  const ignore = read(GITIGNORE);
  // The default may sit inside the repository only if the directory holding
  // it is ignored. Anything else defaults a PRIVATE KEY into a public repo.
  const insideRepo = !keyPath.startsWith('/') && !keyPath.startsWith('~');
  if (insideRepo) {
    const dir = path.posix.dirname(keyPath);
    assert.match(
      ignore,
      new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/$`, 'm'),
      `${keyPath} is inside the repository, so ${dir}/ must be gitignored`
    );
  }
});
