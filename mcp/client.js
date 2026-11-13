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
const TIMEOUT_MS = 30000;

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

  async function call(method, path) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error('No se pudo conectar con el panel');
    }

    // Un corte leyendo el cuerpo no debe parecer un éxito vacío.
    let raw;
    try { raw = await res.text(); } catch { throw new Error('No se pudo leer la respuesta del panel'); }
    let data = raw;
    try { data = JSON.parse(raw); } catch { /* texto plano */ }

    if (res.status === 401) throw new Error('Token inválido o caducado');
    if (res.status === 403) throw new Error('El token no tiene permiso para esta operación');
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && data.error) || res.statusText || 'error desconocido';
      throw new Error(`Error ${res.status}: ${msg}`);
    }

    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + SUFFIX : text;
  }

  return { call };
}
