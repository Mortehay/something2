import { describe, it, expect } from 'vitest';
import { slotJobText } from '../audioBatch.js';

// SOMET-592 validation, defect 3: after a drain stopped on repeated provider
// failures, the Slime hurt card still read "Job: queued" with nothing saying
// the queue was no longer being worked. The card's job line must say so.
const queued = { status: 'queued' };
const breaker = {
  running: false, stopped_reason: 'breaker', error: 'box unreachable', started_at: 't0',
};

describe('slotJobText', () => {
  it('is null with no job', () => {
    expect(slotJobText(null, breaker)).toBe(null);
  });

  it('a queued job while a drain runs is just "queued"', () => {
    expect(slotJobText(queued, { running: true })).toBe('Job: queued');
    expect(slotJobText({ status: 'running' }, { running: true })).toBe('Job: running');
  });

  it('a queued job after the drain stopped on provider failures says the drain stopped and why', () => {
    const text = slotJobText(queued, breaker);
    expect(text).toMatch(/^Job: queued — /);
    expect(text).toMatch(/drain stopped/i);
    expect(text).toContain('box unreachable');
  });

  it('a queued job after a no_provider or error stop carries the reason too', () => {
    expect(slotJobText(queued, { running: false, stopped_reason: 'no_provider', error: 'none active' }))
      .toMatch(/drain stopped.*none active/i);
    expect(slotJobText(queued, { running: false, stopped_reason: 'error', error: 'db down' }))
      .toMatch(/drain stopped.*db down/i);
  });

  it('a queued job with no drain running (Stop pressed, or never started) says to press Start', () => {
    expect(slotJobText(queued, { running: false, stopped_reason: 'stopped' }))
      .toMatch(/^Job: queued — no drain is running.*Start/);
    expect(slotJobText(queued, null)).toMatch(/no drain is running/);
  });

  it('a failed job keeps its error', () => {
    expect(slotJobText({ status: 'failed', error: 'unknown cue' }, breaker)).toBe('Job: failed — unknown cue');
    expect(slotJobText({ status: 'failed' }, breaker)).toBe('Job: failed');
  });
});

// vitest runs in node here (no DOM), so the card is checked at its source:
// the helper above is only worth anything if the card's job line uses it.
describe('AudioSlotCard wiring', () => {
  it('renders the job line through slotJobText with the drain run, not the bare status', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../AudioSlotCard.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/\{slotJobText\(job, run\)\}/);
    expect(src).not.toMatch(/Job: \{job\.status\}/);
  });
});
