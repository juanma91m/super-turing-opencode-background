# Roadmap

## Desde esta alpha hacia un addon real

### Estado actual

- modo soportado hoy: `patched-source-checkout`
- modo objetivo futuro: `plugin-only`
- modo no soportado actual: instalaciones binarias/globales

### Próximos pasos dependientes del addon

1. mantener el lifecycle seguro y explícito
2. ampliar smoke coverage
3. mejorar documentación y release process
4. seguir refinando compat metadata por versión y modo

### Próximos pasos dependientes de upstream

1. disponibilidad oficial de los host hooks requeridos
2. builds oficiales de OpenCode donde el addon pueda activarse en `plugin-only`
3. reducción o eliminación del patch local

### Criterio de salida de alpha

Para acercarse a beta, este addon debería poder:

- operar sin patch en al menos una versión oficial de OpenCode,
- mantener la UX actual intacta,
- soportar un camino de instalación realista más allá del source checkout.
