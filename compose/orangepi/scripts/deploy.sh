#!/usr/bin/env bash
# `make pi-deploy` (SOMET-427): move the board to the tip of the deployment
# branch. Also what the CI deploy hook runs, so everything here has to be safe
# unattended.
#
# Shape of a deploy:
#
#   fetch --force + reset --hard   the board's checkout is a DEPLOYMENT
#                                  ARTEFACT, not a workspace; a local edit
#                                  that blocked a deploy would be a worse
#                                  problem than losing the edit
#   pull image, else build         a pull is under a minute, a build on four
#                                  A53 cores is ten to twenty and competes
#                                  with the running game for memory
#   migrate as its OWN step        never a side effect of the server booting.
#                                  This repository has previously had a dev
#                                  server auto-apply half-written migrations;
#                                  doing that to a live world is worse
#   stop, then start               the authority is stateful and
#                                  single-instance -- two of it disagree about
#                                  the same world

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_pi_env
require_env GIT_REPOSITORY ORANGEPI_BRANCH

APP="$ORANGEPI_APP_DIR"
COMPOSE="$(pi_compose_cmd)"
PROFILES="$(pi_profiles)"

# ghcr.io/<owner>/<repo>-<service>, derived from the clone url so there is one
# place to change it. Overridable for a fork or a different registry.
derive_image_prefix() {
  local url="${GIT_REPOSITORY%.git}"
  case "$url" in
    *github.com[:/]*) ;;
    *)
      # Anything else would produce a nonsense prefix, every pull would fail,
      # and every deploy would silently take the twenty-minute board build --
      # working, but slow for a reason nothing on screen explains.
      printf 'GIT_REPOSITORY (%s) is not a github.com url, so the GHCR image name cannot be derived from it.\n' "$GIT_REPOSITORY" >&2
      printf 'set ORANGEPI_IMAGE_PREFIX explicitly, e.g. ORANGEPI_IMAGE_PREFIX=ghcr.io/owner/repo\n' >&2
      return 1
      ;;
  esac
  local path="${url#*github.com/}"
  path="${path#*github.com:}"
  printf 'ghcr.io/%s' "$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')"
}
IMAGE_PREFIX="${ORANGEPI_IMAGE_PREFIX:-$(derive_image_prefix)}"

if [ -n "${PI_LOCAL:-}" ]; then
  WHERE="on the board itself"
else
  WHERE="${ORANGEPI_LOGIN}@${ORANGEPI_ADDRESS}"
fi

# ORANGEPI_LOGIN and ORANGEPI_ADDRESS describe how to REACH the board, and in
# PI_LOCAL mode there is nothing to reach -- this is running on it. They are
# therefore not required there, and must not be dereferenced bare under
# `set -u`: the deploy hook's first working run died on exactly that, one line
# into a script that had otherwise resolved everything it needed.
printf '%sboard%s      %s\n%sbranch%s     %s\n%simages%s     %s-{backend,caddy}\n\n' \
  "$C_BOLD" "$C_OFF" "$WHERE" \
  "$C_BOLD" "$C_OFF" "$ORANGEPI_BRANCH" \
  "$C_BOLD" "$C_OFF" "$IMAGE_PREFIX"

# --- One deploy at a time (SOMET-715) --------------------------------------
#
# Taken before anything touches the board. Exit 75 (EX_TEMPFAIL) means "another
# deploy is running, nothing was done" so a caller can tell it from a failure.
# The trap releases the lock only if THIS run took it: a run that exits 75 must
# not delete the lock of the deploy that is still going.
PI_DEPLOY_LOCK_HELD=0
release_deploy_lock() {
  if [ "$PI_DEPLOY_LOCK_HELD" = 1 ]; then
    PI_DEPLOY_LOCK_HELD=0
    pi_deploy_unlock
  fi
}
trap release_deploy_lock EXIT
trap 'exit 143' TERM HUP
trap 'exit 130' INT

lock_rc=0
pi_deploy_lock || lock_rc=$?
if [ "$lock_rc" -eq 0 ]; then
  PI_DEPLOY_LOCK_HELD=1
elif [ "$lock_rc" -eq 75 ]; then
  printf 'another deploy is running (lock: %s); nothing was changed.\n' "$(pi_deploy_lock_dir)" >&2
  exit 75
elif [ "$lock_rc" -eq 74 ]; then
  printf 'cannot create the deploy lock %s: the directory is not writable.\n' "$(pi_deploy_lock_dir)" >&2
  if [ -n "${PI_LOCAL:-}" ]; then
    printf 'the deploy hook mounts the data directory read-only except locks/; that mount changes only with `make pi-up`.\n' >&2
  fi
  exit 74
