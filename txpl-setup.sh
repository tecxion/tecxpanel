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

set -uo pipefail

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
warn() { printf "\n${YELLOW}[WARN]${RESET} %s\n" "$1"; }
err()  { printf "\n${RED}[ERROR]${RESET} %s\n" "$1"; exit 1; }
sep()  { echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; }

[[ $EUID -ne 0 ]] && err "Ejecuta como root:  sudo bash txpl-setup.sh"
command -v apt-get >/dev/null || err "Este instalador es para Ubuntu/Debian (apt)."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TXPL_DIR="/opt/txpl"
SITES_DIR="/var/www"
LOGFILE="/tmp/txpl-setup.log"
: > "$LOGFILE"

# ════════════════════════════════════════════════════════════
#  Motor de barra de progreso
# ════════════════════════════════════════════════════════════
TOTAL_STEPS=13
STEP=0
CUR_MSG=""

# Dibuja la barra en una sola línea: spinner [████░░░░] 42% (5/13) mensaje
draw() {
    local step=$1 msg=$2 spin=$3
    local pct=$(( step * 100 / TOTAL_STEPS )); (( pct > 100 )) && pct=100
    local width=30 filled=$(( pct * width / 100 )) i bar=""
    for ((i = 0; i < filled; i++)); do bar+="█"; done
    for ((i = filled; i < width; i++)); do bar+="░"; done
    # \033[K borra hasta el final de línea → sin restos de mensajes anteriores
    printf "\r  ${GREEN}%s${RESET} ${CYAN}[${RESET}%s${CYAN}]${RESET} ${BOLD}%3d%%${RESET} ${CYAN}(%d/%d)${RESET} %s\033[K" \
        "$spin" "$bar" "$pct" "$step" "$TOTAL_STEPS" "$msg"
}

step_begin() {
    STEP=$(( STEP + 1 )); CUR_MSG="$1"
    if [[ -t 1 ]]; then draw "$STEP" "$CUR_MSG" "•"
    else printf "  [%d/%d] %s ... " "$STEP" "$TOTAL_STEPS" "$CUR_MSG"; fi
}

step_done() {
    if [[ -t 1 ]]; then draw "$STEP" "$CUR_MSG" "✓"; printf "\n"
    else printf "OK\n"; fi
}

# Ejecuta un comando/función en segundo plano y anima el spinner mientras corre.
# Toda la salida va a $LOGFILE. Devuelve el código de salida del comando.
run_spin() {
    if [[ ! -t 1 ]]; then "$@" >>"$LOGFILE" 2>&1; return $?; fi
    "$@" >>"$LOGFILE" 2>&1 &
    local pid=$! i=0 rc=0
    local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    while kill -0 "$pid" 2>/dev/null; do
        draw "$STEP" "$CUR_MSG" "${frames:i++%${#frames}:1}"
        sleep 0.1
    done
    wait "$pid" || rc=$?
    return $rc
}

# ════════════════════════════════════════════════════════════
#  Fases de instalación (cada una corre dentro de run_spin)
# ════════════════════════════════════════════════════════════
export DEBIAN_FRONTEND=noninteractive

phase_base() {
    apt-get update -qq
    apt-get install -y -qq \
        curl git ca-certificates gnupg build-essential python3 python3-pip \
        nginx ufw certbot python3-certbot-nginx sqlite3
}

phase_node() {
    local ok=0
    if command -v node >/dev/null; then
        local major; major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
        [[ "$major" -ge 18 ]] && ok=1
    fi
    if [[ "$ok" -eq 0 ]]; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y -qq nodejs
    fi
}

phase_pm2() { command -v pm2 >/dev/null || npm install -g pm2; }

phase_db() {
    if [[ "${INSTALL_MYSQL:-0}" == "1" ]] && ! command -v mysql >/dev/null; then
        apt-get install -y -qq mariadb-server
        systemctl enable --now mariadb || true
    fi
    if [[ "${INSTALL_PG:-0}" == "1" ]] && ! command -v psql >/dev/null; then
        apt-get install -y -qq postgresql
        systemctl enable --now postgresql || true
    fi
}

phase_npm() {
    cd "$TXPL_DIR/backend"
    npm install --omit=dev --no-audit --no-fund || npm install --production
}

