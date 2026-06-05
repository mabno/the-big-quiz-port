// minigame.ts — Escena del minijuego arcade del mono (el ~30% del juego).
//
// Port FIEL de EstadoMinijuego (src/tree.wlk, líneas 199-281) + las clases de
// src/minijuego.wlk (Item / Banana / Mate / Cafe / jugador / puntaje).
//
// MECÁNICA ORIGINAL (verificada contra el código Wollok):
//   - Tablero 32x28. El jugador (mono) arranca en game.at(1,1) y se mueve con
//     "a" (izquierda, imagen mono1.png) / "d" (derecha, imagen mono2.png).
//     Clamp: izquierda no baja de x=0, derecha no pasa de x=31.
//   - Caen ítems desde y=27 hacia y=0 (el eje Y crece HACIA ARRIBA): cada ítem
//     baja 1 celda cada `delay` ticks. Tipos: Banana (+2), Mate (+4), Cafe (-15).
//   - Colisión: si item.x == jugador.x && item.y == jugador.y -> aplica puntaje,
//     suena coin.mp3 (acierto, delta>0) o error.mp3 (penalización), y se quita el ítem.
//   - Si item.y == 0 sin colisión -> se quita.
//   - Spawn: cuando el contador llega a 8/dificultad aparece un ítem en x aleatorio
//     (0..31), y=27. Probabilidades: random<20 Banana, <40 Mate, resto Cafe.
//     delay = 4/dificultad.
//   - Dificultad: arranca en 1; pasa a 2 cuando el puntaje del minijuego >= 15.
//   - FIN: puntaje < loseScore (0) -> pierde (config.loseNode);
//          puntaje >= winScore (30) -> gana (config.winNode).
//   - El tick original era game.onTick(100, "actualizar", ...) => 100 ms/tick.
//     Acá usamos un acumulador de dt para emular ese paso fijo (NO atamos la
//     velocidad del juego a los FPS).
//   - HUD: marcador "Puntaje: N" en game.at(1, 26), color #FFFFFF.
//
// OJO (decisión clave): el puntaje del minijuego es el objeto `puntaje` de Wollok,
// SEPARADO del puntaje narrativo `juego.puntaje` (= ctx.score, usado para ramificar
// los quizzes). Por eso acá llevamos un puntaje LOCAL y NO tocamos ctx.score.
//
// DESVÍOS DELIBERADOS DEL ORIGINAL (presentación; la mecánica NO cambia):
//   - Sprites a 2x2 celdas: mono e ítems se dibujan a SPRITE_CELLS (64 px). Los PNG
//     son de 64x64 nativos, así que a 2 celdas se ven 1:1, sin reescalado. Solo
//     cambia el dibujo: la colisión sigue siendo por celda exacta, como en Wollok.
//   - Caída CONTINUA: item.y es float y avanza por frame (dt) en update(), en vez
//     de bajar de a 1 celda por tick (limitación de grid de wollok.game). La
//     velocidad es la equivalente exacta (1 celda cada `delay` ticks de 100 ms) y
//     la colisión se muestrea por tick sobre Math.round(y), así la ventana de
//     atrape dura lo mismo que en el original.
//   - Animación del mono: la LÓGICA de movimiento sigue siendo por celdas (un
//     keydown = una celda, playerX entero, colisión idéntica), pero el sprite se
//     desliza hacia su celda destino con un ease exponencial (playerVisualX) en
//     vez de teletransportarse de celda en celda.
//   - El update/render lo maneja SOLO el bucle global de main.ts. Antes esta escena
//     corría ADEMÁS un rAF propio: el update doble llenaba el acumulador a 2x y el
//     minijuego corría al DOBLE de velocidad que el original.

import type { GameContext, MinigameConfig, Scene } from '../engine/types.js';
import { BOARD_WIDTH } from '../engine/renderer.js';

/** Callback que devuelve el control a la narrativa en un nodo dado. */
export type MinigameFinish = (nodeId: string) => void;

/** Paso de simulación original: 100 ms por tick (game.onTick(100, ...)). */
const TICK_MS = 100;

/** Fila inferior visible del tablero donde el mono "atrapa" los ítems (game.at(1,1)). */
const PLAYER_START_X = 1;
const PLAYER_START_Y = 1;

/** Fila desde la que caen los ítems (Wollok: y=27). */
const SPAWN_Y = 27;

