# OpenCode Background Tasks Addon

Addon alpha para llevar la UX de **background tasks same-session** a OpenCode con una distribución separada del proyecto principal.

## Estado del proyecto

- **alpha**
- orientado a **desarrolladores y early adopters**
- foco en **seguridad, reversibilidad y compatibilidad explícita**
- pensado para evolucionar como:
  - repo propio
  - installer propio
  - lifecycle propio
  - versionado propio

## Qué resuelve

Este addon empaqueta el trabajo de background tasks same-session que hoy permite:

- mandar la corrida actual a background (`ctrl+b ctrl+b`)
- seguir usando el foreground de la consola lógica
- listar tareas con `/bg-tasks`
- reabrir tareas en inspección
- volver al foreground (`ctrl+f ctrl+f`)
- mantener continuidad de prompt inline e interrupt en inspección

En esta alpha, el addon no “instala magia”: administra de forma explícita un **plugin** y un **patch versionado del host/core**.

## Modelo de modos

El lifecycle está preparado para distinguir entre cuatro modos:

- `patched-source-checkout`
  - modo soportado hoy
  - usa plugin + patch sobre un checkout fuente compatible
- `plugin-only`
  - modo objetivo futuro
  - pensado para versiones oficiales de OpenCode que ya incorporen los hooks host necesarios
- `managed-local-install`
  - takeover reversible de una instalación local `curl-binary`
  - respalda `~/.opencode` como unidad y la reemplaza por una instalación administrada por el addon
- `unsupported`
  - el addon detecta el target, pero no puede operarlo de forma segura con este alpha

En esta versión, los modos realmente soportados son:

- `patched-source-checkout`
- `managed-local-install`

## Alcance de esta alpha

### Soportado

| Escenario                                                    | Estado       |
| ------------------------------------------------------------ | ------------ |
| Checkout fuente compatible de OpenCode vía `--opencode-root` | ✅ soportado |
| Checkout fuente compatible si el `cwd` ya apunta al repo     | ✅ soportado |

### No soportado todavía

| Escenario                                                  | Estado                        |
| ---------------------------------------------------------- | ----------------------------- |
| `~/.opencode/bin/opencode` como target directo/plugin-only | ❌ no soportado en esta alpha |
| `npm` / `pnpm` / `bun` / `yarn` global                     | ❌ no soportado en esta alpha |
| `brew` / `scoop` / `choco`                                 | ❌ no soportado en esta alpha |

### Instalar sobre `curl-binary` de forma administrada

| Escenario                                                                | Estado                                    |
| ------------------------------------------------------------------------ | ----------------------------------------- |
| Instalación local `curl-binary` en `~/.opencode` con takeover reversible | ✅ soportado como `managed-local-install` |

#### Condiciones de este modo

- requiere una instalación local detectable en `~/.opencode`
- requiere un checkout fuente compatible pasado vía `--checkout-root`
- requiere `bun` disponible en PATH o vía `--bun-path`
- hace backup + replace + restore de la instalación local completa

## Filosofía del lifecycle

Este addon prioriza:

- **fail-safe** antes que conveniencia
- **detección explícita** antes que heurísticas frágiles
- **reversibilidad** antes que automatización agresiva

Si el target no puede verificarse con suficiente seguridad, el lifecycle falla explícitamente y no toca nada.

## Qué instala / administra

- plugin TUI en:
  - `~/.config/opencode/plugins/background-agents-tui/`
- estado persistido en:
  - `~/.local/state/opencode-addons/opencode-background-tasks/state.json`
- patch versionado del host/core para una versión puntual de OpenCode

## Requisitos del MVP

- checkout fuente compatible de OpenCode
- `git` disponible
- permisos para escribir en:
  - `~/.config/opencode/plugins/`
  - `~/.local/state/opencode-addons/`

## Estructura del repo

```text
manifest/     # metadata del addon y compatibilidad por versión
plugin/       # plugin empaquetado dentro del addon
patches/      # patch versionado del host/core
lib/          # utilidades de detección, estado, patch, plugin y compat
scripts/      # lifecycle: status, enable, disable, reapply, smoke
docs/         # notas de publicación y validación
```

## Uso

### Ver estado

```bash
node ./scripts/status.mjs --opencode-root /ruta/al/opencode-checkout
```

### Habilitar

```bash
node ./scripts/enable.mjs --opencode-root /ruta/al/opencode-checkout
```

### Habilitar en dry-run

```bash
node ./scripts/enable.mjs --opencode-root /ruta/al/opencode-checkout --dry-run
```

### Deshabilitar

```bash
node ./scripts/disable.mjs --opencode-root /ruta/al/opencode-checkout
```

### Reaplicar

```bash
node ./scripts/reapply.mjs --opencode-root /ruta/al/opencode-checkout
```

### Smoke validation

```bash
node ./scripts/smoke.mjs --opencode-root /ruta/al/opencode-checkout
```

### Adoptar instalación local administrada

```bash
node ./scripts/adopt-local-install.mjs \
  --checkout-root /ruta/al/opencode-checkout \
  --bun-path /ruta/al/bun
```

### Restaurar instalación local original

```bash
node ./scripts/restore-local-install.mjs
```

## Garantías de seguridad del MVP

- `enable` y `reapply` validan compatibilidad exacta por versión.
- el lifecycle deja explícito el modo compatible detectado (`patched-source-checkout`, `plugin-only`, `managed-local-install`, `unsupported`).
- los comandos reales no operan sobre checkouts sucios.
- `disable` no borra el plugin si detecta modificaciones manuales.
- si el patch no está en un estado seguro para aplicar/revertir, el lifecycle falla.
- los `dry-run` existen para validar flujo sin mutar estado.
- `managed-local-install` no modifica el ELF en sitio: respalda y reemplaza la instalación local como unidad.

## Validación mínima recomendada

Antes de usar el addon “en serio”, correr:

```bash
node ./scripts/status.mjs --opencode-root /ruta/al/opencode-checkout
node ./scripts/smoke.mjs --opencode-root /ruta/al/opencode-checkout
```

## Limitaciones conocidas

- el patch del host/core sigue siendo sensible a updates de OpenCode
- `managed-local-install` sigue siendo un MVP: necesita un checkout fuente preparado como base y no pretende cubrir todos los métodos de instalación.
- la instalación binaria/global sigue fuera de alcance para el modo `plugin-only`
- todavía no hay soporte universal cross-platform

## Licencia

Este proyecto se distribuye bajo **GNU GPL v3**. Ver `LICENSE`.

## Documentación adicional

- `docs/validation.md`
- `docs/alpha-publication-notes.md`
- `docs/upstream-readiness.md`
- `docs/roadmap.md`
- `docs/security-managed-local-install.md`

## Cómo presentar honestamente esta alpha

La forma correcta de presentarlo hoy es:

> Addon alpha para source checkouts compatibles de OpenCode,
> orientado a iteración segura sobre plugin + patch versionado,
> no todavía como solución universal para cualquier instalación de OpenCode.
