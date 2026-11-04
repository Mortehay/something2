'use strict';
// The two branches the Update flow works with, read from the runner's env (which
// merges .env) fresh on every call. `main` is never built: the build branch is, and
// the source branch is what gets merged into it.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const DEFAULT_BUILD = 'orangepi';
const DEFAULT_SOURCE = 'main';

// { source, build } or { error } with a sentence. Blank values mean "use the default".
function resolveBranches(env) {
  const e = env || {};
  const pick = (v, d) => (v === undefined || String(v).trim() === '' ? d : String(v).trim());
  const build = pick(e.ORANGEPI_BRANCH, DEFAULT_BUILD);
  const source = pick(e.ORANGEPI_SOURCE_BRANCH, DEFAULT_SOURCE);
  if (!NAME_RE.test(build) || build.includes('..')) {
    return { error: `ORANGEPI_BRANCH "${build}" is not a valid branch name (letters, digits, . _ / - only, starting with a letter or digit). Nothing was changed.` };
  }
  if (!NAME_RE.test(source) || source.includes('..')) {
    return { error: `ORANGEPI_SOURCE_BRANCH "${source}" is not a valid branch name (letters, digits, . _ / - only, starting with a letter or digit). Nothing was changed.` };
  }
  if (build === source) {
    return { error: `ORANGEPI_BRANCH and ORANGEPI_SOURCE_BRANCH are both "${build}". The source branch is merged into the build branch, so they must differ. Nothing was changed.` };
  }
  return { source, build };
}

module.exports = { resolveBranches, DEFAULT_BUILD, DEFAULT_SOURCE };
