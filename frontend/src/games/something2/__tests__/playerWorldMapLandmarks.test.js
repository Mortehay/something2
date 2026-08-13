// Landmark badging on the player's fog-of-war World Map (SOMET-298).
import { describe, it, expect } from 'vitest';
import { toCytoscapeElements } from '../playerWorldMap.js';

const world = (id, extra = {}) => ({
  id, name: `World ${id}`, graph_x: 0, graph_y: 0, is_entry: false,
  level_min: 1, level_max: 3, waypointCount: 0, portalCount: 0, ...extra,
});

function nodeFor(elements, id) {
  return elements.find((e) => e.data.id === id && !e.data.source);
}

describe('toCytoscapeElements landmark badge', () => {
  it('marks a world holding a waypoint', () => {
    const els = toCytoscapeElements({
      worlds: [world('a', { waypointCount: 1 })], links: [], unvisited: [], currentWorldId: 'a',
    });
    expect(nodeFor(els, 'a').data.landmarks).toBe('true');
  });

  it('marks a world holding a portal', () => {
    const els = toCytoscapeElements({
      worlds: [world('a', { portalCount: 2 })], links: [], unvisited: [], currentWorldId: 'a',
    });
    expect(nodeFor(els, 'a').data.landmarks).toBe('true');
  });

  it('leaves a world with neither unmarked', () => {
    const els = toCytoscapeElements({
      worlds: [world('a')], links: [], unvisited: [], currentWorldId: 'a',
    });
    expect(nodeFor(els, 'a').data.landmarks).toBe('false');
  });

  it('uses the string "true"/"false" cytoscape selectors actually match', () => {
    // `node[landmarks = "true"]` is the idiom this file's own comment calls out
    // for `unvisited` and `current`; a real boolean would never match it, so the
    // style would silently never apply and the badge would never appear.
    const els = toCytoscapeElements({
      worlds: [world('a', { waypointCount: 1 }), world('b')],
      links: [], unvisited: [], currentWorldId: 'a',
    });
    for (const id of ['a', 'b']) {
      expect(typeof nodeFor(els, id).data.landmarks).toBe('string');
    }
  });

  it('gives an unvisited stub no landmarks datum at all', () => {
    // ABSENT, not 'false'. playerWorldMap.test.js pins a stub's keys to exactly
    // {current, id, label, unvisited}, and its neighbouring test spells out the
    // rule this follows: "a field that is permanently false is a field a later
    // change can quietly make true again". Here that change would be a fog leak
    // -- "this unexplored place has a waypoint". A missing datum also cannot
    // match `node[landmarks = "true"]`, so absence is what makes the badge
    // structurally unreachable for a stub rather than merely switched off.
    const els = toCytoscapeElements({
      worlds: [world('a')], links: [],
      unvisited: [{ id: 'z', from: 'a', edge: 'E' }], currentWorldId: 'a',
    });
    expect(nodeFor(els, 'z').data).not.toHaveProperty('landmarks');
  });

  it('treats a missing count as no landmark rather than throwing', () => {
    // An older client against a newer server, or vice versa.
    const els = toCytoscapeElements({
      worlds: [{ id: 'a', name: 'A', graph_x: 0, graph_y: 0, is_entry: false }],
      links: [], unvisited: [], currentWorldId: 'a',
    });
    expect(nodeFor(els, 'a').data.landmarks).toBe('false');
  });
});
