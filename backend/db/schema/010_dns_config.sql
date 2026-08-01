-- dns_config: fila única (id=1) con la config del PowerDNS (api_key AES-256-GCM).
CREATE TABLE IF NOT EXISTS dns_config (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  api_key_enc TEXT,
  ns1         TEXT,
  ns2         TEXT,
  server_ip   TEXT,
  status      TEXT DEFAULT 'not_installed',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
