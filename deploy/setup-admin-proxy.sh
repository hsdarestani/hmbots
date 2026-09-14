#!/usr/bin/env bash
set -euo pipefail

DOMAIN="cloud.mahanmofagh.ir"
UPSTREAM="http://127.0.0.1:8787"
SITE="/etc/nginx/sites-available/mahan-cloud-admin"

if ! command -v nginx >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y nginx
fi
if ! command -v certbot >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y certbot
fi

mkdir -p /var/www/certbot

cat >"$SITE" <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name cloud.mahanmofagh.ir;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type "text/plain";
    }

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto http;
    }
}
EOF

ln -sfn "$SITE" /etc/nginx/sites-enabled/mahan-cloud-admin
nginx -t
systemctl enable --now nginx
systemctl reload nginx

if [ ! -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ] || [ ! -s "/etc/letsencrypt/live/$DOMAIN/privkey.pem" ]; then
  certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email
fi

cat >"$SITE" <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name cloud.mahanmofagh.ir;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type "text/plain";
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name cloud.mahanmofagh.ir;

    ssl_certificate /etc/letsencrypt/live/cloud.mahanmofagh.ir/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cloud.mahanmofagh.ir/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;

    location /admin {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }

    location = /health {
        proxy_pass http://127.0.0.1:8787/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }

    location / {
        return 404;
    }
}
EOF

nginx -t
systemctl reload nginx

curl -fsS "$UPSTREAM/health" | grep -qi 'ok'
curl -fsS "https://$DOMAIN/health" | grep -qi 'ok'
code="$(curl -sS -o /tmp/mahan-admin-check.html -w '%{http_code}' "https://$DOMAIN/admin")"
case "$code" in
  200|302|401) ;;
  *) echo "Unexpected admin status: $code"; cat /tmp/mahan-admin-check.html; exit 1 ;;
esac

echo "Admin panel verified: https://$DOMAIN/admin (HTTP $code)"
