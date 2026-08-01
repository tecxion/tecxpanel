'use strict';

// queries/dns.js — config (fila única id=1) de PowerDNS (api_key AES-256-GCM).
const { db } = require('../client');

module.exports = {
  getDnsConfig: db.prepare('SELECT * FROM dns_config WHERE id = 1'),
  saveDnsConfig: db.prepare(`
    INSERT INTO dns_config (id, api_key_enc, ns1, ns2, server_ip, status, created_at)
    VALUES (1, @api_key_enc, @ns1, @ns2, @server_ip, @status, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      api_key_enc = @api_key_enc, ns1 = @ns1, ns2 = @ns2,
      server_ip = @server_ip, status = @status`),
};
