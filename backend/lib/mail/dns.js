'use strict';
// ============================================================
//  TecXPaneL — lib/mail/dns.js — registros DNS del correo
// ============================================================

function buildDnsRecords({ domain, hostname, serverIp, dkimPublic, dkimSelector }) {
  return [
    { type: 'A', name: hostname, value: serverIp || '', note: 'IP pública del servidor de correo.' },
    { type: 'MX', name: domain, value: hostname, priority: 10 },
    { type: 'TXT', name: domain, value: 'v=spf1 mx ~all', note: 'SPF.' },
    {
      type: 'TXT',
      name: `${dkimSelector || 'mail'}._domainkey.${domain}`,
      value: dkimPublic || '',
      note: dkimPublic ? 'DKIM.' : 'Genera primero el DKIM para obtener este valor.',
    },
    { type: 'TXT', name: `_dmarc.${domain}`, value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, note: 'DMARC.' },
    { type: 'PTR', name: serverIp || '', value: hostname, note: 'rDNS: se solicita al proveedor del VPS, no en tu DNS.' },
  ];
}

const { buildRecordContent } = require('../dns');

function mailRecordsToRrsets(records, zone) {
  const out = [];
  for (const r of records || []) {
    if (r.type === 'PTR') continue;
    if (!r.value) continue;
    out.push({
      name: r.name,
      type: r.type,
      content: buildRecordContent(r.type, r.value, r.priority || 10),
    });
  }
  return out;
}

module.exports = { buildDnsRecords, mailRecordsToRrsets };