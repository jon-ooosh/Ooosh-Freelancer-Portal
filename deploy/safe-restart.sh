#!/bin/bash
# =============================================================
# Ooosh Operations Portal - restart, but not in the middle of a card payment
# =============================================================
#   bash /var/www/ooosh-portal/deploy/safe-restart.sh
#   FORCE=1 bash /var/www/ooosh-portal/deploy/safe-restart.sh   # restart regardless
#
# A restart cuts off whatever the server is doing. Most of that is simply asked
# again, but a card-reader payment that has been approved and is being recorded
# ("Card approved - recording...") would be left half-done: the client's card
# charged, nothing recorded in OP, nobody told. So this waits until no reader
# payment is in progress (waiting for a card, or recording) before restarting —
# up to 5 minutes, then it stops WITHOUT restarting and says so.
#
# Job 16169, 21 Oct 2026: a deploy restart landed 4 seconds after a card receipt.
#
# Payments started more than 20 minutes ago are ignored: those were abandoned
# (the browser closed while the reader waited), not in progress, and must not
# block every deploy. If the database can't be asked, it says so and restarts
# anyway — this is a safety net, not a gate.
#
# Used by deploy.sh; use it instead of `systemctl restart ooosh-portal` by hand.
# =============================================================

set -uo pipefail

WAIT_SECONDS=300
POLL_SECONDS=5

in_progress() {
  sudo -n -u postgres psql -d ooosh_operations -tA -F ' | ' -c "
    SELECT ts.status, '£' || ts.amount, COALESCE('job ' || j.hh_job_number, ts.payment_type),
           'started ' || to_char(ts.started_at AT TIME ZONE 'Europe/London', 'HH24:MI')
      FROM terminal_sessions ts
      LEFT JOIN jobs j ON j.id = ts.job_id
     WHERE ts.status IN ('pending', 'recording')
       AND ts.started_at > NOW() - INTERVAL '20 minutes'
     ORDER BY ts.started_at"
}

if [ "${FORCE:-0}" != "1" ]; then
  # psql's warnings go to their own file, never into the answer: a harmless notice
  # (e.g. "could not change directory") must not read as a payment in progress.
  err_file="$(mktemp)"
  trap 'rm -f "${err_file}"' EXIT
  waited=0
  while true; do
    if ! busy="$(in_progress 2>"${err_file}")"; then
      echo "!!! Couldn't check for card payments in progress ($(head -1 "${err_file}")) - restarting anyway."
      break
    fi
    [ -z "${busy}" ] && break
    if [ "${waited}" -ge "${WAIT_SECONDS}" ]; then
      echo ""
      echo "!!! NOT restarted: a card payment is still in progress after $((WAIT_SECONDS / 60)) minutes:"
      echo "${busy}" | sed 's/^/!!!   /'
      echo "!!! The new build is in place and the old one is still running. Once the payment"
      echo "!!! is finished (or cancelled on its screen), restart with:"
      echo "!!!   bash /var/www/ooosh-portal/deploy/safe-restart.sh"
      echo "!!! or, if that payment was abandoned, FORCE=1 bash /var/www/ooosh-portal/deploy/safe-restart.sh"
      exit 1
    fi
    if [ "${waited}" -eq 0 ]; then
      echo "Waiting for a card payment in progress to finish before restarting:"
      echo "${busy}" | sed 's/^/  /'
    fi
    sleep "${POLL_SECONDS}"
    waited=$((waited + POLL_SECONDS))
  done
fi

# The server finishes the requests it is already handling before it stops
# (index.ts, up to 60s), so this can take a little while.
echo "Restarting ooosh-portal..."
sudo systemctl restart ooosh-portal
echo "Restarted."