phase_pty() { cd "$TXPL_DIR/backend" && npm install node-pty --no-audit --no-fund; }

phase_pm2_start() {
    cd "$TXPL_DIR"
    pm2 delete txpl-panel 2>/dev/null || true   # idempotente: limpia instancia previa
    pm2 start ecosystem.config.js --env production
    pm2 save
    pm2 startup systemd -u root --hp /root || true
}

# ════════════════════════════════════════════════════════════
#  Configuración interactiva (ANTES de la barra, sin interrupciones)
# ════════════════════════════════════════════════════════════
clear 2>/dev/null || true
sep
echo -e "${BOLD}   TecXPaneL — Instalador${RESET}"
sep
echo ""

# Los motores de BD son para las apps/webs que alojes, NO para el panel
# (el panel usa SQLite). Por eso pueden coexistir o no instalarse ninguno.
# Se puede preconfigurar exportando INSTALL_MYSQL / INSTALL_PG antes de ejecutar.
if [[ -z "${INSTALL_MYSQL:-}" && -z "${INSTALL_PG:-}" && -t 0 ]]; then
    echo -e "  ${BOLD}Motores de base de datos${RESET} ${CYAN}(para tus apps/webs; el panel usa SQLite)${RESET}"
    echo "    1) Ninguno                  — solo HTML/estático"
    echo "    2) MariaDB (MySQL)          — WordPress, PHP, la mayoría de CMS"
    echo "    3) PostgreSQL               — Django, apps modernas"
    echo "    4) Ambos                    — si alojas apps de los dos tipos"
    read -rp "  Elige [1-4] (2): " dbopt
    case "${dbopt:-2}" in
        1) INSTALL_MYSQL=0; INSTALL_PG=0 ;;
        3) INSTALL_MYSQL=0; INSTALL_PG=1 ;;
        4) INSTALL_MYSQL=1; INSTALL_PG=1 ;;
        *) INSTALL_MYSQL=1; INSTALL_PG=0 ;;
    esac
fi
INSTALL_MYSQL="${INSTALL_MYSQL:-0}"
INSTALL_PG="${INSTALL_PG:-0}"

echo ""
echo -e "  ${CYAN}Instalando TecXPaneL...${RESET}  (detalle en $LOGFILE)"
echo ""

# ════════════════════════════════════════════════════════════
#  Instalación con barra de progreso
# ════════════════════════════════════════════════════════════

step_begin "Instalando paquetes base del sistema"
run_spin phase_base || err "Fallo instalando paquetes base. Revisa $LOGFILE"
step_done

step_begin "Instalando Node.js 20 LTS"
run_spin phase_node || err "Fallo instalando Node.js. Revisa $LOGFILE"
step_done

step_begin "Instalando PM2"
run_spin phase_pm2 || err "Fallo instalando PM2. Revisa $LOGFILE"
step_done

step_begin "Instalando bases de datos"
run_spin phase_db || warn "Algún motor de BD no se instaló. Revisa $LOGFILE"
step_done

step_begin "Creando estructura de directorios"
mkdir -p "$TXPL_DIR/backend" "$TXPL_DIR/frontend" "$TXPL_DIR/data" \
         "$TXPL_DIR/backups" /var/log/txpl "$SITES_DIR"
step_done

