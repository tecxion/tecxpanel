// ============================================================
//  TecXPaneL — PM2 Ecosystem Config
//  /opt/txpl/ecosystem.config.js
//  Uso: pm2 start ecosystem.config.js
// ============================================================

// NOTA: NO usamos require('dotenv') aquí. PM2 evalúa este fichero desde
// /opt/txpl y no resolvería el módulo (vive en backend/node_modules).
// server.js carga /opt/txpl/.env por su cuenta; aquí solo fijamos NODE_ENV.

module.exports = {
  apps: [
    // ── Panel principal TXPL ─────────────────────────────────
    {
      name: 'txpl-panel',
      script: '/opt/txpl/backend/server.js',
      cwd: '/opt/txpl/backend',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',

      env: {
        NODE_ENV: 'production',
      },

      // Logs
      log_file: '/var/log/txpl/panel-combined.log',
      out_file: '/var/log/txpl/panel-out.log',
      error_file: '/var/log/txpl/panel-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // Restart
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '10s',

      // Señales de apagado limpio
      kill_timeout: 5000,
      listen_timeout: 8000,
      shutdown_with_message: true,
    }
  ],

  // ── Deploy config (opcional, para deploy desde otro servidor) ──
  deploy: {
    production: {
      user: 'root',
      host: process.env.VPS_IP || 'TU_IP_VPS',
      ref: 'origin/main',
      repo: 'git@github.com:TU_USUARIO/txpl.git',
      path: '/opt/txpl',
      'pre-deploy-local': '',
      'post-deploy': 'cd /opt/txpl/backend && npm install && pm2 reload ecosystem.config.js --env production',
      'pre-setup': 'apt-get install -y git'
    }
  }
};
