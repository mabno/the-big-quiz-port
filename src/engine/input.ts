// input.ts — Gestor de input: teclado + táctil (pointer).
//
// Dos modos de uso, replicando el código original:
//   1. onKey(key, handler): registro de handlers (Wollok: keyboard.left().onPressDo(...)).
//      Devuelve una función de limpieza para des-registrar, con scope por escena.
//   2. isDown(key): polling del estado de una tecla (para el movimiento continuo
//      del minijuego, Wollok: keyboard.a()/keyboard.d() moviendo al jugador).
//
// Teclas usadas por el original:
//   - ArrowLeft / ArrowRight  -> decisiones de la novela visual (playerInput 0/1).
//   - "a" / "d"               -> mover al jugador en el minijuego.
//
// CAPA TÁCTIL (mobile): un pointerdown en la mitad IZQUIERDA del canvas equivale a
// "izquierda" (sintetiza ArrowLeft + 'a'); en la mitad DERECHA a "derecha" (ArrowRight + 'd').
// Como las escenas son EXCLUSIVAS (narrativa usa flechas, minijuego usa a/d) no hay
// conflicto en activar ambas teclas a la vez. El toque:
//   - dispara los handlers onKey UNA sola vez por toque (igual que un keydown sin auto-repeat),
//   - mantiene isDown()=true mientras el dedo siga apoyado (hasta pointerup/cancel).
// El auto-repeat por mantener apoyado SOLO se habilita para el minijuego (ver setHoldRepeat),
// porque el minijuego consume keydowns discretos (onKey('a'/'d')) y sin repeat un dedo
// apoyado movería al mono una sola celda. La narrativa NO debe repetir: un dedo apoyado
// saltándose nodos sería un desastre.

export type KeyHandler = (key: string) => void;

/** Teclas sintéticas que dispara cada mitad de la pantalla. */
const ZONE_KEYS = {
  left: ['ArrowLeft', 'a'],
  right: ['ArrowRight', 'd'],
} as const;

/** Intervalo de auto-repeat al mantener apoyado (ms), solo activo en el minijuego. */
const HOLD_REPEAT_MS = 120;

export class Input {
  /** Estado actual de teclas presionadas (para isDown). */
  private readonly down = new Set<string>();
  /** Handlers registrados por tecla. */
  private readonly handlers = new Map<string, Set<KeyHandler>>();

  /** Canvas al que se enganchan los eventos de pointer (o null si no se enganchó). */
  private canvas: HTMLCanvasElement | null = null;
  /** Zona del puntero actualmente apoyado (para auto-repeat), o null si no hay toque. */
  private activeZone: 'left' | 'right' | null = null;
  /** id del setInterval de auto-repeat (o null). */
  private repeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Si el auto-repeat por mantener apoyado está habilitado (solo minijuego). */
  private holdRepeatEnabled = false;

  constructor() {
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
  }

  private onKeyDown(e: KeyboardEvent): void {
    const key = this.normalize(e.key);
    // Evitamos auto-repeat para los handlers de "onPress" (decisiones discretas).
    const wasDown = this.down.has(key);
    this.down.add(key);
    if (wasDown) return;

    this.fire(key);
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.down.delete(this.normalize(e.key));
  }

  /** Dispara todos los handlers registrados para una tecla. */
  private fire(key: string): void {
    const set = this.handlers.get(key);
    if (set) {
      for (const h of set) h(key);
    }
  }

  /** Normaliza teclas a forma canónica (las letras a minúscula). */
  private normalize(key: string): string {
    return key.length === 1 ? key.toLowerCase() : key;
  }

