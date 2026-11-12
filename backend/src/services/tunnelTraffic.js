// Tunnels tab: in-memory notes of who is connected through which Host, and of server-side errors
// (backend 5xx, refused authority upgrades) together with the Host they arrived on. The authority
// and index.js note everything cheaply; tunnelRecorder decides which hosts are tunnels. Nothing
// here may throw into a caller: it sits on the request and upgrade paths.

const MAX_ERRORS = 500;

// "Foo.TryCloudflare.com:443" -> "foo.trycloudflare.com". IPv6 literals keep their brackets.
function normHost(host) {
  if (typeof host !== 'string' || !host) return '';
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) { const end = h.indexOf(']'); return end === -1 ? h : h.slice(0, end + 1); }
  const colon = h.indexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

function createTunnelTraffic({ now = Date.now } = {}) {
  const conns = new Map(); // host -> Map<userId(number|string), socket count>
  let errors = [];
  // host -> { users: Set, peak }: every account seen since the last takeSeen, and the most
  // distinct accounts connected at once, so a visit shorter than a recorder tick still counts.
  let seen = new Map();
  function seenFor(h) {
    let s = seen.get(h);
    if (!s) { s = { users: new Set(), peak: 0 }; seen.set(h, s); }
    return s;
  }

  function noteConnection(note) {
    try {
      const { host, userId } = note || {};
      const h = normHost(host);
      const id = Number.isFinite(Number(userId)) ? Number(userId) : String(userId);
      if (!h || userId == null) return () => {};
      let users = conns.get(h);
      if (!users) { users = new Map(); conns.set(h, users); }
      users.set(id, (users.get(id) || 0) + 1);
      const s = seenFor(h);
      s.users.add(id);
      s.peak = Math.max(s.peak, users.size);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const m = conns.get(h);
        if (!m) return;
        const n = (m.get(id) || 0) - 1;
        if (n > 0) m.set(id, n); else m.delete(id);
        if (!m.size) conns.delete(h);
      };
    } catch {
      return () => {};
    }
  }

  // Distinct accounts connected through this host now: one friend with two tabs is one player.
  function countFor(host) {
    const m = conns.get(normHost(host));
    return m ? m.size : 0;
  }

  function usersFor(host) {
    const m = conns.get(normHost(host));
    return m ? [...m.keys()] : [];
  }

  function noteError(note) {
    try {
      const { host, kind, detail } = note || {};
      errors.push({ host: normHost(host), kind: String(kind), detail: detail == null ? null : String(detail).slice(0, 300), at: new Date(now()).toISOString() });
      if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS);
    } catch { /* never on the caller's path */ }
  }

  function takeErrors() {
    const out = errors;
    errors = [];
    return out;
  }

  // -> { [host]: { users: [...ids], peak } } since the last take; restarts from who is live now.
  function takeSeen() {
    const out = {};
    for (const [h, s] of seen) out[h] = { users: [...s.users], peak: s.peak };
    seen = new Map();
    for (const [h, m] of conns) seen.set(h, { users: new Set(m.keys()), peak: m.size });
    return out;
  }

  // Puts back what a failed recorder write took, ahead of anything noted since.
  function restore({ errors: back = [], seen: backSeen = {} } = {}) {
    try {
      errors = [...back, ...errors].slice(-MAX_ERRORS);
      for (const [h, v] of Object.entries(backSeen)) {
        const s = seenFor(h);
        for (const id of v.users || []) s.users.add(id);
        s.peak = Math.max(s.peak, Number(v.peak) || 0);
      }
    } catch { /* best effort */ }
  }

  return { noteConnection, countFor, usersFor, noteError, takeErrors, takeSeen, restore };
}

// The process-wide instance the authority, index.js and the recorder share.
const shared = createTunnelTraffic();

module.exports = { ...shared, createTunnelTraffic, normHost, shared };
