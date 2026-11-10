# Amber Stance — arrival protection

Status: draft for owner review, 2026-11-10.

## Why

A character who arrives on a map can't see or react yet. The map, its creatures and the other characters are still loading or drawing. Today a creature or a player standing at the arrival point can kill them in that window. Amber Stance seals the arriving character in a block of amber until their game is ready, plus a short grace period. Arriving should never be the moment someone dies.

## What the player sees

- On arrival the character stands inside a translucent amber block, with smoke drifting around its base. The character stays visible inside.
- A countdown of whole seconds floats above the character's head. Everyone nearby sees the same number.
- When it ends, the amber **fades away** (owner's choice, over ~0.4 s, a builder's call). It doesn't crack or shatter.
- There are 10 amber sprite variants. Each time a character is sealed, it gets one at random.

## Rules (owner-decided)

**Triggers.** Each of these seals the character:
1. walking through a portal;
2. crossing onto another map;
3. logging in;
4. coming back after death, whether the respawn is in the same world or another one.

**While sealed:**
- the character can't move or attack, which includes skills and casting;
- no creature and no other player can hurt them.

**It ends at whichever comes first:**
- **10 s after the player's game reports it has finished drawing** the map, the entities and the other characters;
- **30 s after arrival.** This hard cap always applies, even if the game never reports ready.
- **The player breaks out early.** This is allowed only after the game has reported ready, so a key pressed during loading doesn't break the amber blind.

**Protection ends at the same moment the amber does.** Nobody walks around unhittable.

## Behaviour details (my calls; owner may override)

- **The server owns the timer.**
  - On arrival it records `startedAt`, `hardEndAt = startedAt + 30 s` and `endAt = hardEndAt`.
  - When the client sends its ready message, `endAt = min(hardEndAt, readyAt + 10 s)`.
  - A ready message sent twice, or after the amber has ended, is ignored.
  - A client that stalls the ready message gains nothing past 30 s. A client that sends it instantly only shortens its own protection.
- **What breaks it early:** any move input, attack input, skill key, or click on the ground, once the game has reported ready. The client sends a break message and the server ends the amber that tick. A break before ready is ignored by the server too, not only by the client.
- **Untargetable, not "hit for zero":**
  - Creatures don't pick a sealed player as a target. A creature that was already chasing them drops them and may pick them again once the amber ends.
  - Player attacks, projectiles, area skills, auras and damage over time deal no damage to a sealed player. Enforce this at the single damage choke point (`applyDamage` in `backend/src/authority/damage.js`) **and** at targeting, so no damage path is missed.
  - No new debuffs, knockback or crowd control land on a sealed player.
- **Still allowed while sealed:** chat, opening inventory and menus, equipping. Using world objects (chests, merchants, portals, quest givers) is blocked. **Interaction keys** don't break the amber; only move and attack inputs do.
- **The countdown number** is `ceil((endAt − now) / 1000)`. Before ready it counts toward the 30 s cap, so it can drop from, say, 27 to 10 when the game reports ready. That drop is expected.
- **Variant pick:**
  - The server picks the variant at sealing time, from the variants that have an **approved** sprite, and sends it with the amber state. Everyone sees the same variant for that character.
  - If no variant is approved yet, the game draws a code-drawn amber block with code-drawn smoke, so the feature works before any art exists.
- **Damage that skips `applyDamage`:** several paths subtract hp directly, such as life-cost skills (`world.js`, `teleportCast.js`).
  - These are all self-inflicted costs of casting, and casting is blocked while sealed, so they can't happen.
  - Any outside damage that writes hp directly must also respect the seal. The plan audits every `hp -=` write.
- **Help from others still lands.** Heals, buffs and beneficial auras from other players still apply to a sealed player. The seal only blocks harm.
- **Nothing moves a sealed player.**
  - Knockback, pulls and other forced movement don't apply.
  - Portal and edge triggers under them don't fire while sealed.
  - A teleport cast started before arrival is cancelled.
