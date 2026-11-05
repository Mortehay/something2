// SOMET-742. Writes one parallax loading scene per biome family to
// public/loading-scenes/. Run by hand after changing a scene, commit the output:
//   node frontend/scripts/generate-loading-scenes.mjs
// Each layer is periodic over W, so two copies side by side loop without a seam.
// Everything is drawn here: a scene shows while the network is what is being
// waited for, so it fetches nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 1600;
const H = 900;
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/loading-scenes');

function rng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

// A height function periodic over W: whole-number harmonics only.
function terrain(rand, base, amp, jagged) {
  const waves = [1, 2, 3, 5].map((k, i) => ({ k, a: amp / (i + 1), p: rand() * Math.PI * 2 }));
  if (jagged) waves.push({ k: 9, a: amp / 3, p: rand() * Math.PI * 2 }, { k: 17, a: amp / 5, p: rand() * Math.PI * 2 });
  return (x) => base + waves.reduce((y, w) => y + w.a * Math.sin((2 * Math.PI * w.k * x) / W + w.p), 0);
}

function ridgePath(h, samples, ceiling = false) {
  const pts = [];
  for (let i = 0; i <= samples; i++) { const x = (i / samples) * W; pts.push(`${Math.round(x)} ${Math.round(h(x))}`); }
  // Two pixels past each end: copies that only touched showed a hairline where they met.
  return `M-2 ${Math.round(h(0))}L${pts.join('L')}L${W + 2} ${Math.round(h(W))}V${ceiling ? 0 : H}H-2Z`;
}

const PROPS = {
  pine: '<path d="M-3 0h6v14h-6z"/><path d="M0-96 17-58H8L26-28H12L34 4H-34L-12-28H-26L-8-58H-17Z"/>',
  round: '<path d="M-4 0h8v-34h-8z"/><circle cy="-58" r="30"/><circle cx="-20" cy="-40" r="20"/><circle cx="20" cy="-40" r="20"/>',
  palm: '<path d="M-3 4 0-80h5L5 4Z"/><path d="M2-82C-20-100-46-92-58-68-34-82-14-80 2-74ZM2-82C24-100 50-92 62-68 38-82 18-80 2-74ZM2-80C-6-110-30-118-44-112-22-104-8-94 0-74ZM2-80C10-110 34-118 48-112 26-104 12-94 4-74Z"/>',
  dead: '<path d="M-5 4-3-46-22-70-18-72-1-54 1-84H5L5-52 24-78 28-75 6-40 6 4Z"/>',
  cactus: '<path d="M-7 4V-70A7 7 0 0 1 7-70V4ZM-7-28H-20V-52A5 5 0 0 0-30-52V-28A10 10 0 0 0-20-18H-7ZM7-38H18V-62A5 5 0 0 1 28-62V-38A10 10 0 0 1 18-28H7Z"/>',
  spike: '<path d="M-26 6-8-60-2-24 6-92 28 6Z"/>',
  stalagmite: '<path d="M-24 6-6-74 0-40 8-58 24 6Z"/>',
  crystal: '<path d="M-14 4-18-34-6-62 6-40 4 4Z"/><path d="M4 4 8-26 18-44 26-22 18 4Z" opacity=".75"/>',
  column: '<path d="M-20-112H20V-102H-20ZM-14-102H14V-12H-14ZM-22-12H22V6H-22Z"/>',
  broken: '<path d="M-20-12H22V6H-22ZM-14-12V-62L-4-70 2-58 14-66V-12Z"/>',
  tomb: '<path d="M-16 6V-30A16 16 0 0 1 16-30V6Z"/><path d="M-26 4H26V10H-26Z"/>',
};

const sun = (x, y, r, fill, o = 0.9) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" opacity="${o}"/>`;