else
  printf 'could not take the deploy lock on the board (exit %s).\n' "$lock_rc" >&2
  exit 1
fi

# --- Already there? ---------------------------------------------------------
#
# The hook's own image is not rebuilt by a deploy, so PI_LOCAL always asks this
# question; from the workstation only PI_SKIP_IF_CURRENT=1 does, and a plain
# `make pi-deploy` always redeploys. "At the target and healthy" is NOT enough
# (SOMET-717): this script resets HEAD early, so a deploy that failed after its
# reset, or one still running, leaves HEAD at the target with the OLD backend
# serving, and restarting that old backend would not change it. The board is
# settled only when the marker of the last COMPLETED deploy names HEAD (see
# pi_state_settled). The lock is ours by now, so it is not asked;
# inside the hook, hook_deploying is this very deploy, so it is not asked either.
if [ -n "${PI_SKIP_IF_CURRENT:-}" ] || [ -n "${PI_LOCAL:-}" ]; then
  q_app="$(printf '%q' "$APP")"
  if pi_ssh "git -C $q_app fetch --force --prune origin $(printf '%q' "$ORANGEPI_BRANCH")" >/dev/null 2>&1; then
    target_sha="$(pi_ssh "git -C $q_app rev-parse $(printf '%q' "origin/$ORANGEPI_BRANCH")" 2>/dev/null || true)"
    board_state="$(pi_deploy_state 2>/dev/null || true)"
    if pi_state_settled "$board_state" "$target_sha" "${PI_LOCAL:-}"; then
      printf 'already at %s and settled; nothing to deploy.\n' "${target_sha:0:7}"
      exit 0
    fi
  fi
fi

# Last lines of a failed deploy, for the update job to quote: which steps failed, and whether the
# stack came up anyway. Printed after finish's summary (see lib.sh).
STACK_UP=0
finish_trailer() {
  local i names=""
  for i in "${!STEP_NAMES[@]}"; do
    if [ "${STEP_STATUS[$i]}" != "ok" ]; then names="${names:+$names; }${STEP_NAMES[$i]}"; fi
  done
  printf 'failed-steps=%s\n' "$names"
  [ "$STACK_UP" -eq 1 ] && printf 'stack=up\n'
  return 0
}

# --- Where the board is now ------------------------------------------------

# From here this is a real deploy. The marker of the last COMPLETED deploy goes
# first, so a deploy that fails at any later step leaves none: HEAD is about to
# move while the old containers keep serving, and nothing may call that settled.
MARKER="$(pi_deployed_marker)"
if ! pi_ssh "rm -f $(printf '%q' "$MARKER")" >/dev/null 2>&1; then
  printf 'could not clear the deployed-sha marker %s (the locks directory is not writable, or the connection dropped). Nothing has changed yet.\n' "$MARKER" >&2
  exit 1
fi

FROM_COMMIT="$(pi_ssh "git -C $(printf '%q' "$APP") rev-parse --short HEAD 2>/dev/null" || true)"
FROM_COMMIT="${FROM_COMMIT:-(none)}"

fetch_and_reset() {
  pi_ssh "APP=$(printf '%q' "$APP") BRANCH=$(printf '%q' "$ORANGEPI_BRANCH") bash -s" <<'REMOTE'
set -euo pipefail
cd "$APP"
git fetch --force --prune origin "$BRANCH"
# --hard, deliberately: see the header. Anything the board has locally is
# either a deploy artefact or an accident.
git reset --hard "origin/$BRANCH"
git clean -fd
git log -1 --format='now at %h %s'
REMOTE
}
run_step "fetch and reset to origin/$ORANGEPI_BRANCH" fetch_and_reset

TO_COMMIT="$(pi_ssh "git -C $(printf '%q' "$APP") rev-parse --short HEAD")"
SHA="$(pi_ssh "git -C $(printf '%q' "$APP") rev-parse HEAD")"

# --- Images: pull, or build on the board -----------------------------------

# Set by the pull step so the summary can say which path was taken. An
# operator seeing a nineteen-minute deploy needs to know it built rather than
# guessing from the duration.
IMAGE_SOURCE="build"

try_pull() {
  # Both images or neither: a backend from CI paired with a locally built
  # frontend is a combination nobody tested.
  pi_ssh "docker pull $(printf '%q' "${IMAGE_PREFIX}-backend:${SHA}") \
       && docker pull $(printf '%q' "${IMAGE_PREFIX}-caddy:${SHA}")"
}

