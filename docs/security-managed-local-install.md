# Managed local install security note

## Por qué este modo es más seguro que tocar el binario directamente

El objetivo no es parchear `~/.opencode/bin/opencode` en sitio.

En cambio, el addon trata `~/.opencode` como una **unidad de instalación**:

- respalda el root completo,
- registra metadata suficiente para restore,
- copia un runtime administrado dentro del install root adoptado,
- instala un launcher administrado por el addon,
- y deja un camino explícito de vuelta al estado anterior.

## Garantías reales del MVP

- no modifica el ELF existente byte a byte;
- el launcher final apunta a un runtime persistido dentro de `~/.opencode`, no a un checkout efímero;
- los binarios auxiliares preservados desde `~/.opencode/bin/` se copian/dereferencian en el install administrado, no quedan como symlinks hacia el backup;
- el restore opera sobre la instalación completa, no sobre un archivo aislado;
- el addon puede negarse a operar si faltan precondiciones explícitas;
- el marker del install root y el estado persistido guardan metadata suficiente para auditar launcher, runtime y backup path.

## Cuándo debería negarse a operar

El addon debe fallar explícitamente si:

- no detecta una instalación `curl-binary` administrable,
- no recibe un `--checkout-root` compatible,
- no puede resolver un `bun` válido,
- ya hay una instalación local administrada activa,
- falta metadata suficiente para restore,
- el launcher real no coincide con el runtime esperado,
- falta el backup,
- algún binario auxiliar preservado queda como symlink roto,
- o el root ya no parece una instalación administrada reconocible.

## Recovery de adopciones legacy

Si una adopción vieja quedó con launcher válido pero runtime externo perdido, el addon puede seguir permitiendo `restore-local-install` siempre que el marker y el backup sigan siendo confiables.
Eso evita quedar atrapado por una alpha anterior sin abrir la puerta a sobrescribir roots ambiguos.
La misma lógica permite restaurar cuando el único drift detectado son binarios auxiliares rotos: el backup completo sigue siendo la fuente confiable para volver al estado previo.
