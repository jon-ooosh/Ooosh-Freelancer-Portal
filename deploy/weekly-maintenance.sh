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
    echo "RUNNING - traccar (docker)" >> "$REPORT_FILE"
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

if [ -f /var/run/reboot-required ]; then
    echo "REBOOT REQUIRED: Yes" >> "$REPORT_FILE"
    echo "Reason: $(cat /var/run/reboot-required.pkgs 2>/dev/null || echo 'Unknown')" >> "$REPORT_FILE"
else
    echo "REBOOT REQUIRED: No" >> "$REPORT_FILE"
fi
echo "" >> "$REPORT_FILE"

# --- Old kernel cleanup check ---
# grep -c exits 1 on no matches, so the old `|| echo 0` appended a second zero
# to grep's own "0" and produced "0 0".
KERNEL_COUNT=$(dpkg --list | grep -c "^ii  linux-image" || true)
echo "--- Housekeeping ---" >> "$REPORT_FILE"
echo "Installed kernel images: $KERNEL_COUNT" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

# --- Send to Claude and email ---
echo "Sending report to Claude for digest..."
python3 /etc/ooosh-maintenance/send-digest.py "$REPORT_FILE"

# --- Clean up old logs (keep 12 weeks) ---
find "$LOG_DIR" -name "*.txt" -mtime +84 -delete 2>/dev/null
find "$LOG_DIR" -name "*.log" -mtime +84 -delete 2>/dev/null

echo "=== Maintenance complete - $(date) ==="