# Run first, described afterwards. A missing image is NOT a failure -- it is
# the documented fallback (a commit that never went through CI, a manual
# dispatch, a build still running) -- so the step is reported for what it
# actually was rather than as a failure the summary then contradicts.
pull_start=$(now_ns)
if try_pull >/dev/null 2>&1; then
  IMAGE_SOURCE="registry"
  export ORANGEPI_BACKEND_IMAGE="${IMAGE_PREFIX}-backend:${SHA}"
  export ORANGEPI_FRONTEND_IMAGE="${IMAGE_PREFIX}-caddy:${SHA}"
fi
pull_elapsed=$(awk "BEGIN{printf \"%.1f\", ($(now_ns) - $pull_start)/1000000000}")

if [ "$IMAGE_SOURCE" = "registry" ]; then
  record_step "images for ${SHA:0:7}: pulled from the registry" ok "$pull_elapsed"
else
  record_step "images for ${SHA:0:7}: none published, building on the board" ok "$pull_elapsed"
  printf '  %sa board build takes 10-20 minutes on four A53 cores; a pull takes under one%s\n' \
    "$C_YELLOW" "$C_OFF"
fi

# A prefix for every compose command that runs over pi_ssh. It has to be an
# `export` statement: the command is `<prefix> cd <app> && docker compose ...`,
# and a bare `A=x B=y cd ...` applies the variables to `cd` ALONE, so compose
# silently fell back to its `:local` default (seen on the board). Empty values
# are left out entirely so compose uses its default, and so an empty export
# cannot beat a recorded images file.
IMAGE_ENV=""
if [ -n "${ORANGEPI_BACKEND_IMAGE:-}" ]; then
  IMAGE_ENV="$IMAGE_ENV ORANGEPI_BACKEND_IMAGE=$(printf '%q' "$ORANGEPI_BACKEND_IMAGE")"
fi
if [ -n "${ORANGEPI_FRONTEND_IMAGE:-}" ]; then
  IMAGE_ENV="$IMAGE_ENV ORANGEPI_FRONTEND_IMAGE=$(printf '%q' "$ORANGEPI_FRONTEND_IMAGE")"
fi
[ -z "$IMAGE_ENV" ] || IMAGE_ENV="export${IMAGE_ENV};"

IMAGES_FILE="$(pi_deployed_images_file)"

if [ "$IMAGE_SOURCE" = "build" ]; then
  # A recorded pulled image would otherwise be passed to compose below and
  # beat the image this build produces.
  run_step "forget the recorded images" pi_ssh "rm -f $(printf '%q' "$IMAGES_FILE")"
  run_step "build images on the board" pi_ssh "$IMAGE_ENV $COMPOSE build"
fi

# --- Migrations, as their own step ----------------------------------------

# `run --rm` on a ONE-OFF container, not `exec` into the running one: at this
# point the old version is still serving, and migrations must be applied by
# the new code before the new code starts. A failure here aborts the deploy
# with the previous version still running and untouched.
migrate() {
  pi_ssh "$IMAGE_ENV $COMPOSE run --rm --no-deps -e MIGRATE_ON_BOOT= backend npm run migrate:up"
}
if ! run_step "run migrations" migrate; then
  cat >&2 <<MSG

${C_RED}the deploy was aborted by a failed migration.${C_OFF}
the board is still running the previous version (${FROM_COMMIT}); nothing was
restarted. fix the migration, push, and deploy again.
MSG
  finish "pi-deploy (aborted)"
  exit 1
fi

# --- Catalogs, right after the schema they live in ------------------------
#
# seed-catalogs RESTORES WHAT IS MISSING and writes nothing otherwise, so it
# is safe on every deploy and reports 0 in the steady state. It belongs here
# because a migration creates a catalog TABLE while the rows come from
# checked-in seed data -- exactly the split that let chest_loot exist empty in
# production for months (SOMET-438): every layer worked, the content was
# simply never carried over. Without this, each new catalog needs somebody to
# remember a manual step on the board.
#
# Soft: a catalog that fails to seed leaves the game playable (the previous
# rows are still there), so it must not abort a deploy that has already
# migrated. It is reported as a failed step either way.
seed_catalogs() {
  pi_ssh "$IMAGE_ENV $COMPOSE run --rm --no-deps backend node scripts/seed-catalogs.js"
}
run_step_soft "restore any missing catalog rows" seed_catalogs

