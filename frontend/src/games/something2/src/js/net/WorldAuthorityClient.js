/**
 * WorldAuthorityClient — WebSocket client for the authoritative world sim.
 * Sends movement INPUT (never positions); the server owns authority.
 * Input is throttled to ~inputIntervalMs; the caller buffers the returned
 * {seq,dx,dy,dt} for client-side reconciliation.
 */
export class WorldAuthorityClient {
  constructor({ url, token, onJoined, onState, onError, onClose, onCreatures, inputIntervalMs = 50, now = () => performance.now() }) {
    this.url = url;
    this.token = token;
    this.onJoined = onJoined || (() => {});
    this.onState = onState || (() => {});
    this.onError = onError || ((e) => console.error('WorldAuthorityClient:', e));
    this.onClose = onClose || (() => {});
    this.onCreatures = onCreatures || (() => {});
    this.inputIntervalMs = inputIntervalMs;
    this.now = now;

    this.ws = null;
    this.connected = false;
    this.joined = false;
    this.worldId = null;
    this._seq = 0;
    this._accumDt = 0;
    this._lastSentAt = -Infinity;
  }

  connect(worldId) {
    this.worldId = worldId;
    const sep = this.url.includes('?') ? '&' : '?';
    const wsUrl = `${this.url}${sep}token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.addEventListener('open', () => {
      this.connected = true;
      this._send({ type: 'join', world_id: worldId });
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      switch (msg.type) {
        case 'joined': this.joined = true; this.onJoined(msg); break;
        case 'state': this.onState(msg); break;
        case 'pong': break;
        case 'creatures': this.onCreatures(msg); break;
        case 'error': this.onError(new Error(msg.message || 'authority error')); break;
        default: console.warn('WorldAuthorityClient: unknown msg', msg.type);
      }
    });
    this.ws.addEventListener('error', () => this.onError(new Error('websocket error')));
    this.ws.addEventListener('close', (ev) => {
      this.connected = false; this.joined = false; this.onClose(ev);
    });
  }

  // Returns {sent, seq?, dx?, dy?, dt?}. dt is the seconds accumulated since the
  // previous actual send (so replay during reconciliation uses the real dt).
  sendInput(dx, dy, dt) {
    this._accumDt += dt;
    if (!this.connected) return { sent: false };
    const now = this.now();
    if (now - this._lastSentAt < this.inputIntervalMs) return { sent: false };
    const seq = ++this._seq;
    this._send({ type: 'input', seq, dx, dy });
    this._lastSentAt = now;
    const sentDt = this._accumDt;
    this._accumDt = 0;
    return { sent: true, seq, dx, dy, dt: sentDt };
  }

  ping() { this._send({ type: 'ping' }); }

  sendAttack(ax, ay) { this._send({ type: 'attack', ax, ay }); }

  sendEquip(weaponId) { this._send({ type: 'equip', weaponId }); }

  disconnect() {
    if (this.ws) { try { this.ws.close(); } catch { /* already closed */ } this.ws = null; }
    this.connected = false; this.joined = false;
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }
}
