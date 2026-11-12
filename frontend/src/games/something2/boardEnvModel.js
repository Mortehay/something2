// .env sync box (email accounts, Task 15): pure helpers. The helper sends statuses only: { key, status, locked }.
// No value and no hash ever reaches the browser.
import { t } from './src/js/i18n/i18n.js';

const LABELS = { passed: 'Passed', not_passed: 'Not passed', different: 'Different on board', board_only: 'Only on board', locked: 'Locked' };
const TONES = { passed: 'ok', not_passed: 'warn', different: 'bad', board_only: 'info', locked: 'info' };
const REASONS = { locked: 'locked', not_local: "not in this PC's .env", empty: 'empty' };

export const LOCKED_TIP = 'Board-specific — not copied';
export const RESTART_ENV_NOTE = 'Restart the backend on the board for changes to apply';
export const ENV_HELP = "Keys of this PC's .env and whether the board's .env has the same value. Values are never shown; only a comparison is made.";

// English label (pass it through t() to show it). A locked key carries no comparison at all: the helper never
// compares it, so it is just "Locked".
export const statusLabel = (status) => LABELS[status] || '';
export const statusTone = (status) => TONES[status] || null;

export const copyable = (row) => Boolean(row) && !row.locked && row.status !== 'passed' && row.status !== 'board_only';

export const visibleRows = (rows, hidePassed) => {
  const list = Array.isArray(rows) ? rows : [];
  return hidePassed ? list.filter((r) => r.status !== 'passed') : list;
};

export function envSummary(rows) {
  const out = { passed: 0, not_passed: 0, different: 0, board_only: 0 };
  for (const r of Array.isArray(rows) ? rows : []) if (r && r.status in out) out[r.status] += 1;
  return out;
}

// The ticked keys that are still copyable in the current list (a refresh may have changed a status).
export const effectiveSelection = (rows, selected) => {
  const ok = new Set((Array.isArray(rows) ? rows : []).filter(copyable).map((r) => r.key));
  return [...(selected || [])].filter((k) => ok.has(k));
};

export function copyResultText(out) {
  const written = Array.isArray(out?.written) ? out.written : [];
  const skipped = Array.isArray(out?.skipped) ? out.skipped : [];
  const head = written.length ? t('Copied to the board: {keys}', { keys: written.join(', ') }) : t('Nothing was copied.');
  if (!skipped.length) return head;
  const list = skipped.map((s) => `${s.key} (${t(REASONS[s.reason] || String(s.reason))})`).join(', ');
  return `${head}${written.length ? '.' : ''} ${t('Skipped: {list}', { list })}`;
}
