#!/usr/bin/env bash
#
# One-time setup for a fresh Hetzner Ubuntu 24.04 box (run as root):
#   curl -fsSL <raw-url>/setup-vps.sh | bash   — or scp + bash setup-vps.sh
#
# After it finishes: clone the repo, create render/.env.vps from the example,
# then: cd render && docker compose -f docker-compose.vps.yml up -d --build
set -euo pipefail

echo "==> System packages"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
apt-get install -y ufw git curl unattended-upgrades

echo "==> Firewall (SSH + HTTP/HTTPS only; render server stays behind Caddy)"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> 8 GB swapfile (OOM safety net — 32 GB RAM is the working budget)"
if [ ! -f /swapfile ]; then
  fallocate -l 8G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10
grep -q 'vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf

echo "==> Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> Automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo ""
echo "Done. Next steps:"
echo "  1. git clone <your repo> && cd <repo>/render"
echo "  2. cp .env.vps.example .env.vps && edit it (token, R2 creds, domain)"
echo "  3. docker compose -f docker-compose.vps.yml up -d --build"
echo "  4. curl -s https://\$RENDER_DOMAIN/health"
