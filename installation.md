# Installation

Esta guía documenta el flujo **soportado real** del add-on `opencode-background-tasks`.

## Antes de empezar

Scope soportado hoy:

- OpenCode **1.14.39**, **1.14.41**, **1.14.42**, **1.14.46**, **1.14.48**, **1.14.49**, **1.15.0**, **1.15.3**, **1.15.6**, **1.15.13**, **1.16.2**, **1.17.15** o **1.17.20**
- modo `patched-source-checkout`
- modo `managed-local-install` sobre `~/.opencode`
- `managed-local-install` validado en **Linux x64**

Esto **no** es todavía una instalación `plugin-only` sobre builds oficiales de OpenCode.

## Prerequisitos

- `node`
- `git`
- un checkout fuente compatible de OpenCode `1.14.39`, `1.14.41`, `1.14.42`, `1.14.46`, `1.14.48`, `1.14.49`, `1.15.0`, `1.15.3`, `1.15.6`, `1.15.13`, `1.16.2`, `1.17.15` o `1.17.20`
- para `managed-local-install`: `bun`
- permisos para escribir en:
  - `~/.config/opencode/plugins/`
  - `~/.local/state/opencode-addons/`
  - `~/.opencode/` si vas a adoptar la instalación local

Desde el root de este repo podés inspeccionar el target con:

```bash
node ./scripts/status.mjs --opencode-root /ruta/al/opencode-checkout
```

## Opción A: instalar sobre un source checkout compatible

Usá este flujo si querés trabajar el add-on directamente sobre un checkout fuente de OpenCode.

### 1. Verificar compatibilidad

```bash
node ./scripts/status.mjs --opencode-root /ruta/al/opencode-checkout
```

Esperado:

- `mode: patched-source-checkout`
- `compat version: ok`

### 2. Instalar el add-on

```bash
node ./scripts/enable.mjs --opencode-root /ruta/al/opencode-checkout
```

Esto hace dos cosas:

- instala los plugins del add-on en `~/.config/opencode/plugins/`
  - `background-agents.ts`
  - `background-agents-tui/index.ts`
- instala assets auxiliares del workflow async en `~/.config/opencode/`
  - `PLAYBOOK-ASYNC.md`
  - `skills/delegacion-async-opencode/SKILL.md`
- aplica el patch versionado del host/core sobre el checkout fuente compatible

Con esa instalación completa, los agentes ya pasan a conocer las tools async/background del addon sin necesitar una skill de acoplamiento extra. El plugin server/runtime (`background-agents.ts`) expone las tools y reglas, y el plugin TUI (`background-agents-tui`) aporta la UX visible.

### 3. Validar el flujo mínimo

```bash
node ./scripts/smoke.mjs --opencode-root /ruta/al/opencode-checkout
```

### 4. Desinstalar o revertir

```bash
node ./scripts/disable.mjs --opencode-root /ruta/al/opencode-checkout
```

## Opción B: instalar como managed local install add-on

Usá este flujo si querés que el comando local de OpenCode quede corriendo con la UX del add-on.

### Importante

Este modo requiere primero preparar un checkout fuente compatible. El add-on **no** parchea directamente el ELF existente: usa ese checkout como base, compila o reutiliza un runtime compatible y después adopta `~/.opencode` como unidad completa.

### 1. Preparar el checkout fuente base

```bash
node ./scripts/enable.mjs --opencode-root /ruta/al/opencode-checkout
```

Si este paso no corre primero, `adopt-local-install` corta a propósito.

### 2. Adoptar `~/.opencode`

```bash
node ./scripts/adopt-local-install.mjs \
  --checkout-root /ruta/al/opencode-checkout \
  --bun-path /ruta/al/bun
```

`--bun-path` puede apuntar a un binario standalone fuera de `PATH`; el lifecycle lo agrega al entorno durante `bun install` y durante la build del runtime administrado.

Esto:

- hace backup de `~/.opencode`
- hace backup de storage relevante del usuario
- copia el runtime administrado a `~/.opencode/bin/opencode-managed-runtime`
- deja `~/.opencode/bin/opencode` como launcher del add-on

