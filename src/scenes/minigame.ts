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
  y: number;
  /** Ticks que tarda en bajar una celda (Wollok: delay). */
  delay: number;
  /** Contador interno hasta `delay` (Wollok: delayCount). */
  delayCount: number;
}

export class MinigameScene implements Scene {
  private readonly ctx: GameContext;
  private readonly config: MinigameConfig;
  private readonly onFinish: MinigameFinish;

  /** Id del rAF en curso (para poder cancelarlo en exit/stop). */
  private rafId: number | null = null;
  /** Timestamp del frame previo, para calcular dt. */
  private lastTime = 0;
  /** Acumulador para emular el tick fijo de 100 ms. */
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
    this.playerSprite = 'mono1.png';
    this.finished = false;

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

    this.start();
  }

  exit(): void {
    this.stop();
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

  /** Arranca el bucle requestAnimationFrame. */
  private start(): void {
    this.lastTime = performance.now();
    this.accumulator = 0;
    const loop = (now: number): void => {
      const dt = (now - this.lastTime) / 1000; // segundos
      this.lastTime = now;
      this.update(dt);
      this.render();
      // Si ya terminamos, no reprogramamos el frame.
      if (!this.finished) {
        this.rafId = requestAnimationFrame(loop);
      }
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /** Detiene el bucle. */
  private stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  update(dt: number): void {
    if (this.finished) return;
    // Emula el paso fijo de 100 ms del game.onTick original.
    this.accumulator += dt * 1000;
    while (this.accumulator >= TICK_MS && !this.finished) {
      this.accumulator -= TICK_MS;
      this.tick();
    }
  }

  /**
   * Un "tick" de simulación. Port fiel de EstadoMinijuego.actualizar() (tree.wlk).
   * ORDEN del original:
   *   1) por cada ítem: colisión -> puntaje/sfx/quitar; si y==0 -> quitar; luego mover.
   *   2) si puntaje >= 15 -> dificultad = 2.
   *   3) si puntaje < 0 o >= 30 -> fin.
   *   4) si nuevoItem == 8/dificultad -> spawnear ítem; nuevoItem = 0.
   *   5) nuevoItem++.
   */
  private tick(): void {
    // 1) Colisiones, despawn por borde y caída. Iteramos sobre una copia porque
    //    mutamos `items` al quitar (igual que items.remove dentro del forEach Wollok).
    for (const item of [...this.items]) {
      if (item.x === this.playerX && item.y === this.playerY) {
        const diferencia = ITEM_SCORE[item.kind];
        if (diferencia > 0) {
          this.ctx.audio.playSfx('coin');
        } else {
          this.ctx.audio.playSfx('error');
        }
        this.score += diferencia;
        this.removeItem(item);
      } else if (item.y === 0) {
        this.removeItem(item);
      }
      // mover() del Item: baja 1 celda cada `delay` ticks.
      this.moverItem(item);
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

  /** Caída del ítem (Wollok: Item.mover()). Baja 1 celda cada `delay` ticks. */
  private moverItem(item: FallingItem): void {
    item.delayCount += 1;
    if (item.delayCount === item.delay) {
      item.y -= 1;
      item.delayCount = 0;
    }
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
    this.items.push({
      kind,
      x,
      y: SPAWN_Y,
      delay: 4 / this.dificultad,
      delayCount: 0,
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

    // Ítems que caen.
    for (const item of this.items) {
      const sprite = r.getCached(ITEM_SPRITE[item.kind]);
      if (sprite) r.drawSprite(sprite, item.x, item.y);
    }

    // Jugador (mono).
    const mono = r.getCached(this.playerSprite);
    if (mono) r.drawSprite(mono, this.playerX, this.playerY);

    // HUD: marcador de puntaje (Wollok: game.at(1, 26), "Puntaje: N", #FFFFFF).
    r.drawText(`Puntaje: ${this.score}`, 1, 26, '#FFFFFF');
  }

  /**
   * Termina el minijuego y devuelve el control a la narrativa.
   * Detiene el bucle, marca finished (idempotente) y dispara onFinish.
   */
  private finish(nodeId: string): void {
    if (this.finished) return;
    this.finished = true;
    this.stop();
    // Corta la música del minijuego antes de volver a la narrativa.
    this.ctx.audio.stopMusic();
    this.onFinish(nodeId);
  }
}
