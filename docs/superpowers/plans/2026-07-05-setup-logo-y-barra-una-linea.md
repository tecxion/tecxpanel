# Logo TECXPANEL + barra de una sola línea en setup.sh — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que `txpl-setup.sh` muestre una barra de progreso en una sola línea persistente (sin apilar 13 líneas) y un logo ASCII "TECXPANEL" en la cabecera.

**Architecture:** Cambios de presentación en un solo fichero bash (`txpl-setup.sh`). Task 1 ajusta el cierre de cada paso para no saltar de línea; Task 2 añade una función `banner()` con el logo y su fallback. Sin cambios funcionales del instalador.

**Tech Stack:** Bash, secuencias ANSI (`\r`, `\033[K`, colores), `tput`.

## Global Constraints

- **Idioma español** en comentarios y textos.
- **Sin cambios funcionales** del instalador: mismos pasos y misma lógica; solo presentación.
- **Degradación segura:** sin TTY o terminal estrecha (< 74 columnas) → banner de texto simple y barra paso a paso (rama no-TTY existente). `tput` ausente → asumir 80 columnas.
- **Usar las variables de color existentes** (`GREEN`, `CYAN`, `YELLOW`, `RED`, `BOLD`, `RESET`) y el helper `sep()`.
- **Verificación:** `bash -n txpl-setup.sh` debe pasar tras cada tarea (no se puede correr el instalador completo: requiere root/apt).

---

### Task 1: Barra de progreso en una sola línea persistente

**Files:**
- Modify: `txpl-setup.sh` (función `step_done`; nuevo helper `steps_end`; una llamada tras el último paso)

**Interfaces:**
- Produces: `steps_end()` — imprime un único `\n` solo en TTY, para cerrar la barra.

- [ ] **Step 1: Quitar el salto de línea por paso en `step_done`**

En `txpl-setup.sh`, reemplazar la función `step_done` actual:

```bash
step_done() {
    if [[ -t 1 ]]; then draw "$STEP" "$CUR_MSG" "✓"; printf "\n"
    else printf "OK\n"; fi
}
```

por (sin el `printf "\n"` en la rama TTY):

```bash
step_done() {
    if [[ -t 1 ]]; then draw "$STEP" "$CUR_MSG" "✓"
    else printf "OK\n"; fi
}
```

- [ ] **Step 2: Añadir el helper `steps_end`**

Justo debajo de `step_done` (antes del bloque de fases), añadir:

```bash
# Cierra la barra de progreso con un único salto de línea (solo en TTY),
# para que el resumen final empiece en una línea limpia.
steps_end() { [[ -t 1 ]] && printf "\n"; }
```

- [ ] **Step 3: Llamar a `steps_end` tras el último paso**

En `txpl-setup.sh`, el último `step_done` es el del paso "Instalando la CLI txpl"
(justo antes del bloque `#  Resumen`). Inmediatamente después de ese `step_done`
y antes del comentario `# ═══...  Resumen`, insertar la llamada:

```bash
step_done

steps_end

# ════════════════════════════════════════════════════════════
#  Resumen
# ════════════════════════════════════════════════════════════
```

(es decir: añadir la línea `steps_end` entre el último `step_done` y el separador de comentario del resumen).

- [ ] **Step 4: Verificar sintaxis y ausencia del salto por paso**

Run: `bash -n txpl-setup.sh && echo "sintaxis OK"`
Expected: imprime `sintaxis OK`.

Run: `grep -n 'printf "\\n"' txpl-setup.sh | grep -c draw` — comprobación informal; lo esencial:
Run: `grep -nA2 '^step_done()' txpl-setup.sh`
Expected: el cuerpo TTY de `step_done` ya NO contiene `printf "\n"` (solo `draw ... "✓"`).

Run: `grep -n 'steps_end' txpl-setup.sh`
Expected: dos coincidencias — la definición y la llamada tras el último paso.

- [ ] **Step 5: Commit**

```bash
git add txpl-setup.sh
git commit -m "feat(setup): barra de progreso en una sola línea persistente"
```

---

### Task 2: Logo TECXPANEL (`banner`)

**Files:**
- Modify: `txpl-setup.sh` (nueva función `banner`; sustituir el banner inicial por `banner`)

