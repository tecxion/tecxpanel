# Diseño: DNS (PowerDNS autoritativo) — Fase 1

Fecha: 2026-07-07
Estado: aprobado (pendiente de plan de implementación)

## Objetivo

Añadir un módulo de **DNS autoritativo** al panel, estilo Hostinger/Plesk: el
VPS se convierte en servidor DNS de los dominios del operador. Motor:
**PowerDNS Authoritative Server** instalado de forma **nativa (apt)** con backend
SQLite y su API HTTP activada. El panel gestiona nameservers, zonas y registros
desde su propia UI, hablando con la API de PowerDNS por loopback.

## Decisiones tomadas

- **Motor: PowerDNS nativo por apt** (`pdns-server` + `pdns-backend-sqlite3`), NO
  contenedor Docker. Razón: el puerto 53 se controla limpiamente de forma nativa
  (`local-address` a la IP pública, evitando el choque con `systemd-resolved`), y
  el DNS es infraestructura core que conviene como servicio systemd de primera
  clase. La API HTTP es idéntica sea cual sea el motor.
- **PowerDNS local/autoritativo** (modelo Hostinger/Plesk), NO integración con
  Cloudflare. El VPS aloja las zonas; el operador delega sus dominios a él.
- **Multi-dominio**: un operador gestiona varias zonas desde un mismo par de NS.
- **Nameservers NO hardcodeados**: se piden al configurar el módulo (coherente con
  "repo público, cada operador su VPS/dominio").
- **Dos nameservers, misma IP**: `ns1`/`ns2` ambos apuntando a la IP de este VPS
  (cumple los registradores que piden 2 NS; sin redundancia real, aceptable para
  un solo VPS). IP autodetectada y editable.
- **API key generada por instalación y cifrada en reposo** (patrón `n8n_config`),
  nunca hardcodeada.
- **PowerDNS es la fuente de la verdad** de zonas/registros; el panel las lee/
  escribe en vivo por la API. La DB del panel solo guarda la config (api key, NS,
  IP).

Fuera de alcance (Fase 2): DNSSEC, creación automática del registro A al crear un
sitio web, reto DNS-01 para certificados wildcard, y soporte de dos IPs para
redundancia real de NS.

## Arquitectura (3 capas, patrón n8n/mail)

- `backend/lib/dns.js` — **helpers puros y testeables** (sin estado ni DB):
  - `isValidDnsDomain(d)` — dominio válido (reutiliza el patrón de validators).
  - `isValidRecord(type, value)` — validación por tipo: `A` (IPv4), `AAAA`
    (IPv6), `CNAME` (hostname), `MX` (prioridad numérica + hostname), `TXT`
    (cadena no vacía sin saltos de línea).
  - `SUPPORTED_TYPES = ['A','AAAA','CNAME','MX','TXT']`.
  - `buildZonePayload({ domain, ns1, ns2, serverIp })` — cuerpo para crear la zona
    en la API de PowerDNS: `name` (FQDN con punto final), `kind: 'Native'`,
    `nameservers`, y los rrsets iniciales (SOA + NS con `ns1`/`ns2`).
  - `buildRrsetPatch({ domain, name, type, records, ttl, changetype })` — cuerpo
    PATCH `{ rrsets: [...] }` para crear/reemplazar (`REPLACE`) o borrar
    (`DELETE`) un rrset. Normaliza nombres a FQDN con punto final.
  - `buildGlueRecords({ ns1, ns2, serverIp }) → object[]` — los registros que el
    operador debe crear en su registrador (glue: `ns1 → IP`, `ns2 → IP`).
  - `parseZones(apiJson)` / `parseRecords(apiZoneJson)` — normalizan las
    respuestas de la API a estructuras simples para la UI.
  - `canonical(name)` — asegura el punto final (FQDN) de un nombre.
- `backend/routes/dns.js` — router `/api/dns` (JWT):
  - `GET /status` — estado (not_installed / needs_config / ready).
  - `POST /install` (streaming) — apt install + genera api-key + escribe pdns.conf
    + inicializa el esquema SQLite + abre UFW 53 + arranca el servicio.
  - `POST /config` — guarda `ns1`, `ns2`, `server_ip`.
  - `GET /zones`, `POST /zones` (crea zona con SOA+NS), `DELETE /zones/:zone`.
  - `GET /zones/:zone/records`, `POST /zones/:zone/records`,
    `DELETE /zones/:zone/records` (vía PATCH de rrset).
  - `GET /zones/:zone/delegation` — glue records + verificación de la delegación
    (consulta el DNS público para ver si los NS del dominio ya apuntan aquí).
  - Helper interno `pdnsApi(method, path, body)` — cliente HTTP a
    `http://127.0.0.1:8081/api/v1/...` con cabecera `X-API-Key` (key descifrada),
    por loopback (patrón n8n).
- `backend/database.js` — tabla `dns_config` (fila única, id=1): `api_key_enc`,
  `ns1`, `ns2`, `server_ip`, `status`, `created_at`.

## Instalación (nativa, streaming)

`POST /install` (streaming con centinela `__TXPL_DONE__`):

1. `apt-get install -y pdns-server pdns-backend-sqlite3`.
2. Genera un `api-key` fresco (`openssl rand -hex 32`) — NUNCA hardcodeado.
3. Inicializa el esquema SQLite del backend (desde el `.sql` que trae el paquete,
   p. ej. `/usr/share/pdns-backend-sqlite3/schema/schema.sqlite3.sql` o la ruta
   equivalente del paquete) en un fichero de DB dedicado (ej.
   `/var/lib/powerdns/pdns.sqlite3`).
