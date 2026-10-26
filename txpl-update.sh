#!/bin/bash
# ============================================================
#  TecXPaneL — Actualizador
#
#  Uso:
#    txpl update                      descarga la última versión de GitHub y la aplica
#    bash txpl-update.sh --check      simulacro: muestra qué se haría, sin tocar nada
#    bash txpl-update.sh [--force]    aplica desde la carpeta donde está este script
#    --remote   descargar el código de GitHub (TXPL_UPDATE_REPO / TXPL_UPDATE_BRANCH)
#    --force    reaplicar aunque la versión sea la misma (o más antigua)
#
#  Cómo funciona:
#   1. Cada paso vive en scripts/update.d/NN-nombre.sh y define step_check
#      ("¿hace falta?", mirando el estado REAL del servidor) y step_run.
#      Así un servidor con PHP ya parcheado se lo salta, y uno que se saltó
#      varias versiones recibe todo lo pendiente.
#   2. Si algo falla, o el panel no responde en /api/health, se hace rollback
#      automático (archivos, dependencias y base de datos).
#   3. Deja marcas en /var/log/txpl-update.log que el panel usa para mostrar
#      el progreso y el resultado.
# ============================================================

set -Eeuo pipefail

if [[ -t 1 ]]; then GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
else GREEN=''; YELLOW=''; RED=''; BOLD=''; RESET=''; fi
log()  { echo -e "${GREEN}[TXPL]${RESET} $1"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $1"; }
err()  { echo -e "${RED}[ERROR]${RESET} $1"; exit 1; }

TXPL_DIR="${TXPL_DIR:-/opt/txpl}"
LOG_FILE="${TXPL_UPDATE_LOG:-/var/log/txpl-update.log}"
REMOTE=0; CHECK=0; FORCE=0; SRC_DIR=""; CLEANUP=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --remote) REMOTE=1 ;;
        --check)  CHECK=1 ;;
        --force)  FORCE=1 ;;
        --yes)    ;;                          # compatibilidad: ya no pregunta nada
        --from-dir) SRC_DIR="$2"; shift ;;    # interno: carpeta con el código descargado
        --cleanup)  CLEANUP="$2"; shift ;;    # interno: carpeta temporal a borrar al acabar
        *) err "Opción desconocida: $1" ;;
    esac
    shift
done

[[ $CHECK == 0 && $EUID -ne 0 ]] && err "Ejecutar como root"
[[ ! -f "$TXPL_DIR/.env" ]] && err "TXPL no instalado. Ejecuta txpl-setup.sh primero"

# Log + marcas START/DONE (las lee el panel). Solo una vez, aunque el script se relance.
if [[ $CHECK == 0 && -z "${TXPL_UPDATE_LOGGED:-}" ]]; then
    export TXPL_UPDATE_LOGGED=1
    exec > >(tee -a "$LOG_FILE") 2>&1
    echo "__TXPL_UPDATE_START__ $(date -Is)"
fi
LOCK_HELD=""
trap 'rc=$?; [[ -n "$LOCK_HELD" ]] && rm -f "$LOCK"; [[ -n "$CLEANUP" ]] && rm -rf "$CLEANUP"; [[ $CHECK == 0 ]] && echo "__TXPL_UPDATE_DONE__$rc"' EXIT

