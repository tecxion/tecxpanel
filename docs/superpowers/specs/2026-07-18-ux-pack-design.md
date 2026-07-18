# UX Pack — Tema Claro/Oscuro, Command Palette, Estados Vacíos, Responsive Móvil

**Fecha:** 2026-07-18
**Rama:** `feat/ux-pack`
**Alcance:** solo frontend (`frontend/`) + extensión de `backend/test/frontend-handlers.test.js`. Cero cambios de backend.

## Motivación

Cuatro mejoras de UX pequeñas e independientes que juntas modernizan el panel frente a Plesk/cPanel/Hestia: tema claro, búsqueda global con teclado, tablas vacías que guían al usuario y uso real desde el móvil. Se agrupan en una sola rama porque comparten ficheros (`styles.css`, `core.js`, `index.html`) y ninguna justifica rama propia.

## 1. Tema Claro/Oscuro

**Decisiones:**
- El tema actual ya es 100% variables CSS en `:root` (`styles.css:13-40`). El modo claro es un bloque `[data-theme="light"]` sobre `<html>` que redefine las variables de color (fondos claros, textos oscuros, bordes suaves). El acento ámbar `#E8A020` se mantiene en ambos temas; verde/rojo/amarillo/azul se oscurecen ligeramente en claro para contraste AA sobre fondo blanco.
- Colores que hoy están hardcodeados fuera de variables (`#0C0D0F` como color de texto sobre acento, `#0a0a0a` del terminal, sombras `rgba(0,0,0,…)`) se extraen a variables nuevas (`--on-accent`, `--bg-terminal`, `--shadow`) para que el bloque claro pueda redefinirlas. El fondo del terminal xterm permanece oscuro en ambos temas (convención universal de terminales).
- Preferencia en `localStorage` clave `txpl_theme` con valores `light` | `dark` | `system`. Por defecto `system` (resuelve con `matchMedia('(prefers-color-scheme: light)')` y escucha cambios del SO en vivo).
- **Anti-flash:** script inline mínimo en el `<head>` de `index.html`, antes del CSS, que lee `localStorage` y pone `data-theme` en `<html>`. Sin él, el primer pintado parpadea.
- **Controles:** icono sol/luna en la topbar que alterna claro↔oscuro (fija la preferencia explícita); tarjeta en Ajustes con selector de 3 opciones (Claro / Oscuro / Sistema).
- Funciones globales nuevas en `core.js`: `applyTheme(pref)`, `toggleTheme()`, `setThemePref(pref)`.

## 2. Command Palette (Ctrl+K / Cmd+K)

**Decisiones:**
- Fichero nuevo `frontend/js/palette.js` (cargado tras `core.js` en `index.html`) + estilos en `styles.css`. Sin librerías.
- Overlay propio (no reutiliza `.modal-overlay` para no heredar su semántica de cierre): input arriba, lista de resultados debajo. Teclado: `Ctrl+K`/`Cmd+K` abre, `↑`/`↓` navegan, `Enter` ejecuta, `Esc` cierra. Clic fuera cierra.
- Búsqueda por subcadena, sin fuzzy ni scoring: se filtra sobre `label + alias`, insensible a mayúsculas y acentos (normalización NFD). Máximo ~12 resultados visibles, agrupados por tipo (Secciones / Acciones / Recursos).
- **Tres fuentes del índice:**
  1. **Secciones** (estático): las 19 páginas con alias en español ("correo" → mail, "tareas" → cron, "copias" → backups, "cortafuegos" → firewall…).
  2. **Acciones** (estático): registro declarativo `PALETTE_ACTIONS = [{ label, icon, fn, page }]` donde `fn` es el NOMBRE de una función global existente (ej. `"showCreateSiteModal"`). Ejecutar una acción navega primero a su página y luego llama a la función. El registro cubre las acciones de creación principales (sitio, app, DB, contenedor, backup, tarea cron, zona DNS, regla firewall, buzón).
  3. **Recursos** (dinámico): al abrir el palette se lanza en paralelo `req()` a `/websites`, `/apps`, `/databases`, `/docker/containers`, con caché en memoria de 60 s. Elegir un recurso navega a su sección. Si una API falla (p.ej. Docker no instalado), esa fuente se omite en silencio.
- **Test:** `backend/test/frontend-handlers.test.js` se extiende para parsear `PALETTE_ACTIONS` en `palette.js` y verificar que cada `fn` referenciada existe exactamente una vez como función global en `frontend/js/*.js` — mismo invariante que ya se aplica a los `onclick=` de las vistas.

## 3. Estados Vacíos con CTA

**Decisiones:**
- La clase `.empty-state` ya existe (`styles.css:339`). Se le añade variante con botón.
- Helper global nuevo en `core.js`: `emptyState(icon, message, ctaLabel, ctaOnclick)` → devuelve el HTML del estado vacío; los dos últimos parámetros son opcionales (módulos sin acción de crear, como Logs, muestran solo icono + mensaje).
- Sweep por los módulos con listados: websites, apps, databases, docker, backups, cron, dns (zonas), firewall (reglas), ssl (certificados), catálogo (instalaciones), mail (buzones y alias). Cada render de tabla/lista vacía pasa a usar `emptyState()` con el CTA que abre su modal de creación (las mismas funciones globales del registro del palette — coherencia garantizada por el mismo test).
- El `ctaOnclick` es un nombre de función global (string), renderizado como `onclick="fn()"` — patrón existente del frontend.

## 4. Responsive Móvil

**Decisiones:**
- Breakpoint único: `@media (max-width: 768px)` en `styles.css`. Todo el panel operable en móvil, sin páginas excluidas.
- **Sidebar off-canvas:** en móvil la sidebar se oculta (`transform: translateX(-100%)`); botón hamburguesa nuevo en la topbar (visible solo <768px) la desliza sobre un overlay oscuro. Navegar o tocar el overlay la cierra. Función global `toggleSidebar()` en `core.js`.
- **Modales:** `max-width: 100%`, alto casi completo (`max-height: 100dvh` menos margen), border-radius reducido.
- **Formularios:** `.form-row` pasa a 1 columna.
- **Contenido:** padding de `.content` reducido a `0.75rem`; `.stats-grid` ya es auto-fit; tablas ya envueltas en `.table-wrap` con `overflow-x: auto` (se verifica que todas las vistas lo usen y se corrige donde falte).
- **Topbar:** el subtítulo/hostname se oculta en móvil para dejar sitio a título + hamburguesa.
- Terminal: el addon fit de xterm ya reajusta columnas al redimensionar; solo se garantiza que el contenedor no desborde.

## Errores y casos límite

- Palette con API caída: fuente omitida, el resto del índice funciona.
- Tema en navegadores sin `matchMedia`: cae a oscuro (comportamiento actual).
- `localStorage` bloqueado (modo privado estricto): el tema no persiste pero funciona en sesión; sin errores en consola (try/catch en lectura/escritura).

## Tests

- `frontend-handlers.test.js` extendido: acciones del palette y `ctaOnclick` de estados vacíos deben existir como funciones globales únicas.
- El resto es CSS/DOM sin lógica de negocio: verificación manual (móvil real o devtools) en la revisión final de la rama.

## Fuera de alcance

- i18n, sparklines del dashboard, wizard de dominio (grupos posteriores).
- Temas personalizados / más de 2 temas.
- Gestos táctiles (swipe para abrir sidebar).
