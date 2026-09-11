// The Skill Tree admin tab (SOMET-571): the passive tree and the 300 class
// skills with their generated icons drawn where the game would draw them.
//
// VIEW-ONLY BY DESIGN. Regenerate, describe, mark-the-wrong-part and the
// attempt history all live in the Art console, and every node and card here
// is a link into it, filtered to that one subject. Duplicating any of that
// machinery would be a second console with a worse table.
//
// WHY IN PLACE. The console lists every icon at 32 px in a flat table. That
// cannot answer the two questions that decide whether an icon is any good:
// does it read at the 48 px box the skills panel draws (skillsPanel.js), and
// does it sit inside a node of its sector on the tree? Nothing in the game
// reads catalog_art yet -- the panel still draws the emoji, the tree draws
// plain circles -- so this is the only place either question can be asked.
//
// Every rule (art lookup by kind+key, coverage, viewBox zoom/pan, the console
// link) is in skillTreeView.js and unit-tested there; this file renders them.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styled from 'styled-components';
import { useArtSubjects } from './useArtConsole.js';
import { usePassiveTree } from './usePassiveTree.js';
import { assetUrlVersioned } from './useTileSprites.js';
import { SKILLS_BY_CLASS } from './src/js/core/skillsData.js';
import { SECTOR_HUES, nodeRadius, grantLine } from './src/js/systems/passiveTreePanel.js';
import {
  indexArt, artFor, artCoverage, distinctLabels, onlyMissing,
  treeBounds, zoomViewBox, panViewBox, artConsoleLink, dragStart, dragMove, dragEnd, dragClick,
} from './skillTreeView.js';
import AdminLoading from './AdminLoading.jsx';

// skillsPanel.js: `const iconBoxS = 48`. The smoke test pins this to that
// line, so the card cannot quietly judge fit at a size the game never shows.
const SKILL_ICON_PX = 48;
const CLASSES = Object.keys(SKILLS_BY_CLASS);
const TREE_PAD = 40;
const ZOOM_STEP = 1.2;

const AdminContainer = styled.div`
  padding: 2rem; color: var(--s2-text); max-width: 1400px; margin: 0 auto;
  height: 100%; overflow-y: auto; background-color: var(--s2-surface);
`;
const Header = styled.div`display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;`;
const PageTitle = styled.h1`margin: 0;`;
const Section = styled.section`margin-bottom: 2.5rem;`;
const SectionHead = styled.div`
  display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.75rem;
`;
const SectionTitle = styled.h2`font-size: 1.1rem; margin: 0; color: var(--s2-text-strong);`;
const Hint = styled.p`color: var(--s2-text-muted); font-size: 0.85rem; margin: 0.25rem 0;`;
const Err = styled.p`color: var(--s2-danger); font-size: 0.85rem; margin: 0.25rem 0;`;
const Pill = styled.span`
  font-size: 0.8rem; padding: 0.15rem 0.5rem; border-radius: 999px;
  background: var(--s2-bg-sunken); color: var(--s2-text-muted);
  &[data-missing="true"] { color: var(--s2-warning); }
`;
const Toggle = styled.label`
  display: flex; gap: 0.35rem; align-items: center; font-size: 0.85rem; color: var(--s2-text-muted);
  cursor: pointer;
`;
const Secondary = styled.button`
  background: var(--s2-btn-grey); color: var(--s2-on-accent); border: none; border-radius: 6px;
  padding: 0.35rem 0.8rem; font-size: 0.85rem; cursor: pointer;
`;
const Tabs = styled.div`display: flex; gap: 0.25rem; flex-wrap: wrap;`;
const Tab = styled.button`
  background: var(--s2-surface-raised); color: var(--s2-text); border: 1px solid var(--s2-border);
  border-radius: 6px; padding: 0.35rem 0.8rem; font-size: 0.85rem; cursor: pointer;
  &[data-active="true"] { border-color: var(--s2-accent); color: var(--s2-accent); font-weight: bold; }
`;
const Legend = styled.div`display: flex; gap: 0.75rem; flex-wrap: wrap; font-size: 0.8rem; color: var(--s2-text-muted);`;
const Swatch = styled.span`
  display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 0.3rem;
  vertical-align: middle;
`;
const TreeRow = styled.div`display: grid; grid-template-columns: 1fr 260px; gap: 1rem; align-items: start;`;
const TreeFrame = styled.div`
  border: 1px solid var(--s2-border); border-radius: 8px; overflow: hidden;
  height: 640px; touch-action: none; user-select: none;
  svg { display: block; width: 100%; height: 100%; cursor: grab; }
  svg:active { cursor: grabbing; }
`;
const Side = styled.div`
  background: var(--s2-surface-raised); border: 1px solid var(--s2-border); border-radius: 8px;
  padding: 0.75rem; font-size: 0.85rem; min-height: 120px;
  h3 { margin: 0 0 0.4rem 0; font-size: 0.95rem; color: var(--s2-text-strong); }
  ul { margin: 0.25rem 0 0 0; padding-left: 1.1rem; color: var(--s2-text-muted); }
`;
const SideThumb = styled.div`
  width: 96px; height: 96px; border-radius: 50%; background: var(--s2-bg-sunken);
  background-size: cover; background-position: center; border: 2px solid var(--s2-border-strong);
  margin: 0.5rem 0;
`;
const Grid = styled.div`
  display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 0.5rem;
`;
const Card = styled.button`
  display: flex; gap: 0.6rem; align-items: center; text-align: left;
  background: var(--s2-surface-raised); border: 1px solid var(--s2-border); border-radius: 8px;
  padding: 0.5rem; color: var(--s2-text); cursor: pointer;
  &:hover { border-color: var(--s2-accent); }
  &[data-missing="true"] { border-style: dashed; }
`;
const CardText = styled.div`
  min-width: 0; line-height: 1.25;
  strong { display: block; color: var(--s2-text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  small { color: var(--s2-text-muted); }
`;

