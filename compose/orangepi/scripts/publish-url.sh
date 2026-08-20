#!/usr/bin/env bash
# `make pi-publish-url` (SOMET-440): keep one stable address pointing at the
# board's current tunnel hostname.
#
# WHY THIS EXISTS. A trycloudflare quick tunnel takes a new random hostname
# every time cloudflared starts, and an old one can never be recovered.
# Deploys and pi-restart no longer restart it, so the realistic trigger is a
# board reboot: the stack comes back by itself, everything reports healthy,
# and every link anyone holds is silently dead. This publishes a redirect page
# so players have one address that does not move.
#
# WHERE IT RUNS, AND WHY THAT MATTERS. On the WORKSTATION, using the gh
# credentials already here. The board deliberately holds no credential of any
# kind -- it clones a public repository anonymously -- and putting a GitHub
# token on an internet-reachable box to solve a convenience problem would
# trade away a real security property for one. The cost of that choice is
# stated rather than hidden: if the board reboots while this machine is off,
# the page is stale until someone runs a command. A hostname that never moves
# is a named tunnel on an owned domain, which is the actual fix.
#
# The page is published from an ORPHAN gh-pages branch, not from docs/ on
# main: sourcing Pages from the working tree would also publish every design
# document in this repository as a website, which is not what anybody asked
# for.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_pi_env
require_env GIT_REPOSITORY

PAGES_BRANCH="${ORANGEPI_PAGES_BRANCH:-gh-pages}"
REPO_SLUG="$(printf '%s' "${GIT_REPOSITORY%.git}" | sed -E 's#.*github\.com[:/]##')"
OWNER="${REPO_SLUG%%/*}"
REPO_NAME="${REPO_SLUG##*/}"
PAGES_URL="https://${OWNER,,}.github.io/${REPO_NAME}/"

command -v gh >/dev/null 2>&1 || {
  echo "the GitHub CLI (gh) is not installed, and it is what publishes the page." >&2
  exit 1
}

url="$(bash "$(dirname "${BASH_SOURCE[0]}")/remote.sh" tunnel-url)"

if [ -z "$url" ]; then
  # A stale page pointing at a dead hostname is worse than a page that says
  # the server is down: the first looks like the game is broken, the second
  # is the truth.
  echo "no tunnel is running on the board, so there is nothing to publish." >&2
  echo "start it with 'make pi-up', then run this again." >&2
  exit 1
fi

publish() {
  local tmp; tmp="$(mktemp -d)"
  # A throwaway clone rather than a branch in this checkout: several sessions
  # share the working tree here, and switching its branch underneath them is
  # how that goes wrong.
  git clone --quiet --depth 1 --branch "$PAGES_BRANCH" \
    "$(git -C "$REPO_ROOT" remote get-url origin)" "$tmp" 2>/dev/null || {
      git clone --quiet --depth 1 "$(git -C "$REPO_ROOT" remote get-url origin)" "$tmp"
      git -C "$tmp" checkout --quiet --orphan "$PAGES_BRANCH"
      git -C "$tmp" rm -rq --cached . 2>/dev/null || true
      find "$tmp" -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} +
      echo "created the $PAGES_BRANCH branch"
    }
  render_front_door_page "$url" "$(date -u '+%Y-%m-%d %H:%M UTC')" > "$tmp/index.html"
  # Check what was actually produced before committing it. This is not
  # defensive padding: a rename left the call above pointing at a function
  # that no longer existed, bash created the file by redirection and then
  # failed to run the command, and the empty result was committed and pushed
  # over a working page -- with a commit message that still said it pointed
  # at the hostname. `set -e` did not stop it, because run_step invokes step
  # functions inside a `|| rc=$?` list, which disables errexit for
  # everything they call.
  if ! front_door_page_is_sane "$tmp/index.html" "$url"; then
    echo "refusing to publish: the rendered page is empty or does not contain $url" >&2
    rm -rf "$tmp"
    return 1
  fi
  # Pages runs Jekyll by default, which ignores files it does not understand
  # and would silently drop anything starting with an underscore later.
  : > "$tmp/.nojekyll"
  git -C "$tmp" add index.html .nojekyll
  if git -C "$tmp" diff --cached --quiet; then
    echo "the published page already points at $url"
  else
    git -C "$tmp" -c user.email=noreply@something2 -c user.name="pi-publish-url" \
      commit --quiet -m "chore(pages): point at ${url#https://}"
    git -C "$tmp" push --quiet origin "$PAGES_BRANCH"
    echo "published $url"
  fi
  rm -rf "$tmp"
}
run_step "publish the current hostname" publish

enable_pages() {
  if gh api "repos/${REPO_SLUG}/pages" >/dev/null 2>&1; then
    echo "Pages already serving"
    return 0
  fi
  gh api -X POST "repos/${REPO_SLUG}/pages" -f "source[branch]=${PAGES_BRANCH}" -f "source[path]=/" >/dev/null
  echo "enabled Pages on ${PAGES_BRANCH}"
}
run_step "ensure GitHub Pages is serving that branch" enable_pages

finish "pi-publish-url"

cat <<MSG

${C_BOLD}stable address${C_OFF}   ${PAGES_URL}
${C_BOLD}now points at${C_OFF}    ${url}

give players the stable one. it survives a board reboot; the tunnel hostname
does not. re-run this (or any workstation deploy) after the tunnel changes.

NOTE: that address is public and guessable, and this staging box has open
registration. It is marked noindex, which keeps it out of search results --
it does not keep anyone out who has the link.
MSG