// Layers run back to front. base/amp shape the ridge; jagged sharpens it;
// props stand on the ridge. Speeds are per layer depth, so nearer moves faster.
const SCENES = {
  forest: { seed: 11, sky: ['#16213a', '#46507a', '#d98f63'], glow: sun(1120, 340, 74, '#f6d9a0'), layers: [
    { base: 420, amp: 44, fill: '#5b6390' },
    { base: 570, amp: 34, fill: '#3a5f5d', props: { kind: 'pine', n: 9, s: 0.6, fill: '#2b4f4a' } },
    { base: 690, amp: 26, fill: '#234640', props: { kind: 'pine', n: 10, s: 1, fill: '#16322e' } },
    { base: 800, amp: 16, fill: '#0f231f' },
  ] },
  meadow: { seed: 23, sky: ['#6fb0e6', '#b9dff2', '#f6eed4'], glow: sun(380, 220, 70, '#fff3c4', 1), layers: [
    { base: 460, amp: 36, fill: '#9cbcae' },
    { base: 580, amp: 30, fill: '#86b56a', props: { kind: 'round', n: 4, s: 0.6, fill: '#5f9a55' } },
    { base: 690, amp: 24, fill: '#5d9b4d', props: { kind: 'round', n: 5, s: 1, fill: '#3e7d3f' } },
    { base: 805, amp: 14, fill: '#3c7539' },
  ] },
  jungle: { seed: 37, sky: ['#0f3a34', '#2e7a5c', '#c8d67a'], glow: sun(1050, 300, 62, '#f2f0a8', 0.75), layers: [
    { base: 400, amp: 40, fill: '#2f6f5b', props: { kind: 'round', n: 14, s: 0.7, fill: '#2f6f5b' } },
    { base: 560, amp: 32, fill: '#1f5a43', props: { kind: 'palm', n: 11, s: 0.8, fill: '#174a36' } },
    { base: 690, amp: 24, fill: '#123f2d', props: { kind: 'palm', n: 9, s: 1.25, fill: '#0c2f21' } },
    { base: 805, amp: 14, fill: '#07211a' },
  ] },
  swamp: { seed: 41, sky: ['#17241e', '#3b5442', '#8f9d66'], glow: sun(820, 300, 66, '#d9dcae', 0.55), layers: [
    { base: 500, amp: 18, fill: '#4b6552' },
    { base: 600, amp: 18, fill: '#31493a', props: { kind: 'dead', n: 8, s: 0.8, fill: '#25382c' } },
    { base: 700, amp: 12, fill: '#22362a', props: { kind: 'dead', n: 7, s: 1.3, fill: '#16251c' } },
    { base: 810, amp: 6, fill: '#3d5a48' },
  ] },
  desert: { seed: 53, sky: ['#d9834a', '#f0b878', '#fbe6b8'], glow: sun(1180, 260, 84, '#fff2c2', 1), layers: [
    { base: 500, amp: 40, fill: '#dca76c' },
    { base: 610, amp: 36, fill: '#c98b50', props: { kind: 'cactus', n: 3, s: 0.6, fill: '#7c6a3a' } },
    { base: 710, amp: 28, fill: '#ad6f3b', props: { kind: 'cactus', n: 4, s: 1, fill: '#5a5029' } },
    { base: 815, amp: 16, fill: '#824f29' },
  ] },
  snow: { seed: 67, sky: ['#20324f', '#6f8fb5', '#dfe9f2'], glow: sun(1240, 230, 56, '#f4f8ff', 0.8), layers: [
    { base: 400, amp: 62, fill: '#b9cbdd', jagged: true, samples: 60 },
    { base: 580, amp: 34, fill: '#dbe6f0', props: { kind: 'pine', n: 7, s: 0.6, fill: '#5c7a94' } },
    { base: 700, amp: 24, fill: '#eef3f8', props: { kind: 'pine', n: 7, s: 1, fill: '#34526b' } },
    { base: 810, amp: 12, fill: '#ffffff' },
  ] },
  volcanic: { seed: 71, sky: ['#170809', '#5a1712', '#e0591f'], glow: sun(1040, 230, 84, '#ff9a3c', 0.8), layers: [
    { base: 440, amp: 70, fill: '#3b1714', jagged: true, samples: 60 },
    { base: 590, amp: 40, fill: '#27100e', jagged: true, samples: 60, props: { kind: 'spike', n: 6, s: 0.7, fill: '#1e0c0a' } },
    { base: 710, amp: 26, fill: '#180a09', jagged: true, samples: 60, props: { kind: 'spike', n: 7, s: 1.1, fill: '#100605' } },
    { base: 815, amp: 12, fill: '#c9471a', top: { base: 835, amp: 12, fill: '#0d0505' } },
  ] },
  coast: { seed: 83, sky: ['#232c3c', '#56677d', '#a3b0b5'], glow: sun(460, 250, 54, '#d6dde0', 0.35), layers: [
    { base: 450, amp: 66, fill: '#3e4d63', jagged: true, samples: 50 },
    { base: 620, amp: 7, fill: '#3b6b80' },
    { base: 700, amp: 12, fill: '#27566c' },
    { base: 800, amp: 16, fill: '#143545' },
  ] },
  cavern: { seed: 97, sky: ['#090c16', '#141b2e', '#22304d'], glow: sun(800, 470, 170, '#3c6d8f', 0.25), ceiling: { base: 120, amp: 60, fill: '#070a12', samples: 70 }, layers: [
    { base: 540, amp: 40, fill: '#1c2640', jagged: true, samples: 50 },
    { base: 640, amp: 28, fill: '#141c31', props: { kind: 'crystal', n: 6, s: 0.8, fill: '#5fd6e0' } },
    { base: 730, amp: 22, fill: '#0e1425', props: { kind: 'stalagmite', n: 8, s: 1.1, fill: '#0a0f1c' } },
    { base: 825, amp: 12, fill: '#070a13' },
  ] },
  ruins: { seed: 101, sky: ['#13121e', '#2c2a40', '#615675'], glow: sun(1030, 280, 68, '#d8d2e6', 0.8), layers: [
    { base: 520, amp: 26, fill: '#3a3750' },
    { base: 625, amp: 20, fill: '#2a283b', props: { kind: 'column', n: 7, s: 0.9, fill: '#1f1d2d', alt: 'broken' } },
    { base: 725, amp: 16, fill: '#1c1b2a', props: { kind: 'tomb', n: 9, s: 1, fill: '#121120' } },
    { base: 825, amp: 10, fill: '#0f0e19' },
  ] },
};

