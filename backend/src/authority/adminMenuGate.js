// The code that turns on the in-game admin menu (spawn a boss, grant gold / levels / items).
//
// When ADMIN_MENU_CODE is set, ANY account that enters it in Settings gets the menu, for
// UNLOCK_MS. That is all it gives: it does not make the account an admin (users.role, the
// token and every REST admin route are untouched), only the debug socket handlers answer it. The
// code is therefore a shared secret for whoever tests the game: keep it out of production .env
// files, and use a long one. With ADMIN_MENU_CODE unset nobody can enter anything: the menu is
// for role-admin accounts only, as before.
//
// Unlocked state is per ACCOUNT, in memory, for UNLOCK_MS: it survives a reconnect or a world
// change but not a server restart, and the code itself is never kept anywhere on the client.
// Wrong codes are counted per account (MAX_FAILS in a row locks the account's attempts for
// LOCK_MS). The comparison is timing-safe, over fixed-length digests.
const crypto = require('node:crypto');

const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;
const UNLOCK_MS = 12 * 60 * 60 * 1000;
const MAX_CODE_LEN = 200;
const MIN_RECOMMENDED_LEN = 8;

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

function createAdminMenuGate({ code = process.env.ADMIN_MENU_CODE, now = Date.now, warn = console.warn } = {}) {
  const secret = typeof code === 'string' && code.length > 0 ? digest(code) : null;
  if (secret && code.length < MIN_RECOMMENDED_LEN) {
    warn(`[admin] ADMIN_MENU_CODE is shorter than ${MIN_RECOMMENDED_LEN} characters: pick a longer one`);
  }
  const unlocked = new Map(); // account id -> expiry (ms)
  const fails = new Map();    // account id -> { n, lockedUntil }

  return {
    get required() { return secret !== null; },

    isUnlocked(userId) {
      if (!secret) return true;
      const key = String(userId);
      const until = unlocked.get(key);
      if (!until) return false;
      if (until <= now()) { unlocked.delete(key); return false; }
      return true;
    },

    // { ok } | { ok: false, error, retryMs? }. Never says which part was wrong beyond "wrong code".
    unlock(userId, attempt) {
      if (!secret) return { ok: true };
      const key = String(userId);
      const f = fails.get(key) || { n: 0, lockedUntil: 0 };
      if (f.lockedUntil > now()) return { ok: false, error: 'too many attempts', retryMs: f.lockedUntil - now() };
      const text = typeof attempt === 'string' ? attempt.slice(0, MAX_CODE_LEN) : '';
      if (text && crypto.timingSafeEqual(digest(text), secret)) {
        fails.delete(key);
        unlocked.set(key, now() + UNLOCK_MS);
        return { ok: true };
      }
      f.n += 1;
      if (f.n >= MAX_FAILS) { f.n = 0; f.lockedUntil = now() + LOCK_MS; }
      fails.set(key, f);
      return { ok: false, error: 'wrong code' };
    },

    lock(userId) { unlocked.delete(String(userId)); },
  };
}

module.exports = { createAdminMenuGate, MAX_FAILS, LOCK_MS, UNLOCK_MS, MAX_CODE_LEN };
