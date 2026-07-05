# Diseño — Logo TECXPANEL y barra de progreso de una sola línea en `txpl-setup.sh`

**Fecha:** 2026-07-05
**Estado:** Aprobado

## Contexto

`txpl-setup.sh` ya tiene un motor de barra de progreso en una sola línea
(`draw()` usa `\r` + `\033[K`, y `run_spin()` anima un spinner braille mientras
cada fase corre en segundo plano con la salida redirigida a `$LOGFILE`). Sin
embargo:

1. `step_done()` imprime un `\n` al terminar **cada** paso, así que los 13 pasos
   dejan 13 líneas apiladas — la barra "salta" de línea en vez de mantenerse fija.
2. El banner de cabecera es un simple `sep` + `TecXPaneL — Instalador`.

Objetivo: (a) que la barra sea **una sola línea persistente** que avanza del 0 al
100% actualizándose en el sitio, con un único salto de línea al final; y (b)
añadir un **logo ASCII "TECXPANEL"** elegante en la cabecera.

## Alcance

**Incluido:**
- Barra de progreso en una sola línea persistente (quitar el `\n` por paso; un
  único `\n` al terminar todos los pasos).
- Función `banner()` con logo ASCII "ANSI Shadow" de TECXPANEL, coloreado, con
  fallback a un banner de texto simple si no hay TTY o la terminal es estrecha.

**Excluido (YAGNI):**
- Cambios en `txpl-update.sh` (su barra/estética queda igual salvo que se pida).
- Colores por gradiente/temas; se usan las variables de color ya existentes.

## Componentes

### 1. Barra de una sola línea (`txpl-setup.sh`)

- **`step_done()`**: dejar de imprimir `\n`. En TTY, solo redibuja la barra con el
  check `✓` y el mensaje del paso en la misma línea (`draw "$STEP" "$CUR_MSG" "✓"`),
  **sin** `printf "\n"`. La rama no-TTY (logs) se mantiene igual (`printf "OK\n"`).
- **Cierre único**: añadir un helper `steps_end()` que, solo en TTY, imprime un
  único `printf "\n"`. Se llama **una vez**, después del último `step_done` y antes
  del resumen final de acceso. Así la barra queda al 100% como última línea y el
  resumen empieza limpio.
- El resto del motor (`draw`, `run_spin`, `step_begin`) no cambia. El `\033[K` de
  `draw` ya limpia restos de mensajes más largos.
- `warn()`/`err()` ya imprimen con `\n` inicial, así que si saltan a mitad de la
  barra, cortan la línea limpiamente; el siguiente `step_begin` vuelve a dibujar
  con `\r`. Comportamiento aceptable (los avisos deben verse).

### 2. Logo `banner()` (`txpl-setup.sh`)

- Nueva función `banner()` definida junto al resto de helpers (tras las variables
  de color). Lógica:
  - Si **hay TTY** (`[[ -t 1 ]]`) **y** el ancho de terminal es suficiente
    (`$(tput cols 2>/dev/null || echo 80)` ≥ 74): imprime el logo ASCII en color
    `CYAN` (`BOLD` opcional), seguido de la línea de tagline y un `sep`.
  - Si no (sin TTY, o terminal estrecha): fallback al banner actual —
    `sep` + `${BOLD}   TecXPaneL — Instalador${RESET}` + `sep`.
- **Logo (ANSI Shadow, TECXPANEL, 6 filas, ~72 columnas):**

```
████████╗███████╗ ██████╗██╗  ██╗██████╗  █████╗ ███╗   ██╗███████╗██╗
╚══██╔══╝██╔════╝██╔════╝╚██╗██╔╝██╔══██╗██╔══██╗████╗  ██║██╔════╝██║
   ██║   █████╗  ██║      ╚███╔╝ ██████╔╝███████║██╔██╗ ██║█████╗  ██║
   ██║   ██╔══╝  ██║      ██╔██╗ ██╔═══╝ ██╔══██║██║╚██╗██║██╔══╝  ██║
   ██║   ███████╗╚██████╗██╔╝ ██╗██║     ██║  ██║██║ ╚████║███████╗███████╗
   ╚═╝   ╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝
              V P S   C O N T R O L   P A N E L
```

- **Integración**: en el bloque de configuración interactiva, sustituir el
  `clear` + `sep` + `echo ... TecXPaneL — Instalador` + `sep` inicial por
  `clear` + `banner`. El resto del flujo (preguntas de BD, recuperación, etc.) no
  cambia.
- **Impresión segura**: el logo lleva caracteres de dibujo de caja Unicode; se
  imprime con `printf '%s\n'` línea a línea (o un `cat <<'EOF'`), envuelto en los
  códigos de color, para que `%`/backslashes no se interpreten.

## Manejo de errores / degradación

- Sin TTY (ejecución con `tee`/redirección) → `banner()` usa el fallback de texto
  y la barra imprime paso a paso (rama no-TTY existente). Nada se rompe.
- Terminal estrecha (< 74 col) → fallback de texto, sin logo cortado.
- `tput` ausente → el `|| echo 80` asume 80 columnas (muestra el logo).

## Criterios de éxito

1. En una terminal normal, la instalación muestra **una sola barra** que avanza
   del 0 al 100% sin dejar una pila de 13 líneas; el resumen final aparece debajo,
   limpio.
2. La cabecera muestra el logo ASCII de TECXPANEL coloreado.
3. Con `tee`/sin TTY o en terminal estrecha, se usa el banner de texto simple y la
   instalación no se rompe.
4. Ningún cambio de comportamiento funcional del instalador (mismos pasos, misma
   lógica); solo presentación.
