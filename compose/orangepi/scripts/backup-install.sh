#!/usr/bin/env bash
# SOMET-400. Install the nightly backup as a systemd USER timer.
#
# Deliberately the same shape as watch-install.sh, including the two traps it
# already paid for -- see that file for the full reasoning, repeated here only
# in summary because getting either wrong produces a backup that silently is
# not running, which is the exact failure this ticket calls "worse than none":
#
#   1. NEVER INSTALL FROM AN EPHEMERAL PATH. A unit pointing into a /tmp
#      worktree works today and fails after the next reboot.
#   2. OnCalendar, NOT OnUnitActiveSec. A monotonic timer has nothing to count
#      from until its service has run once under it, so a fresh install can sit
#      enabled, listed, and with no next elapse at all (SOMET-442, observed).
#
#   backup-install.sh [install|uninstall]
#
# Env: PI_BACKUP_AT   OnCalendar expression (default 03:30 daily)

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="something2-pi-backup.service"
TIMER="something2-pi-backup.timer"
CALENDAR="${PI_BACKUP_AT:-*-*-* 03:30:00}"
BACKUP_REL="compose/orangepi/scripts/backup.sh"

command -v systemctl >/dev/null 2>&1 || {
  echo "systemd is not available here, so there is no timer to install." >&2
  echo "run 'make pi-backup' from cron instead -- it is a single idempotent command." >&2
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
  *) echo "usage: backup-install.sh [install|uninstall]" >&2; exit 2 ;;
esac

mkdir -p "$UNIT_DIR"

INSTALL_ROOT="${PI_BACKUP_REPO:-$(durable_repo_root)}"
if [ -z "$INSTALL_ROOT" ] || path_is_ephemeral "$INSTALL_ROOT"; then
  echo "refusing to install a timer from '${INSTALL_ROOT:-<none>}' -- that path does not survive a reboot" >&2
  echo "run this from a durable checkout, or set PI_BACKUP_REPO to one" >&2
  exit 1
fi
[ -f "$INSTALL_ROOT/$BACKUP_REL" ] || {
  echo "no backup script at $INSTALL_ROOT/$BACKUP_REL" >&2; exit 1;
}

KEY_PATH="$(pi_key_path)"
[ -f "$KEY_PATH" ] || { echo "no ssh key at $KEY_PATH" >&2; exit 1; }
if path_is_ephemeral "$KEY_PATH"; then
  echo "refusing: the board key at $KEY_PATH does not survive a reboot" >&2
  exit 1
fi

cat > "$UNIT_DIR/$SERVICE" <<UNIT
[Unit]
Description=Back up the something2 Orange Pi database to this workstation
Documentation=https://github.com/Mortehay/something2#operating-the-orange-pi

[Service]
Type=oneshot
WorkingDirectory=${INSTALL_ROOT}
ExecStart=/usr/bin/env bash ${INSTALL_ROOT}/${BACKUP_REL}
# backup.sh exits non-zero when it wrote nothing, so a failed unit here is a
# real missed backup rather than noise. \`systemctl --user status\` and
# \`make pi-backup-status\` are the two places that surface it.
UNIT

cat > "$UNIT_DIR/$TIMER" <<UNIT
[Unit]
Description=Nightly something2 board backup

[Timer]
OnCalendar=${CALENDAR}
# Catches the laptop-was-asleep case: a missed run happens on wake rather than
# being skipped until tomorrow. Only meaningful on an OnCalendar timer.
Persistent=true
# Spread the start so a wake-up does not fire this at the same instant as
# everything else queued.
RandomizedDelaySec=15min
AccuracySec=5min

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now "$TIMER" >/dev/null

echo "installed $TIMER ($CALENDAR)"
echo "running from $INSTALL_ROOT"

# ENABLED IS NOT SCHEDULED. Verify a next elapse actually exists rather than
# trusting that enable succeeded -- the whole reason this uses OnCalendar.
next="$(systemctl --user show "$TIMER" -p NextElapseUSecRealtime --value 2>/dev/null || true)"
if [ -z "$next" ] || [ "$next" = "0" ] || [ "$next" = "n/a" ]; then
  echo "WARNING: the timer is enabled but has no next elapse. It will not fire." >&2
  systemctl --user list-timers "$TIMER" --all >&2 || true
  exit 1
fi
systemctl --user list-timers "$TIMER" --all | sed -n '1,3p'

echo
echo "This machine must be on at ${CALENDAR} for the backup to run."
echo "Check it is actually happening:  make pi-backup-status"
