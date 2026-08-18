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

# ghcr.io/<owner>/<repo>-<service>, derived from the clone url so there is one
# place to change it. Overridable for a fork or a different registry.
derive_image_prefix() {
  local url="${GIT_REPOSITORY%.git}"
  local path="${url#*github.com[:/]}"
  path="${url#*github.com/}"
  path="${path#*github.com:}"
  printf 'ghcr.io/%s' "$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')"
}
IMAGE_PREFIX="${ORANGEPI_IMAGE_PREFIX:-$(derive_image_prefix)}"

printf '%sboard%s      %s@%s\n%sbranch%s     %s\n%simages%s     %s-{backend,caddy}\n\n' \
  "$C_BOLD" "$C_OFF" "$ORANGEPI_LOGIN" "$ORANGEPI_ADDRESS" \
  "$C_BOLD" "$C_OFF" "$ORANGEPI_BRANCH" \
  "$C_BOLD" "$C_OFF" "$IMAGE_PREFIX"

# --- Where the board is now ------------------------------------------------

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

if run_step "pull images for ${SHA:0:7} from the registry" try_pull; then
  IMAGE_SOURCE="registry"
  export ORANGEPI_BACKEND_IMAGE="${IMAGE_PREFIX}-backend:${SHA}"
  export ORANGEPI_FRONTEND_IMAGE="${IMAGE_PREFIX}-caddy:${SHA}"
else
  # Not a failure. No image exists for this commit -- a fallback build, a
  # manual dispatch, a commit that never went through CI -- and building is
  # the documented fallback. Reset the failure bookkeeping so the summary is
  # not red for something that is working as designed.
  STEP_FAILED=$((STEP_FAILED - 1))
  STEP_STATUS[$((STEP_INDEX - 1))]="ok"
  STEP_NAMES[$((STEP_INDEX - 1))]="pull images for ${SHA:0:7} (none published -- building on the board)"
  printf '  %sno published image for this commit; building on the board (this takes 10-20 minutes)%s\n' \
    "$C_YELLOW" "$C_OFF"
fi

IMAGE_ENV="ORANGEPI_BACKEND_IMAGE=${ORANGEPI_BACKEND_IMAGE:-} ORANGEPI_FRONTEND_IMAGE=${ORANGEPI_FRONTEND_IMAGE:-}"

if [ "$IMAGE_SOURCE" = "build" ]; then
  run_step "build images on the board" pi_ssh "$COMPOSE build"
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
SERVICES="backend caddy cloudflared"
run_step "stop the serving containers" pi_ssh "$IMAGE_ENV $COMPOSE --profile tunnel stop $SERVICES"
run_step "start the new containers" pi_ssh "$IMAGE_ENV $COMPOSE --profile tunnel up -d --no-deps db $SERVICES"

# A container that starts and exits still leaves `up -d` exiting 0, so the
# deploy is not finished until something answers.
wait_for_health() {
  pi_ssh 'for i in $(seq 1 30); do
            code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:8080/api/health || true)
            [ "$code" = "200" ] && { echo "healthy after ${i}0s at most"; exit 0; }
            sleep 2
          done
          echo "the stack did not answer on 127.0.0.1:8080 within 60s" >&2
          docker ps --filter name=something2-orangepi --format "{{.Names}} {{.Status}}" >&2
          exit 1'
}
run_step "wait for the stack to answer" wait_for_health

finish "pi-deploy"

printf '\n%smoved%s      %s -> %s (%s)\n' "$C_BOLD" "$C_OFF" "$FROM_COMMIT" "$TO_COMMIT" "$IMAGE_SOURCE"
url="$(pi_tunnel_url)"
[ -n "$url" ] && printf '%spublic%s     %s\n' "$C_BOLD" "$C_OFF" "$url"
