#!/bin/bash
# ============================================================
#  TecXPaneL — CLI (txpl)
#  Instalar: cp txpl-cli.sh /usr/local/bin/txpl && chmod +x /usr/local/bin/txpl
#  Uso: txpl <comando> [opciones]
# ============================================================

source /opt/txpl/.env 2>/dev/null || true

TXPL_DIR="/opt/txpl"
API="http://127.0.0.1:${TXPL_PORT:-8585}/api"

C='\033[0;36m'; G='\033[0;32m'; Y='\033[1;33m'
R='\033[0;31m'; B='\033[1m'; X='\033[0m'

banner() {
    echo -e "${C}"
    echo "  ████████╗██╗  ██╗██████╗ ██╗"
    echo "     ██╔══╝╚██╗██╔╝██╔══██╗██║"
    echo "     ██║    ╚███╔╝ ██████╔╝██║"
    echo "     ██║    ██╔██╗ ██╔═══╝ ██║"
    echo "     ██║   ██╔╝ ██╗██║     ███████╗"
    echo "     ╚═╝   ╚═╝  ╚═╝╚═╝     ╚══════╝"
    echo -e "  TecXPaneL CLI${X}"
    echo ""
}

help() {
    banner
    echo -e "${B}Uso:${X} txpl <comando> [opciones]"
    echo ""
    echo -e "${C}Panel:${X}"
    echo "  txpl status          — Estado del panel y servicios"
    echo "  txpl start           — Iniciar el panel"
    echo "  txpl stop            — Parar el panel"
    echo "  txpl restart         — Reiniciar el panel"
    echo "  txpl logs            — Ver logs en tiempo real"
    echo "  txpl reset-password  — Restablecer la contraseña de un usuario"
    echo "  txpl update          — Actualizar el panel"
    echo "  txpl panel:ssl <dom> — Instalar HTTPS en el panel (dominio propio)"
    echo ""
    echo -e "${C}Sitios web:${X}"
    echo "  txpl sites           — Listar sitios web"
    echo "  txpl site:add        — Crear sitio web"
    echo "  txpl site:ssl        — Instalar SSL en un dominio"
    echo ""
    echo -e "${C}Aplicaciones:${X}"
    echo "  txpl apps            — Listar apps PM2"
    echo "  txpl app:start <id>  — Iniciar app"
    echo "  txpl app:stop  <id>  — Parar app"
    echo "  txpl app:logs  <id>  — Ver logs de app"
    echo ""
    echo -e "${C}Bases de datos:${X}"
    echo "  txpl dbs             — Listar bases de datos"
    echo "  txpl db:add          — Crear base de datos"
    echo ""
    echo -e "${C}Sistema:${X}"
    echo "  txpl stats           — Stats del VPS en tiempo real"
    echo "  txpl backup          — Hacer backup ahora"
    echo "  txpl backup:cron     — Instalar backup automático diario"
    echo "  txpl backup:list     — Listar backups"
    echo "  txpl firewall        — Ver reglas del firewall"
    echo "  txpl info            — Información del sistema"
    echo ""
}

# ── Autenticación ─────────────────────────────────────────────
get_token() {
    if [[ -f /tmp/.txpl_token ]]; then
        echo $(cat /tmp/.txpl_token)
        return
    fi

    echo -e "${Y}Autenticación requerida${X}"
    read -p "  Usuario: " USER
    read -sp "  Contraseña: " PASS; echo

    TOKEN=$(curl -s -X POST "$API/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
        | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

    if [[ -z "$TOKEN" ]]; then
        echo -e "${R}Credenciales incorrectas${X}"
        exit 1
    fi

    echo "$TOKEN" > /tmp/.txpl_token
    chmod 600 /tmp/.txpl_token
    echo "$TOKEN"
}

api() {
    local METHOD="$1" ENDPOINT="$2" DATA="$3"
    local TOKEN=$(get_token)
    if [[ -n "$DATA" ]]; then
        curl -s -X "$METHOD" "$API$ENDPOINT" \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/json" \
            -d "$DATA"
    else
        curl -s -X "$METHOD" "$API$ENDPOINT" \
            -H "Authorization: Bearer $TOKEN"
    fi
}

# ── Formatear JSON simple ─────────────────────────────────────
fmt_json() {
    python3 -m json.tool 2>/dev/null || cat
}

# ════════════════════════════════════════════════════════════
# COMANDOS
# ════════════════════════════════════════════════════════════

case "$1" in

# ── Panel ────────────────────────────────────────────────────
status)
    echo -e "${B}Estado del panel TecXPaneL${X}"
    echo ""
    pm2 jlist 2>/dev/null | python3 -c "
