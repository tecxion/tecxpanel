# Paso: python3-venv (necesario para desplegar apps Python).
STEP_DESC="python3-venv"
step_check() { ! dpkg -s python3-venv >/dev/null 2>&1; }
step_run() {
    apt-get update -qq && apt-get install -y -qq python3-venv \
        || warn "No se pudo instalar python3-venv (instálalo con: apt install python3-venv)"
}
