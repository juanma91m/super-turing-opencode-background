# Managed local install security note

## Por qué este modo es más seguro que tocar el binario directamente

El objetivo no es parchear `~/.opencode/bin/opencode` en sitio.

En cambio, el addon trata `~/.opencode` como una **unidad de instalación**:

- respalda el root completo,
- registra metadata suficiente para restore,
- instala un launcher administrado por el addon,
- y deja un camino explícito de vuelta al estado anterior.

## Garantías reales del MVP

- no modifica el ELF existente byte a byte;
- el restore opera sobre la instalación completa, no sobre un archivo aislado;
- el addon puede negarse a operar si faltan precondiciones explícitas;
- el estado persistido guarda el backup path, el checkout base y el bun path usados para la adopción.

## Cuándo debería negarse a operar

El addon debe fallar explícitamente si:

- no detecta una instalación `curl-binary` administrable,
- no recibe un `--checkout-root` compatible,
- no puede resolver un `bun` válido,
- ya hay una instalación local administrada activa,
- falta metadata suficiente para restore.
