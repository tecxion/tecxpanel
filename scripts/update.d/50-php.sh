# Paso: php2shell (CVE-2026-109618/109619). Solo actúa si hay una rama de PHP-FPM
# sin parchear o sin la mitigación; si todo está al día se omite. Mira el estado
# REAL del servidor, así que da igual de qué versión del panel vengas.
STEP_DESC="Parche y mitigaciones de PHP (php2shell)"
php_js() { (cd "$TXPL_DIR/backend" && node -e "$1"); }
step_check() {
    ls /usr/sbin/php-fpm[0-9]* >/dev/null 2>&1 || return 1
    # Sale 0 (hace falta) si alguna rama soportada está sin parchear o sin endurecer.
    php_js "require('./lib/php/engine').check().then(b => process.exit(b.some(x => x.supported && (!x.patched || !x.hardened)) ? 0 : 1))"
}
step_run() {
    php_js "
      const e = require('./lib/php/engine');
      e.patch(console.log).then((c) => e.harden().then((b) => { console.log('Mitigaciones en: ' + b.join(', ')); process.exit(c); }));
    " || warn "PHP sin parche confirmado (los repos pueden no haberlo publicado aún). Mitigaciones aplicadas igualmente."
}
