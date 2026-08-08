#!/usr/bin/env bash
# ==============================================================================
# Family Tasks App - Oracle Cloud Setup Script
# סקריפט התקנה והגדרה עבור שרת Oracle Cloud - אפליקציית משימות משפחתיות
# ==============================================================================
#
# Usage / אופן השימוש:
#   sudo chmod +x setup.sh
#   sudo ./setup.sh DOMAIN EMAIL [ALLOWED_ORIGIN]
#   Example: sudo ./setup.sh family-tasks.duckdns.org you@example.com
#
# EMAIL is used for Let's Encrypt expiry warnings and is required: running
# certbot without one means no warning before the certificate lapses.
#
# ALLOWED_ORIGIN restricts API CORS to a single site. Omit it when the PWA is
# served from this same domain (the common case) and no CORS headers are needed.
# Set it to e.g. https://user.github.io only if the app is hosted elsewhere.
#
# Optional DuckDNS auto-update (keeps the subdomain pointed at this host):
#   DUCKDNS_SUBDOMAIN=family-tasks DUCKDNS_TOKEN=xxxx sudo -E ./setup.sh ...
#
# ==============================================================================

set -eo pipefail

# Colors for terminal output / צבעים לפלט בטרמינל
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Domain configuration / הגדרת דומיין
DOMAIN="${1:-}"
LETSENCRYPT_EMAIL="${2:-}"
ALLOWED_ORIGIN="${3:-}"
APP_DIR="/home/ubuntu/family-app"
WWW_DIR="/var/www/family-app"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="ubuntu"
NODE_MAJOR=20

# DuckDNS (optional) / עדכון אוטומטי של כתובת DuckDNS
DUCKDNS_SUBDOMAIN="${DUCKDNS_SUBDOMAIN:-}"
DUCKDNS_TOKEN="${DUCKDNS_TOKEN:-}"

log_info() {
    echo -e "${BLUE}[מידע / INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[הצלחה / SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[אזהרה / WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[שגיאה / ERROR]${NC} $1"
}

# ------------------------------------------------------------------------------
# 1. Root check / בדיקת הרשאות מנהל
# ------------------------------------------------------------------------------
if [ "$EUID" -ne 0 ]; then
  log_error "Please run as root (use sudo)."
  log_error "אנא הרץ סקריפט זה כ-root (השתמש ב-sudo)."
  exit 1
fi

if [ -z "$DOMAIN" ] || [ -z "$LETSENCRYPT_EMAIL" ]; then
  log_error "Usage: sudo ./setup.sh DOMAIN EMAIL [ALLOWED_ORIGIN]"
  log_error "  e.g. sudo ./setup.sh family-tasks.duckdns.org you@example.com"
  log_error "שימוש: sudo ./setup.sh דומיין אימייל [מקור-מורשה]"
  exit 1
fi

# Certificate issuance needs this hostname to already resolve to this machine.
log_info "Checking that ${DOMAIN} resolves..."
if ! getent hosts "$DOMAIN" >/dev/null 2>&1; then
  log_warning "${DOMAIN} does not resolve yet. Certbot will fail until DNS propagates."
  log_warning "הדומיין ${DOMAIN} אינו מתורגם עדיין. יש להמתין להתפשטות ה-DNS."
fi

log_info "Starting installation for domain: ${DOMAIN}..."
log_info "מתחיל בהתקנה והגדרה עבור דומיין: ${DOMAIN}..."

# ------------------------------------------------------------------------------
# 2. System updates & package installation / עדכון המערכת והתקנת חבילות
# ------------------------------------------------------------------------------
log_info "Step 1/11: Updating system packages..."
log_info "שלב 1/11: מעדכן חבילות מערכת..."

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y

log_info "Step 2/11: Installing dependencies (Node.js 18+, Python 3.11+, sqlite3, nginx, certbot)..."
log_info "שלב 2/11: מתקין תלויות מערכת (Node.js, Python, sqlite3, Nginx, Certbot)..."

