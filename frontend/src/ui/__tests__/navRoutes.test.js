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
    const guarded = app.slice(app.indexOf('<RequireAdmin />'));
    for (const item of items) {
      if (item.path === '/game') continue;
      expect(guarded, `${item.path} is outside RequireAdmin`)
        .toContain(`path="${item.path.replace('/game/', '')}"`);
    }
  });
});
