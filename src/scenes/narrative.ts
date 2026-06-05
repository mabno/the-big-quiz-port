// narrative.ts — Escena de novela visual (el ~70% del juego).
//
// Renderiza la imagen del nodo actual a pantalla completa y maneja las decisiones
// Left/Right delegando en la StateMachine. Es la escena REAL que el agente del
// árbol (port de tree.wlk) alimentará con datos.
//
// Replica el bucle de juego.wlk: keyboard.left()/right().onPressDo({ actualizar() }).

import type { GameContext, Scene } from '../engine/types.js';
import type { StateMachine } from '../engine/stateMachine.js';

export class NarrativeScene implements Scene {
  private readonly ctx: GameContext;
  private readonly machine: StateMachine;
  /** Funciones de limpieza de los handlers de teclado (scope por escena). */
  private cleanups: Array<() => void> = [];
  /** Imagen actualmente lista para dibujar (o null mientras carga). */
  private currentImage: HTMLImageElement | null = null;

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
    // Aplica los efectos de entrar al nodo actual (música, sfx) y carga su imagen.
    this.refreshNode();
  }

  exit(): void {
    // Limpia handlers para que no se solapen con la siguiente escena.
    for (const off of this.cleanups) off();
    this.cleanups = [];
  }

  /** Procesa una decisión del jugador y avanza el autómata. */
  private decide(direction: 'left' | 'right'): void {
    this.machine.transition(direction);
    // Si la transición lanzó un minijuego, el contexto ya cambió de escena;
    // refrescamos solo si seguimos siendo la escena activa narrativa.
    this.refreshNode();
  }

  /** Carga la imagen del nodo actual y la deja lista para render. */
  private refreshNode(): void {
    const node = this.machine.currentNode;
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
  }
}