/* s2-theme-exempt:start — these two surfaces reproduce the GAME's canvas
   colours on purpose: the skills panel's icon box (skillsPanel.js, "rgba(8,
   5, 15, 0.95)" with the skill's own iconColor as the border) and the passive
   tree window (passiveTreePanel.js). Judging whether an icon fits means
   judging it against the background it will actually sit on, in both modes. */
const GAME_ICON_BG = 'rgba(8, 5, 15, 0.95)';
const GAME_TREE_BG = 'rgba(10, 8, 6, 0.98)';
const GAME_EDGE = '#3a3a4e';
const GAME_NODE_FILL = 'rgba(30, 30, 45, 0.9)';
const GAME_EMOJI = '#e5e7eb';
const IconBox = styled.div`
  flex: 0 0 auto; width: ${SKILL_ICON_PX}px; height: ${SKILL_ICON_PX}px;
  background: ${GAME_ICON_BG}; border: 1.5px solid var(--icon-border, #a855f7);
  background-size: cover; background-position: center;
  display: flex; align-items: center; justify-content: center; font-size: 24px; color: ${GAME_EMOJI};
`;
const Emoji = styled.span`
  flex: 0 0 auto; width: 28px; text-align: center; font-size: 18px; color: ${GAME_EMOJI};
  opacity: 0.8;
`;
/* s2-theme-exempt:end */

// --- Section 1: the passive tree -----------------------------------------------