/**
 * Tamaño VISUAL de los sprites del minijuego (mono e ítems), en celdas.
 * Los PNG son de 64x64 nativos y a 1 celda (32 px) se veían reducidos a la
 * mitad; a 2 celdas se dibujan 1:1. Solo afecta el dibujo: la colisión sigue
 * siendo por celda lógica, como en el original.
 */
const SPRITE_CELLS = 2;

/**
 * Tope de dt por frame (en ms). Con la pestaña en segundo plano rAF se pausa
 * y el primer frame de vuelta llega con un dt enorme: sin tope, los ítems
 * atravesarían filas enteras de golpe (túnel) y el acumulador dispararía una
 * ráfaga de ticks juntos.
 */
const MAX_FRAME_MS = 250;

/**
 * Constante de tiempo (ms) del ease exponencial con el que el SPRITE del mono
 * se desliza hacia su celda lógica. A 40 ms cubre ~95% del recorrido en 120 ms
 * (= HOLD_REPEAT_MS del input táctil), así la animación nunca se queda atrás
 * del auto-repeat al mantener apoyado. La lógica/colisión usa playerX ENTERO.
 */
const PLAYER_EASE_MS = 40;

/** Tipos de ítem que caen y su efecto en el puntaje (minijuego.wlk). */
type ItemKind = 'banana' | 'mate' | 'cafe';

/** Sprite y delta de puntaje por tipo de ítem. */
const ITEM_SPRITE: Record<ItemKind, string> = {
  banana: 'banana.png',
  mate: 'mate.png',
  cafe: 'cafe.png',
};
const ITEM_SCORE: Record<ItemKind, number> = {
  banana: 2,
  mate: 4,
  cafe: -15,
};

/** Un ítem que cae (clase Item de minijuego.wlk). */
interface FallingItem {
  kind: ItemKind;
  x: number;
  /** Posición vertical CONTINUA, en celdas (float). Fila lógica = Math.round(y). */
  y: number;
  /**
   * Velocidad de caída en celdas/ms. Equivale al `delay` del original (1 celda
   * cada `delay` ticks de 100 ms): speed = 1 / (delay * TICK_MS).
   */
  speed: number;
}

export class MinigameScene implements Scene {
  private readonly ctx: GameContext;
  private readonly config: MinigameConfig;
  private readonly onFinish: MinigameFinish;

  /** Acumulador para emular el tick fijo de 100 ms (el dt llega del bucle global). */
  private accumulator = 0;

  // --- Estado del minijuego (todo se reinicia en enter()) ---

  /** Puntaje LOCAL del minijuego (Wollok: objeto `puntaje`, separado de ctx.score). */
  private score = 0;
  /** Dificultad: 1 -> 2 cuando score >= 15. */
  private dificultad = 1;
  /** Contador de spawn (Wollok: nuevoItem). */
  private nuevoItem = 0;
  /** Ítems vivos cayendo (Wollok: lista `items`). */
  private items: FallingItem[] = [];
  /** Posición del jugador (mono). Solo varía x; y queda fija en la fila de juego. */
  private playerX = PLAYER_START_X;
  private playerY = PLAYER_START_Y;
  /** X VISUAL del mono (float): persigue a playerX con ease; solo afecta el dibujo. */
  private playerVisualX = PLAYER_START_X;
  /** Sprite actual del mono: mono1 mirando a la izquierda, mono2 a la derecha. */
  private playerSprite: 'mono1.png' | 'mono2.png' = 'mono1.png';
  /** Bandera para no llamar a finish() más de una vez. */
  private finished = false;

  /** Funciones de limpieza de los handlers de teclado (scope por escena). */
  private cleanups: Array<() => void> = [];

  /**
   * CONTRATO DEL CONSTRUCTOR:
   *   new MinigameScene(ctx, config, onFinish)
   * - ctx: contexto del juego (audio, input, renderer, puntaje).
   * - config: parámetros del minijuego (variant, winNode, loseNode, winScore, loseScore, music).
   * - onFinish: callback que recibe el id de nodo destino y devuelve el control
   *   a la escena narrativa. Por convención, el llamador hace
   *   `ctx.resumeNarrative(nodeId)` dentro de este callback.
   */
  constructor(ctx: GameContext, config: MinigameConfig, onFinish: MinigameFinish) {
    this.ctx = ctx;
    this.config = config;
    this.onFinish = onFinish;
  }

