import { describe, it, expect } from "vitest";
import { bodyCentroidX, walkAnchorOffsets, walkAnchorFor, walkAnchorTable } from "../walkAnchor.js";

// Build an RGBA buffer, width w, height h, opaque pixels at the given [x,y] list.
function img(w, h, pts) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (const [x, y] of pts) data[(y * w + x) * 4 + 3] = 255;
  return { data, width: w, height: h };
}
const col = (x, y0, y1) => { const o = []; for (let y = y0; y <= y1; y++) o.push([x, y]); return o; };

describe("bodyCentroidX", () => {
  it("averages x of opaque pixels in the top 44% of the rect", () => {
    // 10x10 rect at 0,0: top rows 0..3 count (44% of 10 = 4.4 -> 4 rows)
    const im = img(10, 10, [...col(2, 0, 3), ...col(8, 9, 9)]); // the foot pixel at row 9 is ignored
    expect(bodyCentroidX(im, [0, 0, 10, 10])).toBe(2);
  });
  it("returns null for an empty frame", () => {
    expect(bodyCentroidX(img(10, 10, []), [0, 0, 10, 10])).toBeNull();
  });
});

describe("walkAnchorOffsets", () => {
  it("shifts every frame of a walk row to the row's mean centroid", () => {
    const manifest = { frames: { "walk/e/0": [0, 0, 10, 10], "walk/e/1": [10, 0, 10, 10] } };
    // frame 0 centroid 2, frame 1 centroid 6 (x=16 -> local 6); mean 4
    const im = img(20, 10, [...col(2, 0, 3), ...col(16, 0, 3)]);
    const o = walkAnchorOffsets(manifest, im);
    expect(o["walk/e/0"]).toBe(2);
    expect(o["walk/e/1"]).toBe(-2);
  });
  it("ignores non-walk frames and rows that already agree", () => {
    const manifest = { frames: { "idle/s/0": [0, 0, 10, 10], "walk/s/0": [10, 0, 10, 10], "walk/s/1": [20, 0, 10, 10] } };
    const im = img(30, 10, [...col(2, 0, 3), ...col(15, 0, 3), ...col(25, 0, 3)]);
    expect(walkAnchorOffsets(manifest, im)).toEqual({});
  });
  it("leaves a frame alone when the needed shift exceeds 40% of the cell", () => {
    const manifest = { frames: { "walk/e/0": [0, 0, 10, 10], "walk/e/1": [10, 0, 10, 10] } };
    const im = img(20, 10, [...col(0, 0, 3), ...col(19, 0, 3)]);
    expect(walkAnchorOffsets(manifest, im)).toEqual({});
  });
});

describe("walkAnchorFor", () => {
  it("returns 0 for a missing key and tolerates a null table", () => {
    expect(walkAnchorFor(null, "walk/e/0")).toBe(0);
    expect(walkAnchorFor({ "walk/e/0": 3 }, "walk/e/1")).toBe(0);
    expect(walkAnchorFor({ "walk/e/0": 3 }, "walk/e/0")).toBe(3);
  });
});

// SOMET-764. A tainted atlas makes getImageData throw. That failure is final
// for the image, so it must not be retried every frame: before this, every
// creature on screen rebuilt and re-read its atlas each frame (~100 ms/frame).
describe("walkAnchorTable", () => {
  const manifest = { frames: { "walk/e/0": [0, 0, 4, 4], "walk/e/1": [4, 0, 4, 4] } };
  const fakeCanvas = (read) => {
    const calls = { made: 0, reads: 0 };
    const create = (w, h) => {
      calls.made++;
      return { width: w, height: h, getContext: () => ({ drawImage() {}, getImageData: (...a) => { calls.reads++; return read(...a); } }) };
    };
    return { create, calls };
  };

  it("tries a throwing atlas read once, not on every call", () => {
    const { create, calls } = fakeCanvas(() => { throw new DOMException("tainted", "SecurityError"); });
    const atlas = { width: 8, height: 4 };
    for (let i = 0; i < 5; i++) expect(walkAnchorTable(atlas, manifest, create)).toBeNull();
    expect(calls.reads).toBe(1);
    expect(calls.made).toBe(1);
  });

  it("re-measures an atlas that has no size yet (still decoding)", () => {
    const { create, calls } = fakeCanvas((x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }));
    const atlas = { width: 0, height: 0 };
    expect(walkAnchorTable(atlas, manifest, create)).toBeNull();
    atlas.width = 8; atlas.height = 4;
    expect(walkAnchorTable(atlas, manifest, create)).toEqual({});
    expect(calls.reads).toBe(1);
  });
});
