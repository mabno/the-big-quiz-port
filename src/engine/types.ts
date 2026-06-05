// types.ts — Tipos núcleo del motor.
// Modelan fielmente los primitivos de Wollok que encontramos en el código original:
//   - El tablero es de 32x28 celdas, cellSize 32 (1024x896 px lógicos).
//   - El eje Y crece HACIA ARRIBA (igual que en wollok.game).
//   - Cada estado/nodo es una pantalla completa: imagen de fondo + audio + música.
//   - Las transiciones son [left, right] indexadas por playerInput (0 = Left, 1 = Right).

// Imports SOLO de tipos: se borran en compilación, así que no introducen
// dependencia circular en runtime (renderer/audio/input importan tipos de acá).
import type { Renderer } from './renderer.js';
import type { AudioManager } from './audio.js';
import type { Input } from './input.js';

/** Dirección de la decisión del jugador en la novela visual. */
export type Direction = 'left' | 'right';

/**
 * Una transición puede ser:
 *  - El id de un nodo destino (caso por defecto, `transiciones.get(playerInput)`).
 *  - Una función del contexto que devuelve el id destino (ramificación por puntaje,
 *    como `EstadoResultado`/`EstadoFinExamen`, que hacen `transiciones().get(juego.puntaje())`).
 */
export type Transition = string | ((ctx: GameContext) => string);

/** Directiva de música asociada a un nodo. Replica la `Musica` de Wollok. */
export interface MusicDirective {
  /** Nombre del archivo (con o sin extensión), p. ej. "dreamscape" o "dreamscape.mp3". */
  file: string;
  /** Volumen 0..1 (los valores originales viven en musica.wlk). */
  volume?: number;
  /** Si la pista debe reproducirse en loop (silence y quiz lo hacen). */
  loop?: boolean;
}

/**
 * Efectos colaterales que se ejecutan al ENTRAR a un nodo (`onEnter`).
 * Equivalen a lo que el `juego.actualizar()` + `Estado.transicion()` hacían:
 * ajustar puntaje, lanzar minijuego, etc. Todos son opcionales.
 */
export interface NodeEffects {
  /** Suma (o resta) al puntaje al entrar. Replica `incrementarPuntaje`. */
  scoreDelta?: number;
  /** Reinicia el puntaje a 0 al entrar. Replica `reiniciarPuntaje`. */
  resetScore?: boolean;
  /**
   * Si está presente, este nodo lanza un minijuego arcade en vez de mostrar
   * una imagen estática. El motor cambiará a la MinigameScene.
   */
  minigame?: MinigameConfig;
}

/**
 * Un nodo narrativo = una pantalla del autómata (clase `Estado` de Wollok).
 * Es la unidad que el agente del árbol (`tree.wlk` port) producirá en masa.
 */
export interface NarrativeNode {
  /** Identificador único del nodo (p. ej. "quiz_0"). */
  id: string;
  /**
   * Nombre del archivo de imagen de fondo. Acepta:
   *  - El imageID crudo de Wollok (p. ej. "quiz-0"), que se resuelve a "imagen-quiz-0.png".
   *  - Un nombre de archivo completo (p. ej. "imagen-quiz-0.png").
   */
  image: string;
  /**
   * Efecto de sonido que suena al entrar al nodo (el `audio` de Wollok).
   * Acepta nombre crudo ("monomovimiento") o con extensión ("monomovimiento.mp3").
   * Si se omite, no suena nada (equivale a "silence").
   */
  sound?: string;
  /**
   * Directiva de música del nodo. En Wollok era `musica = [left, right]`.
   * Acá modelamos la música RESULTANTE de entrar al nodo; si difiere de la actual,
   * el AudioManager corta la previa y arranca esta.
   */
  music?: MusicDirective;
  /** Efectos colaterales al entrar (puntaje, minijuego). */
  onEnter?: NodeEffects;
  /** Destino al presionar Left (ArrowLeft / playerInput = 0). */
  left?: Transition;
  /** Destino al presionar Right (ArrowRight / playerInput = 1). */
  right?: Transition;
  /**
   * Sonido de transición específico para quizzes: par [correcto, incorrecto].
   * Si el playerInput coincide con `correctAnswer`, suena el primero; si no, el segundo.
   * Replica `EstadoQuiz.sonidoDeTransicion` (correct-yay / incorrect-buzzer).
   */
  correctAnswer?: Direction;
  /** Sonidos [acierto, error] para nodos tipo quiz. Por defecto correct-yay / incorrect-buzzer. */
  quizSounds?: [string, string];
}

