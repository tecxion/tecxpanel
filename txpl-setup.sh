#!/bin/bash
# ============================================================
#  TecXPaneL — Instalador para VPS limpio (Ubuntu/Debian)
#
#  Flujo de despliegue desde GitHub:
#    git clone https://github.com/TU_USUARIO/tecxpanel.git
#    cd tecxpanel
#    sudo bash txpl-setup.sh
#
#  Es idempotente: se puede volver a ejecutar sin romper nada.
#  Variables opcionales (se pueden exportar antes de ejecutar):
#    ADMIN_USER, ADMIN_PASS, PANEL_DOMAIN, INSTALL_MYSQL=1, INSTALL_PG=1
# ============================================================

set -euo pipefail

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
log()  { echo -e "${GREEN}[TXPL]${RESET} $1"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $1"; }
err()  { echo -e "${RED}[ERROR]${RESET} $1"; exit 1; }
sep()  { echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; }

[[ $EUID -ne 0 ]] && err "Ejecuta como root:  sudo bash txpl-setup.sh"
command -v apt-get >/dev/null || err "Este instalador es para Ubuntu/Debian (apt)."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TXPL_DIR="/opt/txpl"
SITES_DIR="/var/www"

sep
echo -e "${BOLD}TecXPaneL — Instalador${RESET}"
sep

# ── 1. Paquetes base del sistema ──────────────────────────────
log "Actualizando índices de apt..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

log "Instalando dependencias base (git, build-essential, python3, nginx, ufw, certbot)..."
apt-get install -y -qq \
    curl git ca-certificates gnupg build-essential python3 python3-pip \
    nginx ufw certbot python3-certbot-nginx sqlite3 >/dev/null

# ── 2. Node.js LTS (si falta o es < 18) ───────────────────────
NODE_OK=0
if command -v node >/dev/null; then
    NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
    [[ "$NODE_MAJOR" -ge 18 ]] && NODE_OK=1
fi
if [[ "$NODE_OK" -eq 0 ]]; then
    log "Instalando Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
else
    log "Node.js $(node -v) ya instalado."
fi

# ── 3. PM2 global ─────────────────────────────────────────────
if ! command -v pm2 >/dev/null; then
    log "Instalando PM2..."
    npm install -g pm2 >/dev/null 2>&1
else
    log "PM2 $(pm2 -v) ya instalado."
fi

# ── 4. Bases de datos (opcional) ──────────────────────────────
INSTALL_MYSQL="${INSTALL_MYSQL:-}"
if [[ -z "$INSTALL_MYSQL" ]] && [[ -t 0 ]]; then
    read -p "¿Instalar MariaDB (MySQL)? (S/n): " ans; [[ "$ans" =~ ^[Nn]$ ]] || INSTALL_MYSQL=1
fi
if [[ "$INSTALL_MYSQL" == "1" ]] && ! command -v mysql >/dev/null; then
    log "Instalando MariaDB..."
    apt-get install -y -qq mariadb-server >/dev/null
    systemctl enable --now mariadb >/dev/null 2>&1 || true
fi

INSTALL_PG="${INSTALL_PG:-}"
if [[ -z "$INSTALL_PG" ]] && [[ -t 0 ]]; then
    read -p "¿Instalar PostgreSQL? (s/N): " ans; [[ "$ans" =~ ^[Ss]$ ]] && INSTALL_PG=1
fi
if [[ "$INSTALL_PG" == "1" ]] && ! command -v psql >/dev/null; then
    log "Instalando PostgreSQL..."
    apt-get install -y -qq postgresql >/dev/null
    systemctl enable --now postgresql >/dev/null 2>&1 || true
fi

# ── 5. Estructura de directorios ──────────────────────────────
log "Creando estructura en $TXPL_DIR ..."
mkdir -p "$TXPL_DIR/backend" "$TXPL_DIR/frontend" "$TXPL_DIR/data" \
         "$TXPL_DIR/backups" /var/log/txpl "$SITES_DIR"

# ── 6. Copiar archivos del repo ───────────────────────────────
log "Copiando archivos del panel..."
cp "$SCRIPT_DIR/server.js"            "$TXPL_DIR/backend/"
cp "$SCRIPT_DIR/database.js"          "$TXPL_DIR/backend/"
cp "$SCRIPT_DIR/package.json"         "$TXPL_DIR/backend/"
cp "$SCRIPT_DIR/index.html"           "$TXPL_DIR/frontend/"
cp "$SCRIPT_DIR/ecosystem.config.js"  "$TXPL_DIR/"
cp "$SCRIPT_DIR/txpl-backup.sh" "$SCRIPT_DIR/txpl-update.sh" "$TXPL_DIR/" 2>/dev/null || true
chmod +x "$TXPL_DIR"/*.sh 2>/dev/null || true

# ── 7. Generar .env (solo si no existe) ───────────────────────
ENV_FILE="$TXPL_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
    log "Generando .env con secretos aleatorios..."
    JWT_SECRET=$(openssl rand -hex 32)
    ADMIN_USER="${ADMIN_USER:-admin}"
    ADMIN_PASS="${ADMIN_PASS:-$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-16)}"
    MYSQL_ROOT_PASSWORD=""
    if [[ "$INSTALL_MYSQL" == "1" ]]; then
        MYSQL_ROOT_PASSWORD=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-16)
        # Fijar contraseña root de MariaDB (auth socket por defecto en root local)
        mysql -u root <<SQL 2>/dev/null || true
ALTER USER 'root'@'localhost' IDENTIFIED BY '${MYSQL_ROOT_PASSWORD}';
FLUSH PRIVILEGES;
SQL
    fi
    cat > "$ENV_FILE" <<EOF
TXPL_PORT=8585
TXPL_DIR=$TXPL_DIR
SITES_DIR=$SITES_DIR
FRONTEND_DIR=$TXPL_DIR/frontend
JWT_SECRET=$JWT_SECRET
TXPL_TOKEN_TTL=8h
ADMIN_USER=$ADMIN_USER
ADMIN_PASS=$ADMIN_PASS
MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD
PG_PASSWORD=
SSL_EMAIL=
EOF
    GENERATED_CREDS=1
else
    warn ".env ya existe, se conserva. (No se regeneran secretos.)"
    GENERATED_CREDS=0
fi
chmod 600 "$ENV_FILE"

# ── 8. Dependencias del backend ───────────────────────────────
log "Instalando dependencias Node del backend..."
cd "$TXPL_DIR/backend"
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --production >/dev/null
# Terminal interactiva (opcional; requiere build tools ya instalados)
log "Instalando node-pty (terminal interactiva)..."
npm install node-pty --no-audit --no-fund >/dev/null 2>&1 || warn "node-pty no se pudo compilar; la terminal quedará deshabilitada."

# ── 9. Nginx ──────────────────────────────────────────────────
log "Configurando Nginx..."
cp "$SCRIPT_DIR/txpl-nginx.conf" /etc/nginx/sites-available/txpl-panel
if [[ -n "${PANEL_DOMAIN:-}" ]]; then
    sed -i "s/server_name _;/server_name ${PANEL_DOMAIN};/" /etc/nginx/sites-available/txpl-panel
fi
ln -sf /etc/nginx/sites-available/txpl-panel /etc/nginx/sites-enabled/txpl-panel
rm -f /etc/nginx/sites-enabled/default
if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    log "Nginx configurado."
else
    warn "Config de Nginx inválida; revisa: nginx -t"
fi

# ── 10. Firewall UFW ──────────────────────────────────────────
log "Configurando firewall UFW (SSH, HTTP, HTTPS)..."
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp  >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

# ── 11. Arrancar el panel con PM2 ─────────────────────────────
log "Arrancando el panel con PM2..."
cd "$TXPL_DIR"
pm2 start ecosystem.config.js --env production >/dev/null 2>&1 || pm2 restart txpl-panel >/dev/null
pm2 save >/dev/null 2>&1
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

# ── 12. CLI txpl ──────────────────────────────────────────────
if [[ -f "$SCRIPT_DIR/txpl-cli.sh" ]]; then
    cp "$SCRIPT_DIR/txpl-cli.sh" /usr/local/bin/txpl
    chmod +x /usr/local/bin/txpl
    log "CLI 'txpl' instalada."
fi

# ── Resumen ───────────────────────────────────────────────────
sleep 2
IP=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
sep
echo -e "${BOLD}${GREEN}✅ TecXPaneL instalado${RESET}"
sep
echo -e "  Panel:    http://${PANEL_DOMAIN:-$IP}/"
echo -e "  Estado:   $(pm2 describe txpl-panel 2>/dev/null | grep -m1 status | awk '{print $4}' || echo '?')"
if [[ "${GENERATED_CREDS:-0}" == "1" ]]; then
    echo ""
    echo -e "  ${YELLOW}Credenciales generadas (guárdalas):${RESET}"
    echo -e "    Usuario:     ${BOLD}$ADMIN_USER${RESET}"
    echo -e "    Contraseña:  ${BOLD}$ADMIN_PASS${RESET}"
    [[ -n "$MYSQL_ROOT_PASSWORD" ]] && echo -e "    MySQL root:  ${BOLD}$MYSQL_ROOT_PASSWORD${RESET}"
    echo -e "  ${CYAN}(También están en $ENV_FILE)${RESET}"
fi
echo ""
echo -e "  ${CYAN}Siguiente paso recomendado — HTTPS:${RESET}"
echo -e "    Apunta tu dominio a $IP y luego:"
echo -e "    certbot --nginx -d tudominio.com"
echo ""
echo -e "  Comandos:  txpl status | txpl logs | txpl restart"
sep