**Interfaces:**
- Consumes: variables de color existentes (`CYAN`, `BOLD`, `RESET`) y `sep`.
- Produces: `banner()` — imprime el logo ASCII o el fallback de texto.

- [ ] **Step 1: Añadir la función `banner`**

En `txpl-setup.sh`, tras la definición de `sep()` (junto a los demás helpers de
cabecera), añadir:

```bash
# Imprime el logo TECXPANEL (ANSI Shadow) si hay TTY y anchura suficiente;
# si no, un banner de texto simple. Solo presentación, no cambia el flujo.
banner() {
    local cols; cols=$(tput cols 2>/dev/null || echo 80)
    if [[ -t 1 && "$cols" -ge 74 ]]; then
        printf '%b' "${CYAN}${BOLD}"
        cat <<'LOGO'
████████╗███████╗ ██████╗██╗  ██╗██████╗  █████╗ ███╗   ██╗███████╗██╗
╚══██╔══╝██╔════╝██╔════╝╚██╗██╔╝██╔══██╗██╔══██╗████╗  ██║██╔════╝██║
   ██║   █████╗  ██║      ╚███╔╝ ██████╔╝███████║██╔██╗ ██║█████╗  ██║
   ██║   ██╔══╝  ██║      ██╔██╗ ██╔═══╝ ██╔══██║██║╚██╗██║██╔══╝  ██║
   ██║   ███████╗╚██████╗██╔╝ ██╗██║     ██║  ██║██║ ╚████║███████╗███████╗
   ╚═╝   ╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝
LOGO
        printf '%b\n' "${RESET}${CYAN}              V P S   C O N T R O L   P A N E L${RESET}"
        sep
    else
        sep
        printf '%b\n' "${BOLD}   TecXPaneL — Instalador${RESET}"
        sep
    fi
}
```

- [ ] **Step 2: Usar `banner` en la cabecera**

En el bloque de configuración interactiva de `txpl-setup.sh`, reemplazar:

```bash
clear 2>/dev/null || true
sep
echo -e "${BOLD}   TecXPaneL — Instalador${RESET}"
sep
echo ""
```

por:

```bash
clear 2>/dev/null || true
banner
echo ""
```

- [ ] **Step 3: Verificar sintaxis y render del logo**

Run: `bash -n txpl-setup.sh && echo "sintaxis OK"`
Expected: imprime `sintaxis OK`.

Run: `grep -n 'TECXPANEL\|banner\|LOGO' txpl-setup.sh`
Expected: la función `banner`, el heredoc `LOGO`, y la llamada `banner` en la cabecera.

Comprobar el render aislado del logo (extrae y ejecuta solo la función `banner`):

Run:
```bash
bash -c '
CYAN="\033[0;36m"; BOLD="\033[1m"; RESET="\033[0m"; sep(){ echo "----"; }
'"$(sed -n '/^banner() {/,/^}/p' txpl-setup.sh)"'
banner'
```
Expected: se dibuja el logo ASCII de TECXPANEL (6 filas) + la línea "V P S CONTROL PANEL" + separador, sin errores.

- [ ] **Step 4: Commit**

```bash
git add txpl-setup.sh
git commit -m "feat(setup): logo ASCII TECXPANEL en la cabecera del instalador"
```

---

## Self-Review

**Cobertura del spec:**
- Barra de una sola línea persistente (quitar `\n` por paso; `\n` único al final) → Task 1. ✓
- `banner()` con logo ANSI Shadow + fallback (sin TTY / < 74 col / sin `tput`) → Task 2. ✓
- Integración en la cabecera sin tocar el resto del flujo → Task 2 Step 2. ✓
- Sin cambios funcionales; solo presentación → ambas tareas solo tocan salida. ✓
- Degradación no-TTY (barra paso a paso + banner de texto) → preservada (ramas `else` intactas). ✓

**Escaneo de placeholders:** sin "TBD"/"TODO"; todo el código y el arte están completos.

**Consistencia:** `steps_end` (Task 1) y `banner` (Task 2) se definen y se llaman con esos nombres exactos. Las variables `CYAN/BOLD/RESET` y `sep` existen ya en el script. El arte del logo es el mismo aprobado en el spec.
