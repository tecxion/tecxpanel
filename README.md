<p align="center">
  <img src="public/logo1.png" alt="TecXPaneL Logo" width="150" />
</p>

# ⚡ TecXPaneL

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18-green?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js Version" />
  <img src="https://img.shields.io/badge/Database-SQLite-blue?style=for-the-badge&logo=sqlite&logoColor=white" alt="Database SQLite" />
  <img src="https://img.shields.io/badge/Security-JWT%20%26%20bcrypt-red?style=for-the-badge&logo=json-web-tokens&logoColor=white" alt="Security JWT" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License MIT" />
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=for-the-badge" alt="PRs Welcome" />
</p>

### Último commit

![GitHub last commit](https://img.shields.io/github/last-commit/tecxion/tecxpanel)

**TecXPaneL** es un panel de control autohospedado, moderno y extremadamente ligero diseñado para gestionar servidores VPS basados en **Ubuntu/Debian**. Ofrece una alternativa de alto rendimiento y bajo consumo a paneles pesados como cPanel o Plesk, consumiendo menos de **30 MB de RAM**.

Está desarrollado como una **SPA (Single Page Application)** modular en el frontend y un backend rápido en **Node.js** con base de datos **SQLite**.

---

## 🚀 Características Principales

- 🌐 **Sitios Web**: Despliegue de sitios estáticos HTML, PHP (con selector de versiones PHP-FPM), Node.js, React y Python configurados automáticamente con proxy inverso en Nginx.
- 📦 **Aplicaciones en un Clic**: Despliegue avanzado de aplicaciones Node.js, Python o React a través de PM2. Soporta carga de archivos en `.zip`/`.tar.gz` y gestión de archivos `.env`.
- 🐘 **Bases de Datos**: Creación instantánea de bases de datos MySQL (MariaDB) y PostgreSQL. Autogeneración de contraseñas seguras cifradas en reposo (AES-256-GCM).
- 🔒 **SSL Automático**: Instalación y renovación automática de certificados SSL gratuitos de **Let's Encrypt** mediante Certbot con redirección HTTPS forzada.
- 🛡️ **Firewall & Seguridad**: Gestión de reglas de firewall **UFW** desde el panel. Autenticación **JWT** con expiración corta, bloqueo temporal de IPs por fuerza bruta e integración nativa de **2FA (TOTP)**.
- 📟 **Terminal SSH Integrada**: Consola interactiva en tiempo real directamente en el navegador utilizando WebSockets y `node-pty`.
- 📂 **Gestor de Archivos**: Explorador web para navegar, editar, comprimir, extraer, eliminar y subir archivos (con soporte drag-and-drop y barra de progreso) en `/var/www`.
- ⚡ **Plugins del Servidor**: Instalador no interactivo de dependencias críticas: **Docker**, **phpMyAdmin** (puerto 8081), **Redis**, **Fail2Ban**, **Composer** y **Certbot**.
- 🔗 **Workflows (n8n)**: Integración nativa de **n8n** para automatización de flujos. Instala n8n como contenedor Docker (volumen persistente y proxy Nginx opcional) desde el propio panel, con **barra de progreso de descarga en vivo**. Conecta tu API key (cifrada en reposo) y gestiona tus workflows sin salir de TecXPaneL: lístalos, actívalos/desactívalos, consulta las ejecuciones recientes y abre el editor de n8n con un clic.

---

## 🏗️ Arquitectura del Proyecto

El proyecto está estructurado de forma limpia y desacoplada:

```text
/opt/txpl/
├── backend/
│   ├── server.js          # Punto de entrada de la API REST + WebSockets
│   ├── database.js        # Capa de datos con SQLite (better-sqlite3)
│   ├── routes/            # Enrutadores divididos por módulos (apps, webs, system, etc.)
│   ├── lib/               # Librerías de websocket, criptografía y utilidades
│   └── package.json       # Dependencias del backend
├── frontend/
│   ├── index.html         # SPA (Single Page Application) modularizada
│   ├── css/
│   │   └── styles.css     # Estilos CSS modernos
│   └── js/
│       └── app.js         # Lógica vanilla JS del lado del cliente
├── data/
│   └── txpl.db            # Base de datos SQLite del panel (se crea en el arranque)
└── ecosystem.config.js    # Configuración de ejecución continua en PM2
```

---

## 💿 Instalación en un VPS limpio

En un VPS limpio con **Ubuntu** o **Debian**, todo el proceso de aprovisionamiento se realiza mediante un script interactivo. Este instala Node.js, Nginx, PM2, UFW y Certbot, configura un `.env` seguro y arranca el panel.

> [!WARNING]
> **Instalación en servidor en producción:**
> El script de instalación configura el firewall UFW, crea bloques en Nginx y realiza modificaciones globales en los paquetes del sistema. Se recomienda **encarecidamente** ejecutarlo únicamente en un VPS limpio recién creado para evitar conflictos de puertos o configuraciones previas.

Ejecuta el siguiente comando como `root` o usando `sudo`:

```bash
git clone https://github.com/TU_USUARIO/tecxpanel.git && cd tecxpanel && sudo bash txpl-setup.sh
```

Al terminar, la consola imprimirá la dirección de acceso y las credenciales de administrador autogeneradas.

### ⚙️ Instalación Personalizada

Puedes predefinir variables de entorno antes de lanzar el instalador:

```bash
export ADMIN_USER="admin"
export ADMIN_PASS="tu-contraseña-segura"
export PANEL_DOMAIN="panel.tudominio.com"
export INSTALL_MYSQL=1
export INSTALL_PG=0

sudo -E bash txpl-setup.sh
```

---

## 🛠️ Desarrollo y Pruebas Locales (Sin Servidor VPS)

Puedes clonar el repositorio y arrancar la aplicación de pruebas en tu máquina local (**Windows / macOS / Linux**):

1.  Crea un archivo `.env` en la raíz del proyecto:
    ```env
    TXPL_PORT=8585
    JWT_SECRET=un_secreto_muy_largo_de_mas_de_32_caracteres_de_prueba
    ADMIN_USER=admin
    ADMIN_PASS=contraseñadeprueba
    TXPL_DIR=./
    FRONTEND_DIR=./frontend
    ```
2.  Instala las dependencias y arranca el servidor local:
    ```bash
    npm install
    npm run dev
    ```
3.  Accede desde el navegador a: `http://localhost:8585`

> [!NOTE]
> **Limitaciones en Windows:**
> Al probar el panel de control localmente en Windows, las funciones específicas de Linux (como el Firewall UFW, la terminal SSH con `node-pty` y la gestión de servicios con `systemctl`) lanzarán excepciones controladas. Sin embargo, toda la interfaz, base de datos SQLite y gestor de archivos locales funcionarán al 100% para realizar pruebas de desarrollo.

---

## 💻 Comandos del CLI `txpl`

El panel incluye una herramienta de consola (`txpl`) instalada en `/usr/local/bin/txpl` para administrar el panel desde la terminal de tu VPS:

| Comando                    | Descripción                                                    |
| :------------------------- | :------------------------------------------------------------- |
| `txpl status`              | Muestra el estado del panel, servicios de red y consumo        |
| `txpl restart`             | Reinicia el panel sin pérdida de servicio (PM2 reload)         |
| `txpl logs`                | Muestra en vivo los registros de actividad del panel           |
| `txpl panel:ssl <dominio>` | Configura el dominio e instala HTTPS mediante Certbot          |
| `txpl sites`               | Lista los sitios web Nginx gestionados                         |
| `txpl apps`                | Muestra las aplicaciones en ejecución de PM2                   |
| `txpl dbs`                 | Lista las bases de datos SQLite, MySQL y Postgres              |
| `txpl backup`              | Crea una copia de seguridad empaquetada en `/opt/txpl/backups` |
| `txpl backup:cron`         | Instala un cron job diario para backups a las 03:00 AM         |
| `txpl backup:list`         | Lista todas las copias de seguridad disponibles                |

---

## 🔗 Automatización con n8n (Workflows)

TecXPaneL integra **n8n** para que orquestes automatizaciones desde el mismo panel, sin instalarlo ni administrarlo a mano.

> [!NOTE]
> La sección **Workflows** requiere **Docker**. Si no está instalado, el panel te llevará a instalarlo desde **Plugins** con un clic.

**Flujo de uso:**

1.  Entra en la sección **Workflows** y pulsa **Instalar n8n**. El panel descarga la imagen (`n8nio/n8n:latest`) y crea el contenedor `txpl-n8n` con volumen persistente `n8n_data`, mostrando el progreso de descarga en directo.
2.  Abre n8n (botón **Abrir en n8n**, que apunta a la IP de tu servidor + puerto, o a tu dominio si lo configuraste), crea tu cuenta de propietario y genera tu **API key** en `Settings → API`.
3.  Pega la API key en el asistente del panel. Se valida contra n8n y se guarda **cifrada** (AES-256-GCM). No necesitas indicar ninguna URL.
4.  Desde el **dashboard de Workflows** puedes: ver tus workflows y su estado, **activarlos/desactivarlos**, revisar las **ejecuciones recientes**, ver la URL de webhook de un workflow y abrir el editor de n8n para editarlos.

> [!TIP]
> **Editar** workflows siempre se hace en la interfaz propia de n8n (enlace directo). El panel actúa como panel de control y monitorización, hablando con n8n de forma segura por *loopback*. Para instalar con dominio + HTTPS, indica el dominio al instalar y emite el certificado desde la sección **SSL**.

---

## 🛡️ Seguridad Aplicada

> [!IMPORTANT]
> La seguridad es un pilar fundamental en TecXPaneL. El backend y los scripts están protegidos con políticas estrictas de control y aislamiento.

- **Zero Shell Interpolation**: Toda ejecución externa se hace con `execFile` pasando argumentos en arrays, imposibilitando los ataques de Command Injection.
- **Cifrado Robusto**: Contraseñas del administrador hasheadas con `bcrypt` (12 rondas). Secretos de bases de datos guardados en la base de datos local con cifrado simétrico AES-256-GCM.
- **Jaula de Rutas (Path Jail)**: Rutas del gestor de archivos validadas y resueltas para bloquear ataques de Path Traversal fuera del directorio base.
- **Protección contra Ataques**: Cabeceras de seguridad configuradas mediante `helmet`, rate limiting de solicitudes por IP y protección contra fuerza bruta integrada.

---

## 🤝 Colaboración

¡Las contribuciones son lo que hacen a la comunidad de código abierto un lugar increíble para aprender, inspirar y crear! Cualquier colaboración que hagas será **muy apreciada**.

1.  Haz un **Fork** del proyecto.
2.  Crea una rama para tu característica (`git checkout -b feature/NuevaMejora`).
3.  Realiza tus cambios y haz un commit (`git commit -m 'Añade nueva funcionalidad'`).
4.  Sube la rama a tu fork (`git push origin feature/NuevaMejora`).
5.  Abre un **Pull Request**.

![GitHub contributors](https://img.shields.io/github/contributors/tecxion/tecxpanel)

---

## 💰 ¿Puedes ayudarme a crecer?

<h1 align="center">
   <a href="https://paypal.me/jfmpkiko">
<img src="https://img.shields.io/badge/PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white" alt="Paypal" />  </a><a href="https://coff.ee/tecxart"><img src="https://github.com/tecxion/TecXion/blob/main/Media/cafe1.png" alt="Cafe">   <img alt="GitHub watchers" src="https://img.shields.io/github/watchers/tecxion/tecxpanel">    <img alt="GitHub User's stars" src="https://img.shields.io/github/stars/tecxion/tecxpanel">

</a>
</h1>

<br />

### Gracias a todos los que hacen esto posible

<p align="center">
  <img src="public/logo2.png" alt="TecXPaneL Logo 2" width="150" />
</p>
