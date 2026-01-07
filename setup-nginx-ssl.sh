#!/usr/bin/env bash
set -euo pipefail

# Configuration
DOMAIN="${DOMAIN:-battleship-linera.xyz}"
EMAIL="${EMAIL:-egor4042007@gmail.com}"
PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo bash setup-nginx-ssl.sh"
  exit 1
fi

echo "Domain: $DOMAIN"
echo "Email:  $EMAIL"
echo "Project: $PROJECT_DIR"

if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "Project directory not found: $PROJECT_DIR"
  exit 1
fi

# Install Nginx, Certbot and Node.js (Debian/Ubuntu)
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx curl gnupg lsb-release ca-certificates

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# Allow firewall (optional)
if command -v ufw >/dev/null 2>&1; then
  ufw allow 'Nginx Full' || true
  ufw allow OpenSSH || true
fi

# Nginx site config
cat >/etc/nginx/sites-available/$DOMAIN <<'EOF'
server {
  listen 80;
  server_name DOMAIN_PLACEHOLDER;

  # Cross-origin isolation for SharedArrayBuffer in WASM/Workers
  add_header Cross-Origin-Opener-Policy "same-origin" always;
  add_header Cross-Origin-Embedder-Policy "require-corp" always;
  add_header Cross-Origin-Resource-Policy "same-origin" always;

  location /.well-known/acme-challenge/ {
    root /var/www/html;
  }

  location = /app {
    return 301 /;
  }

  location = /app/ {
    return 301 /;
  }

  location = / {
    root ROOT_PLACEHOLDER;
    try_files /app/index.html =404;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
  }

  location = /index.html {
    root ROOT_PLACEHOLDER;
    try_files /app/index.html =404;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
  }

  location ^~ /node_modules/ {
    root ROOT_PLACEHOLDER;
    try_files $uri =404;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
  }

  location = /tests {
    root ROOT_PLACEHOLDER;
    try_files /app/index.html =404;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
  }

  location / {
    root ROOT_PLACEHOLDER;
    try_files $uri /app$uri /app/index.html;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
  }

  # Proxy Linera faucet via local path so the frontend can use the site domain
  location /faucet/ {
    proxy_pass https://faucet.testnet-conway.linera.net/;
    proxy_http_version 1.1;
    proxy_set_header Host faucet.testnet-conway.linera.net;
    proxy_ssl_server_name on;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # Generic Linera RPC dynamic proxy: /linera-rpc/{proto}/{host}/{path}
  location ~ ^/linera-rpc/(?<proto>https|http)/(?<dest>[^/]+)/(?<path>.*)$ {
    if ($request_method = OPTIONS) {
      add_header Access-Control-Allow-Origin *;
      add_header Access-Control-Allow-Methods 'GET, POST, OPTIONS';
      add_header Access-Control-Allow-Headers 'Content-Type, Authorization, X-Requested-With';
      add_header Cross-Origin-Opener-Policy "same-origin" always;
      add_header Cross-Origin-Embedder-Policy "require-corp" always;
      add_header Cross-Origin-Resource-Policy "same-origin" always;
      return 204;
    }
    resolver 1.1.1.1 8.8.8.8 valid=300s;
    proxy_pass $proto://$dest/$path$is_args$args;
    proxy_set_header Host $dest;
    proxy_ssl_server_name on;
    proxy_buffering off;
    proxy_http_version 1.1;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Origin $http_origin;
    add_header Access-Control-Allow-Origin *;
    add_header Access-Control-Allow-Methods 'GET, POST, OPTIONS';
    add_header Access-Control-Allow-Headers 'Content-Type, Authorization, X-Requested-With';
    add_header Access-Control-Expose-Headers 'grpc-status,grpc-message,grpc-status-details-bin';
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
  }
}
EOF

sed -i "s/DOMAIN_PLACEHOLDER/$DOMAIN/g" /etc/nginx/sites-available/$DOMAIN
ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
nginx -t
systemctl reload nginx

# Issue and configure SSL cert
certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --redirect --non-interactive

cat >/etc/nginx/sites-available/$DOMAIN <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN www.$DOMAIN;

  location /.well-known/acme-challenge/ {
    root /var/www/html;
  }

  location / {
    return 301 https://\$host\$request_uri;
  }
}

