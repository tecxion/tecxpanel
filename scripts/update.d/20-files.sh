# Paso: copiar los archivos nuevos. rsync --delete borra lo que ya no existe en el
# código nuevo (con cp -r quedaban ficheros viejos). node_modules NO se toca.
STEP_DESC="Archivos del panel (backend, frontend, scripts)"
step_check() { [[ "$FILES_CHANGE" == 1 ]]; }
step_preview() {
    echo "    cambios en backend/:  $(rsync -ani --delete --exclude node_modules "$SRC/backend/" "$TXPL_DIR/backend/" | grep -c '^[<>*c]')"
    echo "    cambios en frontend/: $(rsync -ani --delete "$SRC/frontend/" "$TXPL_DIR/frontend/" | grep -c '^[<>*c]')"
}
step_run() {
    rsync -a --delete --exclude node_modules "$SRC/backend/" "$TXPL_DIR/backend/"
    rsync -a --delete "$SRC/frontend/" "$TXPL_DIR/frontend/"
    cp "$SRC/package.json" "$TXPL_DIR/backend/package.json"
    [[ -f "$SRC/package-lock.json" ]] && cp "$SRC/package-lock.json" "$TXPL_DIR/backend/package-lock.json"
    cp "$SRC/ecosystem.config.js" "$TXPL_DIR/ecosystem.config.js"
    cp "$SRC/txpl-update.sh" "$SRC/txpl-backup.sh" "$TXPL_DIR/" && chmod +x "$TXPL_DIR"/*.sh
    rsync -a --delete "$SRC/scripts/update.d/" "$TXPL_DIR/scripts/update.d/" 2>/dev/null || { mkdir -p "$TXPL_DIR/scripts" && cp -r "$SRC/scripts/update.d" "$TXPL_DIR/scripts/"; }
    [[ -f "$SRC/txpl-cli.sh" ]] && cp "$SRC/txpl-cli.sh" "${TXPL_CLI_PATH:-/usr/local/bin/txpl}" && chmod +x "${TXPL_CLI_PATH:-/usr/local/bin/txpl}"
    cp "$SRC/VERSION" "$TXPL_DIR/VERSION"
    NEED_RESTART=1
}
