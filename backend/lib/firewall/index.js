'use strict';

const net = require('net');

const ACTIONS = ['allow', 'deny', 'reject', 'limit'];
const PROTOCOLS = ['tcp', 'udp', ''];

function parsePortSpec(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(\d+)(?::(\d+))?$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) return null;
  return { value: start === end ? String(start) : `${start}:${end}`, start, end };
}

function isValidSource(value) {
  const source = String(value ?? '').trim();
  if (!source) return true;
  const [address, prefix] = source.split('/');
  const version = net.isIP(address);
  if (!version) return false;
  if (prefix === undefined) return true;
  const max = version === 4 ? 32 : 128;
  return /^\d+$/.test(prefix) && Number(prefix) >= 0 && Number(prefix) <= max;
}

function buildRuleArgs({ action = 'allow', port, protocol = 'tcp', from = '' } = {}) {
  if (!ACTIONS.includes(action)) return { ok: false, error: 'Acción inválida' };
  if (!PROTOCOLS.includes(protocol)) return { ok: false, error: 'Protocolo inválido' };
  const portSpec = parsePortSpec(port);
  if (!portSpec) return { ok: false, error: 'Puerto inválido (usa 1-65535 o un rango como 8000:8010)' };
  const source = String(from ?? '').trim();
  if (!isValidSource(source)) return { ok: false, error: 'IP/CIDR de origen inválida' };
  if (source) return { ok: true, args: [action, 'from', source, 'to', 'any', 'port', portSpec.value, ...(protocol ? ['proto', protocol] : [])] };
  return { ok: true, args: [action, portSpec.value + (protocol ? `/${protocol}` : '')] };
}

function parseUfwStatus(stdout = '', verbose = '') {
  const text = String(stdout);
  const detail = String(verbose || text);
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\[\s*(\d+)\]\s+(.+?)\s+(ALLOW|DENY|REJECT|LIMIT)(?:\s+(IN|OUT))?\s*(.*)$/i);
    if (!match) continue;
    rules.push({
      num: Number(match[1]), to: match[2].trim(), action: match[3].toUpperCase(),
      direction: (match[4] || 'IN').toUpperCase(), from: match[5].trim() || 'Anywhere',
    });
  }
  const defaultMatch = detail.match(/Default:\s*([^,]+),\s*([^,]+)(?:,\s*([^\r\n]+))?/i);
  const loggingMatch = detail.match(/Logging:\s*([^\r\n]+)/i);
  return {
    enabled: /^Status:\s*active/im.test(text) || /^Status:\s*active/im.test(detail),
    rules,
    defaults: defaultMatch ? { incoming: defaultMatch[1].trim(), outgoing: defaultMatch[2].trim(), routed: (defaultMatch[3] || '').trim() } : null,
    logging: loggingMatch ? loggingMatch[1].trim() : null,
  };
}

function formatUfwError(stderr) {
  return String(stderr || 'Error de UFW').split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 240) || 'Error de UFW';
}

module.exports = { ACTIONS, PROTOCOLS, parsePortSpec, isValidSource, buildRuleArgs, parseUfwStatus, formatUfwError };
