// SOMET-598: generated skill icons in the game. Two halves, both pinned:
// the GameArt lookup (lazy, load-once, null-safe) and every skill surface
// drawing the IMAGE when one is ready and its EMOJI when not.
import { describe, it, expect, vi } from "vitest";
import { GameArt, artIcon, drawIconFit } from "../gameArt.js";
import { layoutSkillsPanel, drawSkillsPanel } from "../skillsPanel.js";
import { layoutGemShopPanel, drawGemShopPanel } from "../gemShopPanel.js";
import { RenderSystem } from "../RenderSystem.js";
import { getSkillById } from "../../core/skillsData.js";

// A canvas stand-in that accepts any call and records the two that matter.
function recordingCtx() {
  const texts = [];
  const images = [];
  const props = { imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
  const special = {
    fillText: (t, x, y) => texts.push({ t: String(t), x, y }),
    drawImage: (img, x, y, w, h) => images.push({ img, x, y, w, h, smoothing: props.imageSmoothingEnabled }),
    measureText: (t) => ({ width: String(t).length * 6 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
  };
  const ctx = new Proxy({}, {
    get: (_, k) => (k in special ? special[k] : k in props ? props[k] : () => {}),
    set: (_, k, v) => { props[k] = v; return true; },
  });
  return { ctx, texts, images, props };
}

const IMG = { naturalWidth: 256, naturalHeight: 256, tag: "icon" };

// Art for exactly one skill, so the other surfaces' emoji stay observable.
function artFor(skillId) {
  return { icon: (kind, key) => (kind === "skill" && key === skillId ? IMG : null) };
}

function fakeImageManager() {
  const loaded = new Map();
  return {
    load: vi.fn((name) => { loaded.set(name, null); return Promise.resolve(); }),
    get: (name) => loaded.get(name) || null,
    finish: (name, img) => loaded.set(name, img),
  };
}

describe("GameArt lookup", () => {
  it("is null with no index, for unknown subjects, and for a null key", () => {
    const art = new GameArt(fakeImageManager(), "http://api");
    expect(art.icon("skill", "mag_fireball")).toBe(null);
    art.setIndex({ skill: {} });
    expect(art.icon("skill", "mag_fireball")).toBe(null);
    expect(art.icon("skill", null)).toBe(null);
    expect(art.icon("nope", "x")).toBe(null);
  });

  it("loads lazily, once, from the versioned asset URL, and returns the image once loaded", () => {
    const im = fakeImageManager();
    const art = new GameArt(im, "http://api");
    art.setIndex({ skill: { mag_fireball: { image: "sprites/objects/Fireball/j1/static.png", v: "2026-09-30T10:00:00.000Z" } } });

    expect(art.icon("skill", "mag_fireball")).toBe(null);
    expect(art.icon("skill", "mag_fireball")).toBe(null);
    expect(im.load).toHaveBeenCalledTimes(1);
    expect(im.load).toHaveBeenCalledWith(
      "art:sprites/objects/Fireball/j1/static.png",
      "http://api/api/assets/sprites/objects/Fireball/j1/static.png?v=2026-09-30T10%3A00%3A00.000Z",
    );

    im.finish("art:sprites/objects/Fireball/j1/static.png", IMG);
    expect(art.icon("skill", "mag_fireball")).toBe(IMG);
  });

  it("never re-requests a failed load (icon() runs every frame)", () => {
    const im = fakeImageManager();
    const art = new GameArt(im, "http://api");
    art.setIndex({ item: { 7: { image: "missing.png", v: null } } });
    for (let i = 0; i < 100; i++) expect(art.icon("item", 7)).toBe(null);
    expect(im.load).toHaveBeenCalledTimes(1);
  });

  it("ignores a garbage index instead of throwing", () => {
    const art = new GameArt(fakeImageManager(), "http://api");
    art.setIndex("not an object");
    expect(art.icon("skill", "x")).toBe(null);
    expect(artIcon(null, "skill", "x")).toBe(null);
    expect(artIcon({}, "skill", "x")).toBe(null);
  });
});

describe("drawIconFit", () => {
  it("keeps aspect, centres, and smooths only for its own draw", () => {
    const { ctx, images, props } = recordingCtx();
    drawIconFit(ctx, { naturalWidth: 200, naturalHeight: 100 }, 10, 20, 40);
    expect(images[0]).toMatchObject({ x: 10, y: 30, w: 40, h: 20, smoothing: true });
    expect(props.imageSmoothingEnabled).toBe(false);
    expect(props.imageSmoothingQuality).toBe("low");
  });
});

describe("skill surfaces draw art when ready, emoji otherwise", () => {
  const fireball = getSkillById("mag_fireball");

  it("skills panel: hotbar socket + gem list", () => {
    // The skill on the list's first row, ALSO socketed, so both draw sites
    // are exercised by one subject.
    const first = layoutSkillsPanel({ tab: "all", page: 0 }).gemRows[0].gem;
    const layout = layoutSkillsPanel({ tab: "all", page: 0, hotbarSkills: new Map([[1, first]]) });
    const emojiCount = (r) => r.texts.filter((x) => x.t === first.icon).length;

    const plain = recordingCtx();
    drawSkillsPanel(plain.ctx, layout, {});
    expect(plain.images).toHaveLength(0);
    const sameEmojiElsewhere = layout.gemRows.filter((r) => r.gem.id !== first.id && r.gem.icon === first.icon).length;
    expect(emojiCount(plain)).toBe(2 + sameEmojiElsewhere);

    const withArt = recordingCtx();
    drawSkillsPanel(withArt.ctx, layout, {}, artFor(first.id));
    expect(withArt.images).toHaveLength(2);
    expect(withArt.images.every((d) => d.img === IMG)).toBe(true);
    expect(emojiCount(withArt)).toBe(sameEmojiElsewhere);
  });

  it("gem merchant rows", () => {
    const state = { page: 0 };
    const layout = layoutGemShopPanel(state);
    const shown = layout.rows.map((r) => r.gem);
    const target = shown[0];
    expect(target).toBeTruthy();

    const plain = recordingCtx();
    drawGemShopPanel(plain.ctx, layout, state);
    expect(plain.images).toHaveLength(0);

    const withArt = recordingCtx();
    drawGemShopPanel(withArt.ctx, layout, state, artFor(target.id));
    expect(withArt.images).toHaveLength(1);
    expect(withArt.texts.some((x) => x.t === target.icon)).toBe(
      shown.filter((g) => g.id !== target.id).some((g) => g.icon === target.icon),
    );
  });

  function rsWith(art) {
    const rs = Object.create(RenderSystem.prototype);
    const rec = recordingCtx();
    rs.ctx = rec.ctx;
    rs.gameArt = art;
    return { rs, rec };
  }

  it("HUD skill bar", () => {
    const skills = new Map([[1, { id: "mag_fireball", nameEn: "Fireball", icon: "🔥" }]]);
    const a = rsWith(null);
    a.rs._drawSkillBar(skills, []);
    expect(a.rec.images).toHaveLength(0);
    expect(a.rec.texts.some((x) => x.t === "🔥")).toBe(true);

    const b = rsWith(artFor("mag_fireball"));
    b.rs._drawSkillBar(skills, []);
    expect(b.rec.images).toHaveLength(1);
    expect(b.rec.texts.some((x) => x.t === "🔥")).toBe(false);
  });

  it("active buffs", () => {
    const now = Date.now();
    const buffs = [{ id: "mag_fireball", nameEn: "Fireball", icon: "🔥", startedAt: now, durationMs: 5000, expiresAt: now + 5000 }];
    const a = rsWith(null);
    a.rs._drawActiveBuffs(buffs);
    expect(a.rec.texts.some((x) => x.t === "🔥")).toBe(true);

    const b = rsWith(artFor("mag_fireball"));
    b.rs._drawActiveBuffs(buffs);
    expect(b.rec.images).toHaveLength(1);
    expect(b.rec.texts.some((x) => x.t === "🔥")).toBe(false);
  });

  it("skill tooltip header", () => {
    const a = rsWith(null);
    a.rs._drawSkillTooltip(fireball, 100, 100);
    expect(a.rec.texts.some((x) => x.t.startsWith(`${fireball.icon}  `))).toBe(true);

    const b = rsWith(artFor("mag_fireball"));
    b.rs._drawSkillTooltip(fireball, 100, 100);
    expect(b.rec.images).toHaveLength(1);
    expect(b.rec.texts.some((x) => x.t === fireball.nameEn)).toBe(true);
    expect(b.rec.texts.some((x) => x.t.startsWith(`${fireball.icon}  `))).toBe(false);
  });
});

// The panels are pure and take `art` as an argument, so every panel test above
// would stay green if RenderSystem stopped passing it along -- a dead feature
// under a green suite. These pin the hand-off itself.
describe("RenderSystem hands its GameArt to the panels", () => {
  function rs(art) {
    const r = Object.create(RenderSystem.prototype);
    r.gameArt = art;
    return r;
  }
  const everything = { icon: () => IMG };

  it("skills panel", () => {
    const rec = recordingCtx();
    rs(everything).renderSkillsPanel(rec.ctx, { tab: "all", page: 0 }, []);
    expect(rec.images.length).toBeGreaterThan(0);
  });

  it("gem merchant", () => {
    const rec = recordingCtx();
    rs(everything).renderGemShopPanel(rec.ctx, { page: 0 }, []);
    expect(rec.images.length).toBeGreaterThan(0);
  });
});
