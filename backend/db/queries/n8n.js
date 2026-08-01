'use strict';

// queries/n8n.js — config (fila única id=1) de la instancia n8n gestionada.
const { db } = require('../client');

module.exports = {
  getN8nConfig: db.prepare('SELECT * FROM n8n_config WHERE id = 1'),
  saveN8nConfig: db.prepare(`
    INSERT INTO n8n_config (id, base_url, api_key_enc, container_id, domain, host_port, status, created_at)
    VALUES (1, @base_url, @api_key_enc, @container_id, @domain, @host_port, @status, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      base_url = excluded.base_url,
      api_key_enc = excluded.api_key_enc,
      container_id = excluded.container_id,
      domain = excluded.domain,
      host_port = excluded.host_port,
      status = excluded.status`),
  clearN8nConfig: db.prepare('DELETE FROM n8n_config WHERE id = 1'),
};
