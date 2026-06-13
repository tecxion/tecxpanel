# TecXPaneL

Panel de control ligero para VPS (Ubuntu/Debian): sitios web, aplicaciones PM2,
bases de datos, firewall UFW, SSL Let's Encrypt, gestor de archivos, terminal SSH
y estadísticas en tiempo real. Frontend SPA de un solo fichero + backend Node.js.

## Arquitectura

```
/opt/txpl/
├── backend/
│   ├── server.js          # API REST + WebSockets (este repo: server.js)
│   ├── database.js        # capa SQLite (este repo: database.js)
│   ├── package.json
│   └── .env               # secretos (NO en git) — ver .env.example
├── frontend/
│   └── index.html         # SPA (este repo: index.html)
├── data/txpl.db           # base de datos del panel
└── ecosystem.config.js    # configuración PM2
```

Nginx hace de proxy inverso hacia `127.0.0.1:8585` (el backend solo escucha en
localhost). La CLI `txpl` consume la misma API.

## Requisitos

- Node.js ≥ 18, npm
- nginx, PM2 (`npm i -g pm2`)
- Opcional: MySQL/MariaDB, PostgreSQL, certbot, ufw
- Para la terminal interactiva: `node-pty` (dependencia opcional)

## Instalación en un VPS limpio (recomendada)

En un VPS Ubuntu/Debian recién creado, todo el aprovisionamiento se hace con
`txpl-setup.sh`: instala Node, nginx, PM2, UFW y certbot (y opcionalmente
MariaDB/PostgreSQL), genera el `.env` con secretos aleatorios, instala
dependencias y arranca el panel.

```bash
# En el VPS (como root o con sudo):
git clone https://github.com/TU_USUARIO/tecxpanel.git && cd tecxpanel && sudo bash txpl-setup.sh
```

Al terminar imprime la URL del panel y las credenciales generadas (usuario,
contraseña y root de MySQL). El instalador es **idempotente**: puedes volver a
ejecutarlo y conservará el `.env` existente.

Variables opcionales que puedes exportar antes de ejecutarlo:

```bash
export ADMIN_USER=admin
export ADMIN_PASS="tu-contraseña"
export PANEL_DOMAIN=panel.tudominio.com
export INSTALL_MYSQL=1 INSTALL_PG=0
sudo -E bash txpl-setup.sh
```

### Actualizaciones posteriores

```bash
cd tecxpanel && git pull
sudo bash txpl-update.sh        # reload sin downtime con PM2
```

### Instalación manual (alternativa)

```bash
sudo mkdir -p /opt/txpl/backend /opt/txpl/frontend /opt/txpl/data
sudo cp server.js database.js package.json /opt/txpl/backend/
sudo cp index.html /opt/txpl/frontend/
sudo cp ecosystem.config.js /opt/txpl/
sudo cp .env.example /opt/txpl/.env   # rellena JWT_SECRET (openssl rand -hex 32) y ADMIN_PASS
sudo chmod 600 /opt/txpl/.env
cd /opt/txpl/backend && npm install --production
sudo cp txpl-nginx.conf /etc/nginx/sites-available/txpl-panel
sudo ln -sf /etc/nginx/sites-available/txpl-panel /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
pm2 start /opt/txpl/ecosystem.config.js --env production && pm2 save
```

## Seguridad

El backend está construido con la seguridad como requisito de diseño:

- **Autenticación JWT** con expiración (`TXPL_TOKEN_TTL`), verificada también en
  los WebSockets antes de abrir la sesión.
- **Contraseña admin con hash bcrypt** (coste 12). Nunca se guarda en claro.
  Comparación en tiempo constante incluso para usuarios inexistentes.
- **Sin inyección de comandos**: toda llamada al sistema usa `execFile(cmd, [args])`,
  jamás se interpola entrada de usuario en una shell.
- **Listas blancas** para servicios, acciones, tipos y rutas de logs.
- **Jaula de rutas** en el gestor de archivos: toda ruta se resuelve y debe quedar
  dentro de `SITES_DIR`; se bloquea path traversal.
- **Validación por regex** de dominios, nombres de app/BD, puertos e IPs.
- **Rate limiting** (login y API) + cabeceras de seguridad (helmet).
- **Auditoría** de acciones sensibles en la tabla `audit_log`.
- El backend escucha **solo en `127.0.0.1`**: la exposición pública es vía nginx
  con HTTPS (descomenta el bloque SSL en `txpl-nginx.conf` tras instalar certbot).

### Próximos pasos de seguridad recomendados

- Forzar HTTPS + HSTS en nginx (bloque comentado en `txpl-nginx.conf`).
- 2FA (TOTP) en el login — la tabla `users` ya reserva `totp_secret`.
- Cifrar en reposo las contraseñas de BD almacenadas (hoy se guardan para poder
  mostrarlas; valora un secreto maestro o KMS).
- Escapado de HTML en el frontend (los datos se insertan con `innerHTML`).

## Variables de entorno

Ver [`.env.example`](.env.example). Las imprescindibles: `JWT_SECRET` (≥32 chars),
`ADMIN_PASS`, y `MYSQL_ROOT_PASSWORD` si vas a crear bases de datos MySQL.
