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
INTERVAL="${PI_WATCH_INTERVAL:-10min}"

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

# WorkingDirectory is the repository, because the scripts resolve .env and
# their own paths relative to it.
cat > "$UNIT_DIR/$SERVICE" <<UNIT
[Unit]
Description=Reconcile the something2 Orange Pi public URL
Documentation=https://github.com/Mortehay/something2#operating-the-orange-pi

[Service]
Type=oneshot
WorkingDirectory=${REPO_ROOT}
ExecStart=/usr/bin/env bash ${REPO_ROOT}/compose/orangepi/scripts/reconcile-url.sh
# The reconciler exits 0 when there is nothing to do and when the board is
# simply off, so a non-zero status here means something it could not repair.
UNIT

cat > "$UNIT_DIR/$TIMER" <<UNIT
[Unit]
Description=Check every ${INTERVAL} whether the something2 board's public URL has moved

[Timer]
# A first run shortly after login catches the overnight case: the board
# rebooted while this machine was off, and the published address is already
# wrong by the time anyone sits down.
OnStartupSec=2min
OnUnitActiveSec=${INTERVAL}
# Without this a suspended laptop silently skips every run it slept through.
Persistent=true
AccuracySec=1min

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now "$TIMER" >/dev/null

echo "installed $TIMER (every ${INTERVAL})"
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
