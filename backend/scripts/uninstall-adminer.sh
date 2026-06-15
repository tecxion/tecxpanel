#!/bin/bash
# ============================================================
#  TecXPaneL — Desinstalador de Adminer
#  Revierte lo que hizo install-adminer.sh: quita el vhost de nginx,
#  borra los archivos de Adminer y cierra el puerto 8082 del firewall.
# ============================================================
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
