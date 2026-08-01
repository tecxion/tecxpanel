-- n8n_config: fila única (id=1) con la config de conexión a la instancia n8n.
CREATE TABLE IF NOT EXISTS n8n_config (
  id           INTEGER PRIMARY KEY,
  base_url     TEXT,
  api_key_enc  TEXT,
  container_id TEXT,
  domain       TEXT,
  host_port    INTEGER,
  status       TEXT,
  created_at   TEXT
);
