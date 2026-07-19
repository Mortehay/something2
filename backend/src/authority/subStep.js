// The ONE sub-step resolution shared by every spatial walk in the authority:
// projectile movement, the melee line-of-sight walk, and the AoE blast's
// per-candidate line-of-sight check. Must stay smaller than the thinnest wall
// and than the smallest projectile capture radius, or a fast mover (or a long
// swing, or a blast) can sample straight past an obstacle.
//
// It lives in its own module because projectiles.js and weapons.js both need
// it AND need each other: with the constant defined in either one, requiring
// the other at load time forms a cycle in which `MAX_SUB` resolves to
// `undefined`. That failure is silent and severe — `Math.ceil(dist/undefined)`
// is NaN, the line-of-sight loop never runs, and `hasLineOfSight` returns true
// for every query, disabling terrain blocking everywhere. Keep this leaf
// module dependency-free.
const MAX_SUB = 16;

module.exports = { MAX_SUB };