  enter(): void {
    // Reinicio completo del estado del minijuego (cada partida arranca limpia).
    this.score = 0;
    this.dificultad = 1;
    this.nuevoItem = 0;
    this.items = [];
    this.playerX = PLAYER_START_X;
    this.playerY = PLAYER_START_Y;
    this.playerVisualX = PLAYER_START_X;
    this.playerSprite = 'mono1.png';
    this.finished = false;
    this.accumulator = 0;

    // Música de fondo del minijuego (Wollok: minijuego.mp3, volumen 0.4 en musica.wlk).
    if (this.config.music) {
      this.ctx.audio.playMusic(this.config.music.file, {
        loop: this.config.music.loop ?? true,
        volume: this.config.music.volume ?? 0.4,
      });
    }

    // Precarga de sprites (mono + ítems) para que el primer dibujo no parpadee.
    const r = this.ctx.renderer;
    void r.loadImage(this.playerSprite);
    void r.loadImage('mono2.png');
    void r.loadImage(ITEM_SPRITE.banana);
    void r.loadImage(ITEM_SPRITE.mate);
    void r.loadImage(ITEM_SPRITE.cafe);

    // Movimiento del jugador con "a"/"d" (Wollok: keyboard.a()/keyboard.d().onPressDo).
    // El original mueve EN CADA pulsación (onPress), de a una celda. Replicamos
    // ese onPress con onKey; el acumulador de ticks no influye en el movimiento.
    this.cleanups.push(this.ctx.input.onKey('a', () => this.moverIzq()));
    this.cleanups.push(this.ctx.input.onKey('d', () => this.moverDer()));

    // NO arrancamos un rAF propio: el bucle global de main.ts ya llama a
    // update(dt) + render() de la escena activa en cada frame (un rAF propio
    // duplicaría el update y el minijuego correría a 2x; ver cabecera).
  }

  exit(): void {
    // Limpia handlers de teclado y vacía los ítems/visuales.
    for (const off of this.cleanups) off();
    this.cleanups = [];
    this.items = [];
  }

  /** Mueve el mono a la izquierda (Wollok: jugador.moverIzq, clamp x>=0). */
  private moverIzq(): void {
    this.playerSprite = 'mono1.png';
    if (this.playerX !== 0) {
      this.playerX -= 1;
    }
  }

  /** Mueve el mono a la derecha (Wollok: jugador.moverDer, clamp x<=31). */
  private moverDer(): void {
    this.playerSprite = 'mono2.png';
    if (this.playerX !== BOARD_WIDTH - 1) {
      this.playerX += 1;
    }
  }

  update(dt: number): void {
    if (this.finished) return;
    // Tope al dt: con la pestaña en segundo plano rAF se pausa y el primer
    // frame de vuelta llega con un dt gigante (ver MAX_FRAME_MS).
    const dtMs = Math.min(dt * 1000, MAX_FRAME_MS);

    // Caída CONTINUA: los ítems avanzan por frame, desacoplados del tick de
    // 100 ms (en Wollok bajaban de a 1 celda por limitación del motor).
    for (const item of this.items) {
      item.y -= dtMs * item.speed;
    }

    // Animación del mono: el sprite persigue a playerX (entero, la verdad lógica)
    // con un ease exponencial independiente del framerate. Snap al llegar para no
    // quedar acercándose asintóticamente para siempre.
    const ease = 1 - Math.exp(-dtMs / PLAYER_EASE_MS);
    this.playerVisualX += (this.playerX - this.playerVisualX) * ease;
    if (Math.abs(this.playerX - this.playerVisualX) < 0.01) {
      this.playerVisualX = this.playerX;
    }

    // Emula el paso fijo de 100 ms del game.onTick original para la LÓGICA:
    // colisiones, despawn, dificultad, fin de juego y spawn.
    this.accumulator += dtMs;
    while (this.accumulator >= TICK_MS && !this.finished) {
      this.accumulator -= TICK_MS;
      this.tick();
    }
  }

