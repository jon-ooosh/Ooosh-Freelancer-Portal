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
# =============================================================

set -euo pipefail

APP_DIR="/var/www/ooosh-portal"
BRANCH="${1:-main}"  # Default to main branch, or pass branch name as arg

echo "============================================"
echo "  Deploying Ooosh Operations Portal"
echo "  Branch: ${BRANCH}"
echo "============================================"

cd "${APP_DIR}"

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
npm ci --production=false  # Need devDeps for TypeScript build
cd "${APP_DIR}/frontend"
npm ci

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

echo ""
echo "============================================"
echo "  Build Complete!"
echo "============================================"
echo ""
echo "  Restart the service:"
echo "    sudo systemctl restart ooosh-portal"
echo ""
echo "  Check status:"
echo "    sudo systemctl status ooosh-portal"
echo "    sudo journalctl -u ooosh-portal -f"
echo ""
