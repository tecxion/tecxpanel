#!/bin/bash
# Instala Adminer (gestor web para MySQL y PostgreSQL) y lo sirve por nginx en el puerto 8082
set -e

echo "▶ Instalando dependencias PHP (php-fpm, php-pgsql, php-mysql)..."
DEBIAN_FRONTEND=noninteractive apt-get install -y php-fpm php-pgsql php-mysql curl

echo "▶ Descargando Adminer..."
mkdir -p /usr/share/adminer
curl -fsSL https://www.adminer.org/latest.php -o /usr/share/adminer/index.php

SOCK=$(ls /run/php/*fpm*.sock 2>/dev/null | sort -r | head -n1)
if [ -z "$SOCK" ]; then
  echo "✖ No se encontró el socket de PHP-FPM"
  exit 1
fi
echo "▶ Usando PHP-FPM: $SOCK"

echo "▶ Configurando nginx (puerto 8082)..."
cat > /etc/nginx/sites-available/txpl-adminer <<NGINX
server {
    listen 8082;
    server_name _;
    root /usr/share/adminer;
    index index.php;
    location / { try_files \$uri /index.php?\$query_string; }
    location ~ \.php\$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:${SOCK};
    }
}
NGINX

ln -sf /etc/nginx/sites-available/txpl-adminer /etc/nginx/sites-enabled/txpl-adminer
nginx -t
systemctl reload nginx
ufw allow 8082/tcp || true

echo "✅ Adminer instalado y disponible en el puerto 8082"