  /**
   * Un "tick" de simulación. Port de EstadoMinijuego.actualizar() (tree.wlk).
   * ORDEN del original (la caída ahora es continua y vive en update()):
   *   1) por cada ítem: colisión -> puntaje/sfx/quitar; si llegó a y=0 -> quitar.
   *   2) si puntaje >= 15 -> dificultad = 2.
   *   3) si puntaje < 0 o >= 30 -> fin.
   *   4) si nuevoItem == 8/dificultad -> spawnear ítem; nuevoItem = 0.
   *   5) nuevoItem++.
   */
  private tick(): void {
    // 1) Colisiones y despawn por borde. La fila lógica del ítem es Math.round(y):
    //    round(y) == 1 vale durante 1 celda de recorrido (= `delay` ticks), o sea
    //    la MISMA ventana de atrape que el original con y entero. Iteramos sobre
    //    una copia porque mutamos `items` al quitar (igual que items.remove dentro
    //    del forEach Wollok).
    for (const item of [...this.items]) {
      const row = Math.round(item.y);
      if (item.x === this.playerX && row === this.playerY) {
        const diferencia = ITEM_SCORE[item.kind];
        if (diferencia > 0) {
          this.ctx.audio.playSfx('coin');
        } else {
          this.ctx.audio.playSfx('error');
        }
        this.score += diferencia;
        this.removeItem(item);
      } else if (row <= 0) {
        this.removeItem(item);
      }
    }

    // 2) Ajuste de dificultad.
    if (this.score >= 15) {
      this.dificultad = 2;
    }

    // 3) Condición de fin (usa el puntaje LOCAL del minijuego, no ctx.score).
    const loseScore = this.config.loseScore ?? 0;
    const winScore = this.config.winScore ?? 30;
    if (this.score < loseScore) {
      this.finish(this.config.loseNode);
      return;
    }
    if (this.score >= winScore) {
      this.finish(this.config.winNode);
      return;
    }

    // 4) Spawn de un nuevo ítem cada 8/dificultad ticks.
    if (this.nuevoItem === 8 / this.dificultad) {
      this.spawnItem();
      this.nuevoItem = 0;
    }
    // 5) Avanza el contador de spawn.
    this.nuevoItem++;
  }

  /** Quita un ítem de la lista (Wollok: items.remove + game.removeVisual). */
  private removeItem(item: FallingItem): void {
    const idx = this.items.indexOf(item);
    if (idx !== -1) this.items.splice(idx, 1);
  }

  /** Crea un ítem nuevo con tipo aleatorio (Wollok: probabilidades 20/40/resto). */
  private spawnItem(): void {
    const random = Math.random() * 100;
    let kind: ItemKind;
    if (random < 20) {
      kind = 'banana';
    } else if (random < 40) {
      kind = 'mate';
    } else {
      kind = 'cafe';
    }
    // x aleatorio 0..31 (Wollok: 0.randomUpTo(32).truncate(0)).
    const x = Math.floor(Math.random() * BOARD_WIDTH);
    // Velocidad continua equivalente al original: 1 celda cada `delay` ticks,
    // con delay = 4/dificultad (fijada al momento del spawn, como en Wollok).
    const delay = 4 / this.dificultad;
    this.items.push({
      kind,
      x,
      y: SPAWN_Y,
      speed: 1 / (delay * TICK_MS),
    });
  }

  render(): void {
    const r = this.ctx.renderer;
    r.clear();

    // Fondo del minijuego (imagen "minijuego" -> imagen-minijuego.png), si está cacheada.
    const bg = r.getCached('minijuego');
    if (bg) {
      r.drawBackground(bg);
    }

    // Ítems que caen: a SPRITE_CELLS x SPRITE_CELLS, centrados en su celda lógica
    // (drawSprite acepta coordenadas fraccionarias; y es float por la caída continua).
    const off = (SPRITE_CELLS - 1) / 2;
    for (const item of this.items) {
      const sprite = r.getCached(ITEM_SPRITE[item.kind]);
      if (sprite) {
        r.drawSprite(sprite, item.x - off, item.y - off, SPRITE_CELLS, SPRITE_CELLS);
      }
    }

    // Jugador (mono): centrado horizontal en su columna, con los pies en su fila
    // (crece hacia arriba, así que la base queda donde estaba la celda original).
    // Se dibuja en playerVisualX (float, animado); la colisión usa playerX entero.
    const mono = r.getCached(this.playerSprite);
    if (mono) {
      r.drawSprite(mono, this.playerVisualX - off, this.playerY, SPRITE_CELLS, SPRITE_CELLS);
    }

    // HUD: marcador de puntaje (Wollok: game.at(1, 26), "Puntaje: N", #FFFFFF).
    r.drawText(`Puntaje: ${this.score}`, 1, 26, '#FFFFFF');
  }

  /**
   * Termina el minijuego y devuelve el control a la narrativa.
   * Marca finished (idempotente, y frena update/tick) y dispara onFinish.
   */
  private finish(nodeId: string): void {
    if (this.finished) return;
    this.finished = true;
    // Corta la música del minijuego antes de volver a la narrativa.
    this.ctx.audio.stopMusic();
    this.onFinish(nodeId);
  }
}
