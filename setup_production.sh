#!/usr/bin/env bash
set -euo pipefail

# =========================
# CONFIG
# =========================
DOMAIN="lineraflow.xyz"
EMAIL="egor4042007@gmail.com"
WORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
RUN_USER="${SUDO_USER:-$(whoami)}"
BUILD_DIR="$WORK_DIR/dist"
PB_VERSION="0.35.0"

echo ">>> Starting deployment for $DOMAIN..."

# =========================
# INSTALL SYSTEM PACKAGES
# =========================
echo ">>> Installing system packages..."
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg ufw nodejs nginx certbot python3-certbot-nginx unzip openssl

# Install Node.js 20.x
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# =========================
# UFW FIREWALL
# =========================
echo ">>> Configuring Firewall..."
sudo ufw allow OpenSSH
sudo ufw allow "Nginx Full"
sudo ufw allow 8090/tcp
sudo ufw allow 8077/tcp
sudo ufw --force enable

# =========================
# ENVIRONMENT CONFIG
# =========================
echo ">>> Generating .env file..."
cat > "$WORK_DIR/.env" <<EOF
VITE_LINERA_FAUCET_URL=https://faucet.testnet-conway.linera.net
VITE_LINERA_APPLICATION_ID=c22e3cca7be626030f9a2e2b6eb9e22dc1f2f13296d5e4fb3a0496f7da3b05b8
VITE_LINERA_MAIN_CHAIN_ID=fcc99b4e4c6be2f33864d71de61acb33c0f692c397a32b6d64578cf0c82f7faa
VITE_POCKETBASE_URL=https://$DOMAIN:8090
VITE_BLOB_SERVER_URL=/upload
EOF

# =========================
# BUILD FRONTEND
# =========================
echo ">>> Building frontend..."
cd "$WORK_DIR"
if [ ! -d "node_modules" ]; then
    npm ci
fi
npm run build

