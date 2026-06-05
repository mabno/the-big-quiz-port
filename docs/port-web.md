# The Big Quiz — Port web (HTML5 + TypeScript)

Port del juego **The Big Quiz** (originalmente escrito en Wollok) a la web, usando
**Vite + TypeScript vanilla** (sin React, sin Phaser, sin dependencias de runtime).

## Cómo correrlo

```bash
npm install      # instala vite + typescript (solo devDependencies)
npm run dev      # levanta el servidor de desarrollo de Vite
```

Otros scripts:

```bash
npm run build        # build de producción (NO usar durante el desarrollo guiado)
npm run preview      # sirve el build de producción
npm run typecheck    # tsc --noEmit (chequeo de tipos sin emitir)
```

## Arquitectura

El juego es ~70% **novela visual** (una máquina de estados: imagen a pantalla
completa + audio por estado, decisiones Left/Right) y ~30% **minijuegos arcade**
(items que caen, movimiento del jugador con `a`/`d`).

### Tablero (heredado de Wollok)

- 32 × 28 celdas, celda de 32 px → **resolución lógica 1024 × 896**.
- **El eje Y crece HACIA ARRIBA** (origen abajo-izquierda), igual que `wollok.game`.
  El renderer convierte a coordenadas de canvas.
- El canvas se escala a la ventana con **letterboxing** manteniendo la relación de aspecto.

### Estructura

```
src/
  engine/
    types.ts         # Tipos núcleo: NarrativeNode, Scene, GameContext, MinigameConfig.
    renderer.ts      # Canvas único, escala con letterbox, cache de imágenes, drawSprite (eje Y Wollok).
    audio.ts         # AudioManager sobre HTMLAudioElement: música única + sfx, unlock() por autoplay.
    input.ts         # Teclado: onKey(...) con limpieza por escena + isDown(...) para el minijuego.
    stateMachine.ts  # Autómata: registro de nodos, transiciones (id o función de puntaje), efectos onEnter.
    assets.ts        # Mapea nombres "pelados" a URLs /assets/... (carpeta plana).
  scenes/
    narrative.ts     # Escena de novela visual (implementación real).
    minigame.ts      # Minijuego arcade del mono (caída continua de ítems, sprites 2x2 celdas).
    data/tree.ts     # PLACEHOLDER del árbol de estados (lo reemplaza el port de tree.wlk).
  main.ts            # Arranque: pantalla de inicio → unlock de audio → escena narrativa.
public/
  assets/            # 319 assets (177 PNG + 141 MP3 + 1 JPG), nombres originales exactos.
```

### Sistema de audio

Solo suena **una pista de música a la vez**: cambiar de pista corta la previa
(replica el `alternar()` de `musica.wlk`). Los efectos de sonido (sfx) se reproducen
encima sin cortar la música. Por la política de autoplay del navegador, el audio se
**desbloquea con la primera tecla** (pantalla de inicio).

### Puntaje y ramificación

El puntaje vive en el `GameContext`. Algunos nodos ramifican según el puntaje:
las transiciones pueden ser un id de nodo **o una función** del contexto que devuelve
el id destino (replica `EstadoResultado`/`EstadoFinExamen`, que en Wollok hacían
`transiciones().get(juego.puntaje())`).

### Minijuego del mono — drift respecto del original

La MECÁNICA es fiel al Wollok original (tablero, tipos de ítem, puntajes,
dificultad, ventana de colisión, condiciones de fin), pero la PRESENTACIÓN se
despega deliberadamente:

- **Sprites a 2×2 celdas (64 px)**: el mono y los ítems se dibujan al doble del
  tamaño. Los PNG son de 64×64 nativos, así que se ven 1:1 (a 1 celda / 32 px se
  reducían a la mitad). Solo cambia el dibujo: la colisión sigue siendo por celda
  exacta (`item.x == jugador.x`), como en el original.
- **Caída continua de los ítems**: en `wollok.game` los ítems bajaban de a 1 celda
  por tick (limitación de grid del motor). Acá `item.y` es un float que avanza por
  frame, con la velocidad equivalente exacta (1 celda cada `delay` ticks de 100 ms).
  La colisión se muestrea por tick sobre `Math.round(y)`, así que la ventana de
  atrape dura lo mismo que en el original.
- **Animación del mono**: la lógica de movimiento sigue siendo por celdas (un
  keydown = una celda, clamp 0..31, colisión sobre `playerX` entero), pero el
  sprite se desliza hacia su celda destino con un ease exponencial
  (`playerVisualX`) en vez de teletransportarse de celda en celda.
- **Bugfix de velocidad (2×)**: la escena corría un `requestAnimationFrame` propio
  y ADEMÁS el bucle global de `main.ts` le llamaba `update(dt)`; el update doble
  llenaba el acumulador de ticks al doble y el minijuego corría a **2× la
  velocidad del original**. Ahora el único driver de update/render es el bucle
  global.

El detalle fino está comentado en la cabecera de `src/scenes/minigame.ts`
(sección «DESVÍOS DELIBERADOS DEL ORIGINAL»).