# --- The passive tree, which is a catalog that needs --force ---------------
#
# SOMET-524. Unlike seed-catalogs above, seed-passive-tree does NOT restore
# what is missing by default: its upsert writes `grants` only under --force
# (`CASE WHEN $10 OR EXCLUDED.kind = 'start'`), because the admin UI can
# hand-tune a node and an ordinary reseed must not cost an admin that edit.
#
# So a retune of the checked-in spec reaches the board ONLY with --force. A
# deploy that ran the unforced variant would ship a tree that is retuned in the
# repo and unchanged in the database -- and EVERY TEST WOULD STILL PASS, since
# the tests read the generator, not the board. That is the failure mode this
# step exists to prevent, and it is why --force is not optional here.
#
# The refund migration (1714440521000) has already run in the migrate step
# above, which is the required order: --force prunes nodes the generator no
# longer produces and deletes their character_passives rows on the way, so the
# refund must count them first.
#
# Soft, like the catalogs: a tree that fails to reseed leaves the previous tree
# in place and the game playable.
seed_passive_tree() {
  pi_ssh "$IMAGE_ENV $COMPOSE run --rm --no-deps backend node scripts/seed-passive-tree.js --force"
}
run_step_soft "reseed the passive tree (--force)" seed_passive_tree

# --- Restart ---------------------------------------------------------------

# Stop then start, never an overlap: the authority holds an in-memory tick
# loop per live world, so two backends disagree about the same world. This is
# roughly thirty seconds of downtime and that is the accepted trade at this
# player count.
#
# Named services rather than `down`, for two reasons. `down` would stop the
# DEPLOY HOOK container as well -- and when the hook is what started this
# deploy, that kills the deploy halfway through, which presents as a deploy
# that silently stopped rather than as a deploy that was killed. It also
# leaves the database up, which has no reason to bounce for an application
# release.
# cloudflared is NOT here, and that is the single most useful thing in this
# script. A quick tunnel takes a new random hostname every time it starts, so
# restarting it on every deploy meant: the public URL players hold changes on
# every deploy, and the DEPLOY_HOOK_URL that CI posts to goes stale, so the
# NEXT push fails with a Cloudflare 530 against a hostname that no longer
# exists. Both were observed.
#
# It does not need restarting. cloudflared connects to `caddy:80` by name, and
# docker's embedded DNS resolves the replacement container -- so leaving the
# tunnel alone across a deploy keeps the hostname stable for as long as the
# board stays up, at the cost of a few seconds of 502 while Caddy restarts.
SERVICES="backend caddy"
run_step "stop the serving containers" pi_ssh "$IMAGE_ENV $COMPOSE $PROFILES stop $SERVICES"
run_step "start the new containers" pi_ssh "$IMAGE_ENV $COMPOSE $PROFILES up -d --no-deps db $SERVICES"

# Started if absent, never recreated -- see the note on SERVICES above. A
# tunnel that is already up keeps its hostname. One that an operator switched
# off (tunnel.sh stop) stays off: pi_ensure_tunnels reads the remembered choice.
run_step "ensure the tunnel is running" \
  pi_ensure_tunnels "$IMAGE_ENV" "$COMPOSE" "$PROFILES"

# The deploy hook is started, never RESTARTED, and it is deliberately not in
# $SERVICES above. When a deploy was triggered by the hook, restarting the
# hook container kills the deploy halfway through -- which presents as a
# deploy that silently stopped rather than one that was killed. --no-recreate
# means an absent or stopped hook is started here, and a running one is left
# exactly as it is. The consequence, stated rather than discovered: a change
# to the hook's own image reaches the board on `make pi-up`, not on a deploy.
case "$PROFILES" in
  *"--profile hook"*)
    run_step "ensure the deploy hook is running" \
      pi_ssh "$IMAGE_ENV $COMPOSE $PROFILES up -d --no-deps --no-recreate deploy-hook"
    ;;
esac

# A container that starts and exits still leaves `up -d` exiting 0, so the
# deploy is not finished until something answers.
wait_for_health() {
  local url; url="$(pi_health_url)"
  pi_ssh "URL=$(printf '%q' "$url") bash -s" <<'REMOTE'
set -u
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$URL" || true)
  if [ "$code" = "200" ]; then
    echo "answered after ~$((i * 2))s at $URL"
    exit 0
  fi
  sleep 2
done
echo "the stack did not answer on $URL within 90s" >&2
docker ps --filter name=something2-orangepi --format "{{.Names}} {{.Status}}" >&2
echo "--- last backend output ---" >&2
docker logs --tail 20 something2-orangepi-backend-1 >&2 2>&1 || true
exit 1
REMOTE
}
run_step "wait for the stack to answer" wait_for_health
STACK_UP=1