apt-get install -y \
    curl \
    git \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    sqlite3 \
    nginx \
    certbot \
    python3-certbot-nginx \
    ufw \
    iptables-persistent

# Node.js: add the NodeSource repo, then actually install the package.
# (A previous version added the repo but omitted `nodejs` from the install list,
#  so Node was never present and the WhatsApp channel could not start.)
NODE_CURRENT=0
if command -v node &> /dev/null; then
    NODE_CURRENT="$(node -v | cut -d'.' -f1 | tr -d 'v')"
fi

if [ "$NODE_CURRENT" -lt "$NODE_MAJOR" ]; then
    log_info "Installing Node.js ${NODE_MAJOR}.x (found major version: ${NODE_CURRENT})..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
fi

if ! command -v node &> /dev/null; then
    log_error "Node.js installation failed; the WhatsApp channel requires it."
    exit 1
fi
log_success "Node.js $(node -v) is installed."

log_success "System packages installed successfully."
log_success "חבילות המערכת הותקנו בהצלחה."

# ------------------------------------------------------------------------------
# 3. Nanobot installation / התקנת nanobot
# ------------------------------------------------------------------------------
log_info "Step 3/11: Installing nanobot-ai..."
log_info "שלב 3/11: מתקין את nanobot-ai..."

# Create Python virtualenv if not existing / יצירת סביבה וירטואלית
VENV_PATH="/opt/nanobot-venv"
if [ ! -d "$VENV_PATH" ]; then
    python3 -m venv "$VENV_PATH"
fi

"$VENV_PATH/bin/pip" install --upgrade pip
"$VENV_PATH/bin/pip" install nanobot-ai || pip3 install nanobot-ai --break-system-packages || true

# Symlink nanobot executable to /usr/local/bin / יצירת קישור למשתנה סביבה
if [ -f "$VENV_PATH/bin/nanobot" ]; then
    ln -sf "$VENV_PATH/bin/nanobot" /usr/local/bin/nanobot
fi

log_success "nanobot installed successfully."
log_success "nanobot הותקן בהצלחה."

# ------------------------------------------------------------------------------
# 4. Directory Structure Creation / יצירת מבנה תיקיות
# ------------------------------------------------------------------------------
log_info "Step 4/11: Creating directory structure..."
log_info "שלב 4/11: יוצר מבנה תיקיות..."

mkdir -p "${APP_DIR}"
mkdir -p "${APP_DIR}/uploads"
mkdir -p "${WWW_DIR}"

# Fix permissions / הגדרת הרשאות
# Owned by the service user; not world-writable. Nginx reads uploads via its
# own group membership rather than through 777.
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}" || chown -R 1000:1000 "${APP_DIR}" || true
chmod 755 "${APP_DIR}"
chmod 755 "${APP_DIR}/uploads"
usermod -aG "${SERVICE_USER}" www-data || true

log_success "Directories created successfully."
log_success "התיקיות נוצרו בהצלחה."

# ------------------------------------------------------------------------------
# 5. Copy Configuration Files / העתקת קובצי תצורה
# ------------------------------------------------------------------------------
log_info "Step 5/11: Copying configuration files..."
log_info "שלב 5/11: מעתיק קובצי תצורה..."

if [ -f "${SCRIPT_DIR}/nanobot-config.json" ]; then
    cp -u "${SCRIPT_DIR}/nanobot-config.json" "${APP_DIR}/nanobot-config.json"
else
    log_warning "nanobot-config.json not found in script directory. Skipping copy."
fi

if [ -f "${SCRIPT_DIR}/schema.sql" ]; then
    cp -u "${SCRIPT_DIR}/schema.sql" "${APP_DIR}/schema.sql"
else
    log_warning "schema.sql not found in script directory. Skipping copy."
fi

# ------------------------------------------------------------------------------
# 6. Initialize SQLite Database / אתחול מסד נתונים SQLite
# ------------------------------------------------------------------------------
log_info "Step 6/11: Initializing SQLite database from schema.sql..."
log_info "שלב 6/11: מאתחל את מסד הנתונים SQLite מתוך schema.sql..."

