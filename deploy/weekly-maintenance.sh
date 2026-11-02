#!/bin/bash
# =============================================================
# Ooosh Server Weekly Maintenance Script
# Runs every Monday at 2:30am UTC via cron
# Applies safe updates, checks services, sends Claude digest
# =============================================================
#
# LIVE COPY: /etc/ooosh-maintenance/weekly-maintenance.sh
#
# This file is the tracked source of truth. It is NOT symlinked — a git pull
# does not update the running script. After changing it here, copy it across:
#
#   sudo cp /var/www/ooosh-portal/deploy/weekly-maintenance.sh \
#           /etc/ooosh-maintenance/weekly-maintenance.sh
#   sudo chmod +x /etc/ooosh-maintenance/weekly-maintenance.sh
#
# Companion files stay server-side only (they hold secrets):
#   /etc/ooosh-maintenance/config.env
#   /etc/ooosh-maintenance/send-digest.py
# =============================================================

source /etc/ooosh-maintenance/config.env

LOG_DIR="/var/log/ooosh-maintenance"
mkdir -p "$LOG_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
REPORT_FILE="$LOG_DIR/report-$TIMESTAMP.txt"
LOG_FILE="$LOG_DIR/maintenance-$TIMESTAMP.log"

# When this run began. Used to tell "restarted during maintenance" (expected,
# informational) apart from "was already down" (actually worth knowing about).
RUN_START_EPOCH=$(date +%s)

# How long to let services settle after upgrades before judging their health.
# `apt upgrade` can restart anything linking a replaced library — that is how
# the libkrb5 update bounced Postgres on 17 Aug 2026, which severed the API's
# pooled connections and restarted it. Checking health immediately after the
# upgrade meant reporting an outage this script had just caused. Overridable
# from config.env.
SETTLE_SECONDS="${SETTLE_SECONDS:-45}"

# Where OP is deployed. Read for backend/.env, to tell whether the nightly
# Traccar backup is switched on. Overridable from config.env.
APP_DIR="${APP_DIR:-/var/www/ooosh-portal}"

# Last report's disk-used figure, so this one can say how much it changed.
# Not .txt or .log, so the 12-week clean-up at the bottom never deletes it.
DISK_STATE="$LOG_DIR/disk-used.last"

# Traccar's own log folder (mounted into its container). Overridable from
# config.env.
TRACCAR_LOG_DIR="${TRACCAR_LOG_DIR:-/opt/traccar/logs}"

# Log everything to file
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=== Ooosh Weekly Maintenance - $(date) ==="

# --- Pre-update snapshot ---
echo "--- Pre-Update State ---" > "$REPORT_FILE"
echo "Date: $(date)" >> "$REPORT_FILE"
echo "Hostname: $(hostname)" >> "$REPORT_FILE"
echo "Kernel: $(uname -r)" >> "$REPORT_FILE"
echo "Uptime: $(uptime -p)" >> "$REPORT_FILE"
echo "Disk: $(df -h / | tail -1 | awk '{print $3, "used of", $2, "("$5")"}')" >> "$REPORT_FILE"
echo "Memory: $(free -h | grep Mem | awk '{print $3, "used of", $2}')" >> "$REPORT_FILE"
echo "Swap: $(free -h | grep Swap | awk '{print $3, "used of", $2}')" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

# --- Run updates ---
echo "--- Updates ---" >> "$REPORT_FILE"
echo "Running apt update..."
apt update 2>&1 | tail -1 >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

echo "Running apt upgrade..."
APT_OUTPUT=$(DEBIAN_FRONTEND=noninteractive apt upgrade -y 2>&1)
echo "$APT_OUTPUT" >> "$LOG_FILE"

# Extract what was upgraded
UPGRADE_COUNT=$(echo "$APT_OUTPUT" | grep "^Setting up" | wc -l)
UPGRADED_LIST=$(echo "$APT_OUTPUT" | grep "^Setting up" | sed 's/Setting up \([^ ]*\) (\(.*\)).*/\1 \2/' || echo "")

echo "Packages upgraded: $UPGRADE_COUNT" >> "$REPORT_FILE"
if [ "$UPGRADE_COUNT" -gt 0 ]; then
    echo "Upgraded:" >> "$REPORT_FILE"
    echo "$UPGRADED_LIST" >> "$REPORT_FILE"
fi
echo "" >> "$REPORT_FILE"

