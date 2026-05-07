# OpenCode Background Tasks Add-on

Alpha add-on para OpenCode que lleva la UX de **background tasks same-session** a la TUI sin mezclar el producto con `super-turing-opencode`.

## Qué agrega

Este add-on empaqueta la experiencia de background tasks que hoy permite:

- mandar la corrida actual a background con `ctrl+b ctrl+b`
- volver al foreground con `ctrl+f ctrl+f`
- listar tareas con `/bg-tasks`
- inspeccionar tareas completadas o en curso
- mantener la vista nativa de sesión y session switcher con proyección controlada por plugin

## Cómo está empaquetado

Hoy el add-on no depende de cambios en runtime/server. Se distribuye como:

- un **plugin TUI** (`background-agents-tui`)
- un **patch versionado del host/core** para OpenCode `1.14.39`
- un lifecycle propio para instalar, revalidar, adoptar una instalación local y restaurarla

En `managed-local-install`, el add-on:

- respalda `~/.opencode` completo
- instala un launcher administrado por el add-on
- persiste un runtime propio en `~/.opencode/bin/opencode-managed-runtime`
- usa la DB real del usuario mediante `OPENCODE_DB`

## Estado actual

- **alpha**
- orientado a **desarrolladores y early adopters técnicos**
- foco en **reversibilidad, trazabilidad y compatibilidad explícita**
- pensado para evolucionar como repo, lifecycle e instalador independientes

## Scope soportado hoy

### Soportado

- `patched-source-checkout` sobre OpenCode **1.14.39**
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
   - instalás el plugin del add-on
   - aplicás el patch versionado a un checkout fuente compatible

2. **Managed local install mode**
   - primero preparás un checkout fuente compatible con `enable`
   - después adoptás `~/.opencode` usando ese checkout como base
   - el install adoptado deja de depender de `/tmp` para ejecutar el runtime administrado

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

- plugin: `~/.config/opencode/plugins/background-agents-tui/index.ts`
- state: `~/.local/state/opencode-addons/opencode-background-tasks/state.json`
- marker de adopción: `~/.opencode/.opencode-background-addon.json`
- runtime administrado: `~/.opencode/bin/opencode-managed-runtime`

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
plugin/       # plugin empaquetado dentro del add-on
patches/      # patch versionado del host/core
lib/          # utilidades de detección, estado, patch, plugin y compat
scripts/      # lifecycle: status, enable, disable, reapply, smoke
docs/         # validación, seguridad y notas complementarias
```

## Limitaciones conocidas

- el patch del host/core sigue siendo sensible a updates de OpenCode
- `managed-local-install` sigue siendo un MVP deliberadamente acotado
- el plugin global sigue siendo compartido entre modos; `restore-local-install` lo remueve solo si sigue intacto
- si venís de una alpha anterior que apuntaba a un runtime efímero, primero restaurá y después re-adoptá con esta versión

## Cómo presentar honestamente esta alpha

> Add-on alpha para OpenCode 1.14.39,
> orientado a checkouts fuente compatibles y a takeover administrado de `~/.opencode` en Linux x64,
> con lifecycle reversible y explícito,
> no todavía como solución universal para cualquier instalación de OpenCode.

## Licencia

Este proyecto se distribuye bajo **GNU GPL v3**. Ver `LICENSE`.
