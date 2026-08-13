# OpenCode Background Tasks Add-on

Portable OpenCode addon for async same-session background tasks, extending `super-turing-opencode` with foreground/background switching, task inspection, and managed local install support.

Alpha add-on para OpenCode que lleva la UX de **background tasks same-session** a la TUI sin mezclar el producto con `super-turing-opencode`.

## Qué agrega

Este add-on empaqueta la experiencia de background tasks que hoy permite:

- mandar la corrida actual a background con `ctrl+b ctrl+b`
- volver al foreground con `ctrl+f ctrl+f`
- listar tareas con `/bg-tasks`
- inspeccionar tareas completadas o en curso
- mantener la vista nativa de sesión y session switcher con proyección controlada por plugin

Con la instalación completa del add-on, los agentes pasan a conocer y usar estas capacidades de forma autónoma porque el plugin server/runtime expone las tools y reglas necesarias, mientras el plugin TUI aporta la UX visible.

## Cómo está empaquetado

Hoy el add-on se distribuye como:

- un **plugin server/runtime** (`background-agents.ts`) para delegaciones async,
- un **plugin TUI** (`background-agents-tui`) para la UX visible en foreground,
- un **playbook operativo** (`PLAYBOOK-ASYNC.md`) para el workflow async,
- una **skill reusable** (`skills/delegacion-async-opencode/SKILL.md`) para orientar el uso de delegaciones,
- un **patch versionado del host/core** para OpenCode `1.14.39`, `1.14.41`, `1.14.42`, `1.14.46`, `1.14.48`, `1.14.49`, `1.15.0`, `1.15.3`, `1.15.6`, `1.15.13`, `1.16.2`, `1.17.15`, `1.17.20` y `1.18.17`,
- y un lifecycle propio para instalar, revalidar, adoptar una instalación local y restaurarla.

En `managed-local-install`, el add-on:

- respalda `~/.opencode` completo
- instala un launcher administrado por el add-on
- persiste un runtime propio en `~/.opencode/bin/opencode-managed-runtime`
- preserva binarios auxiliares existentes en `~/.opencode/bin/` copiándolos/dereferenciándolos, para no dejar symlinks hacia backups efímeros
- usa la DB real del usuario mediante `OPENCODE_DB`

## Estado actual

- **alpha**
- orientado a **desarrolladores y early adopters técnicos**
- foco en **reversibilidad, trazabilidad y compatibilidad explícita**
- pensado para evolucionar como repo, lifecycle e instalador independientes

## Scope soportado hoy

### Soportado

- `patched-source-checkout` sobre OpenCode **1.14.39**, **1.14.41**, **1.14.42**, **1.14.46**, **1.14.48**, **1.14.49**, **1.15.0**, **1.15.3**, **1.15.6**, **1.15.13**, **1.16.2**, **1.17.15**, **1.17.20** y **1.18.17**
- `managed-local-install` sobre instalación local `curl-binary` en `~/.opencode`
- `managed-local-install` validado en **Linux x64**

### No soportado todavía

- `plugin-only` sobre builds oficiales sin patch local
- instaladores globales tipo `npm`, `pnpm`, `yarn`, `bun`
- `brew`, `scoop`, `choco`
- soporte universal cross-platform

## Flujo soportado real

Hay dos caminos honestamente soportados:

1. **Source checkout mode**
   - instalás los plugins del add-on
   - aplicás el patch versionado a un checkout fuente compatible

2. **Managed local install mode**
   - primero preparás un checkout fuente compatible con `enable`
   - después adoptás `~/.opencode` usando ese checkout como base
   - el install adoptado deja de depender de `/tmp` para ejecutar el runtime administrado
   - para cambiar entre versiones soportadas, hacés `restore-local-install` y luego repetís `enable` + `adopt-local-install` con el checkout nuevo

## Instalación

Las instrucciones paso a paso viven en [`installation.md`](./installation.md).

Ahí están documentados:

- prerequisitos
- instalación sobre checkout fuente
- instalación como `managed-local-install`
- validación post-install
- rollback

## Validación y seguridad