# --- Check held packages for available updates ---
echo "--- Held Packages ---" >> "$REPORT_FILE"
for pkg in $(apt-mark showhold); do
    AVAILABLE=$(apt-cache policy "$pkg" 2>/dev/null | grep "Candidate:" | awk '{print $2}')
    INSTALLED=$(apt-cache policy "$pkg" 2>/dev/null | grep "Installed:" | awk '{print $2}')
    if [ "$AVAILABLE" != "$INSTALLED" ]; then
        echo "UPDATE AVAILABLE - $pkg: installed=$INSTALLED, available=$AVAILABLE" >> "$REPORT_FILE"
    else
        echo "UP TO DATE - $pkg: $INSTALLED" >> "$REPORT_FILE"
    fi
done
echo "" >> "$REPORT_FILE"

# --- Service health checks ---
# Settle first (see SETTLE_SECONDS above), then judge. A service that came back
# on its own is reported as running-and-restarted, not DOWN.
echo "--- Service Health ---" >> "$REPORT_FILE"
if [ "$UPGRADE_COUNT" -gt 0 ]; then
    echo "Upgrades applied - settling ${SETTLE_SECONDS}s before health checks..."
    echo "(health checked ${SETTLE_SECONDS}s after upgrades)" >> "$REPORT_FILE"
    sleep "$SETTLE_SECONDS"
fi

for svc in nginx postgresql@16-main ooosh-portal fail2ban redis-server; do
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
        SVC_START=$(systemctl show "$svc" -p ActiveEnterTimestamp --value 2>/dev/null)
        # Guard the empty case explicitly: `date -d ""` does not fail, it
        # quietly returns midnight today, which would misread as a restart on
        # any run starting after 00:00.
        if [ -n "$SVC_START" ]; then
            SVC_START_EPOCH=$(date -d "$SVC_START" +%s 2>/dev/null || echo 0)
        else
            SVC_START_EPOCH=0
        fi
        if [ "$SVC_START_EPOCH" -gt "$RUN_START_EPOCH" ]; then
            echo "RUNNING - $svc (restarted during maintenance)" >> "$REPORT_FILE"
        else
            echo "RUNNING - $svc" >> "$REPORT_FILE"
        fi
    else
        # Second chance before crying wolf — a slow starter is not an outage.
        sleep 20
        if systemctl is-active --quiet "$svc" 2>/dev/null; then
            echo "RUNNING - $svc (slow to start, up on recheck)" >> "$REPORT_FILE"
        else
            echo "DOWN - $svc" >> "$REPORT_FILE"
            echo "  last log lines:" >> "$REPORT_FILE"
            journalctl -u "$svc" --no-pager -n 15 2>/dev/null | sed 's/^/  /' >> "$REPORT_FILE"
        fi
    fi
done

# Traccar via Docker
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q traccar; then
    # Docker restarts the container by itself (--restart always), so "running"
    # alone hides a crash. On 19 Oct 2026 it had been up 5 hours and nothing
    # said why. Report when it last started, like the services above.
    TC_STARTED=$(docker inspect -f '{{.State.StartedAt}}' traccar 2>/dev/null)
    TC_START_EPOCH=0
    if [ -n "$TC_STARTED" ]; then
        TC_START_EPOCH=$(date -d "$TC_STARTED" +%s 2>/dev/null || echo 0)
    fi
    if [ "$TC_START_EPOCH" -gt "$RUN_START_EPOCH" ]; then
        echo "RUNNING - traccar (docker) (restarted during maintenance)" >> "$REPORT_FILE"
    elif [ "$TC_START_EPOCH" -gt $((RUN_START_EPOCH - 7 * 86400)) ]; then
        echo "RUNNING - traccar (docker) (last started $(date -d "@$TC_START_EPOCH" '+%a %d %b %H:%M') - a reboot, a manual restart or a crash; not this maintenance run)" >> "$REPORT_FILE"
    else
        echo "RUNNING - traccar (docker)" >> "$REPORT_FILE"
    fi
else
    echo "DOWN - traccar (docker)" >> "$REPORT_FILE"
fi
echo "" >> "$REPORT_FILE"

# --- Application health ---
# systemd only knows the process exists. This asks the API whether it can
# actually reach Postgres and Redis: GET /api/health returns 503 if either is
# unreachable. It also reports process uptime, which reveals restarts.
echo "--- Application Health ---" >> "$REPORT_FILE"
HEALTH_RAW=$(curl -s --max-time 15 -w '\n%{http_code}' http://127.0.0.1:3001/api/health 2>/dev/null)
HEALTH_CODE=$(echo "$HEALTH_RAW" | tail -1)
HEALTH_BODY=$(echo "$HEALTH_RAW" | sed '$d')
case "$HEALTH_CODE" in
    200) echo "OK - API responding 200" >> "$REPORT_FILE" ;;
    503) echo "DEGRADED - API responding 503 (database or redis unreachable)" >> "$REPORT_FILE" ;;
    "" |000) echo "DOWN - API health endpoint did not respond" >> "$REPORT_FILE" ;;
    *)   echo "UNEXPECTED - API health returned HTTP $HEALTH_CODE" >> "$REPORT_FILE" ;;
