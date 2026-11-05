// SOMET-734. Pure rules for the Invite codes box of the Orange Pi tab: the same limits the helper enforces
// (it validates again), the status words, and the copy. No React, no fetching.

export const INVITE_COUNT_MAX = 20;
export const INVITE_NOTE_MAX = 80;
// Control characters and line separators (a string, not a literal: U+2028 inside a regex literal ends the line).
const NOT_PRINTABLE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

export const INVITES_HELP = 'The board lets people register only with a code. Testers type the code into the "Invite code" field of the sign-up form (Need an account? Register).';
export const INVITES_UPDATE_TEXT = 'The board is on an older version and cannot list its invite codes. Press Update, then this list fills in. Making and revoking codes still work.';

// { ok: true, count, note } | { ok: false, message }. The count box is a text field, so it arrives as a string.
export function inviteDraft({ count, note }) {
  const text = String(count ?? '').trim();
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > INVITE_COUNT_MAX) {
    return { ok: false, message: `Choose how many codes to make, from 1 to ${INVITE_COUNT_MAX}.` };
  }
  const n = String(note ?? '').trim();
  if ([...n].length > INVITE_NOTE_MAX || NOT_PRINTABLE.test(n)) {
    return { ok: false, message: `The note can have at most ${INVITE_NOTE_MAX} printable characters.` };
  }
  return { ok: true, count: Number(text), note: n };
}

export const INVITE_STATUS = {
  unused: { label: 'Unused', tone: 'ok' },
  used: { label: 'Used', tone: 'info' },
  revoked: { label: 'Revoked', tone: 'warn' },
};
export const inviteStatus = (s) => INVITE_STATUS[s?.status] || INVITE_STATUS.used;

// A code can be copied or revoked only while nobody has spent it.
export const canRevoke = (invite) => invite?.status === 'unused';

export function madeText(result) {
  if (!result) return null;
  const n = result.codes?.length || 0;
  if (result.partial) return `Made ${n} of ${result.requested} codes. The rest could not be made.`;
  return n === 1 ? 'Made 1 code.' : `Made ${n} codes.`;
}

export function listSummary(data) {
  if (!data || data.needsUpdate) return null;
  const shown = data.invites?.length || 0;
  const unused = (data.invites || []).filter((i) => i.status === 'unused').length;
  if (!shown) return 'No invite codes yet.';
  const more = data.total > shown ? ` Showing the newest ${shown} of ${data.total}.` : '';
  return `${unused} unused of ${data.total}.${more}`;
}
