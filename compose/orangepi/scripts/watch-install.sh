#!/usr/bin/env bash
# `make pi-watch-install` / `pi-watch-uninstall` (SOMET-441).
#
# Installs a systemd USER timer that runs the reconciler every ten minutes, so
# a hostname change after a board reboot repairs itself instead of waiting for
# somebody to notice the link is dead.
#
# A user timer, not a system one, deliberately: this needs the workstation's
# own gh credentials and ssh key, both of which belong to this login. Nothing
# here touches root, /etc, or any credential store.
#
# THE RESIDUAL GAP, SAID OUT LOUD: a user timer runs only while the user has a
# session, unless lingering is enabled. So nothing heals while this machine is
# off or logged out -- which is precisely the case a stable hostname would
# solve properly. This narrows the window; it does not close it.

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="something2-pi-reconcile.service"
TIMER="something2-pi-reconcile.timer"
# Minutes between passes. Kept to whole minutes that divide an hour because the
# schedule below is a wall-clock one; "10min" is accepted for the old spelling.
INTERVAL="${PI_WATCH_INTERVAL:-10}"
INTERVAL="${INTERVAL%min}"
case "$INTERVAL" in
  ''|*[!0-9]*) echo "PI_WATCH_INTERVAL must be a whole number of minutes" >&2; exit 2 ;;
esac
if [ "$INTERVAL" -lt 1 ] || [ "$INTERVAL" -gt 30 ]; then
  echo "PI_WATCH_INTERVAL must be between 1 and 30 minutes" >&2
  exit 2
fi
CALENDAR="*:0/${INTERVAL}"

command -v systemctl >/dev/null 2>&1 || {
  echo "systemd is not available here, so there is no timer to install." >&2
  echo "run 'make pi-reconcile' from cron instead -- it is a single idempotent command." >&2
  exit 1
}

case "${1:-install}" in
  uninstall)
    systemctl --user disable --now "$TIMER" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$TIMER" "$UNIT_DIR/$SERVICE"
    systemctl --user daemon-reload
    echo "removed $TIMER and $SERVICE"
    exit 0
    ;;
  install) ;;
  *) echo "usage: watch-install.sh [install|uninstall]" >&2; exit 2 ;;
esac

mkdir -p "$UNIT_DIR"

# --- The unit must point somewhere that survives a reboot (SOMET-442) -------
#
# This script is often run from a throwaway worktree under /tmp. Installing
# from there produces a timer that works today and, after the next reboot,
# fails every ten minutes against a path that no longer exists -- the quietest
# possible way for a self-healer to stop healing. So: never install from an
# ephemeral root. Use a durable checkout if there is one, otherwise keep a
# small clone of our own and install from that.
DURABLE_HOME="${PI_WATCH_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/something2-pi}"
RECONCILER_REL="compose/orangepi/scripts/reconcile-url.sh"

# The clone carries code only. Configuration stays in ONE place -- a symlink,
# not a copy, so editing .env keeps working and there is no second board
# address to forget about.
link_env() {
  local root="$1" src="$2"
  if [ -L "$root/.env" ] || [ ! -e "$root/.env" ]; then
    ln -sfn "$src" "$root/.env"
  fi
}

ensure_durable_checkout() {
  local origin src_env root="$DURABLE_HOME/repo"
  origin="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null)" || origin=""
  [ -n "$origin" ] || { echo "no origin remote to clone from" >&2; return 1; }

  # Config must already live somewhere permanent; a copy of it here would be a
  # second source of truth for the board's address and password.
  src_env="$(durable_repo_root)/.env"
  [ -f "$src_env" ] || { echo "no durable .env at $src_env" >&2; return 1; }

  if [ -d "$root/.git" ]; then
    git -C "$root" fetch --quiet --depth 1 origin HEAD
  else
    mkdir -p "$DURABLE_HOME"
    git clone --quiet --depth 1 --filter=blob:none "$origin" "$root"
    git -C "$root" fetch --quiet --depth 1 origin HEAD
  fi
  git -C "$root" checkout --quiet --detach FETCH_HEAD
  link_env "$root" "$src_env"
  printf '%s\n' "$root"
}