esac
[ -n "$HEALTH_BODY" ] && echo "  $HEALTH_BODY" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

# --- Application errors (last 7 days) ---
# Some of these are non-fatal by design, which means silent. Counting them here
# is what stops "recovered on its own" quietly becoming "happening constantly".
echo "--- Application Errors (7 days) ---" >> "$REPORT_FILE"

APP_JOURNAL=$(journalctl -u ooosh-portal --since "7 days ago" --no-pager 2>/dev/null)

# Severed pooled connections. Stopped killing the process in Aug 2026 — a
# Postgres restart trips these and pg recovers on the next query. A handful
# after a maintenance window is expected; a steady stream is not.
POOL_ERRORS=$(echo "$APP_JOURNAL" | grep -c "Database pool error" || true)
echo "Database pool errors: $POOL_ERRORS" >> "$REPORT_FILE"
if [ "$POOL_ERRORS" -gt 0 ]; then
    echo "$APP_JOURNAL" | grep "Database pool error" | tail -5 | sed 's/^/  /' >> "$REPORT_FILE"
fi

# Process guards in index.ts deliberately keep the API alive on these, so they
# never surface as a crash. They still indicate a bug worth chasing.
GUARD_HITS=$(echo "$APP_JOURNAL" | grep -cE "UNCAUGHT EXCEPTION|UNHANDLED REJECTION" || true)
echo "Uncaught exceptions / unhandled rejections: $GUARD_HITS" >> "$REPORT_FILE"

# Unplanned restarts (systemd's Restart=on-failure kicking in). A deploy shows
# up here too, so treat a small number as normal.
APP_RESTARTS=$(echo "$APP_JOURNAL" | grep -c "Scheduled restart job" || true)
echo "ooosh-portal auto-restarts: $APP_RESTARTS" >> "$REPORT_FILE"

# Scheduled task failures — sync, chasers, backups, emails.
SCHED_FAILS=$(echo "$APP_JOURNAL" | grep -ciE "Scheduler:.*(failed|error)" || true)
echo "Scheduler task failures: $SCHED_FAILS" >> "$REPORT_FILE"
if [ "$SCHED_FAILS" -gt 0 ]; then
    echo "$APP_JOURNAL" | grep -iE "Scheduler:.*(failed|error)" | tail -5 | sed 's/^/  /' >> "$REPORT_FILE"
fi
echo "" >> "$REPORT_FILE"

# --- Backups ---
# Nightly pg_dump to R2, run by the app scheduler at 02:00. A silent backup
# failure is the worst thing on this server, and it has happened before (the
# sync_log permission bug, broken for weeks before anyone noticed in Mar 2026).
# Check it explicitly rather than assume.
echo "--- Backups ---" >> "$REPORT_FILE"
BACKUP_LINES=$(echo "$APP_JOURNAL" | grep -i "backup" | grep -vi "scheduled at" | tail -8)
if [ -n "$BACKUP_LINES" ]; then
    echo "$BACKUP_LINES" | sed 's/^/  /' >> "$REPORT_FILE"
else
    echo "WARNING: no backup activity in the journal for the last 7 days" >> "$REPORT_FILE"
fi

# Each backup counted on its own. In the mixed tail above, a missing Traccar
# backup could hide behind seven good OP ones. Once the old H2 copies are gone
# (docs/TRACCAR-POSTGRES.md Phase 6), the nightly R2 dump is the only
# off-server copy of the GPS history, so a gap there must be loud.
OP_BACKUP_OK=$(echo "$APP_JOURNAL" | grep -c "Scheduler: Backup complete" || true)
OP_BACKUP_FAIL=$(echo "$APP_JOURNAL" | grep -c "Scheduler: Backup failed" || true)
if [ "$OP_BACKUP_OK" -gt 0 ]; then
    OP_BACKUP_LAST=$(echo "$APP_JOURNAL" | grep "Scheduler: Backup complete" | tail -1 | awk '{print $1, $2, $3}')
    echo "OK - OP database: $OP_BACKUP_OK good backup(s) in 7 days, last $OP_BACKUP_LAST" >> "$REPORT_FILE"
else
    echo "WARNING - OP database: no successful backup in 7 days" >> "$REPORT_FILE"
fi
[ "$OP_BACKUP_FAIL" -gt 0 ] && echo "WARNING - OP database: $OP_BACKUP_FAIL failed backup(s) in 7 days" >> "$REPORT_FILE"

