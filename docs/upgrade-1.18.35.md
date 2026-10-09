# Upgrade controlado a OpenCode 1.18.35

Esta guía prepara el salto desde el `managed-local-install` actual hacia
OpenCode `1.18.35`. No corresponde ejecutar `opencode upgrade`: el binario
productivo está construido desde fuente y contiene un patch de host.

## Estado validado

- release estable objetivo: `v1.18.35`
- patch reutilizado: `patches/opencode/1.18.17.patch`
- `git apply --check`: OK sobre el tag `v1.18.35`
- cambios upstream entre `1.18.30` y `1.18.35` sobre archivos parcheados: ninguno
- typecheck: `packages/plugin`, `packages/tui` y `packages/opencode`: OK
- tests TUI focalizados: 15 OK
- build Linux x64 con Bun `1.3.14`: OK
- binario construido: `--version` y `debug config`: OK
- smoke del lifecycle del addon: OK

## Precondiciones

1. Cerrar todas las sesiones de OpenCode.
2. Confirmar que el repo del addon no tiene cambios inesperados.
3. Confirmar que el estado actual informa `managed-local-install: adopted`,
   `launcher.matchesExpected: true` y `problems: []`.
4. Revisar el dry-run del restore antes de modificar `~/.opencode`.

```bash
node ./scripts/status.mjs --install-root ~/.opencode --json
node ./scripts/restore-local-install.mjs --install-root ~/.opencode --dry-run
```

## Ejecución

Desde el root de este addon:

```bash
node ./scripts/restore-local-install.mjs --install-root ~/.opencode
node ./scripts/enable.mjs \
  --opencode-root "$HOME/.local/src/opencode-background-source-1.18.35"
node ./scripts/adopt-local-install.mjs \
  --checkout-root "$HOME/.local/src/opencode-background-source-1.18.35" \
  --install-root ~/.opencode \
  --bun-path "$HOME/.local/opt/bun-1.3.14/bun-linux-x64/bun"
```

El instalador completo (`bash ./scripts/install.sh`) también apunta a `1.18.35`,
pero si ya hay una adopción sana puede terminar sin cambios. Para una migración
de versión explícita, usá el restore + enable + adopt de arriba.

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
revisar primero el backup de storage creado por la nueva adopción. El rollback
de datos debe ser una operación separada y explícita.
