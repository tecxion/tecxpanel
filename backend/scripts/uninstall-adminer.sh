#!/bin/bash
# Desinstala Adminer y elimina su configuración de nginx
echo "▶ Eliminando configuración de nginx..."
rm -f /etc/nginx/sites-enabled/txpl-adminer
rm -f /etc/nginx/sites-available/txpl-adminer

echo "▶ Eliminando archivos de Adminer..."
rm -rf /usr/share/adminer

if nginx -t 2>/dev/null; then
  systemctl reload nginx
fi
ufw delete allow 8082/tcp || true

echo "✅ Adminer desinstalado"