if grep -q '^TRACCAR_DATABASE_URL=' "$APP_DIR/backend/.env" 2>/dev/null; then
    TC_BACKUP_OK=$(echo "$APP_JOURNAL" | grep -c "Scheduler: Traccar backup complete" || true)
    TC_BACKUP_FAIL=$(echo "$APP_JOURNAL" | grep -c "Scheduler: Traccar backup failed" || true)
    if [ "$TC_BACKUP_OK" -gt 0 ]; then
        TC_BACKUP_LAST=$(echo "$APP_JOURNAL" | grep "Scheduler: Traccar backup complete" | tail -1)
        echo "OK - Traccar (GPS) database: $TC_BACKUP_OK good backup(s) in 7 days, last $(echo "$TC_BACKUP_LAST" | awk '{print $1, $2, $3}')" >> "$REPORT_FILE"
        echo "  $(echo "$TC_BACKUP_LAST" | sed 's/.*Scheduler: //')" >> "$REPORT_FILE"
    else
        echo "WARNING - Traccar (GPS) database: no successful backup in 7 days" >> "$REPORT_FILE"
    fi
    [ "$TC_BACKUP_FAIL" -gt 0 ] && echo "WARNING - Traccar (GPS) database: $TC_BACKUP_FAIL failed backup(s) in 7 days" >> "$REPORT_FILE"
else
    echo "WARNING - Traccar (GPS) database: nightly backup is not switched on (no TRACCAR_DATABASE_URL in backend/.env) - the GPS history has no off-server copy" >> "$REPORT_FILE"
fi
echo "" >> "$REPORT_FILE"

# --- SSL certificates ---
# certbot auto-renews, but a broken renewal timer is invisible until the site
# stops loading. Renewal happens at 30 days out, so under 21 means something
# has gone wrong and there is still time to fix it by hand.
echo "--- SSL ---" >> "$REPORT_FILE"
CERT_FOUND=0
for cert in /etc/letsencrypt/live/*/fullchain.pem; do
    [ -f "$cert" ] || continue
    CERT_FOUND=1
    DOMAIN=$(basename "$(dirname "$cert")")
    CERT_END=$(openssl x509 -enddate -noout -in "$cert" 2>/dev/null | cut -d= -f2)
    CERT_END_EPOCH=$(date -d "$CERT_END" +%s 2>/dev/null || echo 0)
    DAYS_LEFT=$(( (CERT_END_EPOCH - RUN_START_EPOCH) / 86400 ))
    if [ "$DAYS_LEFT" -lt 21 ]; then
        echo "WARNING - $DOMAIN expires in $DAYS_LEFT days ($CERT_END) - renewal may have failed" >> "$REPORT_FILE"
    else
        echo "OK - $DOMAIN expires in $DAYS_LEFT days" >> "$REPORT_FILE"
    fi
done
[ "$CERT_FOUND" -eq 0 ] && echo "No Let's Encrypt certificates found" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

# --- Security monitoring ---
echo "--- Security ---" >> "$REPORT_FILE"

# Fail2ban stats. Note "total" figures are cumulative since fail2ban last
# restarted, not weekly — the weekly number is the SSH count further down.
if fail2ban-client status sshd &>/dev/null; then
    F2B_OUTPUT=$(fail2ban-client status sshd 2>/dev/null)
    CURRENTLY_BANNED=$(echo "$F2B_OUTPUT" | grep "Currently banned:" | awk '{print $NF}')
    TOTAL_BANNED=$(echo "$F2B_OUTPUT" | grep "Total banned:" | awk '{print $NF}')
    TOTAL_FAILED=$(echo "$F2B_OUTPUT" | grep "Total failed:" | awk '{print $NF}')
    BANNED_IPS=$(echo "$F2B_OUTPUT" | grep "Banned IP list:" | sed 's/.*Banned IP list:\s*//')
    echo "Fail2ban SSH: $CURRENTLY_BANNED currently banned, $TOTAL_BANNED banned all-time, $TOTAL_FAILED failed attempts all-time" >> "$REPORT_FILE"
    if [ -n "$BANNED_IPS" ] && [ "$BANNED_IPS" != " " ]; then
        echo "Currently banned IPs: $BANNED_IPS" >> "$REPORT_FILE"
    fi
else
    echo "Fail2ban: NOT RUNNING or sshd jail not found" >> "$REPORT_FILE"
fi