4. Escribe la config de PowerDNS (backend `gsqlite3`, `api=yes`,
   `webserver=yes`, `webserver-address=127.0.0.1`, `webserver-port=8081`,
   `api-key=<key>`, y **`local-address=<IP pública>`** para bindear el puerto 53
   sin chocar con el stub de `systemd-resolved` en 127.0.0.53).
5. Abre **UFW 53** (TCP y UDP).
6. Arranca/reinicia el servicio (`systemctl restart pdns`).
7. Guarda el `api-key` **cifrado** (`encryptSecret`) en `dns_config` con estado
   `needs_config`.

## Nameservers y zonas

- **Configurar** (`POST /config`): valida y guarda `ns1`, `ns2` (dominios
  válidos) y `server_ip` (IPv4; autodetectada en la UI, editable). Estado → `ready`.
- **Añadir dominio** (`POST /zones`): valida el dominio y crea la zona en PowerDNS
  con `buildZonePayload` (SOA + NS con `ns1`/`ns2`). Listar (`GET /zones`) y borrar
  (`DELETE /zones/:zone`).

## Registros

CRUD de registros (**A, AAAA, CNAME, MX, TXT**) dentro de una zona, vía la API de
PowerDNS (PATCH de rrsets con `buildRrsetPatch`). Cada registro se valida por tipo
(`isValidRecord`) antes de enviarse. Para MX se acepta prioridad + host.

## Delegación

`GET /zones/:zone/delegation` devuelve:

- Los **glue records** a crear en el registrador (`buildGlueRecords`): `ns1 → IP`,
  `ns2 → IP`.
- La instrucción de cambiar los **NS del dominio** a `ns1`/`ns2` en el registrador.
- Una **verificación**: el panel consulta el DNS público (ej. `dig NS <dominio>` o
  resolución equivalente) y reporta si los NS del dominio ya apuntan a los del
  operador. Best-effort e informativo.

Límite honesto (a documentar): crear los glue records y cambiar los NS en el
**registrador** siempre lo hace el humano; ningún panel puede automatizarlo porque
el acceso al registrador es externo al VPS.

## Frontend

Nuevo item **"DNS"** en el sidebar → `frontend/views/pages/dns.html` (cargada por
`loadTemplates`), lógica en `frontend/js/app.js`:

- Vista adaptativa por estado (no instalado → instalar; instalado sin config →
  formulario de nameservers + IP; ready → gestión).
- En ready: lista de **zonas** (añadir/borrar), y por zona la gestión de
  **registros** (tabla + alta por tipo/nombre/valor/TTL + borrado) y una tarjeta de
  **delegación** (glue records + botón de verificar).
- Consola de streaming para la instalación.
- Todo dato externo (dominios, valores de registro) se escapa con `esc()`.

## Seguridad

- **API key** generada por instalación (`openssl rand`) y **cifrada en reposo**
  (`encryptSecret`/`decryptSecret`); el backend habla con PowerDNS por loopback.
- **Zero shell interpolation**: instalación y comandos vía `execFile` con arrays;
  la config de PowerDNS se escribe a fichero, no se interpola en una shell.
- **Validación estricta** de dominios y de cada registro por tipo antes de tocar la
  API.
- **Auditoría** (`audit`) en instalar, configurar, crear/borrar zona y crear/borrar
  registro.
- **UFW**: solo el puerto 53 (TCP+UDP) se abre, explícitamente en la instalación.
- Sin secretos hardcodeados (repo público).

## Pruebas

Tests unitarios de `backend/lib/dns.js` con `node:test`:

- `isValidRecord` por tipo: A (acepta IPv4, rechaza basura), AAAA (IPv6), CNAME
  (hostname), MX (prioridad + host; rechaza sin prioridad), TXT (no vacío, sin
  saltos de línea).
- `buildZonePayload`: FQDN con punto final, kind Native, SOA presente, NS con
  `ns1`/`ns2`.
- `buildRrsetPatch`: estructura `{ rrsets: [...] }` con `name` canónico (punto
  final), `changetype` REPLACE/DELETE, `records` con `content` y `ttl`.
- `buildGlueRecords`: dos registros A (`ns1`/`ns2` → IP).
- `canonical`: añade el punto final si falta, lo respeta si ya está.

## Notas honestas (a documentar)

- Convertir el VPS en DNS autoritativo requiere que el operador **delegue** sus
  dominios (cambiar NS + crear glue en el registrador) — paso manual, externo al
  VPS.
- En Ubuntu, `systemd-resolved` ocupa 127.0.0.53:53; por eso PowerDNS se bindea a
  la **IP pública** (`local-address`), no a `0.0.0.0`.
- Requiere puerto 53 (TCP+UDP) abierto y accesible desde Internet.

## Patrones reutilizados del código existente

- Cliente API por loopback + API key cifrada (de `routes/n8n.js` / `lib/n8n.js`).
- Streaming de instalación con centinela `__TXPL_DONE__` (de `plugins.js` /
  `n8n.js` / `mail.js`).
- Apertura de puertos UFW (de `routes/firewall.js` / `mail.js`).
- Tabla + queries de fila única cifrada (patrón `n8n_config`).
- Helpers puros aislados y testeados (de `lib/n8n.js` / `lib/mail.js`).
- Sección frontend adaptativa por estado (de las secciones n8n / correo).
