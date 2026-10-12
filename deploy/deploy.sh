#!/bin/bash
# =============================================================
# Ooosh Operations Portal - Deploy / Update Script
# =============================================================
# Run as the ooosh user:
#   bash /var/www/ooosh-portal/deploy/deploy.sh
#
# This script:
#   1. Pulls latest code from git
#   2. Installs dependencies
#   3. Builds frontend and backend
#   4. Runs database migrations
#   5. Restarts the service
#
# The service keeps running the previous build until the final restart, so
# deploys can happen ad hoc while staff are using OP. If `npm ci` fails
# (10 Oct 2026: ENOTEMPTY on a half-deleted node_modules), the folder is
# cleared and the install retried once. If any step fails, nothing is
# restarted and the old build carries on — the script says so.
# =============================================================

set -euo pipefail

APP_DIR="/var/www/ooosh-portal"
BRANCH="${1:-main}"  # Default to main branch, or pass branch name as arg

echo "============================================"
echo "  Deploying Ooosh Operations Portal"
echo "  Branch: ${BRANCH}"
echo "============================================"

cd "${APP_DIR}"

on_fail() {
  echo ""
  echo "!!! Deploy FAILED — nothing was restarted; the previous build is still running."
  echo "!!! Do NOT restart ooosh-portal until this script completes: if the install"
  echo "!!! step failed, node_modules may be incomplete and a restart would crash."
  echo "!!! Fix the error above and re-run this script."
}

# npm ci, and if it fails (e.g. ENOTEMPTY) clear node_modules and try once more.
install_deps() {
  if [ -f package-lock.json ]; then
    npm ci "$@" || { echo "npm ci failed — clearing node_modules and retrying once..."; rm -rf node_modules; npm ci "$@"; }
  else
    npm install
  fi
}
trap on_fail ERR

# --- Pull latest code ---
echo ""
echo "[1/5] Pulling latest code..."
git fetch origin "${BRANCH}"
git checkout "${BRANCH}"
git pull origin "${BRANCH}"

# --- Install dependencies ---
echo ""
echo "[2/5] Installing dependencies..."
cd "${APP_DIR}/backend"
install_deps --production=false
cd "${APP_DIR}/frontend"
install_deps

# --- Build backend ---
echo ""
echo "[3/5] Building backend..."
cd "${APP_DIR}/backend"
npm run build

# --- Build frontend ---
echo ""
echo "[4/5] Building frontend..."
cd "${APP_DIR}/frontend"
npm run build

# --- Run migrations ---
echo ""
echo "[5/5] Running database migrations..."
cd "${APP_DIR}/backend"
npm run db:migrate

# --- Restart the service (a few seconds' blip) ---
sudo systemctl restart ooosh-portal
trap - ERR

echo ""
echo "============================================"
echo "  Deploy Complete — service restarted"
echo "============================================"
echo ""
echo "  Check status:"
echo "    sudo systemctl status ooosh-portal"
echo "    sudo journalctl -u ooosh-portal -f"
echo ""