# SSH activity, scoped to the last 7 days. Previously this counted the whole of
# auth.log, so "4,610 failed attempts" read as a weekly figure when it was
# however far back the current logfile happened to reach.
SSH_JOURNAL=$(journalctl --since "7 days ago" --no-pager _COMM=sshd 2>/dev/null)
if [ -z "$SSH_JOURNAL" ]; then
    SSH_JOURNAL=$(cat /var/log/auth.log 2>/dev/null)
    echo "(SSH stats from auth.log - journald had no sshd entries, window may exceed 7 days)" >> "$REPORT_FILE"
fi

FAILED_SSH_COUNT=$(echo "$SSH_JOURNAL" | grep -c "Failed password" || true)
FAILED_SSH_UNIQUE_IPS=$(echo "$SSH_JOURNAL" | grep "Failed password" | grep -oP 'from \K[0-9.]+' | sort -u | wc -l)
echo "Failed SSH attempts (7 days): $FAILED_SSH_COUNT from $FAILED_SSH_UNIQUE_IPS unique IPs" >> "$REPORT_FILE"

echo "Top offending IPs:" >> "$REPORT_FILE"
echo "$SSH_JOURNAL" | grep "Failed password" | grep -oP 'from \K[0-9.]+' | sort | uniq -c | sort -rn | head -5 >> "$REPORT_FILE"

# Successful logins - unique IPs with auth method and key fingerprint
echo "Successful SSH logins (7 days):" >> "$REPORT_FILE"
echo "$SSH_JOURNAL" | grep "Accepted" | grep -oP 'from \K[0-9.]+' | sort -u | while read -r ip; do
    LOGIN_COUNT=$(echo "$SSH_JOURNAL" | grep "Accepted" | grep -c "from $ip " || true)
    AUTH_METHOD=$(echo "$SSH_JOURNAL" | grep "Accepted" | grep "from $ip " | tail -1 | grep -oP 'Accepted \K\S+')
    KEY_FP=$(echo "$SSH_JOURNAL" | grep "Accepted" | grep "from $ip " | tail -1 | grep -oP 'SHA256:\K\S+')
    echo "  $ip ($LOGIN_COUNT logins via $AUTH_METHOD, key=$KEY_FP)" >> "$REPORT_FILE"
done

# Password-based logins would be concerning - this box is key-only
PASSWORD_LOGINS=$(echo "$SSH_JOURNAL" | grep -c "Accepted password" || true)
if [ "$PASSWORD_LOGINS" -gt 0 ]; then
    echo "WARNING: $PASSWORD_LOGINS successful PASSWORD logins detected (should be key-only):" >> "$REPORT_FILE"
    echo "$SSH_JOURNAL" | grep "Accepted password" >> "$REPORT_FILE"
fi

# New user accounts
NEW_USERS=$(echo "$SSH_JOURNAL" | grep "new user" || true)
if [ -n "$NEW_USERS" ]; then
    echo "WARNING: New user accounts created:" >> "$REPORT_FILE"
    echo "$NEW_USERS" >> "$REPORT_FILE"
fi

echo "" >> "$REPORT_FILE"

# --- Post-update state ---
echo "--- Post-Update State ---" >> "$REPORT_FILE"
echo "Disk: $(df -h / | tail -1 | awk '{print $3, "used of", $2, "("$5")"}')" >> "$REPORT_FILE"
echo "Memory: $(free -h | grep Mem | awk '{print $3, "used of", $2}')" >> "$REPORT_FILE"

# The memory line above is one reading at 3am, when nothing is busy. The real
# sign of a box short of memory is the kernel killing a process to survive -
# on 4GB, most likely Traccar's Java or PostgreSQL. _TRANSPORT=kernel rather
# than -k, because -k only reads since the last boot.
KERNEL_JOURNAL=$(journalctl _TRANSPORT=kernel --since "7 days ago" --no-pager 2>/dev/null)
OOM_KILLS=$(echo "$KERNEL_JOURNAL" | grep -ci "out of memory: killed process" || true)
echo "Out-of-memory kills (7 days): $OOM_KILLS" >> "$REPORT_FILE"
if [ "$OOM_KILLS" -gt 0 ]; then
    echo "WARNING - the kernel killed a process to free memory:" >> "$REPORT_FILE"
    echo "$KERNEL_JOURNAL" | grep -i "out of memory: killed process" | tail -3 | cut -c1-220 | sed 's/^/  /' >> "$REPORT_FILE"
fi

if [ -f /var/run/reboot-required ]; then
    echo "REBOOT REQUIRED: Yes" >> "$REPORT_FILE"
    echo "Reason: $(cat /var/run/reboot-required.pkgs 2>/dev/null || echo 'Unknown')" >> "$REPORT_FILE"
else
    echo "REBOOT REQUIRED: No" >> "$REPORT_FILE"
