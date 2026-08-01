import {
  HiOutlinePuzzlePiece, HiOutlineWrenchScrewdriver, HiOutlineBeaker,
  HiOutlineCube, HiOutlineMap, HiOutlineGlobeAlt, HiOutlineShare,
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
      { id: 'worldmap', label: 'World Map',  path: '/game/world-map', Icon: HiOutlineShare,   adminType: 'maps' },
    ],
  },
];

// The sections this visitor may see. Admin-only sections are dropped entirely
// rather than rendered empty, so the "Admin" heading never appears alone.
export function visibleSections(isAdmin) {
  return NAV_SECTIONS.filter((section) => !section.adminOnly || isAdmin);
}