  /**
   * Registra un handler para una tecla. Devuelve una función de limpieza.
   * Las escenas deben guardar esas funciones y llamarlas en exit() (scope por escena).
   */
  onKey(key: string, handler: KeyHandler): () => void {
    const k = this.normalize(key);
    let set = this.handlers.get(k);
    if (!set) {
      set = new Set();
      this.handlers.set(k, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  /** Polling: ¿está la tecla presionada ahora mismo? (movimiento del minijuego). */
  isDown(key: string): boolean {
    return this.down.has(this.normalize(key));
  }

  /** Limpia TODOS los handlers (útil al destruir/reiniciar el juego). */
  clearAll(): void {
    this.handlers.clear();
  }

  // --- Capa táctil (pointer) -------------------------------------------------

  /**
   * Engancha la entrada táctil al canvas. Cada toque se traduce a teclas sintéticas
   * según la mitad de pantalla tocada. Idempotente: solo engancha una vez.
   * @param onFirstGesture callback opcional que se ejecuta en el PRIMER pointerdown
   *   (para pasar la pantalla de inicio + desbloquear audio, igual que el keydown).
   */
  attachTouch(canvas: HTMLCanvasElement, onFirstGesture?: () => void): void {
    if (this.canvas) return;
    this.canvas = canvas;

    let firstGestureFired = false;

    const handleDown = (e: PointerEvent): void => {
      // Evita el comportamiento por defecto (scroll/zoom) y el fantasma de mouse.
      e.preventDefault();
      // El primer gesto desbloquea audio y pasa la pantalla de inicio.
      if (!firstGestureFired && onFirstGesture) {
        firstGestureFired = true;
        onFirstGesture();
      }
      const zone = this.zoneFromEvent(e);
      this.pressZone(zone);
    };

    const handleUp = (): void => {
      this.releaseZone();
    };

    // pointerdown captura mouse + touch + pen con una sola API.
    canvas.addEventListener('pointerdown', handleDown);
    // up/cancel/leave sueltan la zona para que isDown vuelva a false.
    canvas.addEventListener('pointerup', handleUp);
    canvas.addEventListener('pointercancel', handleUp);
    canvas.addEventListener('pointerleave', handleUp);
  }

  /** Determina la zona (mitad izquierda/derecha) a partir de la posición del puntero. */
  private zoneFromEvent(e: PointerEvent): 'left' | 'right' {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    return x < rect.width / 2 ? 'left' : 'right';
  }

  /**
   * Activa una zona: marca sus teclas como down y dispara los handlers UNA vez
   * (semántica de keydown). Si el hold-repeat está habilitado (minijuego), arranca
   * el timer de repetición mientras el dedo siga apoyado.
   */
  private pressZone(zone: 'left' | 'right'): void {
    this.activeZone = zone;
    const keys = ZONE_KEYS[zone];
    for (const key of keys) {
      const k = this.normalize(key);
      const wasDown = this.down.has(k);
      this.down.add(k);
      // Solo disparamos el onKey si no estaba ya apoyada (fire-once, sin auto-repeat).
      if (!wasDown) this.fire(k);
    }
    if (this.holdRepeatEnabled) this.startRepeat();
  }

  /** Suelta la zona activa: limpia el estado down de sus teclas y detiene el repeat. */
  private releaseZone(): void {
    this.stopRepeat();
    if (this.activeZone) {
      for (const key of ZONE_KEYS[this.activeZone]) {
        this.down.delete(this.normalize(key));
      }
      this.activeZone = null;
    }
  }

  /**
   * Habilita/inhabilita el auto-repeat por mantener apoyado. SOLO debe activarse
   * mientras corre el minijuego (que consume keydowns discretos). La narrativa lo
   * mantiene apagado para no auto-saltarse nodos con un dedo apoyado.
   */
  setHoldRepeat(enabled: boolean): void {
    this.holdRepeatEnabled = enabled;
    if (!enabled) this.stopRepeat();
    // Si se habilita con un dedo ya apoyado, arrancamos el repeat de inmediato.
    else if (this.activeZone) this.startRepeat();
  }

  /** Arranca el timer de repetición (re-dispara los handlers de la zona activa). */
  private startRepeat(): void {
    if (this.repeatTimer !== null) return;
    this.repeatTimer = setInterval(() => {
      if (!this.activeZone) return;
      // Re-dispara los handlers (mover al mono otra celda). NO toca el set `down`.
      for (const key of ZONE_KEYS[this.activeZone]) {
        this.fire(this.normalize(key));
      }
    }, HOLD_REPEAT_MS);
  }

  /** Detiene el timer de repetición. */
  private stopRepeat(): void {
    if (this.repeatTimer !== null) {
      clearInterval(this.repeatTimer);
      this.repeatTimer = null;
    }
  }
}
