// Pure helpers for the Tunnels admin tab (no React, no fetch).
const STATUS = {
  off: 'Off', starting: 'Starting…', on: 'On', failed: 'Failed', busy: 'ngrok is busy with another project',
};
const REASONS = {
  switched_off: 'You switched it off',
  went_down: 'Laptop or containers went down',
  crashed: 'Crashed',
  failed_to_start: 'Failed to start',
};

export const POLL_MS = 5000;
export const PROVIDERS = [
  { id: 'cloudflare', name: 'Cloudflare' },
  { id: 'ngrok', name: 'ngrok' },
];

export function formatUptime(startedAt, now) {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return '';
  const mins = Math.max(0, Math.floor((now - start) / 60_000));
  const h = Math.floor(mins / 60);
  return h > 0 ? `On for ${h} h ${mins % 60} min` : `On for ${mins} min`;
}

export const statusLabel = (state) => STATUS[state] || STATUS.off;

export function endReasonLabel(reason) {
  if (!reason) return 'Still running';
  return REASONS[reason] || String(reason);
}

export const canToggle = (card, pending) => Boolean(card) && !pending && card.state !== 'starting';

export const durationText = (sec) => {
  if (!Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${m % 60} min` : `${m} min`;
};
