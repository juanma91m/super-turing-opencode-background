# Changelog

## [Unreleased]

- esta rama empieza a absorber el ownership de la capa async/background que hoy sigue viviendo en `super-turing-opencode`
- se agrega `plugin/background-agents.ts` junto al plugin TUI para que el addon sea dueño completo del behavior async
- se incorporan `PLAYBOOK-ASYNC.md` y `skills/delegacion-async-opencode` como parte del source-of-truth del addon
- se agrega soporte explícito para OpenCode `1.14.41` con patch versionado dedicado
- `adopt-local-install` ahora hace que un `--bun-path` explícito también quede disponible en `PATH` para postinstall/build steps del checkout fuente
- el sidebar nativo de background ahora incluye también delegaciones autónomas, no solo corridas same-session

## 0.1.0-alpha.1

- initial alpha scaffold for an independent OpenCode background tasks addon
- lifecycle MVP with `status`, `enable`, `disable`, `reapply`, `smoke`
- explicit support model for compatible source checkouts
- mode model prepared for future `plugin-only` support
