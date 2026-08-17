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
// Etiqueta fija: SIN tag, la Docker API descarga TODAS las etiquetas del
// repositorio (equivale a `docker pull --all-tags`) → decenas de GB. Fijamos
// una etiqueta concreta para bajar una sola imagen.
const N8N_TAG = 'latest';
const N8N_PORT = 5678;
const N8N_MIN_HOST_PORT = 1024;
const N8N_MAX_HOST_PORT = 65535;

// Construye la ruta del pull para la Docker API `/images/create`, SIEMPRE con
// `tag` para no disparar la descarga de todas las etiquetas. Testeable en aislado.
function buildPullPath(image, tag) {
  return `/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`;
}

// URL con la que el BACKEND del panel habla con n8n: siempre por loopback
// (127.0.0.1 + el puerto host publicado del contenedor). No depende de la IP
// pública ni del dominio, así que no falla por hairpin NAT ni por DNS/SSL.
function buildLocalApiBase(hostPort) {
  return `http://127.0.0.1:${hostPort || N8N_PORT}`;
}

function validateN8nInstallOptions({ hostPort, timezone = 'UTC' } = {}) {
  const port = Number(hostPort);
  if (!Number.isInteger(port) || port < N8N_MIN_HOST_PORT || port > N8N_MAX_HOST_PORT) {
    return { ok: false, error: `El puerto debe estar entre ${N8N_MIN_HOST_PORT} y ${N8N_MAX_HOST_PORT}.` };
  }
  if (typeof timezone !== 'string' || timezone.length > 64 || /[\u0000-\u001f\u007f]/.test(timezone)) {
    return { ok: false, error: 'Zona horaria inválida.' };
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch (_) {
    return { ok: false, error: 'Zona horaria inválida.' };
  }
  return { ok: true, hostPort: port, timezone };
}

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
    Image: `${N8N_IMAGE}:${N8N_TAG}`,
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
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 15_000) : null;
  if (controller) opts.signal = controller.signal;
  let res;
  let text;
  try { res = await fetchImpl(url, opts); text = await res.text(); } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('Tiempo de espera agotado al contactar con n8n.');
      timeoutError.code = 'N8N_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
  N8N_CONTAINER, N8N_VOLUME, N8N_IMAGE, N8N_TAG, N8N_PORT, N8N_MIN_HOST_PORT, N8N_MAX_HOST_PORT,
  buildN8nContainerConfig, buildPullPath, buildLocalApiBase, validateN8nInstallOptions,
  n8nApi, computeN8nStatus, accumulatePullProgress,
};
