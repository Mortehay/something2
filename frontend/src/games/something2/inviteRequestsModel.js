// Admin "Invites" tab: pure helpers. The server's list endpoint treats a MISSING status as "pending", so the
// History view must always send an explicit one.
export const STATUS_FILTERS = ['all', 'approved', 'rejected'];

export function statusLabel(req) {
  if (!req) return '';
  if (req.status === 'approved') return req.codeUsed ? 'approved — code used' : 'approved — code unused';
  return String(req.status ?? '');
}

export const canDecide = (req) => Boolean(req) && req.status === 'pending';

export const historyStatus = (filter) => (STATUS_FILTERS.includes(filter) ? filter : 'all');
