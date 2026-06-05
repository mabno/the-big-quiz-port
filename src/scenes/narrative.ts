// narrative.ts — Escena de novela visual (el ~70% del juego).
//
// Renderiza la imagen del nodo actual a pantalla completa y maneja las decisiones
// Left/Right delegando en la StateMachine. Es la escena REAL que el agente del
// árbol (port de tree.wlk) alimentará con datos.
//
// Replica el bucle de juego.wlk: keyboard.left()/right().onPressDo({ actualizar() }).
//
// DESVÍO DELIBERADO DEL ORIGINAL: al cargar un nodo nuevo, las decisiones quedan
// BLOQUEADAS por NODE_LOCK_SECONDS y el contador restante se dibuja en pantalla
// (anti-flood: el original aceptaba el input de inmediato y se podían saltear
// pantallas a fuerza de teclas/clicks repetidos).

import type { GameContext, Scene } from '../engine/types.js';
import type { StateMachine } from '../engine/stateMachine.js';
import { LOGICAL_WIDTH, LOGICAL_HEIGHT } from '../engine/renderer.js';

/**
 * Segundos que las decisiones quedan bloqueadas al cargar un nodo nuevo
 * (anti-flood de clicks). El contador se muestra centrado en el borde inferior.
 */
const NODE_LOCK_SECONDS = 3;

/** Fondo por defecto de la página (letterbox alrededor del canvas). */
const DEFAULT_PAGE_BACKGROUND = '#000';

export class NarrativeScene implements Scene {
  private readonly ctx: GameContext;
  private readonly machine: StateMachine;
  /** Funciones de limpieza de los handlers de teclado (scope por escena). */
  private cleanups: Array<() => void> = [];
  /** Imagen actualmente lista para dibujar (o null mientras carga). */
  private currentImage: HTMLImageElement | null = null;
  /** Segundos restantes del bloqueo anti-flood (0 = decisiones habilitadas). */
  private lockRemaining = 0;

  constructor(ctx: GameContext, machine: StateMachine) {
    this.ctx = ctx;
    this.machine = machine;
  }

  enter(): void {
    // Registra las decisiones izquierda/derecha (las dos únicas teclas narrativas).
    this.cleanups.push(
      this.ctx.input.onKey('ArrowLeft', () => this.decide('left')),
      this.ctx.input.onKey('ArrowRight', () => this.decide('right')),
    );
    // Carga la imagen del nodo actual y arma el bloqueo anti-flood. OJO: los
    // efectos de entrada del nodo (música/sfx) NO se aplican acá — los aplica
    // quien posiciona la máquina (machine.start() al arrancar, goTo() al volver
    // del minijuego); re-aplicarlos en cada enter() los duplicaría.
    this.refreshNode();
    this.lockRemaining = NODE_LOCK_SECONDS;
  }

  exit(): void {
    // Limpia handlers para que no se solapen con la siguiente escena.
    for (const off of this.cleanups) off();
    this.cleanups = [];
    // Restaura el fondo de la página por si el nodo activo lo había teñido
    // (las otras escenas asumen el letterbox negro).
    document.body.style.background = DEFAULT_PAGE_BACKGROUND;
  }

  /** Procesa una decisión del jugador y avanza el autómata. */
  private decide(direction: 'left' | 'right'): void {
    // Anti-flood: mientras corre el contador del nodo recién cargado, la
    // decisión se ignora por completo (ni transición, ni sonidos, ni puntaje).
    if (this.lockRemaining > 0) return;

    const before = this.machine.currentNode;
    this.machine.transition(direction);
    // Si la transición lanzó un minijuego, el contexto ya cambió de escena;
    // refrescamos solo si seguimos siendo la escena activa narrativa.
    this.refreshNode();
    // Re-arma el bloqueo SOLO si efectivamente cambió el nodo: las hojas sin
    // transición devuelven el mismo nodo y no deben reiniciar el contador.
    if (this.machine.currentNode !== before) {
      this.lockRemaining = NODE_LOCK_SECONDS;
    }
  }

  /** Descuenta el bloqueo anti-flood (dt en segundos, lo llama el bucle global). */
  update(dt: number): void {
    if (this.lockRemaining > 0) {
      this.lockRemaining = Math.max(0, this.lockRemaining - dt);
    }
  }

  /** Carga la imagen del nodo actual y la deja lista para render. */
  private refreshNode(): void {
    const node = this.machine.currentNode;
    // Fondo de la PÁGINA (letterbox): los nodos pueden teñirlo (p. ej. bsod lo
    // pinta del azul de la pantalla azul para que ocupe todo el visor). El #app
    // del index.html es transparente a propósito para que esto se vea.
    document.body.style.background = node.pageBackground ?? DEFAULT_PAGE_BACKGROUND;
    this.currentImage = this.ctx.renderer.getCached(node.image) ?? null;
    void this.ctx.renderer
      .loadImage(node.image)
      .then((img: HTMLImageElement) => {
        // Solo asignamos si seguimos en el mismo nodo (evita parpadeos al avanzar rápido).
        if (this.machine.currentNode.id === node.id) {
          this.currentImage = img;
        }
      })
      .catch((err: unknown) => {
        console.error(err);
      });
  }

  render(): void {
    const r = this.ctx.renderer;
    r.clear();
    if (this.currentImage) {
      r.drawBackground(this.currentImage);
    }
    if (this.lockRemaining > 0) {
      this.renderLockCounter();
    }
  }

  /**
   * Dibuja el contador anti-flood (segundos restantes, redondeados hacia arriba:
   * 3 → 2 → 1) en una pastilla semitransparente centrada en el borde inferior.
   * Va al CENTRO y no en una esquina: las imágenes de los nodos dibujan las
   * opciones de decisión en las esquinas inferiores y se solaparían.
   */
  private renderLockCounter(): void {
    const c = this.ctx.renderer.context;
    const seconds = Math.ceil(this.lockRemaining);
    const size = 56;
    const margin = 16;
    const x = (LOGICAL_WIDTH - size) / 2;
    const y = LOGICAL_HEIGHT - size - margin;
    c.fillStyle = 'rgba(0, 0, 0, 0.55)';
    c.fillRect(x, y, size, size);
    c.fillStyle = '#FFFFFF';
    c.font = '36px monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(String(seconds), x + size / 2, y + size / 2 + 2);
    // Restaura valores por defecto para no afectar a otros dibujos.
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
  }
}
