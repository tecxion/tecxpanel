# TecXPaneL MCP (solo lectura)

Servidor [MCP](https://modelcontextprotocol.io) que permite a una IA (Claude Desktop, Claude Code…) **consultar** el estado de tu VPS a través de la API de TecXPaneL.

## Qué es y cómo funciona

- Es un paquete **aparte** del panel (ESM, con sus propias dependencias). **No se despliega en el VPS**: corre en **tu ordenador**.
- El cliente MCP lo lanza como un proceso y habla con él por stdin/stdout. Cada herramienta se traduce en una petición `GET` por HTTPS al panel, autenticada con un **token de API** (`Authorization: Bearer txpl_…`).
- El token solo puede llamar a las rutas de una lista blanca del panel (ver "Seguridad y límites").
- En esta versión el servidor MCP es **de solo lectura**. Las acciones de escritura son una fase futura (sin fecha prevista).

## Puesta en marcha

1. **Crea un token** en el panel: **Ajustes → Tokens de API (IA / MCP)**. Pon un nombre, elige la caducidad (30, 90 o 365 días) e introduce tu contraseña actual. El token (`txpl_…`) se muestra **una sola vez**: cópialo.
2. **Instala las dependencias** (Node.js 18 o superior):

   ```bash
   cd mcp && npm install
   ```

3. **Configura el cliente por consola (recomendado).** Sin editar ningún JSON a mano:

   ```bash
   cd mcp && npm run setup                      # Claude Desktop (pregunta la URL y el token)
   npm run setup -- --code                      # Claude Code
   npm run setup -- --both --url https://panel.tudominio.com
   ```

   Comprueba que el panel acepta el token (`--no-check` lo omite), escribe la configuración de Claude Desktop con copia de seguridad (`.bak`) y sin pisar tus otros servidores MCP, y usa rutas absolutas. El token se pide sin mostrarse en pantalla.

   **Configuración manual (alternativa).**

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

Variables de entorno: `TXPL_URL` (dirección del panel) y `TXPL_TOKEN` (el token de API).

## Herramientas (13)

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

## Seguridad y límites

- **Solo rutas de la lista blanca.** El token únicamente permite las 13 rutas de arriba. **No** puede leer contraseñas, variables de entorno de apps, volcados de BD, backups descargables ni archivos; **no** abre la terminal y **no** borra nada. Un token inválido o caducado responde 401; un token válido en una ruta fuera de la lista responde 403 y queda en el registro de auditoría.
- **Caduca** (30, 90 o 365 días, según elijas al crearlo).
- **Se revoca** en cualquier momento desde **Ajustes → Tokens de API**.
- **HTTPS obligatorio.** El MCP exige `https://`, salvo `http://localhost` o `http://127.0.0.1`. Si tu panel se sirve por `http://` con una IP, el MCP lo rechazará: ponlo detrás de HTTPS o usa un túnel SSH a localhost (`ssh -L 8585:localhost:8585 usuario@tu-vps` y `TXPL_URL=http://localhost:8585`).
- **No sigue redirecciones**, para no reenviar el token a otro destino.
- **Los logs son texto no fiable.** Lo que lee la IA en los logs (de apps, contenedores y errores) puede contener secretos que impriman tus apps y texto malicioso que intente darle instrucciones. Revisa qué imprimen tus apps.
- `listar_contenedores` devuelve las etiquetas completas de Docker; evita guardar secretos en labels.
- Las respuestas muy largas se recortan (20 000 caracteres).
- **Trata el token como una credencial:** una IA con este token puede ver el estado de tu servidor. No lo subas a repositorios ni lo compartas.

## Tests

```bash
cd mcp && npm test
```

Estos tests no forman parte de `npm test` de la raíz del panel.
