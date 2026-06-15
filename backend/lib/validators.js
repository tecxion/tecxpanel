'use strict';

// ============================================================
//  TecXPaneL — Validadores y listas blancas
//
//  Reglas para comprobar que los datos que llegan del usuario son
//  válidos ANTES de usarlos (crear sitios, abrir puertos, etc.).
//  Validar pronto evita errores y cierra la puerta a entradas
//  maliciosas. Usamos "listas blancas" (solo se permite lo que está
//  en la lista) porque son más seguras que las listas negras.
// ============================================================

// Servicios del sistema que el panel puede controlar (start/stop/restart).
const ALLOWED_SERVICES = ['nginx', 'mysql', 'mariadb', 'postgresql', 'redis', 'redis-server', 'ssh', 'sshd'];
// Acciones permitidas sobre esos servicios.
const ALLOWED_SVC_ACTIONS = ['start', 'stop', 'restart'];
// Acciones permitidas sobre las apps de PM2.
const ALLOWED_APP_ACTIONS = ['start', 'stop', 'restart', 'delete'];
// Tipos de sitio web soportados.
const ALLOWED_SITE_TYPES = ['html', 'php', 'nodejs', 'react', 'python'];
// Tipos de app desplegable soportados.
const ALLOWED_APP_TYPES = ['nodejs', 'typescript', 'react', 'python'];
// Motores de base de datos soportados.
const ALLOWED_DB_TYPES = ['mysql', 'postgresql'];
// Ficheros de log que se pueden leer desde el panel (lista blanca de rutas).
const LOG_FILES = {
  nginx_access: '/var/log/nginx/access.log',
  nginx_error:  '/var/log/nginx/error.log',
  system:       '/var/log/syslog',
};

// ── Expresiones regulares (patrones de validación) ────────────
// Un dominio válido: etiquetas separadas por puntos, sin empezar/terminar en "-".
const RE_DOMAIN = /^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/;
// Nombre de app: letras, números, guion y guion bajo (1-40 caracteres).
const RE_APP_NAME = /^[a-zA-Z0-9_-]{1,40}$/;
// Nombre de base de datos: letras, números y guion bajo (1-32).
const RE_DB_NAME = /^[a-zA-Z0-9_]{1,32}$/;
// Nombre de usuario de BD: mismas reglas que el nombre de BD.
const RE_DB_USER = /^[a-zA-Z0-9_]{1,32}$/;
// IP o rango CIDR (ej. "1.2.3.4" o "1.2.3.0/24").
const RE_IP_CIDR = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;

// ¿Es un número de puerto válido? (entero entre 1 y 65535).
const isPort = (v) => Number.isInteger(v) && v > 0 && v <= 65535;
// ¿Es una cadena que cumple el patrón de dominio?
const isValidDomain = (d) => typeof d === 'string' && RE_DOMAIN.test(d);

module.exports = {
  ALLOWED_SERVICES, ALLOWED_SVC_ACTIONS, ALLOWED_APP_ACTIONS,
  ALLOWED_SITE_TYPES, ALLOWED_APP_TYPES, ALLOWED_DB_TYPES, LOG_FILES,
  RE_DOMAIN, RE_APP_NAME, RE_DB_NAME, RE_DB_USER, RE_IP_CIDR,
  isPort, isValidDomain,
};
