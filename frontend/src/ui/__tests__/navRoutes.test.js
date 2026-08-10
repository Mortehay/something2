import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV_SECTIONS } from '../navSections.js';

// The sidebar and the route table in App.jsx are two lists that have to agree:
// a nav entry pointing at an unregistered path renders a blank content area,
// and a route with no nav entry is unreachable except by typing the URL.
// vitest runs in a plain node env here (no jsdom/RTL), so this compares the
// nav definitions against App.jsx's source text rather than a rendered router.
const here = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.join(here, '../../App.jsx'), 'utf8');

const items = NAV_SECTIONS.flatMap((s) => s.items);

// Split by the section's own adminOnly flag rather than by "is it /game".
// Until SOMET-263 every non-index nav path happened to be an admin path, so
// the guarded-block checks below iterated `items` and read as correct. They
// were really asserting "every nav path except /game is behind RequireAdmin",
// which would equally have failed to notice a PLAYER route drifting behind the
// admin guard -- a route players silently cannot reach.
const adminItems = NAV_SECTIONS.filter((s) => s.adminOnly).flatMap((s) => s.items);
const playerItems = NAV_SECTIONS.filter((s) => !s.adminOnly).flatMap((s) => s.items);
const segmentOf = (item) => item.path.replace('/game/', '');

// Extracts the balanced <Route element={<RequireAdmin />}>...</Route> block by
// walking Route open/close tags to depth 0, rather than slicing to end-of-file.
// A textual tail slice would consider any route AFTER the opening tag "guarded"
// even if it is actually a sibling that closed the RequireAdmin block already --
// see the mutation test in the task-8 report for a route that slipped past that way.
function extractGuardedBlock(source) {
  const start = source.indexOf('<Route element={<RequireAdmin />}>');
  if (start === -1) return { start, end: -1, block: '' };
  // Tags here can carry a nested self-closing element in their `element={...}`
  // attribute (e.g. `<Route element={<RequireAdmin />}>`), which itself contains
  // a `>` before the real tag's own closing `>`. A naive `[^>]*>` stops at that
  // inner `>` and misreads the *opening* RequireAdmin tag as self-closing (net
  // depth 0), so the walk ends after one match and "guarded" collapses to just
  // the tag itself -- silently vacuous. Allow one level of brace nesting so the
  // match always ends at the tag's real closing `>`.
  const tagRe = /<\/?Route\b(?:[^<>{}]|\{[^{}]*\})*\/?>/g;
  tagRe.lastIndex = start;
  let depth = 0;
  let end = -1;
  let m;
  while ((m = tagRe.exec(source))) {
    depth += m[0].startsWith('</Route') ? -1 : (m[0].endsWith('/>') ? 0 : 1);
    if (depth === 0) { end = tagRe.lastIndex; break; }
  }
  return { start, end, block: end === -1 ? '' : source.slice(start, end) };
}

describe('nav paths and App.jsx routes agree', () => {
  it('registers a child route for every admin nav path', () => {
    for (const item of items) {
      if (item.path === '/game') continue;          // the index route, no path= segment
      const segment = item.path.replace('/game/', '');
      expect(app, `${item.path} has no route`).toContain(`path="${segment}"`);
    }
  });

  it('mounts the game shell at /game with an index route', () => {
    expect(app).toMatch(/path="game"\s+element=\{<GameShell \/>\}/);
    expect(app).toMatch(/<Route index element=\{<GameView \/>\} \/>/);
  });

  it('keeps every admin route behind RequireAdmin', () => {
    const { start, end, block: guarded } = extractGuardedBlock(app);
    expect(start, 'could not find the RequireAdmin route element').not.toBe(-1);
    expect(end, 'RequireAdmin route block never balanced back to depth 0').not.toBe(-1);
    // Would pass vacuously against an empty admin section.
    expect(adminItems.length).toBeGreaterThan(0);
    for (const item of adminItems) {
      expect(guarded, `${item.path} is outside RequireAdmin`)
        .toContain(`path="${segmentOf(item)}"`);
    }
  });

  it('keeps every player route OUTSIDE RequireAdmin', () => {
    // The converse, and the one that matters for SOMET-263: a player-facing
    // route that drifts inside the guarded block is not a visible break. The
    // nav entry still renders, the path still resolves, and only an actual
    // player -- never an admin testing it -- gets bounced.
    const { block: guarded } = extractGuardedBlock(app);
    const nonIndex = playerItems.filter((i) => i.path !== '/game');
    expect(nonIndex.length).toBeGreaterThan(0);
    for (const item of nonIndex) {
      expect(guarded, `${item.path} is behind RequireAdmin and players cannot reach it`)
        .not.toContain(`path="${segmentOf(item)}"`);
      expect(app, `${item.path} has no route at all`).toContain(`path="${segmentOf(item)}"`);
    }
  });

  it('has an ADMIN nav entry for every route registered under RequireAdmin', () => {
    const { start, end, block: guarded } = extractGuardedBlock(app);
    expect(start, 'could not find the RequireAdmin route element').not.toBe(-1);
    expect(end, 'RequireAdmin route block never balanced back to depth 0').not.toBe(-1);
    // Admin segments only. Matching against every nav entry would let a route
    // sit behind the admin guard while its nav entry is in the player section.
    const adminSegments = new Set(adminItems.map(segmentOf));
    const routeSegments = [...guarded.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
    expect(routeSegments.length).toBeGreaterThan(0);
    for (const segment of routeSegments) {
      expect(adminSegments, `route "${segment}" has no admin nav entry`).toContain(segment);
    }
  });
});
