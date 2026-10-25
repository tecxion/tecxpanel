'use strict';

// ============================================================
//  TecXPaneL — PHP: helpers puros (php2shell, CVE-2026-109618/109619)
//
//  php2shell es un fallo del PROPIO PHP (RCE sin autenticación vía
//  agotamiento de memoria en la gestión de peticiones). Lo arregla
//  actualizar PHP; esto solo detecta, y aplica mitigaciones.
// ============================================================

// Último parche upstream seguro por rama. Ramas fuera de la tabla
// (7.x, 8.0, 8.1…) no reciben parche por apt: se marcan sin soporte.
const FIXED_PATCH = { '8.2': 35, '8.3': 36, '8.4': 27, '8.5': 12 };

// Debian/Ubuntu parchean sin cambiar el número de versión (Ubuntu: 8.3.6-0ubuntu0.24.04.13),
// así que la prueba fiable es que el changelog del paquete cite los CVE.
const CVE_PATTERN = 'CVE-2026-10961[89]';

const RE_BRANCH = /^\d+\.\d+$/;

// "PHP 8.3.6 (fpm-fcgi) ..." → { branch: '8.3', patch: 6, full: '8.3.6' } | null
function parsePhpVersion(text) {
  const m = /PHP (\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return m ? { branch: `${m[1]}.${m[2]}`, patch: +m[3], full: `${m[1]}.${m[2]}.${m[3]}` } : null;
}

// ¿Versión upstream ya corregida? (válido en Debian; en Ubuntu mirar el changelog).
function isFixedUpstream(text) {
  const v = parsePhpVersion(text);
  return !!v && FIXED_PATCH[v.branch] !== undefined && v.patch >= FIXED_PATCH[v.branch];
}

function isSupportedBranch(branch) {
  return Object.prototype.hasOwnProperty.call(FIXED_PATCH, branch);
}

// Mitigaciones del PHP Foundation/Sansec: upload-progress de sesión es la vía más
// explotada. El resto es endurecimiento estándar. Va en conf.d de FPM (el que
// leen las webs; el php.ini del CLI no cuenta).
const HARDENING_INI = `; Gestionado por TecXPaneL — php2shell (CVE-2026-109618/109619). No editar a mano.
session.upload_progress.enabled = Off
session.use_strict_mode = 1
expose_php = Off
cgi.fix_pathinfo = 0
allow_url_include = Off
`;

// Salida de `dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n'` → solo paquetes
// realmente instalados ("ii"). El glob php8.5* también devuelve virtuales/residuales
// (p. ej. php8.5-json) y `apt install` abortaba entero con ellos.
function parseInstalledPkgs(out) {
  return String(out).split('\n').map((l) => /^ii\s+(\S+)$/.exec(l.trim())?.[1]).filter(Boolean);
}

const hardeningIniPath = (branch) => `/etc/php/${branch}/fpm/conf.d/99-txpl-hardening.ini`;

module.exports = {
  FIXED_PATCH, CVE_PATTERN, RE_BRANCH, HARDENING_INI,
  parsePhpVersion, parseInstalledPkgs, isFixedUpstream, isSupportedBranch, hardeningIniPath,
};
