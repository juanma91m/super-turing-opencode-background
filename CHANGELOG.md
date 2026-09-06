# Changelog

## [Unreleased]

- el plugin TUI usa `session_notice` para mostrar en tiempo real cuántos subagentes están detenidos esperando permisos o respuestas, sin agregar otro cambio al patch del host
- el installer bootstrappea Bun `1.3.14` en un runtime user-space propio cuando no existe, verificando el SHA-256 fijado por el manifest; versión del addon `0.1.0-alpha.5`
- se agrega soporte validado para OpenCode `1.18.18`; como el release no modifica ninguna superficie tocada por el host patch, reutiliza explícitamente el patch `1.18.17` después de `git apply --check`
- el preflight valida ahora la versión local de OpenCode antes de aceptar Bun o modificar el sistema; versión del addon `0.1.0-alpha.4`
- se agrega `scripts/preflight.sh` para que la distribución valide Bun antes de modificar la instalación global; también detecta las ubicaciones oficiales `~/.bun/bin/bun` y `~/.local/bin/bun` aunque el shell todavía no haya actualizado `PATH`
- versión del addon `0.1.0-alpha.3`
- se agrega `scripts/install.sh` como contrato estable de distribución: prepara el checkout OpenCode preferido, ejecuta `enable` y adopta la instalación local sin mover esa lógica al stack base
- `manifest/addon.json` declara versión OpenCode y repo fuente preferidos para bootstrap; versión del addon `0.1.0-alpha.2`

- `plugin/background-agents.ts` ahora inyecta una guía mucho más compacta y solo en agentes callers relevantes para bajar costo fijo de contexto sin perder el workflow async
- esta rama empieza a absorber el ownership de la capa async/background que hoy sigue viviendo en `super-turing-opencode`
- se agrega `plugin/background-agents.ts` junto al plugin TUI para que el addon sea dueño completo del behavior async
- se incorporan `PLAYBOOK-ASYNC.md` y `skills/delegacion-async-opencode` como parte del source-of-truth del addon
- se agrega soporte explícito para OpenCode `1.14.46`, `1.14.48`, `1.14.49`, `1.15.0`, `1.15.3`, `1.15.6`, `1.15.13`, `1.16.2`, `1.17.15`, `1.17.20` y `1.18.17`; `1.17.20` reutiliza el patch validado de `1.17.15` y `1.18.17` usa patch propio por cambio de minor
- `adopt-local-install` ahora hace que un `--bun-path` explícito también quede disponible en `PATH` para postinstall/build steps del checkout fuente
- el sidebar nativo de background ahora incluye también delegaciones autónomas, no solo corridas same-session
- el patch de OpenCode `1.18.17` ahora aísla la selección manual de variant por agente/modelo y respeta el `variant` configurado por agente para evitar que `high` de `master-dev` se filtre a agentes `medium` o `low`
- en `1.14.46`, `1.14.48`, `1.14.49`, `1.15.0`, `1.15.3`, `1.15.6`, `1.15.13`, `1.16.2`, `1.17.15`, `1.17.20` y `1.18.17`, los atajos async siguen plugin-side y el sidebar visible mantiene el apoyo en patch host por estabilidad
- el addon instala también `PLAYBOOK-ASYNC.md` y `skills/delegacion-async-opencode/SKILL.md` para que la distribución background sea autosuficiente fuera del stack base

## 0.1.0-alpha.1

- initial alpha scaffold for an independent OpenCode background tasks addon
- lifecycle MVP with `status`, `enable`, `disable`, `reapply`, `smoke`
- explicit support model for compatible source checkouts
- mode model prepared for future `plugin-only` support
