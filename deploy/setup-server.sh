#!/bin/bash
# =============================================================
# Ooosh Operations Portal - Hetzner Server Setup Script
# =============================================================
# Run this script as root on your Hetzner VPS:
#   chmod +x setup-server.sh && sudo ./setup-server.sh
#
# BEFORE running this script:
#   1. SSH into your Hetzner VPS
#   2. Make sure you know your server's IP address
#
# AFTER running this script:
#   1. Edit /var/www/ooosh-portal/backend/.env with your real values
#   2. Run the deploy script: sudo -u ooosh /var/www/ooosh-portal/deploy/deploy.sh
# =============================================================

set -euo pipefail

echo "============================================"
echo "  Ooosh Operations Portal - Server Setup"
echo "============================================"

# --- 1. System packages ---
echo ""
echo "[1/7] Installing system packages..."
apt-get update -qq
apt-get install -y -qq curl git build-essential

# --- 2. Node.js 20 LTS ---
echo ""
echo "[2/7] Installing Node.js 20 LTS..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
fi
echo "  Node.js $(node -v) installed"
echo "  npm $(npm -v) installed"

# --- 3. PostgreSQL ---
echo ""
echo "[3/7] Setting up PostgreSQL..."
if ! command -v psql &> /dev/null; then
    apt-get install -y -qq postgresql postgresql-contrib
fi
systemctl enable postgresql
systemctl start postgresql

# Create database and user (idempotent)
DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='ooosh'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE USER ooosh WITH PASSWORD '${DB_PASSWORD}';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='ooosh_operations'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE DATABASE ooosh_operations OWNER ooosh;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ooosh_operations TO ooosh;"

echo "  PostgreSQL ready"
echo "  Database: ooosh_operations"
echo "  User: ooosh"
echo "  Password: ${DB_PASSWORD}"
echo "  >>> SAVE THIS PASSWORD - you'll need it for .env <<<"

# --- 4. Redis ---
echo ""
echo "[4/7] Installing Redis..."
if ! command -v redis-cli &> /dev/null; then
    apt-get install -y -qq redis-server
fi
systemctl enable redis-server
systemctl start redis-server
echo "  Redis ready on localhost:6379"

# --- 5. Create ooosh system user ---
echo ""
echo "[5/7] Creating ooosh system user..."
if ! id "ooosh" &>/dev/null; then
    useradd -r -m -s /bin/bash ooosh
fi
echo "  User 'ooosh' ready"

# --- 6. Create app directory ---
echo ""
echo "[6/7] Setting up app directory..."
mkdir -p /var/www/ooosh-portal
chown ooosh:ooosh /var/www/ooosh-portal

# --- 7. Nginx (should already be installed for Traccar) ---
echo ""
echo "[7/7] Checking Nginx..."
if ! command -v nginx &> /dev/null; then
    apt-get install -y -qq nginx
fi
systemctl enable nginx
echo "  Nginx ready"

echo ""
echo "============================================"
echo "  Setup Complete!"
echo "============================================"
echo ""
echo "NEXT STEPS:"
echo ""
echo "  1. Clone the repo as the ooosh user:"
echo "     sudo -u ooosh git clone https://github.com/jon-ooosh/Ooosh-Freelancer-Portal.git /var/www/ooosh-portal"
echo ""
echo "  2. Create the backend .env file:"
echo "     sudo -u ooosh cp /var/www/ooosh-portal/backend/.env.example /var/www/ooosh-portal/backend/.env"
echo "     sudo -u ooosh nano /var/www/ooosh-portal/backend/.env"
echo ""
echo "  3. Update these values in .env:"
echo "     NODE_ENV=production"
echo "     DATABASE_URL=postgresql://ooosh:${DB_PASSWORD}@localhost:5432/ooosh_operations"
echo "     JWT_SECRET=$(openssl rand -base64 32)"
echo "     FRONTEND_URL=http://YOUR_SERVER_IP"
echo ""
echo "  4. Run the deploy script:"
echo "     sudo -u ooosh bash /var/www/ooosh-portal/deploy/deploy.sh"
echo ""
echo "  5. Install systemd service & nginx config:"
echo "     sudo cp /var/www/ooosh-portal/deploy/ooosh-portal.service /etc/systemd/system/"
echo "     sudo systemctl daemon-reload"
echo "     sudo systemctl enable ooosh-portal"
echo "     sudo systemctl start ooosh-portal"
echo ""
echo "     # Update YOUR_SERVER_IP in nginx config, then:"
echo "     sudo cp /var/www/ooosh-portal/deploy/nginx-ooosh-portal.conf /etc/nginx/sites-available/ooosh-portal"
echo "     sudo ln -sf /etc/nginx/sites-available/ooosh-portal /etc/nginx/sites-enabled/"
echo "     sudo nginx -t && sudo systemctl reload nginx"
echo ""
echo "  6. Visit http://YOUR_SERVER_IP to see the portal!"
echo ""
