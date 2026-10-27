import { describe, it, expect } from 'vitest';
import { loadAllSubjects } from '../useArtConsole.js';

// A fake of GET /api/art-subjects and GET /api/art-subjects/:kind that honours
// page/per_page exactly as the route does (per_page capped at 500).
function fakeServer(counts) {
  const calls = [];
  const getJson = async (url) => {
    calls.push(url);
    const u = new URL(url, 'http://x');
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 2) return { kinds: Object.keys(counts).map((kind) => ({ kind })) };
    const kind = decodeURIComponent(parts[2]);
    const perPage = Math.min(Math.max(Number(u.searchParams.get('per_page')) || 100, 1), 500);
    const page = Math.max(Number(u.searchParams.get('page')) || 1, 1);
    const all = Array.from({ length: counts[kind] }, (_, i) => ({ kind, key: `${kind}${i}` }));
    const start = (page - 1) * perPage;
    return { page, per_page: perPage, total: all.length, subjects: all.slice(start, start + perPage) };
  };
  return { getJson, calls };
}

describe('loading every subject', () => {
  // SOMET-538 rework: one request per kind at per_page=500 silently dropped
  // every row past the 500th, and "Select all N matching" then undercounted.
  it('pages through a kind larger than the server per_page cap', async () => {
    const { getJson } = fakeServer({ entity: 1203, skill: 3 });
    const { kinds, subjects } = await loadAllSubjects(getJson);
    expect(kinds).toEqual(['entity', 'skill']);
    expect(subjects.filter((s) => s.kind === 'entity')).toHaveLength(1203);
    expect(new Set(subjects.map((s) => `${s.kind}/${s.key}`)).size).toBe(1206);
  });

  it('still makes one request for a kind that fits in one page', async () => {
    const { getJson, calls } = fakeServer({ skill: 300 });
    await loadAllSubjects(getJson);
    expect(calls.filter((u) => u.includes('/art-subjects/skill'))).toHaveLength(1);
  });

  // A catalogue that shrinks between two page requests must not loop forever.
  it('stops on an empty page even if total says there is more', async () => {
    let n = 0;
    const getJson = async (url) => {
      if (!url.includes('/art-subjects/')) return { kinds: [{ kind: 'item' }] };
      n += 1;
      if (n > 5) throw new Error('runaway pagination');
      return n === 1
        ? { total: 900, subjects: Array.from({ length: 500 }, (_, i) => ({ kind: 'item', key: `i${i}` })) }
        : { total: 900, subjects: [] };
    };
    const { subjects } = await loadAllSubjects(getJson);
    expect(subjects).toHaveLength(500);
  });
});