/**
 * Variante de minijuego arcade. El valor es el nombre del objeto/clase Wollok
 * en minúsculas y sin acentos.
 *
 * NOTA IMPORTANTE (resultado de auditar src/tree.wlk + src/minijuego.wlk):
 * En el código original existe UNA SOLA mecánica de minijuego jugable:
 * `EstadoMinijuego` (el juego del mono con ítems que caen: banana/mate/café).
 * Los estados `videojuego-bombas`, `videojuego-ranas` y `videojuego-raycasting-*`
 * NO son minijuegos: son pantallas narrativas estáticas (`Estado` / `EstadoJuegoLag`),
 * solo imagen + audio, sin lógica de juego. El "raycasting" es puro relato (ver
 * python-gen-images/narrativa.py). Por eso la única variante real es 'mono'.
 * Dejamos la unión abierta a futuras variantes, pero hoy solo 'mono' está implementada.
 */
export type MinigameVariant = 'mono';

/** Configuración de un minijuego arcade (lanzado desde un nodo). */
export interface MinigameConfig {
  /**
   * Variante de minijuego a ejecutar. Por ahora solo 'mono' (el único minijuego
   * jugable del original). El agente del árbol castea a este tipo.
   */
  variant: MinigameVariant;
  /** Nodo al que se vuelve cuando el jugador GANA (puntaje alto). */
  winNode: string;
  /** Nodo al que se vuelve cuando el jugador PIERDE (puntaje negativo). */
  loseNode: string;
  /** Puntaje objetivo para ganar (Wollok original: 30). */
  winScore?: number;
  /** Puntaje límite inferior; por debajo se pierde (Wollok original: 0, pierde con < 0). */
  loseScore?: number;
  /** Música de fondo del minijuego (Wollok: "minijuego.mp3"). */
  music?: MusicDirective;
}

/**
 * Una escena del juego. El motor solo conoce escenas a través de esta interfaz.
 * Las dos implementaciones son NarrativeScene y MinigameScene.
 */
export interface Scene {
  /** Se llama al activar la escena. Registra inputs, arranca música, etc. */
  enter(): void;
  /** Se llama al salir. DEBE limpiar inputs, timers y visuales. */
  exit(): void;
  /** Update opcional por frame (segundos delta). Solo lo usan escenas con loop (minijuego). */
  update?(dt: number): void;
  /** Dibuja la escena en el canvas. */
  render(): void;
  /** Manejo directo de tecla (alternativa a registrar handlers en `enter`). */
  onKey?(key: string): void;
}

/**
 * Contexto global del juego que se pasa a escenas y máquina de estados.
 * Es la fachada hacia los subsistemas del motor (audio, render, input, puntaje).
 */
export interface GameContext {
  /** Puntaje actual del jugador (Wollok: `juego.puntaje`). */
  score: number;
  /** Última tecla de decisión: 0 = Left, 1 = Right (Wollok: `playerInput`). */
  playerInput: 0 | 1;
  /** Renderer del canvas. */
  readonly renderer: Renderer;
  /** Gestor de audio. */
  readonly audio: AudioManager;
  /** Gestor de input de teclado. */
  readonly input: Input;
  /** Cambia la escena activa (sale de la actual, entra a la nueva). */
  setScene(scene: Scene): void;
  /** Lanza el minijuego con la config dada; al terminar vuelve a la narrativa. */
  startMinigame(config: MinigameConfig): void;
  /** Vuelve a la escena narrativa posicionada en el nodo `nodeId`. */
  resumeNarrative(nodeId: string): void;
  /** Suma (o resta) al puntaje. */
  addScore(delta: number): void;
  /** Reinicia el puntaje a 0. */
  resetScore(): void;
}
