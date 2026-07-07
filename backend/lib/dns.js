'use strict';

// ============================================================
//  TecXPaneL — Helpers puros de DNS (PowerDNS)
//
//  Sin estado ni dependencias del servidor: validación de dominios
//  y registros, canonicalización FQDN, y construcción de payloads
//  para la API de PowerDNS y de los registros de delegación.
// ============================================================

const SUPPORTED_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'];

// Dominio válido SIN punto final (como lo introduce el usuario).
const RE_DOMAIN = /^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/;

// Asegura el punto final (FQDN) que exige PowerDNS.
function canonical(name) {
  const s = String(name || '').trim();
  return s.endsWith('.') ? s : s + '.';
}

function isValidDnsDomain(x) {
  return typeof x === 'string' && !x.endsWith('.') && RE_DOMAIN.test(x);
}

function isValidIpv4(ip) {
  if (typeof ip !== 'string') return false;
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
}

function isValidIpv6(ip) {
  if (typeof ip !== 'string' || ip.includes('.') || /[^0-9a-fA-F:]/.test(ip)) return false;
  // Debe tener al menos dos ':' o una compresión '::', y grupos hex de 1-4.
  if (!ip.includes(':')) return false;
  return ip.split(':').every((g) => g === '' || /^[0-9a-fA-F]{1,4}$/.test(g));
}

// Un hostname es un dominio válido (para CNAME/MX).
function isValidHostname(h) {
  return isValidDnsDomain(h);
}

function isValidRecord(type, value) {
  switch (type) {
    case 'A': return isValidIpv4(value);
    case 'AAAA': return isValidIpv6(value);
    case 'CNAME': return isValidHostname(value);
    case 'MX': return isValidHostname(value);
    case 'TXT': return typeof value === 'string' && value.trim() !== '' && !/[\n\r]/.test(value);
    default: return false;
  }
}

function isValidPriority(p) {
  return Number.isInteger(p) && p >= 0 && p <= 65535;
}

module.exports = {
  SUPPORTED_TYPES, canonical, isValidDnsDomain, isValidIpv4, isValidIpv6,
  isValidHostname, isValidRecord, isValidPriority,
};