- **Projectiles pass through.** A projectile already in flight goes through a sealed player without hitting them or being used up. Boss redirect/soak mechanics skip sealed players.
- **Each arrival gets its own seal.**
  - The server sends an arrival id with the amber state, and the client's ready and break messages carry it back.
  - A message carrying an older arrival id is ignored, so a late "ready" from the previous map can't shorten a new seal.
  - A new trigger while sealed starts a fresh seal: new timer, new variant.
- **Trade and party:** trade windows and party invites work as usual while sealed. They neither hurt the character nor move them.
- **No cooldown on re-sealing.** Reconnecting over and over keeps a character sealed, but a sealed character can't do anything except chat and manage inventory, so there's nothing to exploit.
- **Accepted, not prevented:** stepping through a portal to escape a fight, or logging out and back in, grants a fresh amber. Arrival already moves you away from the fight. We'll revisit if it gets abused.

## Tuning

Two `game_settings` keys:
- `amber_max_seconds`, default 30;
- `amber_after_ready_seconds`, default 10.

Edit them where the other game settings are edited. The values are read at sealing time.

## Art

- **10 rows, `amber_stance_1` … `amber_stance_10`.** They are the first members of a new **Status visuals** group on the Sprite tab. This group starts project 5 of the effects roadmap ("status and world visuals"). The rows live in a small table of their own (`status_visuals`). They don't go in `buff_visuals`, because amber isn't a skill buff.
- **Drawing:**
  - Generated on the GPU box through the existing effect-sprite pipeline.
  - **Nothing is auto-approved.** The owner approves each variant in the Sprite tab.
  - The prompt describes a translucent amber crystal block, sized to enclose a standing figure, with wisps of smoke at the base, as a looping animation.
  - The 10 variants share the idea but use different seeds and small prompt variations (shade, cracks, smoke density). The variations come from the prompt writer.
- **Box kind:** use the box `shell` kind if the box has shipped it by build time; this was requested earlier for body buffs and fits "a shell around a figure". Otherwise, the closest existing kind. Don't block on the box.
- **Drawing order:** the amber sprite draws **over** the character, at an opacity the builder tunes so the character reads through it.
- **Seed/export:** the new table travels through seed/export with the art.
  - Add it to the seed-sync registry and to the checked-in `backend/seeds/sync/art.json`. Otherwise the whole Art seed is refused; the guard test `seed_sync_checked_in_files.test.js` catches this.
  - The migration freezes its seed rows and requires no application code.

## Goals

- No arriving character dies or takes damage before their game has drawn the world.
- The rule holds on every arrival path (portal, map crossing, login, respawn) and every damage path.
- Others can see that the character is protected and for how long.

## Non-goals

- No arrival grace for creatures.
- No crack/shatter animation.
- No per-map or per-portal timing.
- No admin screen beyond the Sprite tab rows and the two settings.

## Anti-goals (failure even if it "works")

- A character stays unhittable after they can move.
- A stalled client keeps someone sealed or protected past 30 s.
- One damage path (a DoT, a projectile already in flight, a boss aura) still hurts a sealed character.
- Sealed characters render with a missing or broken sprite instead of the code-drawn fallback.

## Constraints

- Server-authoritative: the client never decides protection, only reports ready and requests a break.
- Tests must not touch the shared dev DB. Use private test databases, as in recent projects.
- Arrival points live in `backend/src/authority/server.js` (join/`addPlayer`, cross-world move, death respawn). The amber must be applied after the player's final position is set, so a respawn relocation can't skip it.

## Left to the builder

- The message names for ready and break, and where the client decides "finished drawing". The existing loading-screen/preload completion plus the first full frame is the expected signal.
- Fade timing, countdown font and styling, amber overlay opacity.
- How amber state rides the snapshot (per-player `amber: { endsInMs, variant }` or similar).
