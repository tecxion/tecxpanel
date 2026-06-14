'use strict';

const fs = require('fs');
const path = require('path');

const localEnv = path.resolve(__dirname, '../.env');
const envPath = process.env.TXPL_ENV || (fs.existsSync(localEnv) ? localEnv : '/opt/txpl/.env');
require('dotenv').config({ path: envPath });
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { seedAdmin } = require('./database');
const { initEncryption } = require('./lib/crypto');
const { setupWebSockets } = require('./lib/websocket');

// ── Configuración ─────────────────────────────────────────────
const PORT = parseInt(process.env.TXPL_PORT || '8585', 10);
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = process.env.TXPL_TOKEN_TTL || '8h';
const FRONTEND_DIR = process.env.FRONTEND_DIR || path.join(process.env.TXPL_DIR || '/opt/txpl', 'frontend');

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET ausente o demasiado corto (mínimo 32 caracteres). Revisa el .env.');
  process.exit(1);
}

initEncryption(process.env.TXPL_SECRET_KEY || JWT_SECRET);
seedAdmin();

// ── Express ───────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '50mb' }));

const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos de login. Espera unos minutos.' } });
app.use('/api/', apiLimiter);

// ── Auth routes (antes de app.use('/api', auth)) ──────────────
const createAuthRouter = require('./routes/auth');
const { router: authRouter, auth, verifyToken } = createAuthRouter(JWT_SECRET, TOKEN_TTL, loginLimiter);
app.use('/api/auth', authRouter);

// Webhooks público (no requiere token JWT)
app.use('/api/webhooks', require('./routes/webhooks'));

// A partir de aquí, todo /api requiere token.
app.use('/api', auth);

// ── API routes ────────────────────────────────────────────────
app.use('/api/system', require('./routes/system'));
app.use('/api/websites', require('./routes/websites'));
app.use('/api/apps', require('./routes/apps'));
app.use('/api/databases', require('./routes/databases'));
app.use('/api/files', require('./routes/files'));
app.use('/api/firewall', require('./routes/firewall'));
app.use('/api/logs', require('./routes/logs'));
app.use('/api/plugins', require('./routes/plugins'));
app.use('/api/docker', require('./routes/docker'));

// ── Frontend estático ─────────────────────────────────────────
app.use(express.static(FRONTEND_DIR, { maxAge: 0, index: 'index.html', etag: true }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
    return res.status(404).json({ error: 'No encontrado' });
  }
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ── HTTP + WebSockets ─────────────────────────────────────────
const server = http.createServer(app);
setupWebSockets(server, verifyToken);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[txpl] Panel escuchando en http://127.0.0.1:${PORT}`);
});

function shutdown() {
  console.log('[txpl] Apagando...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('message', (m) => { if (m === 'shutdown') shutdown(); });
