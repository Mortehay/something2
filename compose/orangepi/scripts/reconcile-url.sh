#!/usr/bin/env bash
# `make pi-reconcile` (SOMET-441): make the published address and the CI hook
# agree with what the board is actually serving, and say nothing when they
# already do.
#
# WHY. A quick tunnel takes a new hostname whenever cloudflared starts. A
# board reboot does that, the stack comes back by itself, and two things are
# then silently wrong at once: the published page (SOMET-440) points at a dead
# hostname, and CI's DEPLOY_HOOK_URL does too, so the next push fails with a
# Cloudflare 530. Neither shows up as an error anywhere until someone tries to
# play or push.
#
# QUIET BY DEFAULT. This is built to run on a timer, and a timer that reports
# every ten minutes is a timer nobody reads. It prints only when it changed
# something, or when something is wrong that it cannot fix. PI_VERBOSE=1 makes
# it explain itself.
#
# It never publishes a hostname it has not confirmed is serving: a page
# pointing at a URL that does not answer is worse than a page pointing at an
# old one, because it looks like the game is broken rather than moved.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_pi_env
require_env GIT_REPOSITORY

HERE="$(dirname "${BASH_SOURCE[0]}")"
REPO_SLUG="$(printf '%s' "${GIT_REPOSITORY%.git}" | sed -E 's#.*github\.com[:/]##')"
PAGES_URL="https://$(printf '%s' "${REPO_SLUG%%/*}" | tr '[:upper:]' '[:lower:]').github.io/${REPO_SLUG##*/}/"
CHANGED=0

say() { printf '%s\n' "$*"; }
chatter() { [ -n "${PI_VERBOSE:-}" ] && printf '%s\n' "$*" || true; }

# --- Is there anything to reconcile against? -------------------------------

# A board that is off is not a fault this can repair, and it is the normal
# state of a machine at home. Exit 0 without a word: a timer that complains
# nightly gets masked, and then it is not there on the morning it matters.
if ! pi_ssh true 2>/dev/null; then
  chatter "board unreachable; nothing to reconcile"
  exit 0
fi

live="$(pi_tunnel_url)"
if [ -z "$live" ]; then
  chatter "no tunnel running on the board; nothing to reconcile"
  exit 0
fi

# Confirm the board is really serving on that hostname before pointing anyone
# at it. Cloudflare answers for a hostname whose origin is down, so a 200 from
# the game's own health endpoint is the only thing worth trusting here.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${live}/api/health" || true)"
if [ "$code" != "200" ]; then
  say "the board's tunnel ${live} answers HTTP ${code:-000} on /api/health -- not publishing it."
  say "check 'make pi-status'; this will heal by itself once the stack is serving."
  exit 1
fi

# --- The published front door ---------------------------------------------

published="$(curl -s --max-time 20 "$PAGES_URL" 2>/dev/null \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)"

case "$(front_door_state "$published" "$live")" in
  current)
    chatter "front door already points at $live"
    ;;
  missing)
    # Not published at all is a choice, not a fault: publishing opens a public
    # address, and doing that unasked from a background timer would be a
    # surprise of exactly the wrong kind.
    chatter "no front door published; leaving it alone (run 'make pi-publish-url' to create one)"
    ;;
  stale)
    say "front door was pointing at ${published:-nothing}; the board is serving ${live}"
    if bash "$HERE/publish-url.sh" >/dev/null 2>&1; then
      say "  republished ${PAGES_URL} -> ${live}"
      CHANGED=1
    else
      say "  FAILED to republish -- run 'make pi-publish-url' to see why" >&2
      exit 1
    fi
    ;;
esac

# --- The CI deploy hook ----------------------------------------------------

if command -v gh >/dev/null 2>&1 \
   && gh secret list --repo "$REPO_SLUG" 2>/dev/null | grep -q '^DEPLOY_HOOK_URL'; then
  # The secret's value cannot be read back, so the check is behavioural: does
  # the hook answer on the hostname the board is serving now? If it does not,
  # re-registering costs nothing and fixes the case that matters.
  hook_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${live}/deploy-hook/health" || true)"
  if [ "$hook_code" = "200" ]; then
    chatter "deploy hook reachable on $live"
    # Registered URL and live URL can still differ while both answer -- the
    # front door check above is what catches that, and a re-register after a
    # confirmed front-door drift keeps the two in step.
    if [ "$CHANGED" = "1" ]; then
      if bash "$HERE/hook-register.sh" >/dev/null 2>&1; then
        say "  re-registered DEPLOY_HOOK_URL with ${REPO_SLUG}"
      else
        say "  FAILED to re-register DEPLOY_HOOK_URL -- run 'make pi-hook-register'" >&2
      fi
    fi
  else
    say "deploy hook does not answer on ${live} (HTTP ${hook_code:-000})"
    if bash "$HERE/hook-register.sh" >/dev/null 2>&1; then
      say "  re-registered DEPLOY_HOOK_URL with ${REPO_SLUG}"
      CHANGED=1
    else
      say "  FAILED to re-register DEPLOY_HOOK_URL -- run 'make pi-hook-register'" >&2
      exit 1
    fi
  fi
fi

[ "$CHANGED" = "1" ] && say "reconciled." || chatter "nothing to do."
exit 0
