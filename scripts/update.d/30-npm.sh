# Paso: dependencias npm, solo si cambió package.json/package-lock.json (o falta node_modules).
STEP_DESC="Dependencias Node.js"
HASH_FILE="$TXPL_DIR/data/deps.hash"
deps_hash() { cat "$SRC/package.json" "$SRC/package-lock.json" 2>/dev/null | sha256sum | cut -d' ' -f1; }
step_check() {
    [[ ! -d "$TXPL_DIR/backend/node_modules" ]] && return 0
    [[ "$(cat "$HASH_FILE" 2>/dev/null)" != "$(deps_hash)" ]]
}
step_run() {
    cd "$TXPL_DIR/backend"
    npm install --omit=dev --no-audit --no-fund --silent
    deps_hash > "$HASH_FILE"
    NEED_RESTART=1
}
