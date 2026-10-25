# Upgrade controlado a OpenCode 1.19.4

Esta guía prepara el salto desde el `managed-local-install` actual hacia
OpenCode `1.19.4`. No corresponde ejecutar `opencode upgrade`: el binario
productivo está construido desde fuente y contiene un patch de host.

## Estado validado

- release estable objetivo: `v1.19.4`
- patch dedicado: `patches/opencode/1.19.4.patch`
- `git apply --check`: OK sobre el tag `v1.19.4`
- cambio upstream relevante desde `1.18.35`: eliminación de los comandos TUI
  de share/unshare; el nuevo patch omite únicamente esos hunks obsoletos
- typecheck: `packages/plugin`, `packages/tui` y `packages/opencode`: OK
- tests TUI: 205 OK, 1 skip, 0 fallos
- build Linux x64 con Bun `1.4.4`: OK
- binario construido: `--version` y `debug config`: OK
- smoke del lifecycle del addon: OK

## Precondiciones

1. Cerrar todas las sesiones de OpenCode.
2. Confirmar que el repo del addon no tiene cambios inesperados.
3. Confirmar que el estado actual informa `managed-local-install: adopted`,
   `launcher.matchesExpected: true` y `problems: []`.
4. Revisar espacio disponible y el dry-run del restore antes de modificar
   `~/.opencode`.

```bash
df -h "$HOME"
node ./scripts/status.mjs --install-root ~/.opencode --json
node ./scripts/restore-local-install.mjs --install-root ~/.opencode --dry-run
```

## Ejecución

Desde el root de este addon:

```bash
node ./scripts/restore-local-install.mjs --install-root ~/.opencode
node ./scripts/enable.mjs \
  --opencode-root "$HOME/.local/src/opencode-background-source-1.19.4"

OPENCODE_CHANNEL=background \
OPENCODE_VERSION="1.19.4--$(date -u +%Y%m%d%H%M)" \
PATH="$HOME/.local/opt/bun-1.4.4/bun-linux-x64:$PATH" \
  "$HOME/.local/opt/bun-1.4.4/bun-linux-x64/bun" \
  run --cwd "$HOME/.local/src/opencode-background-source-1.19.4" \
  packages/opencode/script/build.ts --single

node ./scripts/adopt-local-install.mjs \
  --checkout-root "$HOME/.local/src/opencode-background-source-1.19.4" \
  --install-root ~/.opencode \
  --bun-path "$HOME/.local/opt/bun-1.4.4/bun-linux-x64/bun"
```

El instalador completo (`bash ./scripts/install.sh`) también apunta a `1.19.4`,
pero si ya hay una adopción sana puede terminar sin cambios. Para una migración
de versión explícita, usá el restore + enable + build + adopt de arriba.
`OPENCODE_CHANNEL=background` conserva el runtime como build no oficial y
`OPENCODE_VERSION` deja visible tanto la versión fuente como su timestamp, por
ejemplo `1.19.4--202610071738`.

### Espacio insuficiente para el backup de storage

`adopt-local-install` crea por defecto un backup completo del storage. Si no hay
espacio suficiente y ya existe un rollback de datos válido, se puede usar
`--skip-storage-backup` como excepción explícita. Esta opción reduce las
garantías de rollback y queda registrada en el estado del addon; no debe usarse
silenciosamente ni como default.

## Validación posterior

```bash
node ./scripts/status.mjs --install-root ~/.opencode --json
opencode --version
opencode debug config >/dev/null
```

No compartir la salida completa de `debug config`: puede resolver referencias a
archivos y mostrar headers sensibles. Para esta validación alcanza su exit code.

Además de la configuración, validar manualmente:

- `ctrl+b ctrl+b` envía la sesión al background
- `ctrl+f ctrl+f` vuelve al foreground
- `/bg-tasks` lista e inspecciona tareas
- el selector nativo de sesiones conserva la proyección del addon
- el aviso de subagentes pendientes aparece ante permisos o preguntas

## Rollback

`restore-local-install` restaura el árbol de instalación, pero no restaura
automáticamente el storage de sesiones. Si el binario nuevo ya llegó a abrir el
storage y luego falla, no ejecutar una versión anterior contra esos datos sin
revisar primero el backup de storage asociado. El rollback de datos debe ser una
operación separada y explícita.
