// ============================================================
//  TecXPaneL — PM2 Ecosystem Config
//  /opt/txpl/ecosystem.config.js
//  Uso: pm2 start ecosystem.config.js
// ============================================================

require('dotenv').config({ path: '/opt/txpl/.env' });

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
        TXPL_PORT: process.env.TXPL_PORT || 8585,
        TXPL_DIR: '/opt/txpl',
        JWT_SECRET: process.env.JWT_SECRET,
        ADMIN_USER: process.env.ADMIN_USER || 'admin',
        ADMIN_PASS: process.env.ADMIN_PASS,
        MYSQL_ROOT_PASSWORD: process.env.MYSQL_ROOT_PASSWORD,
        PG_PASSWORD: process.env.PG_PASSWORD,
        SITES_DIR: process.env.SITES_DIR || '/var/www',
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