- guía de validación: [`docs/validation.md`](./docs/validation.md)
- nota de seguridad de `managed-local-install`: [`docs/security-managed-local-install.md`](./docs/security-managed-local-install.md)

Garantías principales del lifecycle actual:

- valida compatibilidad exacta por versión
- no opera sobre checkouts sucios cuando eso sería riesgoso
- `status` usa filesystem real, no solo `state.json`
- `restore-local-install` falla ante roots ambiguos o inconsistentes
- adopciones legacy con drift recuperable siguen pudiendo restaurarse si marker + backup siguen siendo confiables

## Archivos administrados por el add-on

- plugins:
  - `~/.config/opencode/plugins/background-agents.ts`
  - `~/.config/opencode/plugins/background-agents-tui/index.ts`
- assets auxiliares:
  - `~/.config/opencode/PLAYBOOK-ASYNC.md`
  - `~/.config/opencode/skills/delegacion-async-opencode/SKILL.md`
- state: `~/.local/state/opencode-addons/opencode-background-tasks/state.json`
- marker de adopción: `~/.opencode/.opencode-background-addon.json`
- runtime administrado: `~/.opencode/bin/opencode-managed-runtime`
- binarios auxiliares preservados desde el install previo: otras entradas de `~/.opencode/bin/` distintas de `opencode` y `opencode-managed-runtime`

## Comandos del lifecycle

Desde el root del repo del add-on:

```bash
node ./scripts/status.mjs
node ./scripts/enable.mjs --opencode-root /ruta/al/opencode-checkout
node ./scripts/disable.mjs --opencode-root /ruta/al/opencode-checkout
node ./scripts/reapply.mjs --opencode-root /ruta/al/opencode-checkout
node ./scripts/smoke.mjs --opencode-root /ruta/al/opencode-checkout
node ./scripts/adopt-local-install.mjs --checkout-root /ruta/al/opencode-checkout --bun-path /ruta/al/bun
node ./scripts/restore-local-install.mjs
```

## Estructura del repo

```text
manifest/     # metadata del add-on y compatibilidad por versión
plugin/       # plugins server/TUI empaquetados dentro del add-on
patches/      # patch versionado del host/core
lib/          # utilidades de detección, estado, patch, plugin y compat
scripts/      # lifecycle: status, enable, disable, reapply, smoke
docs/         # validación, seguridad y notas complementarias
skills/       # skills asociadas al workflow async/background
```

## Assets migrados desde el stack base

Esta rama también concentra el source-of-truth de la capa async/background que antes vivía en `super-turing-opencode`, incluyendo:

- `plugin/background-agents.ts`
- `plugin/background-agents-tui/index.ts`
- `PLAYBOOK-ASYNC.md`
- `skills/delegacion-async-opencode/SKILL.md`

El lifecycle del addon ahora instala también esos assets auxiliares en `~/.config/opencode/`, de modo que la funcionalidad background quede distribuible sin depender de que el stack base siga versionándolos.

La idea es que esta rama quede lista para luego mergearse tanto con `main` como con `sync-super-turing-background-clean`.

## Limitaciones conocidas

- el patch del host/core sigue siendo sensible a updates de OpenCode
- `managed-local-install` sigue siendo un MVP deliberadamente acotado
- el plugin global sigue siendo compartido entre modos; `restore-local-install` lo remueve solo si sigue intacto
- si venís de una alpha anterior que apuntaba a un runtime efímero, primero restaurá y después re-adoptá con esta versión

## Cómo presentar honestamente esta alpha

> Add-on alpha para OpenCode 1.14.39 / 1.14.41 / 1.14.42 / 1.14.46 / 1.14.48 / 1.14.49 / 1.15.0 / 1.15.3 / 1.15.6 / 1.15.13 / 1.16.2 / 1.17.15 / 1.17.20 / 1.18.17,
> orientado a checkouts fuente compatibles y a takeover administrado de `~/.opencode` en Linux x64,
> con lifecycle reversible y explícito,
> no todavía como solución universal para cualquier instalación de OpenCode.

## Licencia

Este proyecto se distribuye bajo **GNU GPL v3**. Ver `LICENSE`.
