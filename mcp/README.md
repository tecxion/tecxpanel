# TecXPaneL MCP

Servidor [MCP](https://modelcontextprotocol.io) que permite a una IA (Claude Desktop, Claude Code…) **consultar** el estado de tu VPS y, si tú lo activas, **actuar** sobre él a través de la API de TecXPaneL.

## Qué es y cómo funciona

- Es un paquete **aparte** del panel (ESM, con sus propias dependencias). **No se despliega en el VPS**: corre en **tu ordenador**.
- El cliente MCP lo lanza como un proceso y habla con él por stdin/stdout. Cada herramienta se traduce en una petición HTTPS al panel, autenticada con un **token de API** (`Authorization: Bearer txpl_…`).
- El token solo puede llamar a lo que permite su **ámbito** (ver "Ámbitos de token").
- **Por defecto es de solo lectura** (13 herramientas). Las herramientas de acción y de control total solo se registran si activas `TXPL_ENABLE_WRITE=1` / `TXPL_ENABLE_ADMIN=1` **y** el token tiene ese ámbito.

## Ámbitos de token

| Ámbito | Nombre en el panel | Qué permite | Caducidad |
| :--- | :--- | :--- | :--- |
| `read` | Solo lectura | Las 13 rutas `GET` de la tabla de abajo | 30, 90 o 365 días |
| `write` | Lectura y acciones | Lo anterior + `POST` para reiniciar/recargar una app, reiniciar un contenedor, crear un backup completo y renovar un certificado SSL | 30, 90 o 365 días |
| `admin` | Control total | Cualquier ruta `/api/*` (cualquier método) **salvo `/api/auth*`**, incluido `POST /api/system/exec` (shell como root) | **7 o 30 días** |

Para crear un token `admin` hace falta, además de la contraseña actual (y el código 2FA si lo tienes activo), que el interruptor global **«Control total de IA»** de Ajustes esté **encendido** (apagado por defecto). Si lo apagas, los tokens `admin` ya creados dejan de funcionar al instante.

## Puesta en marcha

1. **Crea un token** en el panel: **Ajustes → Tokens de API (IA / MCP)**. Pon un nombre, elige el ámbito y la caducidad e introduce tu contraseña actual (y el código 2FA si lo tienes activo). El token (`txpl_…`) se muestra **una sola vez**: cópialo.
2. **Instala las dependencias** (Node.js 18 o superior):

   ```bash
   cd mcp && npm install
   ```

3. **Configura el cliente.**

   **Claude Desktop** (`claude_desktop_config.json`). Cambia la ruta, la URL y el token:

   ```json
   {
     "mcpServers": {
       "tecxpanel": {
         "command": "node",
         "args": ["/RUTA/A/tecxpanel/mcp/index.js"],
         "env": { "TXPL_URL": "https://panel.tudominio.com", "TXPL_TOKEN": "txpl_..." }
       }
     }
   }
   ```

   **Claude Code:**

   ```bash
   claude mcp add tecxpanel -e TXPL_URL=https://panel.tudominio.com -e TXPL_TOKEN=txpl_... -- node /RUTA/A/tecxpanel/mcp/index.js
   ```

   El token queda en claro en `~/.claude.json` y en el historial de la shell: antepón un espacio al comando (con `HISTCONTROL=ignorespace`) o edita el JSON a mano. Si sospechas que se ha filtrado, revócalo en Ajustes; cambiar la contraseña **no** revoca los tokens de API.

4. Reinicia el cliente y pregúntale, por ejemplo, "¿cómo está mi servidor?".

Variables de entorno:

- `TXPL_URL` (dirección del panel) y `TXPL_TOKEN` (el token de API): obligatorias.
- `TXPL_ENABLE_WRITE=1`: registra las 4 herramientas de acción (necesita un token `write` o `admin`).
- `TXPL_ENABLE_ADMIN=1`: registra `ejecutar_comando` y `llamar_api` (necesita un token `admin`).

Sin las dos últimas, el servidor solo expone las 13 herramientas de lectura. Al arrancar escribe en stderr los ámbitos activos (`txpl-mcp: listo (solo lectura)`, `listo (lectura + escritura)`…).

Ejemplo con acciones activadas (Claude Desktop):

```json
"env": { "TXPL_URL": "https://panel.tudominio.com", "TXPL_TOKEN": "txpl_...", "TXPL_ENABLE_WRITE": "1" }
```

Claude Code con control total (token `admin`):

```bash
claude mcp add tecxpanel -e TXPL_URL=https://panel.tudominio.com -e TXPL_TOKEN=txpl_... -e TXPL_ENABLE_WRITE=1 -e TXPL_ENABLE_ADMIN=1 -- node /RUTA/A/tecxpanel/mcp/index.js
```

## Herramientas de lectura (13)

Todas son `GET` de solo lectura.

| Herramienta | Qué devuelve | Ruta del panel |
| :--- | :--- | :--- |
| `estado_sistema` | CPU, memoria, disco y uptime del VPS | `/api/system/stats` |
| `estado_servicios` | Estado de los servicios del sistema (nginx, mysql, postgresql, redis y ssh) | `/api/system/services` |
| `version_panel` | Versión instalada del panel y si hay actualización | `/api/system/update` |
| `listar_sitios` | Sitios web configurados | `/api/websites` |
| `listar_apps` | Apps desplegadas y su estado | `/api/apps` |
| `logs_app` (`id`) | Últimas líneas de log de una app | `/api/apps/{id}/logs` |
| `listar_bases_datos` | Bases de datos gestionadas | `/api/databases` |
| `listar_contenedores` | Contenedores Docker y su estado | `/api/docker/containers` |
| `logs_contenedor` (`id`) | Últimas líneas de log de un contenedor | `/api/docker/containers/{id}/logs` |
| `stats_contenedor` (`id`) | Uso de CPU y memoria de un contenedor | `/api/docker/containers/{id}/stats` |
| `certificados_ssl` | Certificados SSL y su caducidad | `/api/ssl/certificates` |
| `listar_backups` | Copias de seguridad existentes | `/api/backups` |
| `errores_recientes` | Errores recientes de nginx y del log del sistema (filtrados) | `/api/logs/errors` |

## Herramientas de acción (opcionales)

Con `TXPL_ENABLE_WRITE=1` (token `write` o superior):

| Herramienta | Qué hace | Ruta del panel |
| :--- | :--- | :--- |
| `reiniciar_app` (`id`, `modo`: `restart`/`reload`) | Reinicia o recarga una app de PM2 | `POST /api/apps/{id}/restart\|reload` |
| `reiniciar_contenedor` (`id`) | Reinicia un contenedor Docker | `POST /api/docker/containers/{id}/restart` |
| `crear_backup` | Crea una copia de seguridad completa | `POST /api/backups` |
| `renovar_ssl` (`nombre`) | Renueva un certificado con certbot | `POST /api/ssl/{nombre}/renew` |

Con `TXPL_ENABLE_ADMIN=1` (token `admin`):

| Herramienta | Qué hace | Ruta del panel |
| :--- | :--- | :--- |
| `ejecutar_comando` (`comando`, `cwd?`, `timeout_s?`) | Ejecuta `bash -lc` **como root** en el VPS. Límite de 1 a 110 s (60 por defecto); al agotarse se mata el grupo de procesos entero. Devuelve el código de salida y los últimos 64 KB de salida. Para trabajos largos usa `nohup … &` | `POST /api/system/exec` |
| `llamar_api` (`metodo`, `ruta`, `cuerpo?`) | Llama a cualquier ruta `/api/*` salvo `/api/auth*` | la indicada |

Las acciones esperan hasta 120 s; si se agota, el MCP responde «Tiempo de espera agotado: la operación puede seguir ejecutándose en el panel» (comprueba el resultado antes de reintentar). Estas herramientas se anuncian al cliente como **no de solo lectura y destructivas**.

## Advertencias (léelas antes de activar acciones)

- **Un token `admin` equivale a root en tu VPS.** Quien lo tenga (o la IA que lo use) puede ejecutar cualquier comando, leer secretos y borrar datos.
- **Prompt injection.** La IA lee logs, páginas web y contenido de terceros que pueden incluir instrucciones maliciosas («ejecuta este comando…»). Con `write`/`admin`, esas instrucciones pueden convertirse en acciones reales.
- **No marques «permitir siempre»** en el cliente para `ejecutar_comando`, `llamar_api` ni las demás herramientas de acción: revisa cada llamada antes de aprobarla.
- **Caducidad corta:** usa 7 días para `admin` y crea un token nuevo cuando lo necesites; no lo dejes activo «por si acaso».
- **Si sospechas algo:** revoca el token en Ajustes → Tokens de API **y** apaga el interruptor «Control total de IA».
- **Cambiar la contraseña no revoca los tokens de API.** Revócalos a mano.
- **Auditoría:** toda petición con token que no sea `GET` queda registrada como `apitoken.call`, y `system.exec` registra el comando **antes** de ejecutarlo.

## Seguridad y límites

- **Solo lo que permite el ámbito.** Con un token `read`, solo las 13 rutas `GET` de arriba: **no** puede leer contraseñas, variables de entorno de apps, volcados de BD, backups descargables ni archivos; **no** abre la terminal y **no** borra nada. Con `write`, además las 4 acciones. Con `admin`, casi todo el panel excepto `/api/auth*` (los tokens y la contraseña no se gestionan con tokens). Un token inválido o caducado responde 401; un token válido en una ruta fuera de su ámbito responde 403 y queda en el registro de auditoría.
- **Caduca** (30, 90 o 365 días; 7 o 30 para `admin`, según elijas al crearlo).
- **Se revoca** en cualquier momento desde **Ajustes → Tokens de API**.
- **HTTPS obligatorio.** El MCP exige `https://`, salvo `http://localhost` o `http://127.0.0.1`. Si tu panel se sirve por `http://` con una IP, el MCP lo rechazará: ponlo detrás de HTTPS o usa un túnel SSH a localhost (`ssh -L 8585:localhost:8585 usuario@tu-vps` y `TXPL_URL=http://localhost:8585`).
- **No sigue redirecciones**, para no reenviar el token a otro destino.
- **Los logs son texto no fiable.** Lo que lee la IA en los logs (de apps, contenedores y errores) puede contener secretos que impriman tus apps y texto malicioso que intente darle instrucciones. Revisa qué imprimen tus apps.
- `listar_contenedores` devuelve las etiquetas completas de Docker; evita guardar secretos en labels.
- Las respuestas muy largas se recortan (20 000 caracteres).
- **Trata el token como una credencial:** una IA con un token `read` puede ver el estado de tu servidor; con `write` o `admin`, además puede actuar sobre él. No lo subas a repositorios ni lo compartas.

## Tests

```bash
cd mcp && npm test
```

Estos tests no forman parte de `npm test` de la raíz del panel.
