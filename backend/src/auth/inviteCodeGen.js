const crypto = require('crypto');

// 12 bytes of crypto randomness, base32-ish. Long enough that guessing is
// hopeless against the auth rate limiter (10 attempts per 15 min), short
// enough to read down a phone line. Ambiguous characters are excluded so a
// code can be dictated without spelling it out.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
function mintCode() {
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

module.exports = { ALPHABET, mintCode };