fi
echo "" >> "$REPORT_FILE"

# --- Disk space ---
# A percentage on its own hides the trend. On 12 Oct 2026 the disk was about
# half full; a week later it was 76% and the digest called it "acceptable" -
# 11GB had landed in one go (the Traccar move's safety copies). So say how
# much it changed since last week, and where the space is.
echo "--- Disk Space ---" >> "$REPORT_FILE"
DISK_USED_MB=$(df -BM --output=used / | tail -1 | tr -dc 0-9)
DISK_PCT=$(df --output=pcent / | tail -1 | tr -dc 0-9)
PREV_DATE=""
PREV_MB=""
[ -r "$DISK_STATE" ] && read -r PREV_DATE PREV_MB < "$DISK_STATE"
if [[ "$PREV_MB" =~ ^[0-9]+$ ]]; then
    DIFF_MB=$((DISK_USED_MB - PREV_MB))
    echo "Change since last report ($PREV_DATE): $(awk -v d="$DIFF_MB" 'BEGIN { printf "%+.1f", d / 1024 }') GB" >> "$REPORT_FILE"
    if [ "$DIFF_MB" -ge 2048 ]; then
        echo "WARNING - disk use grew by more than 2GB since the last report - the list below shows where" >> "$REPORT_FILE"
    fi
else
    echo "Change since last report: no earlier figure yet (first run with this check)" >> "$REPORT_FILE"
fi
echo "$(date +%F) $DISK_USED_MB" > "$DISK_STATE"

# A full disk stops PostgreSQL writing, which takes OP and GPS down with it.
if [ "$DISK_PCT" -ge 85 ]; then
    echo "WARNING - disk at ${DISK_PCT}% - act now" >> "$REPORT_FILE"
elif [ "$DISK_PCT" -ge 80 ]; then
    echo "NOTE - disk at ${DISK_PCT}% - time to look at what is using it" >> "$REPORT_FILE"
fi

echo "Largest folders:" >> "$REPORT_FILE"
du -xh / --max-depth=2 2>/dev/null | sort -h | tail -12 | sed 's/^/  /' >> "$REPORT_FILE"

echo "PostgreSQL databases:" >> "$REPORT_FILE"
sudo -u postgres psql -Atc "SELECT datname || ': ' || pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1') ORDER BY pg_database_size(datname) DESC" 2>/dev/null | sed 's/^/  /' >> "$REPORT_FILE"

# Trimmed to 3 months / 2GB under Housekeeping below.
echo "System logs (journal): $(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMGT]' | head -1)" >> "$REPORT_FILE"

# A stopped container keeps everything inside it until it is removed -
# traccar-h2-old held 3.65GB of the old GPS database this way.
STOPPED_CONTAINERS=$(docker ps -a --filter status=exited --size --format '{{.Names}} - {{.Status}} - {{.Size}}' 2>/dev/null)
if [ -n "$STOPPED_CONTAINERS" ]; then
    echo "Stopped Docker containers (still taking disk space until removed):" >> "$REPORT_FILE"
    echo "$STOPPED_CONTAINERS" | sed 's/^/  /' >> "$REPORT_FILE"
fi
echo "" >> "$REPORT_FILE"

# --- Runtime: is what we run still supported, and is it what's running? ---
# Added Oct 2026 after Node 20 sat on this box for six months past its end
# of life with nothing to say so (the Oct 2026 Brotli RCE, CVE-2026-111497,
# had no fix for it; Stripe's telemetry noticed before we did). `apt upgrade`
# cannot catch that: an end-of-life line simply stops publishing packages.
# So this section counts down to each runtime's support end, every week, and
# shouts when a version isn't in the table at all - which is what a line we
# forgot to plan for looks like.
#
# Dates are from endoflife.date (ubuntu / postgresql / nodejs). Add a row when
# upgrading; the "no support end date on file" warning is the nudge.
echo "--- Runtime ---" >> "$REPORT_FILE"

declare -A SUPPORT_END=(
    [ubuntu:22.04]=2027-04-30
    [ubuntu:24.04]=2029-04-30       # end of standard support (5 years)
    [ubuntu:26.04]=2031-04-30
    [postgresql:15]=2027-11-11
    [postgresql:16]=2028-11-09      # final release of the 16 line
    [postgresql:17]=2029-11-08
    [postgresql:18]=2030-11-14
    [nodejs:20]=2026-04-30          # the line we sat on past its end
    [nodejs:22]=2027-04-30          # maintenance LTS ends
    [nodejs:24]=2028-04-30
    [nodejs:26]=2029-04-30
)

