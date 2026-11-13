// ============================================================
//  TecXPaneL MCP — cliente HTTPS del panel
//
//  Traduce una llamada (método + ruta) a una petición autenticada con el
//  token de API (`Authorization: Bearer txpl_…`) y devuelve el cuerpo como
//  texto listo para el modelo. Por seguridad:
//   - exige HTTPS (salvo localhost/127.0.0.1 para desarrollo);
//   - no sigue redirecciones (no reenviar el token a otro destino);
//   - los errores llevan mensajes en español y NUNCA incluyen el token ni la URL;
//   - recorta respuestas enormes para no inundar el contexto del modelo.
// ============================================================

export const MAX_CHARS = 20000;
const SUFFIX = '\n…[recortado]';
const TIMEOUT_GET_MS = 30000;
// Las acciones (backup, renovar SSL, comandos de hasta 110 s) tardan más que una lectura.
const TIMEOUT_WRITE_MS = 120000;
// Los endpoints en streaming terminan con "\n__TXPL_DONE__<código>" (0 = éxito).
const DONE_RE = /\n?__TXPL_DONE__(\d+)\s*$/;

// Recorta a MAX_CHARS conservando el principio (lo usa quien da forma final a la respuesta).
export const recortar = (t) => (t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + SUFFIX : t);
const DETALLE_ERROR = 2000; // de un stream fallido se muestra la COLA: la causa suele estar al final
const esTimeout = (e) => e?.name === 'TimeoutError';
const MSG_TIMEOUT = 'Tiempo de espera agotado: la operación puede seguir en curso en el panel (compruébalo con listar_backups)';

const esLocal = (url) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url);

export function createClient({ url, token, fetchImpl = fetch }) {
  // Los mensajes no repiten url ni token: podrían contener credenciales.
  if (typeof url !== 'string' || !(url.startsWith('https://') || esLocal(url))) {
    throw new Error('TXPL_URL debe empezar por https:// (o ser http://localhost)');
  }
  if (typeof token !== 'string' || !token.startsWith('txpl_')) {
    throw new Error('TXPL_TOKEN debe ser un token de API del panel (empieza por txpl_)');
  }
  const base = url.replace(/\/+$/, '');

  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(method === 'GET' ? TIMEOUT_GET_MS : TIMEOUT_WRITE_MS),
      });
    } catch (e) {
      throw new Error(esTimeout(e) ? MSG_TIMEOUT : 'No se pudo conectar con el panel');
    }

    // Un corte leyendo el cuerpo no debe parecer un éxito vacío.
    let raw;
    try { raw = await res.text(); } catch (e) { throw new Error(esTimeout(e) ? MSG_TIMEOUT : 'No se pudo leer la respuesta del panel'); }
    let data = raw;
    try { data = JSON.parse(raw); } catch { /* texto plano */ }

    if (res.status === 401) throw new Error('Token inválido o caducado');
    if (res.status === 403) throw new Error('El token no tiene permiso para esta operación');
    if (!res.ok) {
      const apiError = data && typeof data === 'object' && data.error;
      // Gateway sin cuerpo JSON del panel (proxy caído o lento): mensaje claro.
      if (!apiError && [502, 503, 504].includes(res.status)) throw new Error('El panel no respondió a tiempo');
      throw new Error(`Error ${res.status}: ${apiError || res.statusText || 'error desconocido'}`);
    }

    // JSON correcto: se devuelve entero; quien lo formatea (tools.js) decide cómo recortarlo.
    if (typeof data !== 'string') return JSON.stringify(data, null, 2);

    // Respuesta en streaming: quita el centinela y, si el código != 0, falla con el final del texto.
    const done = DONE_RE.exec(data);
    if (done) {
      const text = data.slice(0, done.index);
      if (done[1] !== '0') throw new Error(`La operación terminó con error:\n${text.slice(-DETALLE_ERROR)}`);
      return recortar(text);
    }
    // Un POST en text/plain es un stream: sin centinela no sabemos si terminó bien (corte a medias).
    if (method !== 'GET' && /text\/plain/.test(res.headers?.get?.('content-type') || '')) {
      throw new Error('La operación terminó sin confirmación');
    }
    return recortar(data);
  }

  return { call };
}
