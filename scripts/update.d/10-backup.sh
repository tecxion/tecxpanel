# Paso: copia previa a la actualización (solo si se van a tocar archivos).
STEP_DESC="Copia de seguridad previa"
step_check() { [[ "$FILES_CHANGE" == 1 ]]; }
step_run() {
    mkdir -p "$BACKUP_DIR"
    rsync -a --exclude node_modules "$TXPL_DIR/backend/" "$BACKUP_DIR/backend/" 2>/dev/null || true
    rsync -a "$TXPL_DIR/frontend/" "$BACKUP_DIR/frontend/" 2>/dev/null || true
    cp "$TXPL_DIR/.env" "$TXPL_DIR/VERSION" "$TXPL_DIR/ecosystem.config.js" "$BACKUP_DIR/" 2>/dev/null || true
    # La BD está en modo WAL: un `cp` simple puede copiar un estado a medias.
    # VACUUM INTO genera una copia coherente aunque el panel esté escribiendo.
    if [[ -f "$TXPL_DIR/data/txpl.db" ]]; then
        (cd "$TXPL_DIR/backend" && node -e "
          const D = require('better-sqlite3');
          new D('$TXPL_DIR/data/txpl.db', { readonly: true }).exec(\"VACUUM INTO '$BACKUP_DIR/txpl.db'\");
        ") || { warn "VACUUM INTO falló; copio la BD con sus ficheros WAL"; cp "$TXPL_DIR"/data/txpl.db* "$BACKUP_DIR/" 2>/dev/null || true; }
    fi
    # Conserva solo las 5 copias más recientes.
    ls -1dt "$TXPL_DIR"/backups/update-* 2>/dev/null | tail -n +6 | xargs -r rm -rf || true
    log "Copia guardada en $BACKUP_DIR"
}
