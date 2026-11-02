#!/usr/bin/env bash
# Unattended switch of the live Traccar from H2 to PostgreSQL (docs/TRACCAR-POSTGRES.md
# Phase 3). Meant to be scheduled for the small hours:
#
#   systemd-run --unit traccar-switch --on-calendar='2026-10-13 04:30:00 Europe/London' \
#     /bin/bash /var/www/ooosh-portal/deploy/traccar/switch-to-postgres.sh
#
# Checks everything BEFORE touching Traccar; if any check fails it changes nothing.
# If the copy fails, the old Traccar is started again. If the new Traccar doesn't
# answer within 3 minutes, it is removed and the old one put back. Every step is
# logged to /root/traccar-switch.log — read that first in the morning.

set -uo pipefail

LOG=${LOG:-/root/traccar-switch.log}
IMAGE=${IMAGE:-ooosh/traccar:6.11.1}
CONF=${CONF:-/opt/traccar/conf/traccar.xml}
LOGS_DIR=${LOGS_DIR:-/opt/traccar/logs}
DATA_COPY=${DATA_COPY:-/root/traccar-data-final}
REPO=${REPO:-/var/www/ooosh-portal}
# 8082 (the web UI) is bound to localhost: nginx proxies tracking.oooshtours.co.uk to it.
# Docker publishes ports UNDERNEATH ufw, so a bare "-p 8082:8082" put the plain-HTTP
# login page on the open internet (found 19 Oct 2026). 5027 must stay public: the vans report to it.
PORTS=${PORTS:-"-p 5027:5027 -p 5027:5027/udp -p 127.0.0.1:8082:8082"}
WEB=${WEB:-http://localhost:8082}
MIN_FREE_GB=${MIN_FREE_GB:-6}

exec >>"$LOG" 2>&1
log() { echo "[$(date '+%F %T')] $*"; }
fail_unchanged() { log "STOPPED before touching Traccar: $*"; log "Nothing was changed. The old Traccar is still running."; exit 1; }

log "════ Traccar switch to PostgreSQL starting ════"

# ── Checks — nothing has been touched yet ────────────────────────────────
docker inspect traccar >/dev/null 2>&1 || fail_unchanged "no container called 'traccar'"
docker inspect traccar-h2-old >/dev/null 2>&1 && fail_unchanged "traccar-h2-old already exists — has the switch already run?"
[ "$(docker inspect -f '{{.State.Running}}' traccar)" = true ] || fail_unchanged "the live Traccar isn't running"
docker image inspect "$IMAGE" >/dev/null 2>&1 || fail_unchanged "image $IMAGE not found"
[ -s "$CONF" ] || fail_unchanged "config $CONF missing"
grep -q "org.postgresql.Driver" "$CONF" || fail_unchanged "config $CONF isn't the PostgreSQL one"
[ -f "$REPO/deploy/traccar/h2-to-postgres.sh" ] || fail_unchanged "copy script missing"
mkdir -p "$LOGS_DIR"
free_gb=$(df -BG --output=avail /root | tail -1 | tr -dc 0-9)
[ "$free_gb" -ge "$MIN_FREE_GB" ] || fail_unchanged "only ${free_gb}GB free, need ${MIN_FREE_GB}GB"
${PSQL:-sudo -u postgres psql -d traccar} -Atc "SELECT 1" >/dev/null || fail_unchanged "can't reach the traccar database"
log "Checks passed (${free_gb}GB free)."

# ── 1. Stop the old Traccar and copy its data out ────────────────────────
log "Stopping the old Traccar"
docker stop traccar
rm -rf "$DATA_COPY"
log "Copying its H2 data to $DATA_COPY"
if ! docker cp traccar:/opt/traccar/data "$DATA_COPY"; then
  log "Copying the data out FAILED — starting the old Traccar again"
  docker start traccar
  exit 1
fi

# ── 2. Copy H2 into PostgreSQL ───────────────────────────────────────────
log "Copying H2 into PostgreSQL"
if ! H2_DIR="$DATA_COPY" IMAGE="$IMAGE" bash "$REPO/deploy/traccar/h2-to-postgres.sh"; then
  log "The copy FAILED — starting the old Traccar again (nothing lost; it carries on as before)"
  docker start traccar
  exit 1
fi

# ── 3. Start the new Traccar ─────────────────────────────────────────────
log "Starting the new Traccar on PostgreSQL"
docker rename traccar traccar-h2-old
docker update --restart=no traccar-h2-old >/dev/null
# shellcheck disable=SC2086
docker run -d --name traccar --restart always $PORTS \
  -v "$CONF:/opt/traccar/conf/traccar.xml:ro" \
  -v "$LOGS_DIR:/opt/traccar/logs" \
  "$IMAGE"

healthy=false
for _ in $(seq 1 36); do   # up to 3 minutes
  sleep 5
  if curl -sf -m 5 "$WEB/api/server" | grep -q '"version"'; then healthy=true; break; fi
done

if [ "$healthy" = true ] && [ "$(docker inspect -f '{{.State.Running}}' traccar)" = true ]; then
  log "New Traccar is answering: $(curl -s -m 5 "$WEB/api/server" | grep -o '"version":"[^"]*"')"
  log "════ SWITCH COMPLETE — Traccar now runs on PostgreSQL ════"
  exit 0
fi

# ── Roll back ────────────────────────────────────────────────────────────
log "The new Traccar did NOT answer within 3 minutes. Its last log lines:"
docker logs --tail 20 traccar 2>&1 | sed 's/^/    /'
# Traccar writes its errors to its own log file, not to Docker's output.
tail -n 30 "$LOGS_DIR/tracker-server.log" 2>/dev/null | sed 's/^/    /'
log "Rolling back to the old Traccar"
docker rm -f traccar
docker rename traccar-h2-old traccar
docker update --restart=always traccar >/dev/null
docker start traccar
log "════ ROLLED BACK — the old H2 Traccar is running again ════"
exit 1
