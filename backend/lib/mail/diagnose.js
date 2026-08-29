'use strict';
// ============================================================
//  TecXPaneL — lib/mail/diagnose.js
//  Clasificadores PUROS del diagnóstico de correo. Cada función recibe el
//  resultado "crudo" de una sonda (la sonda —DNS/TCP— la ejecuta la ruta, con
//  efectos) y devuelve un check:
//     { id, level, title, detail, fix }   con level ∈ 'ok' | 'warn' | 'error'
//  Sin red ni Docker → testeable en aislamiento.
// ============================================================

const LEVEL_ORDER = { ok: 0, warn: 1, error: 2 };

// Nivel global = el peor de todos los checks (para el semáforo de cabecera).
function overallLevel(checks) {
  return (checks || []).reduce(
    (worst, c) => (LEVEL_ORDER[c.level] > LEVEL_ORDER[worst] ? c.level : worst),
    'ok',
  );
}

// Node devuelve los TXT como string[][] (cada registro puede venir troceado en
// varias cadenas de ≤255 bytes). Los une en un array de strings completos.
function joinTxt(txt) {
  return (txt || []).map((r) => (Array.isArray(r) ? r.join('') : String(r)));
}

function hasTxt(txt, predicate) {
  return joinTxt(txt).some((t) => predicate(t.trim()));
}

// Construye la consulta DNSBL de una IPv4: octetos invertidos + sufijo de la lista.
function dnsblQuery(ip, list) {
  const rev = String(ip).split('.').reverse().join('.');
  return `${rev}.${list}`;
}

// ¿Los códigos A que devuelve una DNSBL son un listado REAL? 127.0.0.x = listada;
// 127.255.255.x = error/consulta bloqueada (típico al consultar desde un resolver
// público como 8.8.8.8) → NO es un listado real, evita el falso positivo.
function dnsblListed(codes) {
  return (codes || []).some((c) => typeof c === 'string' && c.startsWith('127.') && !c.startsWith('127.255.255.'));
}

// ── Clasificadores ───────────────────────────────────────────

function classifyPort25(connected) {
  return connected
    ? { id: 'port25', level: 'ok', title: 'Puerto 25 saliente abierto', detail: 'Tu servidor puede entregar correo directamente a otros servidores.', fix: null }
    : { id: 'port25', level: 'error', title: 'Puerto 25 saliente bloqueado', detail: 'Tu proveedor de VPS bloquea el envío directo de correo (lo más común en VPS económicos): no podrás enviar sin ayuda.', fix: 'Configura un «relay SMTP» (envío a través de otro proveedor) o pide a tu proveedor de VPS que abra el puerto 25 saliente.' };
}

function classifyDnsA(ips, serverIp) {
  ips = ips || [];
  if (!ips.length) return { id: 'dns_a', level: 'error', title: 'Falta el registro A del correo', detail: 'El hostname del correo no resuelve a ninguna IP.', fix: `Crea un registro A: mail.tudominio.com → ${serverIp || 'la IP del VPS'}.` };
  if (serverIp && !ips.includes(serverIp)) return { id: 'dns_a', level: 'warn', title: 'El registro A apunta a otra IP', detail: `El hostname resuelve a ${ips.join(', ')}, pero este VPS es ${serverIp}.`, fix: `Corrige el registro A para que apunte a ${serverIp}.` };
  return { id: 'dns_a', level: 'ok', title: 'Registro A correcto', detail: 'El hostname del correo apunta a este servidor.', fix: null };
}

function classifyPtr(names, hostname) {
  names = (names || []).map((n) => String(n).replace(/\.$/, '').toLowerCase());
  const host = hostname ? hostname.replace(/\.$/, '').toLowerCase() : '';
  if (!names.length) return { id: 'ptr', level: 'warn', title: 'Sin PTR (DNS inverso)', detail: 'La IP no tiene DNS inverso. Sin PTR, casi todo tu correo acabará en spam.', fix: `Pide a tu proveedor de VPS que el PTR de la IP sea ${hostname || 'mail.tudominio.com'}.` };
  if (host && !names.includes(host)) return { id: 'ptr', level: 'warn', title: 'El PTR no coincide con el hostname', detail: `El PTR es ${names.join(', ')}, pero el hostname del correo es ${host}.`, fix: `Pide a tu proveedor que el PTR sea exactamente ${host}.` };
  return { id: 'ptr', level: 'ok', title: 'PTR correcto', detail: 'El DNS inverso coincide con el hostname del correo.', fix: null };
}

