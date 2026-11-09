import { useEffect, useState } from 'react';

// The admin menu's lock as the server last reported it for this account:
// { admin, required, unlocked, ... } or null until the first answer. Subscribes to the running
// game (gameRef.current appears only once the game has started, so it retries until it exists).
export function useAdminGate(gameRef, enabled = true) {
  const [gate, setGate] = useState(null);
  useEffect(() => {
    if (!enabled) { setGate(null); return undefined; }
    let unsubscribe = null;
    let timer = null;
    const attach = () => {
      const g = gameRef.current;
      if (!g || typeof g.onAdminGateChange !== 'function') return false;
      unsubscribe = g.onAdminGateChange(setGate);
      // The join may have happened before this panel mounted: ask again.
      if (typeof g.adminGateRequest === 'function') g.adminGateRequest('status');
      return true;
    };
    if (!attach()) {
      timer = setInterval(() => { if (attach()) { clearInterval(timer); timer = null; } }, 500);
    }
    return () => {
      if (timer) clearInterval(timer);
      if (unsubscribe) unsubscribe();
    };
  }, [gameRef, enabled]);
  return gate;
}