function TreeGraph({ nodes, edges, art, dimLabels, onHover, onPick }) {
  const svgRef = useRef(null);
  const frameRef = useRef(null);
  const bounds = useMemo(() => treeBounds(nodes, TREE_PAD), [nodes]);
  const [box, setBox] = useState(null);
  const view = box || bounds;
  const drag = useRef(null);

  // `box` is null until the user zooms or pans, so the view follows the tree's
  // own bounds until then, and "reset" is simply forgetting the user's box.
  // The graph is not mounted while the tree loads, so a stale box cannot
  // survive the nodes arriving.

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // World units per screen pixel, from the box and the rendered size. The svg
  // keeps the box's aspect (xMidYMid meet), so one axis is enough.
  const unitsPerPx = () => {
    const el = svgRef.current;
    if (!el) return 1;
    const rect = el.getBoundingClientRect();
    return Math.max(view.w / rect.width, view.h / rect.height);
  };
  const toWorld = (clientX, clientY) => {
    const el = svgRef.current;
    const rect = el.getBoundingClientRect();
    const upp = unitsPerPx();
    // With "meet", the box is centred in the element on the slack axis.
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    return {
      x: cx + (clientX - (rect.left + rect.width / 2)) * upp,
      y: cy + (clientY - (rect.top + rect.height / 2)) * upp,
    };
  };

  // React registers `wheel` passively, so preventDefault there is ignored and
  // the page scrolls under the cursor. A native non-passive listener is the
  // only way to zoom instead.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const focus = toWorld(e.clientX, e.clientY);
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setBox((b) => zoomViewBox(b || bounds, factor, focus.x, focus.y));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // No dependency list on purpose: toWorld reads `view` through its closure,
    // and re-binding on every render is what keeps the focus point correct.
  });

  // The press/move/release/click sequence is the drag gate in skillTreeView.js;
  // this only feeds it events. In particular pointerup does NOT forget the
  // press -- the click that follows a pan needs to know it was a pan.
  const onPointerDown = (e) => {
    drag.current = dragStart(e.clientX, e.clientY);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const { state, dx, dy } = dragMove(drag.current, e.clientX, e.clientY);
    drag.current = state;
    if (!state || !state.pressed) return;
    const upp = unitsPerPx();
    setBox((b) => panViewBox(b || bounds, dx, dy, upp));
  };
  const onPointerUp = () => { drag.current = dragEnd(drag.current); };

  const pick = (node) => {
    const { state, allow } = dragClick(drag.current);
    drag.current = state;
    if (allow) onPick(node);
  };

  const kinds = useMemo(() => [...new Set(nodes.map((n) => n.kind))], [nodes]);

  return (
    <TreeFrame ref={frameRef}>
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ background: GAME_TREE_BG }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => setBox(null)}
      >
        <defs>
          {/* One clip per node KIND, not per node: 1800 clipPaths is a real
              cost, and every node of a kind shares its radius. */}
          {kinds.map((k) => (
            <clipPath key={k} id={`skilltree-clip-${k}`}>
              <circle r={nodeRadius(k)} />
            </clipPath>
          ))}
        </defs>
        <g stroke={GAME_EDGE} strokeWidth={1.5}>
          {edges.map(([a, b]) => {
            const na = byId.get(a);
            const nb = byId.get(b);
            if (!na || !nb) return null;
            return <line key={`${a}-${b}`} x1={na.x} y1={na.y} x2={nb.x} y2={nb.y} />;
          })}
        </g>
        {nodes.map((n) => {
          const r = nodeRadius(n.kind);
          const hue = SECTOR_HUES[n.sector] || SECTOR_HUES.core;
          const a = n.label ? artFor(art, 'passive_label', n.label) : null;
          const dimmed = dimLabels && !dimLabels.has(n.label);
          return (
            <g
              key={n.id}
              transform={`translate(${n.x} ${n.y})`}
              opacity={dimmed ? 0.15 : 1}
              style={{ cursor: n.label ? 'pointer' : 'default' }}
              onPointerEnter={() => onHover(n)}
              onClick={() => pick(n)}
            >
              <title>{n.label || n.key}</title>
              <circle r={r} fill={GAME_NODE_FILL} />
              {a && (
                <image
                  x={-r} y={-r} width={r * 2} height={r * 2}
                  clipPath={`url(#skilltree-clip-${n.kind})`}
                  preserveAspectRatio="xMidYMid slice"
                  href={assetUrlVersioned(a.image, a.updated_at)}
                />
              )}
              {/* Solid ring in the sector hue when art is present; dashed when
                  it is missing, so the gaps read at a glance. */}
              <circle
                r={r} fill="none" stroke={hue} strokeWidth={a ? 2 : 1.5}
                strokeDasharray={a ? undefined : `${Math.max(2, r / 2)} ${Math.max(2, r / 2)}`}
              />
            </g>
          );
        })}
      </svg>
    </TreeFrame>
  );
}

function NodeCard({ node, art }) {
  if (!node) {
    return (
      <Side>
        <h3>Hover a node</h3>
        <Hint>Wheel to zoom, drag to pan, double-click to reset. Click a node to open its label in the Art console.</Hint>
      </Side>
    );
  }
  const a = node.label ? artFor(art, 'passive_label', node.label) : null;
  return (
    <Side>
      <h3>{node.label || '(unlabelled)'}</h3>
      <div>{node.kind} · {node.sector} · ring {node.ring}</div>
      {a
        ? <SideThumb style={{ backgroundImage: `url(${assetUrlVersioned(a.image, a.updated_at)})` }} />
        : <SideThumb />}
      <Pill data-missing={!a}>{a ? 'has art' : 'no art'}</Pill>
      {Array.isArray(node.grants) && node.grants.length > 0 && (
        <ul>{node.grants.map((g, i) => <li key={i}>{grantLine(g)}</li>)}</ul>
      )}
    </Side>
  );
}

// --- Section 2: the class skills --------------------------------------------------

function SkillCard({ skill, art, onPick }) {
  const a = artFor(art, 'skill', skill.id);
  return (
    <Card type="button" data-missing={!a} onClick={() => onPick(skill)} title={skill.descEn}>
      <IconBox
        style={{
          '--icon-border': skill.iconColor,
          backgroundImage: a ? `url(${assetUrlVersioned(a.image, a.updated_at)})` : undefined,
        }}
      >
        {!a && (skill.icon || '⚔️')}
      </IconBox>
      {/* The emoji the panel draws today, beside the icon that would replace
          it -- so "does the art fit" is judged against what the player sees now. */}
      <Emoji aria-hidden="true">{skill.icon}</Emoji>
      <CardText>
        <strong>{skill.nameEn}</strong>
        <small>{skill.type} · {skill.costType} {skill.cost} · cd {skill.cooldown}s</small>
      </CardText>
    </Card>
  );
}