import sys, json, time
try:
    data = json.load(sys.stdin)
except Exception:
    data = []
p = next((x for x in data if x.get('name') == 'txpl-panel'), None)
if not p:
    print('  Panel no iniciado  (usa: txpl start)')
else:
    env = p.get('pm2_env', {}); mon = p.get('monit', {})
    up = env.get('pm_uptime')
    secs = int((time.time()*1000 - up)/1000) if up else 0
    h, m = secs // 3600, (secs % 3600) // 60
    print(f\"  Estado:     {env.get('status','?')}\")
    print(f\"  Uptime:     {h}h {m}m\")
    print(f\"  CPU:        {mon.get('cpu',0)}%\")
    print(f\"  Memoria:    {round(mon.get('memory',0)/1048576)} MB\")
    print(f\"  Reinicios:  {env.get('restart_time',0)}\")
" 2>/dev/null || echo "  Panel no iniciado"
    echo ""
    echo -e "${C}Servicios del sistema:${X}"
    for svc in nginx mysql postgresql redis ssh; do
        STATUS=$(systemctl is-active $svc 2>/dev/null)
        if [[ "$STATUS" == "active" ]]; then
            echo -e "  ${G}●${X} $svc — activo"
        else
            echo -e "  ${R}●${X} $svc — parado"
        fi
    done
    ;;

start)
    echo -e "${G}Iniciando TecXPaneL...${X}"
    pm2 start "$TXPL_DIR/ecosystem.config.js" --env production 2>/dev/null || \
    pm2 start "$TXPL_DIR/backend/server.js" --name txpl-panel
    pm2 save
    echo -e "${G}✅ Panel iniciado${X}"
    ;;

stop)
    pm2 stop txpl-panel && echo -e "${Y}Panel detenido${X}"
    ;;

restart)
    pm2 restart txpl-panel && echo -e "${G}✅ Panel reiniciado${X}"
    ;;

logs)
    echo -e "${C}Logs del panel (Ctrl+C para salir):${X}"
    pm2 logs txpl-panel --lines 50
    ;;

reset-password)
    # Restablece la contraseña directamente en la BD (no requiere login).
    # Útil cuando has perdido el acceso al panel.
    echo -e "${B}Restablecer contraseña${X}"
    read -p "  Usuario [admin]: " RP_USER; RP_USER="${RP_USER:-admin}"
    read -sp "  Nueva contraseña (mín 8): " RP_PASS; echo
    read -sp "  Repite la contraseña: " RP_PASS2; echo
    if [[ "$RP_PASS" != "$RP_PASS2" ]]; then
        echo -e "${R}Las contraseñas no coinciden${X}"; exit 1
    fi
    if [[ ${#RP_PASS} -lt 8 ]]; then
        echo -e "${R}La contraseña debe tener al menos 8 caracteres${X}"; exit 1
    fi
    if TXPL_DIR="${TXPL_DIR:-/opt/txpl}" RESET_NEW_PASSWORD="$RP_PASS" \
        node "${TXPL_DIR:-/opt/txpl}/backend/scripts/reset-password.js" "$RP_USER"; then
        echo -e "${G}✅ Listo. Ya puedes entrar con la nueva contraseña.${X}"
    else
        echo -e "${R}No se pudo restablecer la contraseña.${X}"; exit 1
    fi
    ;;

update)
    bash "$(dirname $0)/txpl-update.sh"
    ;;

# ── Sitios web ───────────────────────────────────────────────
sites)
    echo -e "${B}Sitios web${X}"
    echo ""
    RESULT=$(api GET /websites)
    echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if not data:
    print('  Sin sitios web aún')
else:
    print(f'  {'DOMINIO':<30} {'TIPO':<10} {'SSL':<6} {'ESTADO'}')
    print('  ' + '─'*60)
    for s in data:
        ssl = '🔒 Sí' if s.get('ssl') else 'No'
        print(f\"  {s['domain']:<30} {s.get('type','html'):<10} {ssl:<6} {s.get('status','?')}\")
" 2>/dev/null || echo "$RESULT"
    ;;

site:add)
    echo -e "${B}Crear nuevo sitio web${X}"
    read -p "  Dominio: " DOMAIN
    read -p "  Tipo (html/php/nodejs/react/python): " TYPE
    read -p "  SSL automático (s/N): " SSL_OPT
    SSL="false"; [[ "$SSL_OPT" == "s" ]] && SSL="true"

    RESULT=$(api POST /websites "{\"domain\":\"$DOMAIN\",\"type\":\"${TYPE:-html}\",\"ssl\":$SSL}")
    echo "$RESULT" | grep -q "success" && \
        echo -e "${G}✅ Sitio $DOMAIN creado en /var/www/$DOMAIN/public${X}" || \
        echo -e "${R}Error: $RESULT${X}"
    ;;

site:ssl)
    read -p "  ID del sitio: " SITE_ID
    echo -e "Instalando SSL para sitio $SITE_ID..."
    RESULT=$(api POST /websites/$SITE_ID/ssl)
    echo "$RESULT" | grep -q "success" && \
        echo -e "${G}✅ SSL instalado${X}" || echo -e "${R}Error: $RESULT${X}"
    ;;