INSTALL_ROOT="${PI_WATCH_REPO:-}"
if [ -z "$INSTALL_ROOT" ]; then
  INSTALL_ROOT="$(durable_repo_root)"
  if [ -z "$INSTALL_ROOT" ] || [ ! -f "$INSTALL_ROOT/$RECONCILER_REL" ]; then
    echo "installing from a durable clone: $REPO_ROOT will not survive a reboot" >&2
    INSTALL_ROOT="$(ensure_durable_checkout)" || exit 1
  fi
fi

if path_is_ephemeral "$INSTALL_ROOT"; then
  echo "refusing to install a timer from $INSTALL_ROOT -- that path does not survive a reboot" >&2
  exit 1
fi
[ -f "$INSTALL_ROOT/$RECONCILER_REL" ] || {
  echo "no reconciler at $INSTALL_ROOT/$RECONCILER_REL" >&2
  echo "update that checkout, or point PI_WATCH_REPO at one that has it" >&2
  exit 1
}
# The key is what the timer will actually authenticate with, and it is just as
# capable of living in a directory that vanishes.
KEY_PATH="$(pi_key_path)"
[ -f "$KEY_PATH" ] || { echo "no ssh key at $KEY_PATH" >&2; exit 1; }
if path_is_ephemeral "$KEY_PATH"; then
  echo "refusing: the board key at $KEY_PATH does not survive a reboot" >&2
  echo "move it somewhere permanent (~/.ssh/) and set ORANGEPI_SSH_KEY to point there" >&2
  exit 1
fi

# WorkingDirectory is the repository, because the scripts resolve .env and
# their own paths relative to it.
cat > "$UNIT_DIR/$SERVICE" <<UNIT
[Unit]
Description=Reconcile the something2 Orange Pi public URL
Documentation=https://github.com/Mortehay/something2#operating-the-orange-pi

[Service]
Type=oneshot
WorkingDirectory=${INSTALL_ROOT}
ExecStart=/usr/bin/env bash ${INSTALL_ROOT}/compose/orangepi/scripts/reconcile-url.sh
# The reconciler exits 0 when there is nothing to do and when the board is
# simply off, so a non-zero status here means something it could not repair.
UNIT

cat > "$UNIT_DIR/$TIMER" <<UNIT
[Unit]
Description=Check every ${INTERVAL}min whether the something2 board's public URL has moved

[Timer]
# A WALL-CLOCK schedule, not OnUnitActiveSec=. A monotonic timer has nothing to
# count from until its service has run once under it, so a freshly installed or
# reinstalled timer can sit at NextElapseUSecMonotonic=infinity -- enabled,
# listed, and never firing again. Observed, not theorised: uninstall/reinstall
# left the previous version with no next elapse at all.
OnCalendar=${CALENDAR}
# Only has an effect on an OnCalendar timer (man systemd.timer), which is the
# other half of why this is one: a laptop that slept through a pass runs it on
# wake instead of skipping it.
Persistent=true
# A first run shortly after login catches the overnight case: the board
# rebooted while this machine was off, and the published address is already
# wrong by the time anyone sits down.
OnStartupSec=2min
AccuracySec=1min

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now "$TIMER" >/dev/null

echo "installed $TIMER (every ${INTERVAL}min)"
echo "running from $INSTALL_ROOT"
if [ "$INSTALL_ROOT" != "$REPO_ROOT" ]; then
  # Pinned, not self-updating: a timer that pulls and runs new code on its
  # own is a different and much larger promise than this one makes.
  echo "(a pinned copy -- re-run this target to pick up later changes)"
fi
systemctl --user list-timers "$TIMER" --no-pager | sed -n '1,2p'

cat <<MSG

it repairs the published page and the CI hook URL when the board's tunnel
hostname has moved, and says nothing when it has not. watch it with:

    journalctl --user -u ${SERVICE} -f

NOTE: a user timer runs only while you have a session. Nothing heals while
this machine is off or logged out -- 'loginctl enable-linger $USER' lifts the
logged-out half of that, and a named tunnel on a real domain removes the
problem rather than narrowing it.
MSG
