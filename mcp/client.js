// ============================================================
//  TecXPaneL MCP — cliente HTTPS del panel
//
//  Traduce una llamada (método + ruta [+ cuerpo JSON]) a una petición autenticada
//  con el token de API (`Authorization: Bearer txpl_…`) y devuelve el cuerpo como
//  texto listo para el modelo. Las respuestas en streaming del panel terminan con
//  el centinela `__TXPL_DONE__<código>`: se quita y un código ≠ 0 es un error.
//  Por seguridad:
//   - exige HTTPS (salvo localhost/127.0.0.1 para desarrollo);
//   - no sigue redirecciones (no reenviar el token a otro destino);
//   - los errores llevan mensajes en español y NUNCA incluyen el token ni la URL;
//   - recorta respuestas enormes para no inundar el contexto del modelo.
// ============================================================

export const MAX_CHARS = 20000;
const SUFFIX = '\n…[recortado]';
const TIMEOUT_MS = 30000;
// Las acciones (reiniciar, backups, comandos de hasta 110 s) tardan más que una lectura.
const TIMEOUT_ACCION_MS = 120000;
const CENTINELA = /\n?__TXPL_DONE__(\d+)\s*$/;

// Al agotarse el tiempo el panel NO cancela la operación (y puede seguir con el bloqueo puesto).
const esTimeout = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';
const TIMEOUT_MSG = 'Tiempo de espera agotado: la operación puede seguir ejecutándose en el panel';

const recortar = (text) => (text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + SUFFIX : text);

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
    const lectura = method === 'GET';
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (!lectura) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers,
        body: lectura ? undefined : JSON.stringify(body ?? {}),
        redirect: 'error',
        signal: AbortSignal.timeout(lectura ? TIMEOUT_MS : TIMEOUT_ACCION_MS),
      });
    } catch (e) {
      throw new Error(esTimeout(e) ? TIMEOUT_MSG : 'No se pudo conectar con el panel');
    }

    // Un corte leyendo el cuerpo no debe parecer un éxito vacío.
    let raw;
    try { raw = await res.text(); } catch (e) { throw new Error(esTimeout(e) ? TIMEOUT_MSG : 'No se pudo leer la respuesta del panel'); }
    let data = raw;
    try { data = JSON.parse(raw); } catch { /* texto plano */ }

    if (res.status === 401) throw new Error('Token inválido o caducado');
    if (res.status === 403) throw new Error('El token no tiene permiso para esta operación');
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && data.error) || res.statusText || 'error desconocido';
      throw new Error(`Error ${res.status}: ${msg}`);
    }

    if (typeof data === 'string') {
      const fin = data.match(CENTINELA);
      if (fin) {
        const salida = data.slice(0, fin.index);
        if (fin[1] !== '0') throw new Error(recortar(`La operación terminó con error (código ${fin[1]}):\n${salida}`));
        return recortar(salida);
      }
      return recortar(data);
    }
    return recortar(JSON.stringify(data, null, 2));
  }

  return { call };
}