panel:ssl)
    # SSL para el PROPIO panel. Fija server_name (que certbot necesita) y
    # ejecuta certbot, evitando el "Could not find a matching server block".
    DOMAIN="$2"
    [[ -z "$DOMAIN" ]] && echo "Uso: txpl panel:ssl <dominio>   (ej: txpl panel:ssl panel.midominio.com)" && exit 1
    NGINX_CONF="/etc/nginx/sites-available/txpl-panel"
    [[ ! -f "$NGINX_CONF" ]] && echo -e "${R}No encuentro $NGINX_CONF${X}" && exit 1

    echo -e "${C}Configurando SSL del panel para ${B}$DOMAIN${X}..."
    # Reemplaza la línea server_name activa (no las comentadas, que empiezan por #).
    sed -i -E "s/^([[:space:]]*)server_name[[:space:]]+[^;]*;/\1server_name $DOMAIN;/" "$NGINX_CONF"
    if ! nginx -t 2>/dev/null; then
        echo -e "${R}Config nginx inválida tras el cambio. Revisa: nginx -t${X}"; exit 1
    fi
    systemctl reload nginx
    echo -e "${G}✔ server_name fijado a $DOMAIN${X}"

    if [[ -n "${SSL_EMAIL:-}" ]]; then
        certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m "$SSL_EMAIL"
    else
        certbot --nginx -d "$DOMAIN" --redirect
    fi
    echo -e "${G}✅ Listo. Entra en https://$DOMAIN/${X}"
    ;;

# ── Apps ─────────────────────────────────────────────────────
apps)
    echo -e "${B}Aplicaciones PM2${X}"
    echo ""
    RESULT=$(api GET /apps)
    echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if not data:
    print('  Sin aplicaciones aún')
else:
    print(f\"  {'ID':<4} {'NOMBRE':<20} {'TIPO':<12} {'PUERTO':<8} {'ESTADO'}\")
    print('  ' + '─'*60)
    for a in data:
        port = str(a.get('port') or '—')
        print(f\"  {a['id']:<4} {a['name']:<20} {a.get('type','?'):<12} {port:<8} {a.get('status','?')}\")
" 2>/dev/null || echo "$RESULT"
    ;;

app:start)
    [[ -z "$2" ]] && echo "Uso: txpl app:start <id>" && exit 1
    RESULT=$(api POST /apps/$2/start)
    echo "$RESULT" | grep -q "success" && echo -e "${G}✅ App $2 iniciada${X}" || echo -e "${R}Error${X}"
    ;;

app:stop)
    [[ -z "$2" ]] && echo "Uso: txpl app:stop <id>" && exit 1
    RESULT=$(api POST /apps/$2/stop)
    echo "$RESULT" | grep -q "success" && echo -e "${Y}App $2 detenida${X}" || echo -e "${R}Error${X}"
    ;;

app:logs)
    [[ -z "$2" ]] && echo "Uso: txpl app:logs <id>" && exit 1
    RESULT=$(api GET /apps/$2/logs)
    echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('logs','Sin logs'))" 2>/dev/null
    ;;

# ── Bases de datos ───────────────────────────────────────────
dbs)
    echo -e "${B}Bases de datos${X}"
    echo ""
    RESULT=$(api GET /databases)
    echo "$RESULT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if not data:
    print('  Sin bases de datos aún')