DB_FILE="${APP_DIR}/family_tasks.db"

if [ -f "${APP_DIR}/schema.sql" ]; then
    sqlite3 "$DB_FILE" < "${APP_DIR}/schema.sql"
    chown "${SERVICE_USER}:${SERVICE_USER}" "$DB_FILE" 2>/dev/null || true
    # 600, not 666: this holds the family's task data and only the service
    # account needs to read or write it.
    chmod 600 "$DB_FILE"
    log_success "Database initialized at ${DB_FILE}."
    log_success "מסד הנתונים אותחל בהצלחה ב-${DB_FILE}."
else
    log_warning "schema.sql missing, skipping database initialization."
fi

# ------------------------------------------------------------------------------
# 7. Configure Nginx / הגדרת שרת Nginx
# ------------------------------------------------------------------------------
log_info "Step 7/11: Configuring Nginx reverse proxy and static site..."
log_info "שלב 7/11: מגדיר את Nginx כשרת קבצים ושרת תיווך (Reverse Proxy)..."

NGINX_CONF="/etc/nginx/sites-available/family-app"

cat <<'EOF' > "$NGINX_CONF"
server {
    listen 80;
    listen [::]:80;
    server_name DOMAIN_PLACEHOLDER;

    # Base64 photos and uploads exceed the 1m default.
    client_max_body_size 12m;

    # Gzip compression / דחיסת קבצים
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;
    gzip_min_length 256;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Static Web App / קובצי האפליקציה
    location / {
        root /var/www/family-app;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # The service worker and shell must never be served stale, or clients pin
    # themselves to an old build and never see the update prompt.
    location = /sw.js {
        root /var/www/family-app;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    }

    location = /index.html {
        root /var/www/family-app;
        add_header Cache-Control "no-cache" always;
    }

    # Uploads directory / תמונות וקבצים שמועלים
    location /uploads/ {
        alias /home/ubuntu/family-app/uploads/;
        autoindex off;
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }

    # API Proxy to nanobot / תיווך בקשות API ל-nanobot
    location /v1/ {
CORS_PREFLIGHT_PLACEHOLDER
        # No trailing slash: the client calls /v1/chat/completions and nanobot
        # serves that same path. A trailing slash here would strip the /v1
        # prefix and every request would 404 upstream.
        proxy_pass http://127.0.0.1:8900;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 120s;
CORS_HEADERS_PLACEHOLDER
    }
}
EOF

# Substitute actual domain in Nginx configuration / החלפת הדומיין בקובץ התצורה
sed -i "s/DOMAIN_PLACEHOLDER/${DOMAIN}/g" "$NGINX_CONF"

# CORS is only needed when the PWA is served from a different origin than this
# API. When it is, allow exactly that one origin — never '*', which would let
# any site on the internet call the API with a stolen token.
if [ -n "$ALLOWED_ORIGIN" ]; then
    log_info "Restricting API CORS to ${ALLOWED_ORIGIN}"
    PREFLIGHT=$(cat <<CORSEOF
        if (\$request_method = 'OPTIONS') {
            add_header 'Access-Control-Allow-Origin' '${ALLOWED_ORIGIN}' always;
            add_header 'Access-Control-Allow-Methods' 'GET, POST, OPTIONS' always;
            add_header 'Access-Control-Allow-Headers' 'Authorization,Content-Type' always;
            add_header 'Access-Control-Max-Age' 86400;
            add_header 'Content-Length' 0;
            return 204;
        }
CORSEOF
)
    HEADERS="        add_header 'Access-Control-Allow-Origin' '${ALLOWED_ORIGIN}' always;"
else
    log_info "No ALLOWED_ORIGIN given — serving the app same-origin, CORS headers omitted."
    PREFLIGHT=""
    HEADERS=""
fi

python3 - "$NGINX_CONF" "$PREFLIGHT" "$HEADERS" <<'PYEOF'
import sys
path, preflight, headers = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding='utf-8') as fh:
    conf = fh.read()
