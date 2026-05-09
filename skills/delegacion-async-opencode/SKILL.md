---
name: delegacion-async-opencode
description: Condensa el workflow async de OpenCode para delegaciones read-only e isolated-write con foco en task packet, lifecycle y review segura.
compatibility: opencode
---
## Cuando usarme
- Antes de usar `delegate`, `delegate_isolated` o cualquier `delegation_*`.
- Cuando hay que decidir entre delegación read-only vs write-capable aislada.
- Cuando hace falta recordar el lifecycle, los artifacts o las precondiciones de apply/review.

## Regla de oro
Siempre mandar un **task packet explícito** al delegar:

- objetivo,
- por qué,
- alcance,
- hechos relevantes,
- rutas exactas,
- referencias de memoria si aplican,
- formato esperado,
- output budget chico.

## Qué usar y cuándo
- `delegate(prompt, agent)`: investigación, inspección, review o diseño read-only.
- `delegate_isolated(prompt, agent, name?)`: implementación paralela write-capable en worktree aislado.
- `delegation_tail(id)`: seguir progreso incremental.
- `delegation_read(id, wait?)`: leer estado o resultado completo.
- `delegation_continue(id, prompt)`: retomar una delegación read-only completada.
- `delegation_cancel(id|all=true)`: cancelar pending/running.
- `delegation_accept(id)`: aceptar una aislada revisada.
- `delegation_apply(id)`: aplicar una aislada aceptada al workspace principal.
- `delegation_discard(id)`: descartar una aislada y limpiar worktree.

## Guardrails operativos
- `delegate` es solo read-only; no usarlo para trabajo que deba editar.
- `delegate_isolated` no hace auto-merge ni auto-commit.
- Antes de `delegation_apply(id)`, la delegación debe estar `accepted` y el workspace principal debe estar limpio.
- No usar `delegation_list()` como polling continuo; preferir `delegation_tail(id)`.
- La sesión hija aislada tiene `bash` deshabilitado por defecto; la validación shell queda para review manual o una variante explícita futura.
- `delegate_isolated` requiere la API `/experimental/worktree`; en sesiones locales directas puede convenir una sesión server-backed.

## Lifecycle a recordar
- Read-only: `pending` -> `running` -> `completed` / `cancelled` / `error`.
- Isolated write: `running` -> `review_pending` -> `accepted` -> `applied`, o `running/review_pending/accepted` -> `discarded`.

## Artifacts de una aislada
- `meta.json`
- `result.md`
- `changed-files.json`
- `git-status.txt`
- `diff.patch`
- `worktree.json`
- `<id>.md`

## Validación mínima antes de aplicar
- el diff sigue siendo deseable,
- toca solo lo esperado,
- no hubo desvío de alcance,
- el workspace principal está limpio.
