'use strict';

// ============================================================
//  TecXPaneL — Punto de entrada del servidor
//
//  Este archivo arranca TODO el backend:
//   1) Carga la configuración (.env).
//   2) Prepara la base de datos y el cifrado.
//   3) Monta la API REST (Express) y sus rutas.
//   4) Sirve el frontend (los archivos estáticos del panel).
//   5) Levanta los WebSockets (stats en vivo y terminal).
//  Es lo primero que se ejecuta con `node server.js` o vía PM2.
// ============================================================

const fs = require('fs');
const path = require('path');

// Buscamos el archivo .env: primero la variable TXPL_ENV, luego un .env local
// (útil en desarrollo), y si no, el de producción en /opt/txpl/.env.
const localEnv = path.resolve(__dirname, '../.env');
const envPath = process.env.TXPL_ENV || (fs.existsSync(localEnv) ? localEnv : '/opt/txpl/.env');
require('dotenv').config({ path: envPath });

const http = require('http');
const express = require('express');
const helmet = require('helmet');           // cabeceras de seguridad HTTP
const rateLimit = require('express-rate-limit'); // límite de peticiones por IP

const { seedAdmin } = require('./database');
const { initEncryption } = require('./lib/crypto');
const { setupWebSockets } = require('./lib/websocket');

// ── Configuración (leída del .env) ────────────────────────────
const PORT = parseInt(process.env.TXPL_PORT || '8585', 10);
const JWT_SECRET = process.env.JWT_SECRET;            // clave para firmar los tokens
const TOKEN_TTL = process.env.TXPL_TOKEN_TTL || '8h'; // duración de la sesión
const FRONTEND_DIR = path.resolve(process.env.FRONTEND_DIR || path.join(process.env.TXPL_DIR || '/opt/txpl', 'frontend'));

// Sin un JWT_SECRET fuerte no arrancamos: firmaría tokens fáciles de falsificar.
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET ausente o demasiado corto (mínimo 32 caracteres). Revisa el .env.');
  process.exit(1);
}

// Preparamos el cifrado de secretos y creamos el usuario admin si no existe.
initEncryption(process.env.TXPL_SECRET_KEY || JWT_SECRET);
seedAdmin();

// ── Express (el servidor web/API) ─────────────────────────────
const app = express();
app.set('trust proxy', 1);          // confiamos en el proxy nginx que tenemos delante
app.disable('x-powered-by');        // ocultamos que usamos Express (menos pistas a atacantes)
app.use(helmet({ contentSecurityPolicy: false })); // cabeceras de seguridad
app.use(express.json({ limit: '50mb' }));           // parsea cuerpos JSON (hasta 50 MB)

// Límite de peticiones: 120/min en toda la API, y un límite más estricto en el login.
const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos de login. Espera unos minutos.' } });
app.use('/api/', apiLimiter);

// ── Rutas de autenticación ────────────────────────────────────
// El router de auth es una "fábrica": le pasamos el secreto JWT y nos devuelve
// el router, el middleware `auth` (exige token) y `verifyToken`.
const createAuthRouter = require('./routes/auth');
const { router: authRouter, auth, verifyToken } = createAuthRouter(JWT_SECRET, TOKEN_TTL, loginLimiter);
app.use('/api/auth', authRouter);

// Webhooks de auto-despliegue: son PÚBLICOS (no exigen token JWT) porque los
// llama GitHub/GitLab; se protegen con un secreto único por app en la URL.
app.use('/api/webhooks', require('./routes/webhooks'));

// A partir de aquí, TODO lo que cuelga de /api exige un token válido.
app.use('/api', auth);

// ── Rutas de la API (una por dominio funcional) ───────────────
app.use('/api/system', require('./routes/system'));
app.use('/api/websites', require('./routes/websites'));
app.use('/api/apps', require('./routes/apps'));
app.use('/api/databases', require('./routes/databases'));
app.use('/api/files', require('./routes/files'));
app.use('/api/firewall', require('./routes/firewall'));
app.use('/api/logs', require('./routes/logs'));
app.use('/api/plugins', require('./routes/plugins'));
app.use('/api/docker', require('./routes/docker'));
app.use('/api/n8n', require('./routes/n8n'));
app.use('/api/backups', require('./routes/backups'));
app.use('/api/cron', require('./routes/cron'));
app.use('/api/mail', require('./routes/mail'));
app.use('/api/dns', require('./routes/dns'));
app.use('/api/notifications', require('./routes/notifications'));

// ── Frontend estático ─────────────────────────────────────────
// Servimos los archivos del panel (HTML, JS, CSS).
app.use(express.static(FRONTEND_DIR, { maxAge: 0, index: 'index.html', etag: true }));
// Cualquier otra ruta que NO sea /api ni /ws devuelve el index.html (SPA):
// así el enrutado del lado del cliente funciona al recargar la página.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
    return res.status(404).json({ error: 'No encontrado' });
  }
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ── Servidor HTTP + WebSockets ────────────────────────────────
// Creamos el servidor HTTP a mano para poder añadirle los WebSockets encima.
const server = http.createServer(app);
setupWebSockets(server, verifyToken);

// Monitor de notificaciones (disco/servicios/contenedores, cada 60 s).
// Sin config guardada no hace nada; ver lib/monitor.js.
const { startMonitor } = require('./lib/monitor');
startMonitor();

// Escuchamos SOLO en 127.0.0.1: el panel no se expone directo a internet,
// nginx hace de proxy hacia aquí (más seguro).
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[txpl] Panel escuchando en http://127.0.0.1:${PORT}`);
});

// Apagado limpio: cuando el sistema (o PM2) pide parar, cerramos el servidor
// con cuidado y, si tarda demasiado, salimos a la fuerza tras 4 s.
function shutdown() {
  console.log('[txpl] Apagando...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('message', (m) => { if (m === 'shutdown') shutdown(); });