conf = conf.replace('CORS_PREFLIGHT_PLACEHOLDER', preflight)
conf = conf.replace('CORS_HEADERS_PLACEHOLDER', headers)
with open(path, 'w', encoding='utf-8') as fh:
    fh.write(conf)
PYEOF

# Enable site / הפעלת האתר ב-Nginx
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/family-app
rm -f /etc/nginx/sites-enabled/default || true

# Test Nginx syntax / בדיקת תקינות תצורת Nginx
nginx -t

systemctl reload nginx

log_success "Nginx configured successfully."
log_success "Nginx הוגדר בהצלחה."

# Setup Certbot SSL / הגדרת תעודת אבטחה SSL
# A real address is registered so Let's Encrypt can warn before expiry.
# HTTPS is not optional here: without it the phone will not install the PWA.
log_info "Requesting SSL certificate via Certbot for ${DOMAIN}..."
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LETSENCRYPT_EMAIL" --redirect; then
    log_success "HTTPS enabled for ${DOMAIN}."
    systemctl enable certbot.timer 2>/dev/null || true
    systemctl start certbot.timer 2>/dev/null || true
else
    log_warning "Certbot failed. The site is still on plain HTTP."
    log_warning "Most common causes: DNS not pointing here yet, or port 80 blocked."
    log_warning "Check the Oracle Security List ingress rules, then re-run:"
    log_warning "  sudo certbot --nginx -d ${DOMAIN} -m ${LETSENCRYPT_EMAIL} --agree-tos --redirect"
fi

# ------------------------------------------------------------------------------
# 8. Create Systemd Service Files / יצירת שירותי Systemd
# ------------------------------------------------------------------------------
# ------------------------------------------------------------------------------
# 7b. DuckDNS auto-update / עדכון אוטומטי של DuckDNS
# ------------------------------------------------------------------------------
if [ -n "$DUCKDNS_SUBDOMAIN" ] && [ -n "$DUCKDNS_TOKEN" ]; then
    log_info "Configuring DuckDNS auto-update for ${DUCKDNS_SUBDOMAIN}.duckdns.org..."

    install -d -m 700 /etc/duckdns
    cat > /etc/duckdns/update.sh <<DUCKEOF
#!/usr/bin/env bash
# Re-points the DuckDNS record at this host's current public IP.
# Leaving the ip parameter empty tells DuckDNS to use the requesting address.
curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=" -o /var/log/duckdns.log
DUCKEOF

    # The token is a credential: readable by root only.
    chmod 700 /etc/duckdns/update.sh
    chown root:root /etc/duckdns/update.sh

    cat > /etc/systemd/system/duckdns.service <<'DUCKEOF'
[Unit]
Description=Update DuckDNS dynamic DNS record
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/etc/duckdns/update.sh
DUCKEOF

    cat > /etc/systemd/system/duckdns.timer <<'DUCKEOF'
[Unit]
Description=Update DuckDNS every 5 minutes

[Timer]
OnBootSec=60
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
DUCKEOF

    systemctl daemon-reload
    systemctl enable --now duckdns.timer

    if /etc/duckdns/update.sh && grep -q "OK" /var/log/duckdns.log 2>/dev/null; then
        log_success "DuckDNS updated: ${DUCKDNS_SUBDOMAIN}.duckdns.org now points here."
    else
        log_warning "DuckDNS update did not return OK — check the subdomain and token."
    fi
else
    log_info "DuckDNS variables not set; skipping dynamic DNS setup."
fi

log_info "Step 8/11: Creating systemd service files..."
log_info "שלב 8/11: יוצר קובצי שירות Systemd..."

# Service 1: nanobot gateway
cat <<EOF > /etc/systemd/system/family-nanobot.service
[Unit]
Description=Family App Nanobot Gateway Service
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=${APP_DIR}
ExecStart=/usr/local/bin/nanobot gateway --config ${APP_DIR}/nanobot-config.json
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Service 2: nanobot whatsapp channel login
cat <<EOF > /etc/systemd/system/family-whatsapp.service
[Unit]
Description=Family App Nanobot WhatsApp Channel Service
After=network.target family-nanobot.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=${APP_DIR}
ExecStart=/usr/local/bin/nanobot channels login whatsapp --config ${APP_DIR}/nanobot-config.json
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