const SPEEDS = [160, 90, 50, 28];

function propsMarkup(spec, h, rand) {
  if (!spec) return '';
  const step = (W - 80) / spec.n;
  let out = '';
  for (let i = 0; i < spec.n; i++) {
    const x = Math.round(40 + step * i + rand() * step * 0.8);
    const scale = (spec.s * (0.8 + rand() * 0.4)).toFixed(2);
    const kind = spec.alt && i % 2 ? spec.alt : spec.kind;
    out += `<use href="#${kind}" transform="translate(${x} ${Math.round(h(x)) + 2}) scale(${scale})" fill="${spec.fill}"/>`;
  }
  return out;
}

function render(name, scene) {
  const rand = rng(scene.seed);
  const used = new Set(scene.layers.flatMap((l) => (l.props ? [l.props.kind, l.props.alt] : [])).filter(Boolean));
  const defs = [...used].map((k) => `<g id="${k}">${PROPS[k]}</g>`).join('');
  const layers = scene.layers.map((l, i) => {
    const h = terrain(rand, l.base, l.amp, l.jagged);
    let inner = `<path d="${ridgePath(h, l.samples || 40)}" fill="${l.fill}"/>`;
    if (l.top) inner += `<path d="${ridgePath(terrain(rand, l.top.base, l.top.amp), 40)}" fill="${l.top.fill}"/>`;
    inner += propsMarkup(l.props, h, rand);
    return `<g class="l${i}"><g id="L${i}">${inner}</g><use href="#L${i}" x="${W}"/></g>`;
  }).join('\n');
  let ceiling = '';
  if (scene.ceiling) {
    const c = scene.ceiling;
    const h = terrain(rand, c.base, c.amp, true);
    ceiling = `<g class="l1"><path id="C" d="${ridgePath(h, c.samples, true)}" fill="${c.fill}"/><use href="#C" x="${W}"/></g>`;
  }
  const speeds = SPEEDS.map((s, i) => `.l${i}{animation-duration:${s}s}`).join('');
  const [a, b, c] = scene.sky;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
<!-- SOMET-742 loading scene "${name}". Generated by frontend/scripts/generate-loading-scenes.mjs -->
<style>@keyframes drift{to{transform:translateX(-${W}px)}}.l0,.l1,.l2,.l3{animation:drift linear infinite}${speeds}@media (prefers-reduced-motion:reduce){.l0,.l1,.l2,.l3{animation:none}}</style>
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset=".8" stop-color="${c}"/></linearGradient>${defs}</defs>
<rect width="${W}" height="${H}" fill="url(#sky)"/>
${scene.glow}
${layers}
${ceiling}
</svg>
`;
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, scene] of Object.entries(SCENES)) fs.writeFileSync(path.join(OUT, `${name}.svg`), render(name, scene));