# support_line NAME VERSION WARN_DAYS - one report line per runtime.
support_line() {
    local name="$1" ver="$2" warn="$3" end days
    end="${SUPPORT_END[$name:$ver]:-}"
    if [ -z "$ver" ]; then
        echo "WARNING - $name: could not read the installed version" >> "$REPORT_FILE"
        return
    fi
    if [ -z "$end" ]; then
        echo "WARNING - $name $ver: no support end date on file - add [$name:$ver] to SUPPORT_END in weekly-maintenance.sh (see endoflife.date/$name)" >> "$REPORT_FILE"
        return
    fi
    days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
    if [ "$days" -lt 0 ]; then
        echo "WARNING - $name $ver: OUT OF SUPPORT since $end - no more security fixes; upgrade now" >> "$REPORT_FILE"
    elif [ "$days" -le "$warn" ]; then
        echo "WARNING - $name $ver: support ends $end ($days days) - plan the upgrade" >> "$REPORT_FILE"
    else
        echo "OK - $name $ver: supported until $end ($days days)" >> "$REPORT_FILE"
    fi
}

# OS and Postgres want months of notice (a major upgrade is a planned job);
# Node needs a quarter (a point of apt, as Oct 2026 showed).
OS_VERSION=$(. /etc/os-release 2>/dev/null && echo "$VERSION_ID")
PG_VERSION=$(pg_lsclusters -h 2>/dev/null | awk 'NR==1 {print $1}')
[ -z "$PG_VERSION" ] && PG_VERSION=$(psql --version 2>/dev/null | grep -oE '[0-9]+' | head -1)
NODE_INSTALLED=$(/usr/bin/node -v 2>/dev/null)
NODE_MAJOR=$(echo "$NODE_INSTALLED" | sed 's/^v//' | cut -d. -f1)
support_line ubuntu     "$OS_VERSION" 180
support_line postgresql "$PG_VERSION" 180
support_line nodejs     "$NODE_MAJOR" 90

# Is the API actually running the Node that is installed? apt replaces the
# file; the process keeps the old binary until something restarts it. apt's
# needrestart hook normally bounces ooosh-portal in the same run, so this is
# the check that it did. Linux marks a replaced binary "(deleted)" on the
# process's exe link.
PORTAL_PID=$(systemctl show -p MainPID --value ooosh-portal 2>/dev/null)
if [ -n "$PORTAL_PID" ] && [ "$PORTAL_PID" != "0" ]; then
    PORTAL_EXE=$(readlink "/proc/$PORTAL_PID/exe" 2>/dev/null)
    case "$PORTAL_EXE" in
        *"(deleted)"*)
            echo "RESTART NEEDED - ooosh-portal is running a Node binary that has since been replaced on disk (installed: $NODE_INSTALLED) - systemctl restart ooosh-portal" >> "$REPORT_FILE" ;;
        *)
            echo "OK - ooosh-portal is running the installed Node ($NODE_INSTALLED)" >> "$REPORT_FILE" ;;
    esac
fi

# Pending restarts the upgrades left behind. Reported, never acted on here -
# a reboot is jon's call.
if [ -f /var/run/reboot-required ]; then
    REBOOT_PKGS=$(sort -u /var/run/reboot-required.pkgs 2>/dev/null | tr '\n' ' ')
    echo "REBOOT NEEDED - ${REBOOT_PKGS:-see /var/run/reboot-required}" >> "$REPORT_FILE"
else
    echo "OK - no reboot pending" >> "$REPORT_FILE"
fi
if command -v needrestart &>/dev/null; then
    DEFERRED_SVCS=$(needrestart -b -r l 2>/dev/null | awk '/^NEEDRESTART-SVC:/ {print $2}' | tr '\n' ' ')
    if [ -n "$DEFERRED_SVCS" ]; then
        echo "Services still on replaced libraries (restart when convenient): $DEFERRED_SVCS" >> "$REPORT_FILE"
    fi
fi
echo "" >> "$REPORT_FILE"

# --- Old kernel cleanup check ---
# grep -c exits 1 on no matches, so the old `|| echo 0` appended a second zero
# to grep's own "0" and produced "0 0".
KERNEL_COUNT=$(dpkg --list | grep -c "^ii  linux-image" || true)
echo "--- Housekeeping ---" >> "$REPORT_FILE"
echo "Installed kernel images: $KERNEL_COUNT" >> "$REPORT_FILE"

# Traccar starts a new log file every day (~20MB) and never deletes the old
# ones: by Oct 2026 its log folder held 3.6GB going back to Feb. Keep 30 days.
# The positions themselves stay in the database for 12 months.
TC_LOGS_DELETED=$(find "$TRACCAR_LOG_DIR" -maxdepth 1 -name 'tracker-server.log.*' -mtime +30 -print -delete 2>/dev/null | wc -l)
echo "Traccar log files over 30 days old deleted: $TC_LOGS_DELETED" >> "$REPORT_FILE"