log_success "Systemd service files created."
log_success "קובצי שירות Systemd נוצרו בהצלחה."

# ------------------------------------------------------------------------------
# 9. Enable and Start Services / הפעלה וטעינת השירותים
# ------------------------------------------------------------------------------
log_info "Step 9/11: Reloading systemd and enabling services..."
log_info "שלב 9/11: מרענן את systemd ומפעיל את השירותים..."

systemctl daemon-reload
systemctl enable family-nanobot.service || true
systemctl enable family-whatsapp.service || true

# Start nanobot service / התחלת שירות nanobot
systemctl restart family-nanobot.service || log_warning "Could not start family-nanobot service yet (verify nanobot binary path)."

log_success "Services enabled and initialized."
log_success "השירותים הופעלו בהצלחה."

# ------------------------------------------------------------------------------
# 10. Configure Firewall (Ports 80 & 443) / הגדרת חומת אש
# ------------------------------------------------------------------------------
log_info "Step 10/11: Opening firewall ports (80 HTTP, 443 HTTPS)..."
log_info "שלב 10/11: פותח יציאות בחומת האש (פורטים 80 ו-443)..."

# UFW setup / UFW הגדרת
if command -v ufw &> /dev/null; then
    ufw allow 80/tcp || true
    ufw allow 443/tcp || true
    ufw allow 22/tcp || true
    ufw --force enable || true
fi

# Oracle Cloud iptables rules / התאמת כללי iptables עבור Oracle Linux / Ubuntu Cloud
iptables -I INPUT -p tcp --dport 80 -j ACCEPT || true
iptables -I INPUT -p tcp --dport 443 -j ACCEPT || true

if command -v netfilter-persistent &> /dev/null; then
    netfilter-persistent save || true
fi

log_success "Firewall configured."
log_success "חומת האש הוגדרה בהצלחה."

# ------------------------------------------------------------------------------
# 11. Summary and Next Steps / סיכום והנחיות להמשך
# ------------------------------------------------------------------------------
echo -e "${GREEN}"
echo "=========================================================================="
echo "  🎉 Family App Oracle Server Setup Completed Successfully!  "
echo "  🎉 התקנת שרת אפליקציית משימות משפחתיות הושלמה בהצלחה!  "
echo "=========================================================================="
echo -e "${NC}"
echo -e "Summary of configured components / סיכום הרכיבים שהוגדרו:"
echo -e "  • Web Directory / תיקיית שרת קבצים:  ${WWW_DIR}"
echo -e "  • App Directory / תיקיית אפליקציה:  ${APP_DIR}"
echo -e "  • Database / מסד נתונים SQLite:    ${DB_FILE}"
echo -e "  • Domain / דומיין מוגדר:            http://${DOMAIN}"
echo -e "  • API Endpoint / נקודת קצה API:     http://${DOMAIN}/v1/"
echo -e "  • Nanobot Port / פורט פנימי:        8900"
echo ""
echo -e "${YELLOW}Next Steps / צעדים הבאים:${NC}"
echo -e "  1. Copy your PWA static files (index.html, css/, js/) to ${WWW_DIR}"
echo -e "     העתק את קובצי ה-PWA הסטטיים לתיקייה ${WWW_DIR}"
echo -e "  2. Edit ${APP_DIR}/nanobot-config.json and replace OPENAI_API_KEY & API Key."
echo -e "     עדכן את קובץ התצורה בתיקייה ${APP_DIR} עם המפתחות האמיתיים שלך."
echo -e "  3. Restart services: sudo systemctl restart family-nanobot"
echo -e "     הפעל מחדש את השירותים בעזרת הפקודה לעיל."
echo -e "  4. Authenticate WhatsApp: sudo systemctl status family-whatsapp (scan QR code)"
echo -e "     לסריקת קוד QR להתחברות וואטסאפ בדוק את סטטוס השירות."
echo -e "=========================================================================="
