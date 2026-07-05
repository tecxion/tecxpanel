'use strict';

// ============================================================
//  TecXPaneL — Helpers puros de n8n (Workflows)
//
//  Funciones sin estado ni dependencias del servidor, para poder
//  testearlas de forma aislada: config del contenedor Docker,
//  cliente HTTP de la Public API de n8n y cálculo de estado.
// ============================================================

const N8N_CONTAINER = 'txpl-n8n';
const N8N_VOLUME = 'n8n_data';
const N8N_IMAGE = 'n8nio/n8n';
const N8N_PORT = 5678;

// Construye la config que se envía a la Docker API para crear el contenedor n8n.
//  - hostPort: puerto del VPS que se mapea al 5678 interno.
//  - domain:   si hay dominio (proxy + SSL) => https y cookie segura; si no, http.
//  - timezone: zona horaria para los nodos de fecha/cron de n8n.
function buildN8nContainerConfig({ hostPort = N8N_PORT, domain = null, timezone = 'UTC' } = {}) {
  const protocol = domain ? 'https' : 'http';
  const host = domain || 'localhost';
  const webhookUrl = domain ? `https://${domain}/` : `http://localhost:${hostPort}/`;
  const env = [
    `N8N_HOST=${host}`,
    `N8N_PORT=${N8N_PORT}`,
    `N8N_PROTOCOL=${protocol}`,
    `GENERIC_TIMEZONE=${timezone}`,
    `WEBHOOK_URL=${webhookUrl}`,
    // Sin HTTPS el navegador rechaza la cookie de sesión "secure"; en acceso por
    // dominio con SSL sí la exigimos.
    `N8N_SECURE_COOKIE=${domain ? 'true' : 'false'}`,
  ];
  const cPort = `${N8N_PORT}/tcp`;
  return {
    Image: N8N_IMAGE,
    Env: env,
    ExposedPorts: { [cPort]: {} },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: { [cPort]: [{ HostPort: String(hostPort) }] },
      Binds: [`${N8N_VOLUME}:/home/node/.n8n`],
    },
    Labels: domain ? { 'txpl.domain': domain } : {},
  };
}

// Cliente HTTP mínimo para la Public API de n8n. fetchImpl es inyectable para test.
async function n8nApi(baseUrl, apiKey, method, apiPath, body = null, fetchImpl = fetch) {
  const url = String(baseUrl).replace(/\/+$/, '') + apiPath;
  const headers = { 'X-N8N-API-KEY': apiKey, 'Accept': 'application/json' };
  const opts = { method, headers };
  if (body) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetchImpl(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && data.message) ? data.message
      : (typeof data === 'string' && data) ? data : 'error desconocido';
    const err = new Error(`n8n API ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Deriva el estado de alto nivel que consume el frontend para decidir la vista.
function computeN8nStatus({ containerExists, running, hasApiKey }) {
  if (!containerExists) return { state: 'not_installed', installed: false, running: false, configured: false };
  if (!running) return { state: 'stopped', installed: true, running: false, configured: !!hasApiKey };
  if (!hasApiKey) return { state: 'needs_config', installed: true, running: true, configured: false };
  return { state: 'ready', installed: true, running: true, configured: true };
}

// Acumula el progreso de un `docker pull` a partir de los eventos JSON que emite
// la API de Docker (`/images/create`). Guarda {current,total} por capa en `state`
// y devuelve el % global de descarga, la fase y un posible error.
//  - state: acumulador { layers: { <id>: { current, total } } } (empezar en { layers: {} }).
//  - event: un objeto JSON ya parseado de la respuesta de Docker.
function accumulatePullProgress(state, event) {
  if (event && event.error) return { pct: 0, phase: 'descarga', error: String(event.error) };
  const status = (event && event.status) || '';
  const phase = /^extract/i.test(status) ? 'extracción' : 'descarga';
  if (/^downloading$/i.test(status) && event.id && event.progressDetail && event.progressDetail.total > 0) {
    state.layers[event.id] = {
      current: event.progressDetail.current || 0,
      total: event.progressDetail.total,
    };
  }
  let sumCurrent = 0, sumTotal = 0;
  for (const id in state.layers) {
    sumCurrent += state.layers[id].current;
    sumTotal += state.layers[id].total;
  }
  let pct = sumTotal > 0 ? Math.floor((100 * sumCurrent) / sumTotal) : 0;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return { pct, phase, error: null };
}

module.exports = {
  N8N_CONTAINER, N8N_VOLUME, N8N_IMAGE, N8N_PORT,
  buildN8nContainerConfig, n8nApi, computeN8nStatus, accumulatePullProgress,
};