# System logs: keep 3 months, never more than 2GB. Long enough to find when
# something that broke silently started (the sync_log bug went unnoticed for
# weeks); the checks above only read the last 7 days. Runs after them.
journalctl --vacuum-time=3months --vacuum-size=2G 2>&1 | tail -3
echo "System logs after trimming to 3 months / 2GB: $(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMGT]' | head -1)" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

# --- Send to Claude and email ---
# --- GitHub: Dependabot queue -------------------------------------------
# What is waiting in the repo's pull-request list and what to do about each.
# Minor/patch bumps merge themselves once CI is green (dependabot-auto-merge.yml);
# majors never do. Needs GITHUB_TOKEN (fine-grained, read-only: Pull requests +
# Checks + Metadata on the repo) and GITHUB_REPO in config.env. Skipped quietly
# when they are not set.
echo "--- GitHub: Dependabot queue ---" >> "$REPORT_FILE"
if [ -n "${GITHUB_TOKEN:-}" ] && [ -n "${GITHUB_REPO:-}" ]; then
    GITHUB_TOKEN="$GITHUB_TOKEN" GITHUB_REPO="$GITHUB_REPO" python3 - >> "$REPORT_FILE" 2>&1 <<'PY'
import json, os, re, sys, urllib.request, datetime
repo = os.environ["GITHUB_REPO"]; tok = os.environ["GITHUB_TOKEN"]
def gh(path):
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}{path}",
        headers={"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json", "User-Agent": "ooosh-weekly"})
    with urllib.request.urlopen(req, timeout=20) as r: return json.load(r)
try:
    prs = gh("/pulls?state=open&per_page=100")
except Exception as e:
    print(f"Could not read GitHub: {e}"); sys.exit(0)
bots = [p for p in prs if p["user"]["login"] == "dependabot[bot]"]
others = [p for p in prs if p["user"]["login"] != "dependabot[bot]"]
print(f"Open pull requests: {len(prs)} ({len(bots)} Dependabot, {len(others)} other)")
if not bots: print("Dependabot queue is empty.")
now = datetime.datetime.now(datetime.timezone.utc)
def semver_major(t):
    m = re.search(r"from (\d+)[\d.]* to (\d+)[\d.]*", t)
    return bool(m and m.group(1) != m.group(2))
for p in bots:
    title = p["title"]; n = p["number"]
    age = (now - datetime.datetime.fromisoformat(p["created_at"].replace("Z", "+00:00"))).days
    major = semver_major(title) and "minor-and-patch" not in p["head"]["ref"]
    try:
        runs = gh(f"/commits/{p['head']['sha']}/check-runs?per_page=50")["check_runs"]
        ci = [r for r in runs if r["name"] in ("Backend build", "Frontend build")]
        concl = {r["conclusion"] for r in ci}
        state = "green" if ci and concl == {"success"} else ("red" if "failure" in concl else "pending")
    except Exception:
        state = "unknown"
    if major:
        action = f"MAJOR version - never auto-merges. Open a Claude session: \"review Dependabot PR #{n} and recommend merge or close\"."
    elif state == "red":
        action = f"build FAILS - open a Claude session: \"fix Dependabot PR #{n}\"."
    elif state == "green" and age >= 3:
        action = f"green but stuck {age}d - comment \"@dependabot rebase\" on it (or ask Claude to); it then merges itself."
    elif state == "green":
        action = "green - will merge itself."
    else:
        action = f"CI {state} - check again next week; if still open, comment \"@dependabot rebase\"."
    print(f"#{n} ({age}d, CI {state}) {title}\n    -> {action}")
if others:
    print("Other open PRs (yours, not Dependabot):")
    for p in others: print(f"  #{p['number']} {p['title']}")
PY
else
    echo "Not configured: set GITHUB_TOKEN and GITHUB_REPO in /etc/ooosh-maintenance/config.env" >> "$REPORT_FILE"
fi
echo "" >> "$REPORT_FILE"

echo "Sending report to Claude for digest..."
python3 /etc/ooosh-maintenance/send-digest.py "$REPORT_FILE"

# --- Clean up old logs (keep 12 weeks) ---
find "$LOG_DIR" -name "*.txt" -mtime +84 -delete 2>/dev/null
find "$LOG_DIR" -name "*.log" -mtime +84 -delete 2>/dev/null

echo "=== Maintenance complete - $(date) ==="
