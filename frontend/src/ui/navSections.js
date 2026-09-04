import {
  HiOutlinePuzzlePiece, HiOutlineWrenchScrewdriver, HiOutlineBeaker,
  HiOutlineCube, HiOutlineMap, HiOutlineGlobeAlt, HiOutlineShare, HiOutlineBolt, HiOutlineSparkles,
  HiOutlineCpuChip, HiOutlineChartBar, HiOutlineGlobeAmericas, HiOutlinePhoto,
} from "react-icons/hi2";

// One source of truth for the sidebar: label, route, icon and the admin colour
// coding inherited from the old TabBar. Route paths here MUST match the child
// routes registered in App.jsx -- navRoutes.test.js checks that they do.
//
// `adminType` reproduces the TabBar's colour groups (entity=yellow,
// items=pink, maps=green) as the active link's accent stripe, so the visual
// grouping players and admins already learned survives the move to a sidebar.
export const NAV_SECTIONS = [
  {
    title: null,          // no heading -- this is the default destination
    adminOnly: false,
    items: [
      { id: 'game', label: 'Game View', path: '/game', Icon: HiOutlinePuzzlePiece },
      // The PLAYER's read-only fog-of-war map (SOMET-263), not the admin
      // editor below. Both are called "World Map" to the person looking at
      // them, so the admin one is relabelled rather than this one -- a player
      // should see the plain name for the only map they have.
      { id: 'playermap', label: 'World Map', path: '/game/map', Icon: HiOutlineGlobeAlt },
    ],
  },
  {
    title: 'Admin',
    adminOnly: true,
    items: [
      { id: 'tiles',    label: 'Tile Types', path: '/game/tiles',     Icon: HiOutlineWrenchScrewdriver },
      { id: 'entities', label: 'Entities',   path: '/game/entities',  Icon: HiOutlineBeaker,  adminType: 'entity' },
      { id: 'items',    label: 'Items',      path: '/game/items',     Icon: HiOutlineCube,    adminType: 'items' },
      { id: 'maps',     label: 'Maps',       path: '/game/maps',      Icon: HiOutlineMap,     adminType: 'maps' },
      { id: 'biomes',   label: 'Biomes',     path: '/game/biomes',    Icon: HiOutlineGlobeAlt, adminType: 'maps' },
      { id: 'creature-behaviors', label: 'Creature Behaviors', path: '/game/creature-behaviors', Icon: HiOutlineBolt, adminType: 'entity' },
      { id: 'vfx', label: 'Attack Effects', path: '/game/vfx', Icon: HiOutlineSparkles, adminType: 'entity' },
      // Relabelled, not moved: the id is referenced elsewhere and the path is
      // the admin route. See the player entry in the section above.
      { id: 'worldmap', label: 'World Map Editor', path: '/game/world-map', Icon: HiOutlineShare, adminType: 'maps' },
      // Regions fetched from the remote world-spec generator. Sits beside the
      // map editors rather than next to AI Providers: an admin comes here to
      // look at CONTENT -- what a region holds, whether it will seed -- and
      // the connector it happens to be reached through is configuration they
      // set once. adminType 'maps' for the same reason.
      { id: 'generated-worlds', label: 'Generated Worlds', path: '/game/generated-worlds', Icon: HiOutlineGlobeAmericas, adminType: 'maps' },
      // Progression epic T1 (SOMET-469): the game_settings editor, plus the
      // mount points the affix (T12) and passive-node (T9) admin sections
      // land in. Content rather than configuration, so it sits above the
      // AI Providers entry.
      { id: 'progression', label: 'Progression', path: '/game/admin/progression', Icon: HiOutlineChartBar, adminType: 'entity' },
      // SOMET-538: the mass-generation console. Sits directly above AI
      // Providers because the two are used together -- you point the game at a
      // machine there, then drive a batch through it here -- and because both
      // are about how art gets made rather than about one catalogue.
      { id: 'art', label: 'Art Generation', path: '/game/art', Icon: HiOutlinePhoto },
      // SOMET-330: registered remote image-generation services. Sits last
      // because it is configuration rather than content -- an admin opens it
      // once to point the game at a machine, not every session.
      { id: 'settings', label: 'AI Providers', path: '/game/settings', Icon: HiOutlineCpuChip },
    ],
  },
];

// The sections this visitor may see. Admin-only sections are dropped entirely
// rather than rendered empty, so the "Admin" heading never appears alone.
export function visibleSections(isAdmin) {
  return NAV_SECTIONS.filter((section) => !section.adminOnly || isAdmin);
}