function classifyMx(exchanges, hostname) {
  exchanges = (exchanges || []).map((x) => String(x).replace(/\.$/, '').toLowerCase());
  const host = hostname ? hostname.replace(/\.$/, '').toLowerCase() : '';
  if (!exchanges.length) return { id: 'mx', level: 'error', title: 'Falta el registro MX', detail: 'Tu dominio no indica a qué servidor llega su correo.', fix: `Crea un registro MX: tudominio.com → ${hostname || 'mail.tudominio.com'} (prioridad 10).` };
  if (host && !exchanges.includes(host)) return { id: 'mx', level: 'warn', title: 'El MX apunta a otro servidor', detail: `El MX es ${exchanges.join(', ')}, no ${host}.`, fix: `Apunta el MX a ${host} si quieres recibir el correo aquí.` };
  return { id: 'mx', level: 'ok', title: 'Registro MX correcto', detail: 'El correo del dominio llega a este servidor.', fix: null };
}

function classifySpf(txt) {
  return hasTxt(txt, (t) => /^v=spf1\b/i.test(t))
    ? { id: 'spf', level: 'ok', title: 'SPF configurado', detail: 'Autoriza a este servidor a enviar en nombre del dominio.', fix: null }
    : { id: 'spf', level: 'warn', title: 'Falta SPF', detail: 'Sin SPF tu correo tiene más papeletas de acabar en spam.', fix: 'Añade un TXT en el dominio: «v=spf1 mx ~all».' };
}

function classifyDkim(txt) {
  return hasTxt(txt, (t) => /(^|;)\s*v=DKIM1/i.test(t) || /(^|;)\s*p=/i.test(t))
    ? { id: 'dkim', level: 'ok', title: 'DKIM publicado', detail: 'Las firmas de tu correo se pueden verificar.', fix: null }
    : { id: 'dkim', level: 'warn', title: 'Falta DKIM', detail: 'Sin DKIM muchos proveedores desconfían de tu correo.', fix: 'Genera DKIM en el panel y publica el TXT que te muestre.' };
}

function classifyDmarc(txt) {
  return hasTxt(txt, (t) => /^v=DMARC1\b/i.test(t))
    ? { id: 'dmarc', level: 'ok', title: 'DMARC configurado', detail: 'Defines qué hacer con el correo que no pasa SPF/DKIM.', fix: null }
    : { id: 'dmarc', level: 'warn', title: 'Falta DMARC', detail: 'Recomendado para mejorar la entrega y evitar suplantaciones de tu dominio.', fix: 'Añade un TXT en _dmarc.tudominio.com: «v=DMARC1; p=none; rua=mailto:postmaster@tudominio.com».' };
}

function classifyDnsbl(listings) {
  const listed = (listings || []).filter((l) => l && l.listed).map((l) => l.list);
  return listed.length
    ? { id: 'dnsbl', level: 'error', title: 'IP en lista negra', detail: `Tu IP aparece en: ${listed.join(', ')}. Muchos servidores rechazarán tu correo.`, fix: 'Solicita la retirada (delisting) en cada lista y revisa por qué te listaron.' }
    : { id: 'dnsbl', level: 'ok', title: 'IP sin listas negras', detail: 'Tu IP no aparece en las listas negras comprobadas.', fix: null };
}

module.exports = {
  overallLevel, joinTxt, dnsblQuery, dnsblListed,
  classifyPort25, classifyDnsA, classifyPtr, classifyMx,
  classifySpf, classifyDkim, classifyDmarc, classifyDnsbl,
};