else:
    print(f\"  {'ID':<4} {'NOMBRE':<25} {'TIPO':<12} {'USUARIO'}\")
    print('  ' + '─'*60)
    for d in data:
        print(f\"  {d['id']:<4} {d['name']:<25} {d.get('type','?'):<12} {d.get('db_user','?')}\")
" 2>/dev/null || echo "$RESULT"
    ;;

db:add)
    echo -e "${B}Crear base de datos${X}"
    read -p "  Motor (mysql/postgresql): " DB_TYPE
    read -p "  Nombre: " DB_NAME
    read -p "  Usuario (vacío = auto): " DB_USER
    read -sp "  Contraseña (vacío = auto): " DB_PASS; echo

    RESULT=$(api POST /databases "{\"type\":\"$DB_TYPE\",\"name\":\"$DB_NAME\",\"user\":\"$DB_USER\",\"password\":\"$DB_PASS\"}")
    echo "$RESULT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if d.get('success'):
    print(f\"  ✅ Base de datos creada:\")
    print(f\"     Nombre:     {d.get('name')}\")
    print(f\"     Usuario:    {d.get('user')}\")
    print(f\"     Contraseña: {d.get('password')}\")
else:
    print(f\"  Error: {d.get('error','desconocido')}\")
" 2>/dev/null || echo "$RESULT"
    ;;

# ── Sistema ──────────────────────────────────────────────────
stats)
    echo -e "${B}Stats del VPS (actualiza cada 3s, Ctrl+C para salir)${X}"
    while true; do
        clear
        echo -e "${B}TecXPaneL — Stats en tiempo real  $(date '+%H:%M:%S')${X}"
        echo ""
        CPU=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
        MEM=$(free -m | awk 'NR==2{printf "%.0f%%  (%dMB / %dMB)", $3/$2*100, $3, $2}')
        DISK=$(df -h / | awk 'NR==2{print $5 "  (" $3 " / " $2 ")"}')
        LOAD=$(uptime | awk -F'load average:' '{print $2}')
        echo -e "  ${C}CPU:${X}    $CPU%"
        echo -e "  ${C}RAM:${X}    $MEM"
        echo -e "  ${C}Disco:${X}  $DISK"
        echo -e "  ${C}Load:${X}  $LOAD"
        echo ""
        echo -e "  ${C}Procesos Top:${X}"
        ps aux --sort=-%cpu | awk 'NR<=6{printf "  %-20s CPU: %-6s MEM: %s\n", $11, $3"%", $4"%"}' | tail -5
        sleep 3
    done
    ;;

info)
    echo -e "${B}Información del sistema${X}"
    echo ""
    echo -e "  ${C}Hostname:${X}    $(hostname)"
    echo -e "  ${C}Sistema:${X}     $(lsb_release -d 2>/dev/null | cut -f2 || uname -a)"
    echo -e "  ${C}Kernel:${X}      $(uname -r)"
    echo -e "  ${C}Arquitectura:${X} $(uname -m)"
    echo -e "  ${C}Uptime:${X}      $(uptime -p)"
    echo -e "  ${C}IP pública:${X}  $(curl -s --max-time 3 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
    echo ""
    echo -e "  ${C}Node.js:${X}     $(node -v 2>/dev/null || echo 'no instalado')"
    echo -e "  ${C}npm:${X}         $(npm -v 2>/dev/null || echo 'no instalado')"
    echo -e "  ${C}Python:${X}      $(python3 --version 2>/dev/null || echo 'no instalado')"
    echo -e "  ${C}PM2:${X}         $(pm2 -v 2>/dev/null || echo 'no instalado')"
    echo -e "  ${C}Nginx:${X}       $(nginx -v 2>&1 | grep -o 'nginx/[0-9.]*' || echo 'no instalado')"
    echo ""
    ;;

backup)
    bash "$(dirname $0)/txpl-backup.sh"
    ;;

backup:cron)
    bash "$(dirname $0)/txpl-backup.sh" --install-cron
    ;;

backup:list)
    bash "$(dirname $0)/txpl-backup.sh" --list
    ;;

firewall)
    echo -e "${B}Reglas del Firewall UFW${X}"
    echo ""
    ufw status numbered 2>/dev/null | while IFS= read -r line; do
        echo "  $line"
    done
    ;;

logout)
    rm -f /tmp/.txpl_token
    echo -e "${Y}Sesión cerrada${X}"
    ;;

""|help|--help|-h)
    help
    ;;

*)
    echo -e "${R}Comando desconocido: $1${X}"
    echo "  Usa 'txpl help' para ver los comandos disponibles"
    exit 1
    ;;

esac
