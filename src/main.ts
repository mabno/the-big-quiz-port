// main.ts — Secuencia de arranque de The Big Quiz.
//
// 1. Crea los subsistemas (renderer, audio, input) y el GameContext.
// 2. Muestra una pantalla de inicio dibujada en el canvas
//    ("Presioná cualquier tecla para empezar").
// 3. Al primer keypress: desbloquea el audio (política de autoplay) y entra
//    a la escena narrativa en el nodo inicial.
// 4. Corre un bucle de render global (requestAnimationFrame) que delega en la
//    escena activa.

import { Renderer, LOGICAL_WIDTH, LOGICAL_HEIGHT } from './engine/renderer.js';
import { AudioManager } from './engine/audio.js';
import { Input } from './engine/input.js';
import { StateMachine } from './engine/stateMachine.js';
import type { GameContext, MinigameConfig, Scene } from './engine/types.js';
import { NarrativeScene } from './scenes/narrative.js';
import { MinigameScene } from './scenes/minigame.js';
import { TREE, START_NODE } from './scenes/data/tree.js';

function boot(): void {
  const canvas = document.getElementById('game');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('No se encontró el <canvas id="game">');
  }

  const renderer = new Renderer(canvas);
  const audio = new AudioManager();
  const input = new Input();

  // ¿Dispositivo de puntero grueso (touch)? Cambia el texto de la pantalla de inicio
  // y habilita un cartelito de ayuda sobre las dos mitades de pantalla.
  const isCoarsePointer =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;

  // Escena activa (la mutamos al cambiar). Empieza en la pantalla de inicio.
  let activeScene: Scene | null = null;

  // --- GameContext: fachada hacia los subsistemas ---
  const ctx: GameContext = {
    score: 0,
    playerInput: 0,
    renderer,
    audio,
    input,
    setScene(scene: Scene): void {
      activeScene?.exit();
      activeScene = scene;
      // El auto-repeat táctil (mantener apoyado = mover en repetición) SOLO aplica al
      // minijuego, que consume keydowns discretos via onKey('a'/'d'). La narrativa lo
      // mantiene apagado para que un dedo apoyado no se salte nodos.
      input.setHoldRepeat(scene instanceof MinigameScene);
      activeScene.enter();
    },
    startMinigame(config: MinigameConfig): void {
      const scene = new MinigameScene(ctx, config, (nodeId) => {
        ctx.resumeNarrative(nodeId);
      });
      ctx.setScene(scene);
    },
    resumeNarrative(nodeId: string): void {
      machine.goTo(nodeId);
      ctx.setScene(narrative);
    },
    addScore(delta: number): void {
      ctx.score += delta;
    },
    resetScore(): void {
      ctx.score = 0;
    },
  };

  // Máquina de estados y escena narrativa (comparten el ctx).
  const machine = new StateMachine(TREE, START_NODE, ctx);
  const narrative = new NarrativeScene(ctx, machine);

  // --- Pantalla de inicio ---
  const startScene: Scene = {
    enter(): void {
      // El arranque lo dispara el `startHandler` global (cualquier tecla).
      // No registramos handlers acá para no duplicar la captura.
    },
    exit(): void {
      /* nada que limpiar */
    },
    render(): void {
      const c = renderer.context;
      renderer.clear();
      c.fillStyle = '#FFFFFF';
      c.font = '36px monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('THE BIG QUIZ', LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2 - 40);
      c.font = '24px monospace';
      // En táctil mostramos "Tocá la pantalla"; en escritorio, la versión teclado.
      c.fillText(
        isCoarsePointer
          ? 'Tocá la pantalla para empezar'
          : 'Presioná cualquier tecla para empezar',
        LOGICAL_WIDTH / 2,
        LOGICAL_HEIGHT / 2 + 20,
      );
      // Pista sutil (solo táctil): cada mitad de la pantalla es una de las dos opciones.
      if (isCoarsePointer) {
        c.font = '18px monospace';
        c.fillStyle = '#9AA0A6';
        c.fillText(
          'Izquierda y derecha de la pantalla = tus dos opciones',
          LOGICAL_WIDTH / 2,
          LOGICAL_HEIGHT / 2 + 70,
        );
      }
      // Restaura alineación por defecto para otras escenas.
      c.textAlign = 'left';
    },
  };

  // Captura del PRIMER gesto: desbloquea audio y entra a la narrativa.
  // Se usa tanto desde teclado como desde el primer toque (pointer).
  let started = false;
  const startGame = (): void => {
    if (started) return;
    started = true;
    window.removeEventListener('keydown', startHandler);
    audio.unlock();
    ctx.setScene(narrative);
  };
  const startHandler = (): void => startGame();
  window.addEventListener('keydown', startHandler);

  // Capa táctil: engancha el canvas. El primer toque pasa la pantalla de inicio
  // (startGame -> unlock de audio dentro del gesto, clave para iOS) y, de ahí en más,
  // cada toque se traduce a teclas sintéticas (izquierda/derecha).
  input.attachTouch(canvas, startGame);

  // Escena inicial: pantalla de inicio.
  activeScene = startScene;
  activeScene.enter();

  // --- Bucle de render global ---
  let last = performance.now();
  const loop = (now: number): void => {
    const dt = (now - last) / 1000;
    last = now;
    // Las escenas con lógica propia (minijuego) ya corren su update en su rAF;
    // acá solo aseguramos el render de la escena activa por si no tiene loop propio.
    activeScene?.update?.(dt);
    activeScene?.render();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

boot();
