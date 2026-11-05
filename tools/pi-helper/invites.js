'use strict';
// Invite codes from the tab (SOMET-734). REGISTRATION_MODE defaults to `invite` on the board, so testers need
// codes. backend/scripts/invite-codes.js stays a CLI on purpose (no public HTTP surface for it): the helper runs
// it through remote.sh with FIXED arguments only. A value from a request is validated here, then handed over as
// its own argv entry; remote.sh quotes each with printf %q, so a note is data and never shell syntax.
const { BadRequest } = require('../helper-core/helperServer');
const { BoardOffline } = require('./boardJobs');

// Same alphabet and shape as mintCode() in backend/scripts/invite-codes.js (a test compares them). Repeated
// here because the host has no backend dependencies guaranteed (invite-codes.js loads pg).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp(`^[${ALPHABET}]{4}-[${ALPHABET}]{4}-[${ALPHABET}]{4}$`);
const NOTE_MAX = 80;
// Letters, digits, space and . , _ @ : ( ) - only. No quote, $, backtick, ;, backslash or | : a note is a label, and
// the narrower it is the less depends on how the board's shell reads the quoted argument.
const NOTE_RE = /^[\p{L}\p{N} .,_@:()\-]+$/u;
const NOTE_MESSAGE = `note can have at most ${NOTE_MAX} characters: letters, digits, spaces and . , _ @ : ( ) - . No quotes, $, backticks, ; \\ or |.`;
const COUNT_MAX = 20;
const LIST_MAX = 200;
const INVITES_MS = 60_000;
const SCRIPT = ['backend', 'node', 'scripts/invite-codes.js'];
const OLDER = { needsUpdate: true, invites: [], total: 0 };

class InviteFailed extends Error {}

const tail = (text) => String(text || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ');
const unreachable = (r) => r.timedOut || r.code === 255 || r.code === 78 || r.code === 127;

// The one JSON line the script printed with --json, or null (an older image prints text).
function jsonLine(stdout) {
  const line = String(stdout).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
  if (!line) return null;
  try { const v = JSON.parse(line); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

async function run(runner, args) {
  const r = await runner.script('remote.sh', [...SCRIPT, ...args], { timeoutMs: INVITES_MS });
  if (unreachable(r)) throw new BoardOffline('The board could not be reached to handle invite codes.');
  return r;
}

const failed = (what, r) => new InviteFailed(`${what} (exit ${r.code}): ${tail(r.output)}`);

async function listInvites(runner) {
  const r = await run(runner, ['list', '--all', '--json']);
  const out = jsonLine(r.stdout);
  if (r.code === 0 && out && Array.isArray(out.invites)) {
    return { needsUpdate: false, invites: out.invites.slice(0, LIST_MAX), total: out.invites.length };
  }
  // exit 0 without JSON: a board image from before --json. It still answers, in text.
  if (r.code === 0) return { ...OLDER };
  throw failed('Reading the invite codes failed', r);
}

function validateMint(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Number.isInteger(b.count) || b.count < 1 || b.count > COUNT_MAX) throw new BadRequest(`count must be a whole number from 1 to ${COUNT_MAX}.`);
  let note = '';
  if (b.note !== undefined && b.note !== null) {
    const trimmed = typeof b.note === 'string' ? b.note.trim() : null;
    if (trimmed === null || (trimmed !== '' && (!NOTE_RE.test(trimmed) || [...trimmed].length > NOTE_MAX))) throw new BadRequest(NOTE_MESSAGE);
    note = b.note.trim();
  }
  return { count: b.count, note };
}

async function mintInvites(runner, body) {
  const { count, note } = validateMint(body);
  const r = await run(runner, ['mint', String(count), '--json', ...(note ? ['--note', note] : [])]);
  const out = jsonLine(r.stdout);
  if (r.code !== 0) {
    // The script may have made some codes before it failed: hand back what it printed, else say they may exist.
    const printed = [...(out && Array.isArray(out.codes) ? out.codes : []), ...String(r.stdout).split('\n').map((l) => l.trim())].filter((c) => typeof c === 'string' && CODE_RE.test(c));
    if (printed.length) return { codes: [...new Set(printed)], requested: count, partial: true };
    throw new InviteFailed(`${failed('Making the invite codes failed', r).message}. Some codes may exist: refresh the list.`);
  }
  let codes;
  if (out && Array.isArray(out.codes)) codes = out.codes.filter((c) => typeof c === 'string' && CODE_RE.test(c));
  else {
    // An older image ignores --json and has already minted: keep the codes it printed.
    const lines = String(r.stdout).split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !lines.every((l) => CODE_RE.test(l))) throw new InviteFailed(`The board answered unexpectedly: ${tail(r.output)}`);
    codes = lines;
  }
  return { codes, requested: count, partial: codes.length < count };
}

async function revokeInvite(runner, body) {
  const code = body && typeof body === 'object' ? body.code : undefined;
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw new BadRequest('code is not an invite code.');
  const r = await run(runner, ['revoke', code, '--json']);
  if (r.code !== 0) throw failed('Revoking the invite code failed', r);
  const out = jsonLine(r.stdout);
  if (out && 'revoked' in out) return { revoked: typeof out.revoked === 'string' ? out.revoked : null };
  if (/^(no such code|nothing revoked)/m.test(r.stdout)) return { revoked: null };
  const m = String(r.stdout).match(/^revoked (\S+)/m);
  if (m && CODE_RE.test(m[1])) return { revoked: m[1] };
  throw new InviteFailed(`The board answered unexpectedly: ${tail(r.output)}`);
}

module.exports = { listInvites, mintInvites, revokeInvite, InviteFailed, CODE_RE, NOTE_MAX, COUNT_MAX };
