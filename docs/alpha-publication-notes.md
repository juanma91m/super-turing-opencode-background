# Alpha publication notes

## Cómo presentar honestamente este repo

- Presentarlo como **alpha para desarrolladores/early adopters**.
- Explicar que hoy el addon está pensado para **checkouts fuente compatibles** de OpenCode.
- Aclarar que no soporta todavía instalaciones binarias/globales como `~/.opencode/bin/opencode`, npm/pnpm/bun/yarn global, brew, scoop o choco.

## Disclaimers recomendados para el README

- El addon requiere un target detectado con seguridad.
- El lifecycle falla de forma explícita en métodos de instalación no soportados.
- El patch del host/core sigue siendo sensible a updates de OpenCode.
- El proyecto está preparado para un repo independiente, pero no pretende soporte universal en esta etapa.

## Qué faltaría para una beta más amplia

- Soporte explícito por método de instalación (`curl`, npm, pnpm, bun, yarn, brew, scoop, choco).
- Pruebas automatizadas sobre roots limpios y escenarios de drift/reapply.
- Matriz de compatibilidad más amplia por versiones de OpenCode.
- Release process y CI más completos.