step_begin "Copiando archivos del panel"
cp "$SCRIPT_DIR/server.js"           "$TXPL_DIR/backend/"
cp "$SCRIPT_DIR/database.js"         "$TXPL_DIR/backend/"
cp "$SCRIPT_DIR/package.json"        "$TXPL_DIR/backend/"
cp "$SCRIPT_DIR/index.html"          "$TXPL_DIR/frontend/"
cp "$SCRIPT_DIR/ecosystem.config.js" "$TXPL_DIR/"
cp "$SCRIPT_DIR/txpl-backup.sh" "$SCRIPT_DIR/txpl-update.sh" "$TXPL_DIR/" 2>/dev/null || true
chmod +x "$TXPL_DIR"/*.sh 2>/dev/null || true
step_done

step_begin "Generando configuración (.env)"
ENV_FILE="$TXPL_DIR/.env"
GENERATED_CREDS=0
MYSQL_ROOT_PASSWORD=""
if [[ ! -f "$ENV_FILE" ]]; then
    JWT_SECRET=$(openssl rand -hex 32)
    ADMIN_USER="${ADMIN_USER:-admin}"
    ADMIN_PASS="${ADMIN_PASS:-$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-16)}"
    if [[ "$INSTALL_MYSQL" == "1" ]]; then
        MYSQL_ROOT_PASSWORD=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-16)
        mysql -u root >>"$LOGFILE" 2>&1 <<SQL || true
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
fi
chmod 600 "$ENV_FILE"
step_done

step_begin "Instalando dependencias del backend"
run_spin phase_npm || err "Fallo en npm install. Revisa $LOGFILE"
step_done

step_begin "Compilando node-pty (terminal interactiva)"
run_spin phase_pty || warn "node-pty no se pudo compilar; la terminal quedará deshabilitada."
step_done

step_begin "Configurando Nginx"
cp "$SCRIPT_DIR/txpl-nginx.conf" /etc/nginx/sites-available/txpl-panel
[[ -n "${PANEL_DOMAIN:-}" ]] && sed -i "s/server_name _;/server_name ${PANEL_DOMAIN};/" /etc/nginx/sites-available/txpl-panel
ln -sf /etc/nginx/sites-available/txpl-panel /etc/nginx/sites-enabled/txpl-panel
rm -f /etc/nginx/sites-enabled/default
if nginx -t >>"$LOGFILE" 2>&1; then systemctl reload nginx; else warn "Config Nginx inválida; revisa: nginx -t"; fi
step_done

step_begin "Configurando firewall UFW"
{ ufw allow OpenSSH || ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp; ufw --force enable; } >>"$LOGFILE" 2>&1 || true
step_done

step_begin "Arrancando el panel con PM2"
run_spin phase_pm2_start || err "El panel no arrancó. Revisa: pm2 logs txpl-panel"
step_done

step_begin "Instalando la CLI txpl"
if [[ -f "$SCRIPT_DIR/txpl-cli.sh" ]]; then
    cp "$SCRIPT_DIR/txpl-cli.sh" /usr/local/bin/txpl && chmod +x /usr/local/bin/txpl
fi
step_done

# ════════════════════════════════════════════════════════════
#  Resumen
# ════════════════════════════════════════════════════════════
sleep 1
IP=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo ""
sep
echo -e "${BOLD}${GREEN}  ✅ TecXPaneL instalado correctamente${RESET}"
sep
echo -e "  Panel:    http://${PANEL_DOMAIN:-$IP}/"
echo -e "  Estado:   $(pm2 describe txpl-panel 2>/dev/null | grep -m1 status | awk '{print $4}' || echo '?')"
if [[ "$GENERATED_CREDS" == "1" ]]; then
    echo ""
    echo -e "  ${YELLOW}Credenciales generadas (guárdalas):${RESET}"
    echo -e "    Usuario:     ${BOLD}$ADMIN_USER${RESET}"
    echo -e "    Contraseña:  ${BOLD}$ADMIN_PASS${RESET}"
    [[ -n "$MYSQL_ROOT_PASSWORD" ]] && echo -e "    MySQL root:  ${BOLD}$MYSQL_ROOT_PASSWORD${RESET}"
    echo -e "  ${CYAN}(También están en $ENV_FILE)${RESET}"
else
    # .env ya existía: muestra el usuario y dónde está la contraseña.
    EXIST_USER=$(grep -E '^ADMIN_USER=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    echo ""
    echo -e "  ${YELLOW}Credenciales (del $ENV_FILE existente):${RESET}"
    echo -e "    Usuario:     ${BOLD}${EXIST_USER:-admin}${RESET}"
    echo -e "    Contraseña:  consúltala con  ${BOLD}sudo grep ADMIN_PASS $ENV_FILE${RESET}"
fi
echo ""
echo -e "  ${CYAN}Siguiente paso recomendado — HTTPS:${RESET}"
echo -e "    Apunta tu dominio a $IP y luego:  certbot --nginx -d tudominio.com"
echo ""
echo -e "  Comandos:  txpl status | txpl logs | txpl restart"
sep