# Deploy Frontend Files
sudo mkdir -p /var/www/$DOMAIN
sudo rm -rf /var/www/$DOMAIN/*
sudo cp -r "$WORK_DIR/dist/"* /var/www/$DOMAIN/
sudo chown -R www-data:www-data /var/www/$DOMAIN

# =========================
# SETUP POCKETBASE
# =========================
echo ">>> Setting up PocketBase..."
sudo mkdir -p /opt/pocketbase
cd /opt/pocketbase

if [ ! -f "pocketbase" ]; then
    wget -q "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip"
    unzip -o pocketbase_${PB_VERSION}_linux_amd64.zip || {
        echo ">>> Using fallback stable version 0.23.12..."
        PB_VERSION="0.23.12"
        wget -q "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip"
        unzip -o pocketbase_${PB_VERSION}_linux_amd64.zip
    }
    rm -f pocketbase_${PB_VERSION}_linux_amd64.zip
    chmod +x pocketbase
fi

# Create Systemd Service for PocketBase
# We use 8091 for internal binding to avoid conflict with Nginx on 8090
cat <<EOF | sudo tee /etc/systemd/system/pocketbase.service > /dev/null
[Unit]
Description=PocketBase Service
After=network.target

[Service]
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=/opt/pocketbase
ExecStart=/opt/pocketbase/pocketbase serve --http=127.0.0.1:8091
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Create Systemd Service for Blob Server
cat <<EOF | sudo tee /etc/systemd/system/linera-blob-server.service > /dev/null
[Unit]
Description=Linera Blob Server
After=network.target

[Service]
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$WORK_DIR
ExecStart=/usr/bin/node $WORK_DIR/server.js
Restart=always
RestartSec=5
Environment=PORT=8077

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now pocketbase linera-blob-server

# =========================
# NGINX CONFIG
# =========================
echo ">>> Configuring Nginx..."

# Ensure dummy certs exist if we are running for the first time
# This allows Nginx to start so Certbot can run its tests.
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    echo ">>> Creating temporary certificates..."
    sudo mkdir -p /etc/letsencrypt/live/$DOMAIN
    sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout /etc/letsencrypt/live/$DOMAIN/privkey.pem \
        -out /etc/letsencrypt/live/$DOMAIN/fullchain.pem \
        -subj "/CN=$DOMAIN"
    
    if [ ! -f "/etc/letsencrypt/ssl-dhparams.pem" ]; then
        sudo openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048
    fi
    
    if [ ! -f "/etc/letsencrypt/options-ssl-nginx.conf" ]; then
        sudo bash -c "cat > /etc/letsencrypt/options-ssl-nginx.conf <<'ENFOF'
ssl_session_cache shared:le_nginx_SSL:10m;
ssl_session_timeout 1440m;
ssl_session_tickets off;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
ssl_ciphers "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384";
ENFOF"
    fi
fi

# Link site
sudo rm -f /etc/nginx/sites-enabled/default

# Generate Initial Nginx Config (will be overwritten after certbot)
cat <<EOF | sudo tee /etc/nginx/sites-available/$DOMAIN > /dev/null
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    
    # Global Upload Limit
    client_max_body_size 1M;

    root /var/www/$DOMAIN;
    index index.html;
}
EOF

sudo ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
sudo nginx -t
sudo systemctl restart nginx

# =========================
# SSL CERTIFICATES
# =========================
echo ">>> Running Certbot..."
sudo certbot --nginx --non-interactive --agree-tos -m "$EMAIL" -d "$DOMAIN" --redirect

# =========================
# FIX SSL CONFIGURATION
# =========================
echo ">>> Applying final Nginx configuration..."

cat <<EOF | sudo tee /etc/nginx/sites-available/$DOMAIN > /dev/null
# Map Upgrade header to Connection header for SSE/WebSocket support
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      keep-alive;
}

server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN www.$DOMAIN;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    root /var/www/$DOMAIN;
    index index.html;

    # =============================================================
    # GLOBAL HEADERS (Applied to everything served by this block)
    # =============================================================
    
    # 1. Enable SharedArrayBuffer (WASM threads)
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;

    # 2. Allow 'eval' for WASM/JS bindings (Fixes CSP error)
    # We allow 'self', https:, data:, blob:, and 'unsafe-eval'/'unsafe-inline'
    add_header Content-Security-Policy "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' https: wss:; object-src 'none'; base-uri 'self';" always;

    # Assets
    location /assets/ {
        root /var/www/$DOMAIN;
        # Repeat headers because 'location' block can reset them
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
        add_header Cross-Origin-Resource-Policy "same-origin" always;
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
        add_header Cache-Control "public, max-age=31536000, immutable";

        if (\$request_method = OPTIONS) {
            add_header Content-Length 0;
            add_header Content-Type text/plain;
            return 204;
        }
    }

    # Blob Server Proxy
    location /upload {
        proxy_pass http://127.0.0.1:8077;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        client_max_body_size 1M;

        # Ensure Blob Server responses also have the required headers
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
        add_header Cross-Origin-Resource-Policy "same-origin" always;
    }

    # Static files
    location / {
        try_files \$uri /index.html;
    }
}

# PocketBase Secure Proxy (Port 8090)
server {
    listen 8090 ssl http2;
    server_name $DOMAIN;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Fixes: "Cross-Origin Embedder Policy to prevent this frame from being blocked"
    # Even the PocketBase proxy needs these headers if it's being fetched/embedded
    # by a page that has COEP: require-corp.
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "cross-origin" always; # Allow cross-origin if needed

    location / {
        proxy_pass http://127.0.0.1:8091;
        proxy_http_version 1.1;
        
        # WebSocket and SSE support
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        # Disable buffering for SSE
        proxy_buffering off;
        proxy_cache off;
        
        client_max_body_size 1M;
    }
}
EOF

sudo nginx -t
sudo systemctl reload nginx

echo "====================================="
echo " Deployment completed successfully!  "
echo " Frontend: https://$DOMAIN/"
echo " PocketBase: https://$DOMAIN:8090/"
echo "====================================="