### 3. Validar la instalación adoptada

```bash
node ./scripts/status.mjs --install-root ~/.opencode
~/.opencode/bin/opencode --version
```

Si tu shell ya resuelve `opencode` a `~/.opencode/bin/opencode`, también podés validar:

```bash
opencode --version
```

Esperado después de una adopción sana:

- `managed-local-install: adopted`
- `runtimeBinaryPath` apunta dentro de `~/.opencode/bin/`
- el launcher ya no referencia `/tmp`
- el comando instalado devuelve una build del add-on del estilo `0.0.0--<timestamp>`

Ejemplo de validación fresca del lifecycle:

```bash
opencode --version
0.0.0--<timestamp>
```

Si reconstruís el runtime desde otra build, el sufijo timestamp puede variar. Lo importante es que ya no esté ejecutando la versión local original `1.14.39`, `1.14.41`, `1.14.42`, `1.14.46`, `1.14.48`, `1.14.49`, `1.15.0`, `1.15.3`, `1.15.6`, `1.15.13`, `1.16.2`, `1.17.15` o `1.17.20` del install previo.

### 4. Actualizar una instalación ya adoptada a otra versión soportada

Si ya estabas en `managed-local-install` sobre otra versión soportada (por ejemplo `1.14.39`, `1.14.41`, `1.14.42`, `1.14.46`, `1.14.48`, `1.14.49`, `1.15.0`, `1.15.3`, `1.15.6`, `1.15.13`, `1.16.2` o `1.17.15`) y querés pasar a `1.17.20`:

1. restaurá el install actual:

   ```bash
   node ./scripts/restore-local-install.mjs
   ```

2. prepará el nuevo checkout fuente:

   ```bash
   node ./scripts/enable.mjs --opencode-root /ruta/al/nuevo-opencode-checkout
   ```

3. re-adoptá `~/.opencode` usando ese checkout:

   ```bash
   node ./scripts/adopt-local-install.mjs \
     --checkout-root /ruta/al/nuevo-opencode-checkout \
     --bun-path /ruta/al/bun
   ```

Notas útiles del lifecycle actual:

- `restore-local-install` puede dejar los plugins globales en sitio si detecta que fueron modificados respecto del estado guardado; después `enable` los vuelve a reconciliar contra el source-of-truth actual del add-on.
- la validación final debería mostrar `checkoutVersion` apuntando a la nueva versión soportada.

### 5. Restaurar la instalación local original

```bash
node ./scripts/restore-local-install.mjs
```

Comportamiento esperado:

- restaura `~/.opencode` desde el backup
- elimina los plugins y assets auxiliares globales del add-on si siguen intactos
- si el plugin fue modificado manualmente, lo deja en sitio y lo informa

### 6. Revertir también el checkout fuente base

Si querés cerrar completamente el flujo y devolver también el checkout fuente a su estado previo:

```bash
node ./scripts/disable.mjs --opencode-root /ruta/al/opencode-checkout
```

## Validación adicional recomendada

Revisá también:

- [`docs/validation.md`](./docs/validation.md)
- [`docs/security-managed-local-install.md`](./docs/security-managed-local-install.md)

Especialmente para `managed-local-install`, conviene validar:

```bash
node ./scripts/status.mjs --install-root ~/.opencode --json
grep -n "opencode-managed-runtime\|/tmp/" ~/.opencode/bin/opencode
```

Esperado:

- `launcher.matchesExpected: true`
- `problems: []`
- el launcher referencia `opencode-managed-runtime`
- el launcher no necesita referenciar `/tmp`

## Qué hacer si venís de una alpha anterior

Si ya habías adoptado `~/.opencode` con una alpha previa que dejaba el launcher apuntando a un runtime efímero o externo:

1. corré `node ./scripts/status.mjs --install-root ~/.opencode`
2. corré `node ./scripts/restore-local-install.mjs`
3. volvé a seguir esta guía desde el principio

El lifecycle actual detecta esas adopciones legacy como `broken`, pero sigue permitiendo el recovery cuando marker + backup siguen siendo confiables.