export default function SkillTreeAdmin() {
  const navigate = useNavigate();
  const { subjects, isLoadingSubjects, subjectsError } = useArtSubjects();
  const { nodes, edges, isLoadingTree, treeError } = usePassiveTree();
  const art = useMemo(() => indexArt(subjects), [subjects]);

  const [treeMissingOnly, setTreeMissingOnly] = useState(false);
  const [hover, setHover] = useState(null);
  const [cls, setCls] = useState(CLASSES[0]);
  const [skillsMissingOnly, setSkillsMissingOnly] = useState(false);

  const labels = useMemo(() => distinctLabels(nodes), [nodes]);
  const labelCoverage = artCoverage(art, 'passive_label', labels);
  const missingLabels = useMemo(
    () => new Set(onlyMissing(art, 'passive_label', labels, (l) => l)),
    [art, labels],
  );

  const classSkills = SKILLS_BY_CLASS[cls] || [];
  const skillCoverage = artCoverage(art, 'skill', classSkills.map((s) => s.id));
  const shownSkills = skillsMissingOnly
    ? onlyMissing(art, 'skill', classSkills, (s) => s.id)
    : classSkills;

  const openLabel = (node) => { if (node.label) navigate(artConsoleLink('passive_label', node.label)); };
  const openSkill = (skill) => navigate(artConsoleLink('skill', skill.id));

  return (
    <AdminContainer>
      <Header>
        <PageTitle>Skill Tree</PageTitle>
      </Header>
      <Hint>
        Generated icons drawn where the game would draw them. View only — click anything to open it in
        the Art console, which is where regenerate, describe and mark-the-wrong-part live.
      </Hint>
      {subjectsError && <Err role="alert">{subjectsError.message}</Err>}
      {isLoadingSubjects && <AdminLoading label="Loading catalog art…" inline size={16} />}

      <Section id="passive-tree-section">
        <SectionHead>
          <SectionTitle>Passive tree</SectionTitle>
          <Pill>{labelCoverage.total} labels</Pill>
          <Pill>{labelCoverage.withArt} with art</Pill>
          <Pill data-missing={labelCoverage.missing > 0}>{labelCoverage.missing} missing</Pill>
          <Toggle>
            <input
              type="checkbox"
              checked={treeMissingOnly}
              onChange={(e) => setTreeMissingOnly(e.target.checked)}
            />
            missing only
          </Toggle>
          <Legend>
            {Object.entries(SECTOR_HUES).map(([sector, hue]) => (
              <span key={sector}><Swatch style={{ background: hue }} />{sector}</span>
            ))}
          </Legend>
        </SectionHead>
        {treeError && <Err role="alert">{treeError.message}</Err>}
        {isLoadingTree ? (
          <AdminLoading label="Loading passive tree…" inline size={16} />
        ) : (
          <TreeRow>
            <TreeGraph
              nodes={nodes}
              edges={edges}
              art={art}
              dimLabels={treeMissingOnly ? missingLabels : null}
              onHover={setHover}
              onPick={openLabel}
            />
            <NodeCard node={hover} art={art} />
          </TreeRow>
        )}
      </Section>

      <Section id="class-skills-section">
        <SectionHead>
          <SectionTitle>Class skills</SectionTitle>
          <Tabs>
            {CLASSES.map((c) => (
              <Tab key={c} type="button" data-active={c === cls} onClick={() => setCls(c)}>{c}</Tab>
            ))}
          </Tabs>
          <Pill>{skillCoverage.withArt} / {skillCoverage.total} with art</Pill>
          <Pill data-missing={skillCoverage.missing > 0}>{skillCoverage.missing} missing</Pill>
          <Toggle>
            <input
              type="checkbox"
              checked={skillsMissingOnly}
              onChange={(e) => setSkillsMissingOnly(e.target.checked)}
            />
            missing only
          </Toggle>
          <Secondary type="button" onClick={() => navigate(`/game/art?kind=skill&art=missing`)}>
            Open skills in Art console
          </Secondary>
        </SectionHead>
        <Hint>
          Icons at {SKILL_ICON_PX} px on the skills panel&apos;s box, beside the emoji the panel draws today.
        </Hint>
        <Grid>
          {shownSkills.map((s) => <SkillCard key={s.id} skill={s} art={art} onPick={openSkill} />)}
        </Grid>
        {shownSkills.length === 0 && <Hint>Every {cls} skill has art.</Hint>}
      </Section>
    </AdminContainer>
  );
}
