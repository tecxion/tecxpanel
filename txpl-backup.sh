#!/bin/bash
# ============================================================
#  TecXPaneL — Backup Script
#  Uso manual:   bash txpl-backup.sh
#  Cron diario:  0 3 * * * /opt/txpl/txpl-backup.sh >> /var/log/txpl/backup.log 2>&1
#  Instalar cron: bash txpl-backup.sh --install-cron
# ============================================================

set -e
source /opt/txpl/.env 2>/dev/null || true

TXPL_DIR="/opt/txpl"
BACKUP_BASE="$TXPL_DIR/backups"
DATE=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_DIR="$BACKUP_BASE/backup-$DATE"
KEEP_DAYS=7   # días que se conservan los backups
SITES_DIR="${SITES_DIR:-/var/www}"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RESET='\033[0m'
log()  { echo -e "${GREEN}[BACKUP $(date +%H:%M:%S)]${RESET} $1"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $1"; }

# ── Instalar cron ────────────────────────────────────────────
if [[ "$1" == "--install-cron" ]]; then
    CRON_LINE="0 3 * * * /opt/txpl/txpl-backup.sh >> /var/log/txpl/backup.log 2>&1"
    (crontab -l 2>/dev/null | grep -v txpl-backup; echo "$CRON_LINE") | crontab -
    echo -e "${GREEN}✅ Cron instalado: backup diario a las 03:00${RESET}"
    echo "   Verificar con: crontab -l"
    exit 0
fi

# ── Ver backups existentes ────────────────────────────────────
if [[ "$1" == "--list" ]]; then
    echo -e "${CYAN}Backups disponibles:${RESET}"
    ls -lh "$BACKUP_BASE"/*.tar.gz 2>/dev/null | awk '{print "  "$5, $9}' || echo "  Sin backups aún"
    exit 0
fi

# ── Restaurar backup ─────────────────────────────────────────
if [[ "$1" == "--restore" ]]; then
    BACKUP_FILE="$2"
    [[ -z "$BACKUP_FILE" ]] && echo "Uso: txpl-backup.sh --restore /opt/txpl/backups/backup-FECHA.tar.gz" && exit 1
    [[ ! -f "$BACKUP_FILE" ]] && echo "Archivo no encontrado: $BACKUP_FILE" && exit 1

    echo -e "${YELLOW}⚠️  Restaurando desde: $BACKUP_FILE${RESET}"
    read -p "¿Confirmar restauración? (s/N): " confirm
    [[ "$confirm" != "s" ]] && echo "Cancelado" && exit 0

    mkdir -p /tmp/txpl-restore
    tar -xzf "$BACKUP_FILE" -C /tmp/txpl-restore

    # Restaurar BD del panel
    if [[ -f /tmp/txpl-restore/txpl.db ]]; then
        cp /tmp/txpl-restore/txpl.db "$TXPL_DIR/data/txpl.db"
        echo "  ↳ Base de datos del panel restaurada"
    fi

    # Restaurar MySQL
    if [[ -f /tmp/txpl-restore/mysql-all.sql.gz ]]; then
        zcat /tmp/txpl-restore/mysql-all.sql.gz | mysql -u root -p"$MYSQL_ROOT_PASSWORD"
        echo "  ↳ MySQL restaurado"
    fi

    rm -rf /tmp/txpl-restore
    pm2 restart txpl-panel
    echo -e "${GREEN}✅ Restauración completada${RESET}"
    exit 0
fi

# ════════════════════════════════════════════════════════════
# BACKUP PRINCIPAL
# ════════════════════════════════════════════════════════════

log "Iniciando backup completo — $DATE"
mkdir -p "$BACKUP_DIR"

# ── 1. Base de datos del panel (SQLite) ──────────────────────
log "💾 Base de datos del panel..."
if [[ -f "$TXPL_DIR/data/txpl.db" ]]; then
    sqlite3 "$TXPL_DIR/data/txpl.db" ".backup '$BACKUP_DIR/txpl.db'" 2>/dev/null || \
    cp "$TXPL_DIR/data/txpl.db" "$BACKUP_DIR/txpl.db"
    log "  ↳ txpl.db guardado"
fi

# ── 2. MySQL — todas las bases de datos ──────────────────────
log "🐬 MySQL dump..."
if command -v mysqldump &>/dev/null && [[ -n "$MYSQL_ROOT_PASSWORD" ]]; then
    mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" \
        --all-databases \
        --single-transaction \
        --routines \
        --triggers \
        2>/dev/null | gzip > "$BACKUP_DIR/mysql-all.sql.gz"
    log "  ↳ MySQL dump completado ($(du -sh $BACKUP_DIR/mysql-all.sql.gz | cut -f1))"
else
    warn "MySQL no disponible o sin contraseña, saltando"
fi

# ── 3. PostgreSQL ─────────────────────────────────────────────
log "🐘 PostgreSQL dump..."
if command -v pg_dumpall &>/dev/null; then
    sudo -u postgres pg_dumpall 2>/dev/null | gzip > "$BACKUP_DIR/postgresql-all.sql.gz" || \
    warn "PostgreSQL dump fallido"
    log "  ↳ PostgreSQL dump completado"
fi

# ── 4. Archivos de sitios web ─────────────────────────────────
log "🌐 Sitios web ($SITES_DIR)..."
if [[ -d "$SITES_DIR" ]] && [[ "$(ls -A $SITES_DIR)" ]]; then
    tar -czf "$BACKUP_DIR/websites.tar.gz" -C "$(dirname $SITES_DIR)" "$(basename $SITES_DIR)" 2>/dev/null
    log "  ↳ websites.tar.gz guardado ($(du -sh $BACKUP_DIR/websites.tar.gz | cut -f1))"
else
    warn "Sin sitios web para hacer backup"
fi

# ── 5. Configuración Nginx ────────────────────────────────────
log "⚙️  Configuración Nginx..."
tar -czf "$BACKUP_DIR/nginx-conf.tar.gz" /etc/nginx 2>/dev/null
log "  ↳ nginx-conf.tar.gz guardado"

# ── 6. Archivos de configuración del panel ───────────────────
log "📋 Configuración TXPL..."
cp "$TXPL_DIR/.env" "$BACKUP_DIR/txpl.env" 2>/dev/null || true
cp "$TXPL_DIR/backend/package.json" "$BACKUP_DIR/package.json" 2>/dev/null || true
log "  ↳ Configuración guardada"

# ── 7. Empaquetar todo en un .tar.gz ─────────────────────────
log "📦 Empaquetando backup..."
FINAL_FILE="$BACKUP_BASE/backup-$DATE.tar.gz"
tar -czf "$FINAL_FILE" -C "$BACKUP_BASE" "backup-$DATE"
rm -rf "$BACKUP_DIR"

SIZE=$(du -sh "$FINAL_FILE" | cut -f1)
log "✅ Backup completado: backup-$DATE.tar.gz ($SIZE)"

# ── 8. Limpiar backups antiguos ──────────────────────────────
log "🧹 Limpiando backups de más de $KEEP_DAYS días..."
DELETED=$(find "$BACKUP_BASE" -name "backup-*.tar.gz" -mtime +$KEEP_DAYS -delete -print | wc -l)
log "  ↳ $DELETED backup(s) antiguos eliminados"

# ── Resumen final ─────────────────────────────────────────────
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  Backup:   $FINAL_FILE"
echo -e "  Tamaño:   $SIZE"
echo -e "  Total:    $(ls $BACKUP_BASE/*.tar.gz 2>/dev/null | wc -l) backup(s) guardados"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