server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name $DOMAIN www.$DOMAIN;

  ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
  include /etc/letsencrypt/options-ssl-nginx.conf;
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

  add_header Cross-Origin-Opener-Policy "same-origin" always;
  add_header Cross-Origin-Embedder-Policy "require-corp" always;
  add_header Cross-Origin-Resource-Policy "same-origin" always;

  location = /app {
    return 301 /;
  }

  location = /app/ {
    return 301 /;
  }

  location = / {
    root /var/www/$DOMAIN;
    try_files /app/index.html =404;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
  }

  location = /index.html {
    root /var/www/$DOMAIN;
    try_files /app/index.html =404;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
    add_header Cache-Control "no-cache" always;
  }

  location = /node_modules/@linera/client/dist/index.js {
    root /var/www/$DOMAIN;
    try_files \$uri =404;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
    add_header Cache-Control "no-cache" always;
  }

  location ^~ /node_modules/ {
    root /var/www/$DOMAIN;
    try_files \$uri =404;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
    add_header Cache-Control "no-cache" always;
  }

  location = /tests {
    root /var/www/$DOMAIN;
    try_files /app/index.html =404;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
  }

  location / {
    root /var/www/$DOMAIN;
    try_files \$uri /app\$uri /app/index.html;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
  }

  location /faucet/ {
    proxy_pass https://faucet.testnet-conway.linera.net/;
    proxy_http_version 1.1;
    proxy_set_header Host faucet.testnet-conway.linera.net;
    proxy_ssl_server_name on;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }

  location ~ ^/linera-rpc/(?<proto>https|http)/(?<dest>[^/]+)/(?<path>.*)$ {
    if (\$request_method = OPTIONS) {
      add_header Access-Control-Allow-Origin *;
      add_header Access-Control-Allow-Methods 'GET, POST, OPTIONS';
      add_header Access-Control-Allow-Headers 'Content-Type, Authorization, X-Requested-With';
      add_header Cross-Origin-Opener-Policy "same-origin" always;
      add_header Cross-Origin-Embedder-Policy "require-corp" always;
      add_header Cross-Origin-Resource-Policy "same-origin" always;
      return 204;
    }
    resolver 1.1.1.1 8.8.8.8 valid=300s;
    proxy_pass \$proto://\$dest/\$path\$is_args\$args;
    proxy_set_header Host \$dest;
    proxy_ssl_server_name on;
    proxy_buffering off;
    proxy_http_version 1.1;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Origin \$http_origin;
    add_header Access-Control-Allow-Origin *;
    add_header Access-Control-Allow-Methods 'GET, POST, OPTIONS';
    add_header Access-Control-Allow-Headers 'Content-Type, Authorization, X-Requested-With';
    add_header Access-Control-Expose-Headers 'grpc-status,grpc-message,grpc-status-details-bin';
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;
  }
}
EOF

rm -f /etc/nginx/sites-enabled/default || true
ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN

for enabled in /etc/nginx/sites-enabled/*; do
  [[ -e "$enabled" ]] || continue
  if grep -qE "server_name\\s+.*\\b${DOMAIN}\\b" "$enabled"; then
    if [[ "$(readlink -f "$enabled" 2>/dev/null || echo "$enabled")" != "/etc/nginx/sites-available/$DOMAIN" ]]; then
      rm -f "$enabled" || true
    fi
  fi
done

nginx -t
systemctl reload nginx

# Deploy static files to /var/www/$DOMAIN
rm -rf "/var/www/$DOMAIN/"*
mkdir -p "/var/www/$DOMAIN/app"
cp -r "$PROJECT_DIR/app" "/var/www/$DOMAIN/"

# Install dependencies locally and deploy the Linera client files to be served same-origin
cd "$PROJECT_DIR"
npm ci
mkdir -p "/var/www/$DOMAIN/node_modules/@linera/client"
cp -r "$PROJECT_DIR/node_modules/@linera/client/dist" "/var/www/$DOMAIN/node_modules/@linera/client/"

echo "Setup completed. Frontend is served from /var/www/$DOMAIN. Visit: https://$DOMAIN/"