# ── Descarga remota: clona el repo y relanza ESTE mismo script, ya actualizado ──
if [[ $REMOTE == 1 ]]; then
    REPO="${TXPL_UPDATE_REPO:-tecxion/tecxpanel}"; BRANCH="${TXPL_UPDATE_BRANCH:-main}"
    [[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || err "TXPL_UPDATE_REPO inválido"
    [[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || err "TXPL_UPDATE_BRANCH inválido"
    command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }
    TMP=$(mktemp -d /tmp/txpl-update.XXXXXX); CLEANUP="$TMP"
    log "Descargando $REPO ($BRANCH)..."
    git clone -q --depth=1 -b "$BRANCH" "https://github.com/$REPO.git" "$TMP/src" || err "No se pudo descargar el repositorio"
    log "Descargado: v$(cat "$TMP/src/VERSION" 2>/dev/null || echo '?') (commit $(git -C "$TMP/src" rev-parse --short HEAD))"
    ARGS=(--from-dir "$TMP/src" --cleanup "$TMP")
    [[ $CHECK == 1 ]] && ARGS+=(--check)
    [[ $FORCE == 1 ]] && ARGS+=(--force)
    exec bash "$TMP/src/txpl-update.sh" "${ARGS[@]}"
fi

SRC="${SRC_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
[[ -d "$SRC/backend" && -f "$SRC/VERSION" ]] || err "No encuentro backend/ y VERSION en $SRC"

# Una sola actualización a la vez. Fichero con el PID en vez de flock: los procesos
# que lanzamos (pm2 deja un daemon vivo) heredarían el descriptor del flock y el
# bloqueo no se liberaría nunca.
LOCK="${TXPL_UPDATE_LOCK:-/var/lock/txpl-update.lock}"
if [[ $CHECK == 0 ]]; then
    if [[ -f "$LOCK" ]] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
        err "Ya hay otra actualización en curso"
    fi
    echo $$ > "$LOCK"; LOCK_HELD=1
fi

# Herramientas que usan los pasos (instalaciones antiguas pueden no tener rsync).
for tool in rsync curl; do
    command -v "$tool" >/dev/null 2>&1 || { [[ $CHECK == 1 ]] && warn "Falta $tool (se instalará al actualizar)" || { apt-get update -qq && apt-get install -y -qq "$tool"; }; }
done

NEW=$(tr -d '[:space:]' < "$SRC/VERSION")
OLD=$(tr -d '[:space:]' < "$TXPL_DIR/VERSION" 2>/dev/null || true); OLD="${OLD:-0.0.0}"
[[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || err "VERSION inválido: $NEW"

# ¿Hay que tocar archivos? Solo si la versión es distinta (y no más antigua), o con --force.
# Aun sin cambio de versión, los pasos "de sistema" (PHP, Nginx…) miran su propio estado.
FILES_CHANGE=0
if [[ "$NEW" != "$OLD" ]]; then
    if [[ "$(printf '%s\n%s\n' "$NEW" "$OLD" | sort -V | head -1)" == "$NEW" && $FORCE == 0 ]]; then
        warn "La versión descargada ($NEW) es más antigua que la instalada ($OLD). Usa --force para forzarlo."
    else
        FILES_CHANGE=1
    fi
elif [[ $FORCE == 1 ]]; then
    FILES_CHANGE=1
fi

BACKUP_DIR="$TXPL_DIR/backups/update-$(date +%Y%m%d-%H%M%S)"
NEED_RESTART=0
APPLIED=()
STEP_DESC=""

echo -e "${BOLD}TecXPaneL — Actualizador${RESET}  (instalada: v$OLD → disponible: v$NEW)"
[[ $CHECK == 1 ]] && echo "Simulacro (--check): no se modifica nada."

# ── Rollback: devuelve archivos, dependencias y BD al estado previo ──────────
rollback() {
    [[ -d "$BACKUP_DIR/backend" ]] || { warn "No hay copia previa; no se puede hacer rollback."; return; }
    warn "Restaurando la copia previa a la actualización..."
    rsync -a --delete --exclude node_modules "$BACKUP_DIR/backend/" "$TXPL_DIR/backend/"
    rsync -a --delete "$BACKUP_DIR/frontend/" "$TXPL_DIR/frontend/"
    cp "$BACKUP_DIR/.env" "$BACKUP_DIR/VERSION" "$BACKUP_DIR/ecosystem.config.js" "$TXPL_DIR/" 2>/dev/null || true
    pm2 stop txpl-panel >/dev/null 2>&1 || true
    if [[ -f "$BACKUP_DIR/txpl.db" ]]; then
        rm -f "$TXPL_DIR"/data/txpl.db-wal "$TXPL_DIR"/data/txpl.db-shm
        cp "$BACKUP_DIR/txpl.db" "$TXPL_DIR/data/txpl.db"
        log "Base de datos restaurada al estado previo"
    fi
    # El package.json restaurado puede pedir otras dependencias: se reinstalan y se
    # borra el hash para que la próxima actualización vuelva a comprobarlas.
    rm -f "$TXPL_DIR/data/deps.hash"
    (cd "$TXPL_DIR/backend" && npm install --omit=dev --no-audit --no-fund --silent) || warn "No se pudieron reinstalar las dependencias"
    pm2 restart txpl-panel >/dev/null 2>&1 || pm2 start "$TXPL_DIR/ecosystem.config.js" --env production >/dev/null 2>&1 || true
}
on_fail() {
    local rc=$?
    trap - ERR; set +e
    warn "Fallo en el paso: ${STEP_DESC:-desconocido} (código $rc)"
    [[ $CHECK == 0 ]] && rollback
    exit 1
}
trap on_fail ERR

# ── Pasos ───────────────────────────────────────────────────
for f in "$SRC"/scripts/update.d/*.sh; do
    unset -f step_check step_run step_preview 2>/dev/null || true
    STEP_DESC=""
    # shellcheck disable=SC1090
    source "$f"
    if step_check; then
        if [[ $CHECK == 1 ]]; then
            echo "  • $STEP_DESC — pendiente"
            declare -F step_preview >/dev/null && step_preview
        else
            log "▶ $STEP_DESC"
            step_run
            APPLIED+=("$(basename "$f" .sh)")
        fi
    else
        echo "  ✓ $STEP_DESC — al día"
    fi
done
[[ $CHECK == 1 ]] && exit 0

# ── Recarga del panel + comprobación de salud ───────────────
if [[ $NEED_RESTART == 1 ]]; then
    log "🔄 Recargando panel..."
    if pm2 describe txpl-panel >/dev/null 2>&1; then pm2 reload txpl-panel --update-env >/dev/null
    else pm2 start "$TXPL_DIR/ecosystem.config.js" --env production >/dev/null; fi
    pm2 save >/dev/null

    PORT=$(grep -E '^TXPL_PORT=' "$TXPL_DIR/.env" | cut -d= -f2 | tr -d '"' || true); PORT="${PORT:-8585}"
    healthy=0
    for _ in $(seq 1 25); do
        if curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then healthy=1; break; fi
        sleep 1
    done
    if [[ $healthy == 0 ]]; then
        warn "El panel no responde en /api/health tras recargar."
        rollback
        err "Actualización fallida. Copia restaurada. Revisa: pm2 logs txpl-panel"
    fi
    log "✅ Panel respondiendo correctamente"
fi

COMMIT=$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo '-')
echo "$(date -Is) $OLD -> $NEW pasos=[${APPLIED[*]:-}] commit=$COMMIT" >> "$TXPL_DIR/data/update-history.log"
log "✅ Actualización completada: v$NEW"
