# Upgrade controlado a OpenCode 1.18.30

Esta guía prepara el salto desde el `managed-local-install` actual basado en
OpenCode `1.18.17` hacia `1.18.30`. No corresponde ejecutar `opencode upgrade`:
el binario productivo está construido desde fuente y contiene un patch de host.

## Estado validado

- release estable objetivo: `v1.18.30`
- patch reutilizado: `patches/opencode/1.18.17.patch`
- `git apply --check`: OK sobre el tag `v1.18.30`
- cambios upstream entre `1.18.17` y `1.18.30` sobre archivos parcheados:
  `packages/tui/src/component/prompt/index.tsx` y
  `packages/tui/src/routes/session/index.tsx`; no solapan los hunks del addon
- typecheck: `packages/plugin`, `packages/tui` y `packages/opencode`: OK
- tests TUI focalizados: 11 OK
- build Linux x64 con Bun `1.3.14`: OK
- binario construido: `--version` y `debug config`: OK

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
bash ./scripts/install.sh \
  --workspace-dir "$HOME/.local/src" \
  --bun-path "$HOME/.local/opt/bun-1.3.14/bun-linux-x64/bun"
```

El instalador debe clonar `v1.18.30` en
`~/.local/src/opencode-background-source-1.18.30`, aplicar el patch, construir
el runtime y crear un backup nuevo del storage antes de adoptar la instalación.

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
automáticamente el storage de sesiones. OpenCode `1.18.30` incorpora cambios de
base de datos; si el binario nuevo ya llegó a abrir el storage y luego falla,
no ejecutar una versión anterior contra esos datos sin revisar primero el
backup de storage creado por la nueva adopción. El rollback de datos debe ser
una operación separada y explícita.
