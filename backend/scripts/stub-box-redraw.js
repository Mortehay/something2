#!/usr/bin/env node
/* eslint-disable no-console */
// THROWAWAY DEV STUB -- NOT PRODUCTION. Never wire this into src/.
//
// A fake GPU box for browser-checking the sprite frame-redraw feature
// (docs/superpowers/specs/2026-10-22-sprite-frame-redraw-admin-design.md)
// without the real box, whose redraw API does not exist yet. It implements
// the [ASSUMED] redraw contract from gpuBoxSprites.redrawFrames, so passing
// against it proves only that OUR side agrees with OUR assumption.
//
// It owns one finished sheet job (STUB_JOB_ID) whose sheet it draws itself:
// actions idle+attack x 8 directions x 6 frames, 48x64 cells, each cell a
// distinct colour (hue by row, lightness by frame) with "<row>" and "f<frame>"
// printed on it, so crop alignment and tint are obvious in a screenshot.
//
//   GET    /api/action-catalog              catalog (fixture shape)
//   GET    /api/jobs?limit=1                auth probe
//   GET    /api/jobs/:id                    sheet job or redraw task status
//   GET    /api/jobs/:id/sheet | /atlas     the CURRENT in-memory sheet / atlas
//   POST   /api/jobs/:id/redraw             {frames:[{action,direction,frame}]} -> {task_id}
//   DELETE /api/jobs/:id                    cancel a task (404 if unknown)
//   POST   /__stub/fail-next                the next accepted redraw fails while running
//   GET    /__stub/state                    debug: tasks + tinted cells
//
// A redraw task is queued ~1 s, running to ~5 s, then done; on done the marked
// cells are tinted red in the in-memory sheet. With fail-next (or
// STUB_FAIL_NEXT=1 at start, or ?fail=1 on the POST) the task is accepted and
// then ends `failed` without touching the sheet.
//
//   node backend/scripts/stub-box-redraw.js            (port STUB_PORT, default 18411)
const http = require('http');
const zlib = require('zlib');

const PORT = Number(process.env.STUB_PORT) || 18411;
const JOB_ID = process.env.STUB_JOB_ID || 'stub-sheet-zzredraw-0001';
const ACTIONS = ['idle', 'attack'];
const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
const FRAMES = 6;
const CW = 48;
const CH = 64;
const W = CW * FRAMES;
const H = CH * ACTIONS.length * DIRECTIONS.length;
const QUEUED_MS = 1000;
const DONE_MS = 5000;

// ---- PNG encoding (RGBA, no filter) -------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- drawing --------------------------------------------------------------
const FONT = { // 3x5 glyphs
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111',
  4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001001001001',
  8: '111101111101111', 9: '111101111001111', f: '011100110100100',
};
function hsl(hDeg, s, l) {
  const k = (n) => (n + hDeg / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
const sheet = Buffer.alloc(W * H * 4);
function px(x, y, [r, g, b], a = 255) {
  const i = (y * W + x) * 4;
  sheet[i] = r; sheet[i + 1] = g; sheet[i + 2] = b; sheet[i + 3] = a;
}
function text(str, x0, y0, scale, color) {
  let x = x0;
  for (const ch of str) {
    const g = FONT[ch];
    if (g) {
      for (let gy = 0; gy < 5; gy += 1) {
        for (let gx = 0; gx < 3; gx += 1) {
          if (g[gy * 3 + gx] === '1') {
            for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) px(x + gx * scale + dx, y0 + gy * scale + dy, color);
          }
        }
      }
    }
    x += 4 * scale;
  }
}
function drawCell(row, frame) {
  const x0 = frame * CW;
  const y0 = row * CH;
  // Hues 30..300: no row starts out red, so the red tint is unambiguous.
  const fill = hsl(30 + (row * 270) / 15, 0.75, 0.35 + frame * 0.07);
  // 3 px transparent margin around an opaque body, so cell edges are visible.
  for (let y = 3; y < CH - 3; y += 1) for (let x = 3; x < CW - 3; x += 1) px(x0 + x, y0 + y, fill);
  text(String(row).padStart(2, '0'), x0 + 8, y0 + 8, 4, [255, 255, 255]);
  text(`f${frame}`, x0 + 8, y0 + 34, 4, [0, 0, 0]);
}
const rows = [];
ACTIONS.forEach((action, ai) => DIRECTIONS.forEach((direction, di) => {
  const row = ai * DIRECTIONS.length + di;
  rows.push({ row, action, direction });
  for (let f = 0; f < FRAMES; f += 1) drawCell(row, f);
}));
function tintCell(row, frame) {
  for (let y = row * CH; y < (row + 1) * CH; y += 1) {
    for (let x = frame * CW; x < (frame + 1) * CW; x += 1) {
      const i = (y * W + x) * 4;
      if (sheet[i + 3] === 0) continue;
      sheet[i] = Math.round(sheet[i] * 0.3 + 178);
      sheet[i + 1] = Math.round(sheet[i + 1] * 0.3);
      sheet[i + 2] = Math.round(sheet[i + 2] * 0.3);
    }
  }
}

const atlas = () => ({
  cell: { w: CW, h: CH },
  grid: { columns: FRAMES, rows: rows.length },
  directions: DIRECTIONS,
  frames_per_action: FRAMES,
  rows,
  // One frame fails the box's quality check, so the "flagged" badge shows.
  quality: [
    { action: 'attack', direction: 'e', frame: 4, passed: false, failed_checks: ['silhouette'], attempts: 3 },
    { action: 'idle', direction: 's', frame: 1, passed: true, failed_checks: [], attempts: 1 },
  ],
  image: `sheet_${JOB_ID}.png`,
});

// ---- tasks -----------------------------------------------------------------
const tasks = new Map();
const tinted = [];
let failNext = process.env.STUB_FAIL_NEXT === '1';
let seq = 0;

function taskStatus(t) {
  if (t.final) return t.final;
  const age = Date.now() - t.created;
  if (age < QUEUED_MS) return 'queued';
  if (age < DONE_MS) return 'running';
  if (t.fail) {
    t.final = 'failed';
  } else {
    for (const f of t.frames) {
      const r = rows.find((x) => x.action === f.action && x.direction === f.direction);
      tintCell(r.row, f.frame);
      tinted.push(`${f.action}/${f.direction}/${f.frame}`);
    }
    t.final = 'done';
  }
  return t.final;
}
// Tasks advance on their own, not only when polled.
setInterval(() => { for (const t of tasks.values()) taskStatus(t); }, 250).unref();

function send(res, status, body, type = 'application/json') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
}
function readBody(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  });
}