# The record that this deploy finished (atomic: temp file, then rename).
record_deployed() {
  # The images first, the marker last: the marker is what says "settled".
  # A board build (empty values) records no images and removes any old file.
  pi_ssh "M=$(printf '%q' "$MARKER") SHA=$(printf '%q' "$SHA") IMGS=$(printf '%q' "$IMAGES_FILE") B=$(printf '%q' "${ORANGEPI_BACKEND_IMAGE:-}") F=$(printf '%q' "${ORANGEPI_FRONTEND_IMAGE:-}") bash -s" <<'REMOTE'
set -e
if [ -n "$B" ] && [ -n "$F" ]; then
  printf 'ORANGEPI_BACKEND_IMAGE=%s\nORANGEPI_FRONTEND_IMAGE=%s\n' "$B" "$F" > "$IMGS.tmp.$$"
  mv -f "$IMGS.tmp.$$" "$IMGS"
else
  rm -f "$IMGS"
fi
printf '%s\n' "$SHA" > "$M.tmp.$$"
mv -f "$M.tmp.$$" "$M"
REMOTE
}
# Only a deploy with NO failed step is recorded as settled. A soft step that
# failed (catalogs, passive tree --force) is not retried by "already settled",
# and only deploy.sh runs them, so the marker stays off and a retry redeploys.
if [ "$STEP_FAILED" -eq 0 ]; then
  if ! run_step "record the deployed commit" record_deployed; then
    printf 'The stack is up and healthy; only recording the deployed commit failed, so the next deploy will run in full.\n' >&2
  fi
else
  printf 'not recording the deployed commit: %s step(s) failed, so a retry will redeploy.\n' "$STEP_FAILED" >&2
fi

finish "pi-deploy"

printf '\n%smoved%s      %s -> %s (%s)\n' "$C_BOLD" "$C_OFF" "$FROM_COMMIT" "$TO_COMMIT" "$IMAGE_SOURCE"
url="$(pi_tunnel_url)"
[ -n "$url" ] && printf '%spublic%s     %s\n' "$C_BOLD" "$C_OFF" "$url"

# A deploy restarts the tunnel, and a quick tunnel takes a NEW hostname every
# time -- so every deploy invalidates the DEPLOY_HOOK_URL that CI posts to,
# and the next push fails with a Cloudflare 530 against a hostname that no
# longer exists. That was observed, not predicted.
#
# So the URL is refreshed here rather than left as a manual step nobody
# remembers. Deliberately narrow: only from the workstation (the board has no
# gh and no credentials), only when gh is installed, and only when the
# repository ALREADY has a DEPLOY_HOOK_URL -- i.e. when CD was wired up on
# purpose. It never enables delivery as a side effect of a deploy; it only
# keeps delivery that already exists from quietly breaking.
if [ -z "${PI_LOCAL:-}" ] && [ -n "$url" ] && command -v gh >/dev/null 2>&1; then
  repo_slug="$(printf '%s' "${GIT_REPOSITORY%.git}" | sed -E 's#.*github\.com[:/]##')"
  if gh secret list --repo "$repo_slug" 2>/dev/null | grep -q '^DEPLOY_HOOK_URL'; then
    if printf '%s' "${url}/deploy-hook" | gh secret set DEPLOY_HOOK_URL --repo "$repo_slug" >/dev/null 2>&1; then
      # No claim about whether it CHANGED: since the tunnel is no longer
      # restarted by a deploy it usually has not, and a message asserting a
      # change that did not happen is worse than no message.
      printf '%shook%s       DEPLOY_HOOK_URL confirmed on %s (%s)\n' \
        "$C_BOLD" "$C_OFF" "$repo_slug" "$url"
    else
      printf '%shook%s       could not refresh DEPLOY_HOOK_URL -- run `make pi-hook-register`\n' \
        "$C_YELLOW" "$C_OFF" >&2
    fi
  fi

  # Same rule as the hook URL above: refresh the published front door only if
  # one already exists. A deploy must never publish a public address for a
  # board whose operator never asked for one.
  if git -C "$REPO_ROOT" ls-remote --exit-code --heads origin \
       "${ORANGEPI_PAGES_BRANCH:-gh-pages}" >/dev/null 2>&1; then
    if bash "$(dirname "${BASH_SOURCE[0]}")/publish-url.sh" >/dev/null 2>&1; then
      printf '%sfront door%s the published page now points here\n' "$C_BOLD" "$C_OFF"
    else
      printf '%sfront door%s could not update the published page -- run `make pi-publish-url`\n' \
        "$C_YELLOW" "$C_OFF" >&2
    fi
  fi
fi
