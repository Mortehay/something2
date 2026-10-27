import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { jobPollInterval, hasChoices, DISCARD_CONFIRM } from '../seedExportModel.js';

// SOMET-640 fix round 1. useSeedJob cannot be rendered here (vitest is
// node-env, no DOM), so its rules are a pure function plus a source gate.
describe('jobPollInterval', () => {
  it('polls every second only while a job runs', () => {
    expect(jobPollInterval({ id: 1, status: 'running' })).toBe(1000);
    for (const status of ['ok', 'failed', 'cancelled']) expect(jobPollInterval({ id: 1, status })).toBe(false);
    expect(jobPollInterval(null)).toBe(false);
    expect(jobPollInterval(undefined)).toBe(false);
  });
});

describe('useSeedJob wiring (source gate)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'useSeedExport.js'), 'utf8');
  const start = src.indexOf('export function useSeedJob(');
  const end = src.indexOf('export function useCancelSeedJob(');
  const body = src.slice(start, end);
  it('the hook exists', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });
  it('fetches on mount and polls through jobPollInterval', () => {
    expect(body).toContain("queryFn: () => call(\"/jobs/current\")");
    expect(body).toContain("refetchOnMount: 'always'");
    expect(body).toContain('refetchInterval: (q) => jobPollInterval(q.state.data)');
  });
  it('the settle effect invalidates groups, runs and restart once per finished job', () => {
    const fire = body.slice(body.indexOf('jobSettled(seen.current, job)'));
    expect(fire).toContain('seen.current = r.seen;');
    const open = fire.indexOf('if (r.fire) {');
    expect(open).toBeGreaterThan(-1);
    const block = fire.slice(open, fire.indexOf('\n    }', open)); // the if's closing brace
    expect(block).toContain('qc.invalidateQueries({ queryKey: GROUPS_KEY })');
    expect(block).toContain('qc.invalidateQueries({ queryKey: RUNS_KEY })');
    expect(block).toContain('qc.invalidateQueries({ queryKey: RESTART_KEY })');
  });
});

describe('Seed all -> binary group discards choices only after confirm', () => {
  it('hasChoices is true once any group has a changed decision', () => {
    expect(hasChoices({})).toBe(false);
    expect(hasChoices(undefined)).toBe(false);
    expect(hasChoices({ quests: { sig: 's', d: { u1: 'git' } } })).toBe(true);
  });
  it('the binary button asks DISCARD_CONFIRM before leaving (source gate)', () => {
    expect(DISCARD_CONFIRM).toBe('Discard the choices made here?');
    const src = fs.readFileSync(path.join(__dirname, '..', 'SeedAllModal.jsx'), 'utf8');
    expect(src).toContain('if (hasChoices(states) && !window.confirm(DISCARD_CONFIRM)) return;');
    expect(src).toContain('onClick={() => seedSeparately(g.id)}');
  });
});
