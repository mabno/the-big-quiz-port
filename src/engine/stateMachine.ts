// stateMachine.ts — Autómata de la novela visual.
//
// Replica el núcleo de juego.wlk + tree.wlk:
//   - Registro de nodos (Record<id, NarrativeNode>), equivalente a los `const` de tree.wlk.
//   - `estadoActual` -> currentNode.
//   - `actualizar()` -> transition(): calcula el siguiente nodo según la dirección,
//     ejecuta efectos onEnter (imagen, sfx, música, puntaje, minijuego) y avanza.
//   - Soporta transiciones por FUNCIÓN para ramificar por puntaje (EstadoResultado:
//     `transiciones().get(juego.puntaje())`).
//
// La máquina NO dibuja ni toca el DOM directamente: aplica efectos a través del
// GameContext (audio, puntaje, lanzamiento de minijuego). El render lo hace la escena.

import type {
  Direction,
  GameContext,
  NarrativeNode,
  Transition,
} from './types.js';

export class StateMachine {
  /** Registro de todos los nodos por id. */
  private readonly nodes: Record<string, NarrativeNode>;
  /** Nodo actual. */
  private current: NarrativeNode;
  /** Contexto del juego (puntaje, audio, lanzamiento de minijuego). */
  private readonly ctx: GameContext;

  constructor(
    nodes: Record<string, NarrativeNode>,
    startId: string,
    ctx: GameContext,
  ) {
    this.nodes = nodes;
    this.ctx = ctx;
    const start = nodes[startId];
    if (!start) {
      throw new Error(`Nodo inicial desconocido: ${startId}`);
    }
    this.current = start;
  }

  /** Nodo actualmente activo. */
  get currentNode(): NarrativeNode {
    return this.current;
  }

  /**
   * Aplica los efectos de entrada del nodo INICIAL. Debe llamarse UNA vez al
   * arrancar el juego (tras el unlock de audio del primer gesto). Replica
   * juego.init() de Wollok, que arrancaba la música del quiz al iniciar
   * (game.schedule(0, { quiz.alternar() })). Sin esto, el constructor solo
   * asigna `current` y la música del nodo inicial (quiz_0) nunca suena.
   */
  start(): void {
    this.applyEnter(this.current);
  }

  /** Posiciona la máquina en un nodo arbitrario (p. ej. al volver de un minijuego). */
  goTo(nodeId: string): void {
    const node = this.nodes[nodeId];
    if (!node) {
      throw new Error(`Nodo desconocido: ${nodeId}`);
    }
    // Mismo corte que en transition(): al saltar de nodo (p. ej. al volver del
    // minijuego) no deben quedar sfx del nodo/escena anterior sonando.
    this.ctx.audio.stopAllSfx();
    this.current = node;
    this.applyEnter(node);
  }

  /**
   * Resuelve una transición (id directo o función de puntaje) a un id de nodo.
   * Replica `estadoSiguiente()`: por defecto indexado por dirección.
   */
  private resolve(transition: Transition | undefined): string | undefined {
    if (transition === undefined) return undefined;
    if (typeof transition === 'function') {
      return transition(this.ctx);
    }
    return transition;
  }

  /**
   * Avanza según la dirección elegida. Equivale a `juego.actualizar()`:
   *  1. Determina el nodo destino (left/right o función de puntaje).
   *  2. Aplica el sonido de transición del nodo ACTUAL (quiz: yay/buzzer).
   *  3. Cambia al nodo destino y ejecuta sus efectos onEnter.
   *
   * Devuelve el nodo destino, o el actual si no había transición definida (hoja).
   */
  transition(direction: Direction): NarrativeNode {
    this.ctx.playerInput = direction === 'left' ? 0 : 1;

    // Corta los sfx en curso ANTES del sonido de transición: lo que venía sonando
    // del nodo que se abandona no debe mezclarse con los audios del cambio. El
    // ORDEN importa: el yay/buzzer del quiz se dispara DESPUÉS del corte, así el
    // feedback de acierto/error se escucha completo.
    this.ctx.audio.stopAllSfx();

    // Sonido de transición del nodo actual (acierto/error en quizzes).
    this.playTransitionSound(this.current, direction);

    const targetId = this.resolve(
      direction === 'left' ? this.current.left : this.current.right,
    );
    if (targetId === undefined) {
      // Nodo hoja (transiciones vacías, como minijuego_0 en el original).
      return this.current;
    }

    const target = this.nodes[targetId];
    if (!target) {
      throw new Error(
        `Transición a nodo inexistente "${targetId}" desde "${this.current.id}"`,
      );
    }

    this.current = target;
    this.applyEnter(target);
    return target;
  }

  /**
   * Reproduce el sonido de transición. Para nodos con `correctAnswer` (quizzes),
   * suena el sfx de acierto si la dirección coincide, o el de error si no.
   * Replica `EstadoQuiz.sonidoDeTransicion`.
   */
  private playTransitionSound(node: NarrativeNode, direction: Direction): void {
    if (node.correctAnswer === undefined) return;
    const [okSound, badSound] = node.quizSounds ?? ['correct-yay', 'incorrect-buzzer'];
    this.ctx.audio.playSfx(direction === node.correctAnswer ? okSound : badSound);
  }

  /**
   * Ejecuta los efectos de ENTRAR a un nodo: ajuste de puntaje, cambio de música,
   * sfx del nodo y, si corresponde, lanzamiento del minijuego.
   * El render de la imagen lo hace la escena (lee currentNode.image).
   */
  private applyEnter(node: NarrativeNode): void {
    const effects = node.onEnter;

    // 1. Efectos de puntaje.
    if (effects?.resetScore) this.ctx.resetScore();
    if (effects?.scoreDelta) this.ctx.addScore(effects.scoreDelta);

    // 2. Música: si el nodo trae directiva, el AudioManager corta la previa
    //    y arranca esta (idempotente si es la misma pista).
    if (node.music) {
      this.ctx.audio.playMusic(node.music.file, {
        loop: node.music.loop ?? false,
        volume: node.music.volume ?? 1,
      });
    }

    // 3. Sfx del nodo (el `audio` de cada Estado en Wollok).
    if (node.sound) {
      this.ctx.audio.playSfx(node.sound);
    }

    // 4. Minijuego: si el nodo lo lanza, cedemos el control a la escena de minijuego.
    if (effects?.minigame) {
      this.ctx.startMinigame(effects.minigame);
    }
  }
}
