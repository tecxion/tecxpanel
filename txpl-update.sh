#!/bin/bash
# ============================================================
#  TecXPaneL — Update Script (zero downtime)
#  Uso: bash txpl-update.sh
# ============================================================

set -e
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
log()  { echo -e "${GREEN}[TXPL]${RESET} $1"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $1"; }
err()  { echo -e "${RED}[ERROR]${RESET} $1"; exit 1; }
sep()  { echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; }

TXPL_DIR="/opt/txpl"
BACKUP_DIR="$TXPL_DIR/backups/update-$(date +%Y%m%d-%H%M%S)"

[[ $EUID -ne 0 ]] && err "Ejecutar como root"
[[ ! -f "$TXPL_DIR/.env" ]] && err "TXPL no instalado. Ejecuta txpl-setup.sh primero"

sep
echo -e "${BOLD}TecXPaneL — Actualizador${RESET}"
sep

# ── 1. Backup previo ─────────────────────────────────────────
log "📦 Creando backup previo a la actualización..."
mkdir -p "$BACKUP_DIR"
cp -r "$TXPL_DIR/backend" "$BACKUP_DIR/backend" 2>/dev/null || true
cp -r "$TXPL_DIR/frontend" "$BACKUP_DIR/frontend" 2>/dev/null || true
cp "$TXPL_DIR/.env" "$BACKUP_DIR/.env" 2>/dev/null || true
cp "$TXPL_DIR/data/txpl.db" "$BACKUP_DIR/txpl.db" 2>/dev/null || true
log "✅ Backup guardado en $BACKUP_DIR"

# ── 2. Copiar nuevos archivos ─────────────────────────────────
log "📁 Copiando archivos actualizados..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Backend (server.js, database.js, lib/, routes/)
if [[ -d "$SCRIPT_DIR/backend" ]]; then
    cp -r "$SCRIPT_DIR/backend/." "$TXPL_DIR/backend/"
    log "  ↳ backend/ actualizado"
fi

# Frontend (css + js + index.html)
if [[ -d "$SCRIPT_DIR/frontend" ]]; then
    cp -r "$SCRIPT_DIR/frontend/." "$TXPL_DIR/frontend/"
    log "  ↳ frontend/ actualizado"
fi

if [[ -f "$SCRIPT_DIR/ecosystem.config.js" ]]; then
    cp "$SCRIPT_DIR/ecosystem.config.js" "$TXPL_DIR/ecosystem.config.js"
    log "  ↳ ecosystem.config.js actualizado"
fi

# ── 3. Instalar/actualizar dependencias npm ──────────────────
log "📦 Actualizando dependencias Node.js..."
cd "$TXPL_DIR/backend"
if [[ -f "$SCRIPT_DIR/package.json" ]]; then
    cp "$SCRIPT_DIR/package.json" "$TXPL_DIR/backend/package.json"
fi
npm install --silent --production
log "✅ Dependencias actualizadas"

# ── 4. Reload sin downtime con PM2 ──────────────────────────
sep
log "🔄 Recargando panel (zero downtime)..."
if pm2 describe txpl-panel > /dev/null 2>&1; then
    pm2 reload txpl-panel --update-env
    log "✅ Panel recargado con PM2 reload (sin downtime)"
else
    pm2 start "$TXPL_DIR/ecosystem.config.js" --env production
    log "✅ Panel iniciado"
fi
pm2 save

# ── 5. Verificar que está corriendo ─────────────────────────
sleep 2
if pm2 describe txpl-panel | grep -q "online"; then
    log "✅ Panel corriendo correctamente"
else
    warn "El panel no parece estar online. Restaurando backup..."
    cp -r "$BACKUP_DIR/backend/." "$TXPL_DIR/backend/"
    cp -r "$BACKUP_DIR/frontend/." "$TXPL_DIR/frontend/"
    pm2 restart txpl-panel
    err "Actualización fallida. Backup restaurado. Revisa: pm2 logs txpl-panel"
fi

# ── 6. Verificar Nginx ────────────────────────────────────────
if [[ -f "$SCRIPT_DIR/txpl-nginx.conf" ]]; then
    cp "$SCRIPT_DIR/txpl-nginx.conf" /etc/nginx/sites-available/txpl-panel
    if nginx -t 2>/dev/null; then
        systemctl reload nginx
        log "✅ Nginx actualizado y recargado"
    else
        warn "Config Nginx inválida, manteniendo la anterior"
    fi
fi

sep
echo -e "${BOLD}${GREEN}✅ Actualización completada${RESET}"
echo ""
echo -e "  Panel:    $(pm2 describe txpl-panel | grep status | awk '{print $4}')"
echo -e "  Backup:   $BACKUP_DIR"
echo -e "  Logs:     pm2 logs txpl-panel"
sep