const CATALOG = {
  actions: ['attack', 'cast', 'damage', 'idle', 'sway', 'use', 'walk'].map((id) => ({ id, label: id, max_frames: 6 })),
  directions: DIRECTIONS.map((id) => ({ id })),
  max_frames: 6,
  engine: 'stub-box-redraw',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://stub');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}${url.search}`);
  try {
    if (req.method === 'POST' && url.pathname === '/__stub/fail-next') { failNext = true; return send(res, 200, { failNext }); }
    if (req.method === 'GET' && url.pathname === '/__stub/state') {
      return send(res, 200, { failNext, tinted, tasks: [...tasks.values()].map((t) => ({ id: t.id, status: taskStatus(t), frames: t.frames })) });
    }
    if (req.method === 'GET' && url.pathname === '/api/action-catalog') return send(res, 200, CATALOG);
    if (parts[0] !== 'api' || parts[1] !== 'jobs') return send(res, 404, { detail: 'not found' });
    if (parts.length === 2 && req.method === 'GET') return send(res, 200, { jobs: [] });
    const id = parts[2];
    const sub = parts[3];
    if (id === JOB_ID) {
      if (req.method === 'GET' && !sub) {
        return send(res, 200, { job_id: JOB_ID, status: 'done', stage: 'compose', progress_pct: 100, progress_msg: 'complete', error: null });
      }
      if (req.method === 'GET' && sub === 'sheet') return send(res, 200, encodePng(sheet, W, H), 'image/png');
      if (req.method === 'GET' && sub === 'atlas') return send(res, 200, atlas());
      if (req.method === 'POST' && sub === 'redraw') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (_) { return send(res, 400, { detail: 'bad json' }); }
        const frames = Array.isArray(body && body.frames) ? body.frames : [];
        const bad = frames.find((f) => !rows.some((r) => r.action === f.action && r.direction === f.direction)
          || !Number.isInteger(f.frame) || f.frame < 0 || f.frame >= FRAMES);
        if (!frames.length || bad) return send(res, 400, { detail: `bad frame ${JSON.stringify(bad)}` });
        seq += 1;
        const task = { id: `stub-redraw-task-${seq}`, created: Date.now(), frames, fail: failNext || url.searchParams.get('fail') === '1' };
        failNext = false;
        tasks.set(task.id, task);
        console.log(`  redraw task ${task.id}: ${frames.map((f) => `${f.action}/${f.direction}/${f.frame}`).join(' ')}${task.fail ? ' (WILL FAIL)' : ''}`);
        return send(res, 200, { task_id: task.id });
      }
      if (req.method === 'DELETE' && !sub) return send(res, 200, { cancelled: false, detail: 'sheet job already done' });
    }
    const t = tasks.get(id);
    if (!t) return send(res, 404, { detail: `no job ${id}` });
    if (req.method === 'GET' && !sub) {
      const status = taskStatus(t);
      const age = Date.now() - t.created;
      return send(res, 200, {
        job_id: t.id,
        status,
        stage: 'redraw',
        progress_pct: status === 'done' ? 100 : status === 'queued' ? 0 : Math.min(99, Math.round((100 * (age - QUEUED_MS)) / (DONE_MS - QUEUED_MS))),
        progress_msg: status === 'failed' ? 'failed' : `redrawing ${t.frames.length} frames`,
        error: status === 'failed' ? 'stub: forced redraw failure (fail-next)' : null,
      });
    }
    if (req.method === 'DELETE' && !sub) {
      if (!t.final) t.final = 'cancelled';
      return send(res, 200, { cancelled: true });
    }
    return send(res, 404, { detail: 'not found' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { detail: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`stub box on http://127.0.0.1:${PORT} job ${JOB_ID} sheet ${W}x${H}`));
