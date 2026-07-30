import { describe, it, expect } from 'vitest';
import { collapseLinks, lintGraph, linksReplacedBy } from '../mapGraphLint.js';

const L = (from, edge, to) => ({ from_world_id: from, edge, to_world_id: to });
const W = (id, extra = {}) => ({ id, name: id, graph_x: 0, graph_y: 0, ...extra });

describe('collapseLinks', () => {
  it('folds a mirrored pair into one line', () => {
    const out = collapseLinks([L('a', 'E', 'b'), L('b', 'W', 'a')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fromId: 'a', edge: 'E', toId: 'b', toEdge: 'W', mirrored: true });
  });

  it('keeps an unmirrored row and flags it', () => {
    const out = collapseLinks([L('a', 'N', 'b')]);
    expect(out).toHaveLength(1);
    expect(out[0].mirrored).toBe(false);
  });

  it('does not fold a pair that only looks mirrored', () => {
    // b's W points at c, not back at a — not a mirror.
    const out = collapseLinks([L('a', 'E', 'b'), L('b', 'W', 'c')]);
    expect(out).toHaveLength(2);
    expect(out.every((l) => l.mirrored === false)).toBe(true);
  });

  it('handles the live 4-way topology as four separate lines', () => {
    const links = ['N', 'E', 'S', 'W'].flatMap((e) => [L('a', e, 'b'), L('b', { N: 'S', S: 'N', E: 'W', W: 'E' }[e], 'a')]);
    expect(collapseLinks(links)).toHaveLength(4);
  });
});

describe('lintGraph', () => {
  const positions = { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } };

  it('is silent on a consistent graph', () => {
    const out = lintGraph({ worlds: [W('a'), W('b')], links: [L('a', 'E', 'b'), L('b', 'W', 'a')], positions });
    expect(out).toEqual([]);
  });

  it('flags a link drawn against its compass edge', () => {
    // a.W points at b, but b is drawn to the RIGHT of a.
    const out = lintGraph({ worlds: [W('a'), W('b')], links: [L('a', 'W', 'b'), L('b', 'E', 'a')], positions });
    expect(out.map((w) => w.code)).toContain('direction-mismatch');
  });

  it('flags two links leaving one world in the same drawn direction', () => {
    const pos = { a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, c: { x: 300, y: 0 } };
    const links = [L('a', 'E', 'b'), L('b', 'W', 'a'), L('a', 'N', 'c'), L('c', 'S', 'a')];
    const out = lintGraph({ worlds: [W('a'), W('b'), W('c')], links, positions: pos });
    expect(out.map((w) => w.code)).toContain('duplicate-direction');
  });

  it('flags a missing mirror', () => {
    const out = lintGraph({ worlds: [W('a'), W('b')], links: [L('a', 'E', 'b')], positions });
    expect(out.map((w) => w.code)).toContain('missing-mirror');
  });

  it('flags an unpositioned world', () => {
    const out = lintGraph({ worlds: [W('a', { graph_x: null, graph_y: null })], links: [], positions: { a: { x: 0, y: 0 } } });
    expect(out.map((w) => w.code)).toContain('unpositioned');
  });

  it('names the worlds involved so the UI can highlight them', () => {
    const out = lintGraph({ worlds: [W('a'), W('b')], links: [L('a', 'W', 'b'), L('b', 'E', 'a')], positions });
    const mismatch = out.find((w) => w.code === 'direction-mismatch');
    expect(mismatch.worldIds).toEqual(expect.arrayContaining(['a', 'b']));
    expect(typeof mismatch.message).toBe('string');
    expect(mismatch.message.length).toBeGreaterThan(0);
  });
});

describe('linksReplacedBy', () => {
  it('finds nothing when both compass slots are free', () => {
    expect(linksReplacedBy({ links: [], fromId: 'a', edge: 'E', toId: 'b' })).toEqual([]);
  });

  it("reports the source's occupied slot", () => {
    const links = [L('a', 'E', 'c'), L('c', 'W', 'a')];
    const out = linksReplacedBy({ links, fromId: 'a', edge: 'E', toId: 'b' });
    expect(out).toContainEqual(L('a', 'E', 'c'));
  });

  it("reports the TARGET's opposing slot too", () => {
    // Linking a.E -> b also writes b.W, clobbering b's existing W link to d.
    const links = [L('b', 'W', 'd'), L('d', 'E', 'b')];
    const out = linksReplacedBy({ links, fromId: 'a', edge: 'E', toId: 'b' });
    expect(out).toContainEqual(L('b', 'W', 'd'));
  });

  it('reports nothing when the identical link already exists', () => {
    const links = [L('a', 'E', 'b'), L('b', 'W', 'a')];
    expect(linksReplacedBy({ links, fromId: 'a', edge: 'E', toId: 'b' })).toEqual([]);
  });

  it('does not report the same row twice', () => {
    const links = [L('a', 'E', 'c'), L('c', 'W', 'a')];
    const out = linksReplacedBy({ links, fromId: 'a', edge: 'E', toId: 'b' });
    const keys = out.map((l) => `${l.from_world_id}|${l.edge}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
