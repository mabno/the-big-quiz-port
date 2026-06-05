// audio.ts — Gestor de audio sobre HTMLAudioElement (NO Web Audio API).
//
// Replica el sistema de Wollok:
//   - musica.wlk: cada `Musica` tiene archivo + volumen + loop; `alternar()` togglea play/pause.
//   - juego.wlk: cada estado tiene un `sonidoPantalla` (game.sound) que se reproduce al
//     entrar y se DETIENE al salir.
//   - Solo UNA pista de música suena a la vez: cambiar de pista corta la previa.
//
// Política de autoplay del navegador: el audio no puede sonar hasta el primer gesto
// del usuario. Por eso exponemos unlock(), que se llama en el primer keypress.

import { soundUrl } from './assets.js';

interface MusicState {
  /** URL de la pista que está sonando actualmente (o null). */
  url: string | null;
  /** Elemento de audio de la música actual. */
  element: HTMLAudioElement | null;
}

/**
 * WAV silencioso mínimo (44 bytes de cabecera, 0 samples) embebido como data URI.
 * Sirve para "primar" la política de autoplay en iOS: hay que hacer trabajo de audio
 * REAL y SÍNCRONO dentro del handler del gesto, o el audio queda mudo. Reproducir y
 * pausar este clip dentro de unlock() satisface esa exigencia sin descargar nada.
 */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

export class AudioManager {
  /** Cache de elementos de audio por URL (carga perezosa). */
  private readonly cache = new Map<string, HTMLAudioElement>();
  /** Estado de la música de fondo (una sola a la vez). */
  private readonly music: MusicState = { url: null, element: null };
  /** Indica si ya hubo gesto de usuario (autoplay desbloqueado). */
  private unlocked = false;
  /** Elemento silencioso reutilizable para primar el audio en iOS. */
  private primer: HTMLAudioElement | null = null;

  /**
   * Desbloquea el audio tras el primer gesto del usuario.
   *
   * IMPORTANTE (iOS/Safari): el desbloqueo debe hacer trabajo de audio REAL y
   * SÍNCRONO dentro del handler del gesto (play()+pause() de un clip mudo), o los
   * sonidos quedan silenciados aunque después llamemos play(). Por eso primamos un
   * WAV silencioso embebido ANTES de arrancar la música pendiente.
   */
  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;

    // 1) Primado síncrono del audio (clave para iOS): play() + pause() de un clip mudo.
    try {
      const primer = this.primer ?? new Audio(SILENT_WAV);
      this.primer = primer;
      primer.muted = true;
      const p = primer.play();
      if (p && typeof p.then === 'function') {
        void p
          .then(() => {
            primer.pause();
            primer.currentTime = 0;
          })
          .catch(() => {
            /* algún navegador puede rechazar el clip mudo; no es crítico */
          });
      }
    } catch {
      /* entornos sin Audio (SSR/tests): ignorar */
    }

    // 2) Si había una pista pendiente de sonar, la arrancamos ahora.
    if (this.music.element && this.music.element.paused) {
      void this.music.element.play().catch(() => {
        /* el navegador puede rechazar; se ignora */
      });
    }
  }

  /** Carga perezosa (y cacheo) de un elemento de audio por URL. */
  private getElement(url: string): HTMLAudioElement {
    let el = this.cache.get(url);
    if (!el) {
      el = new Audio(url);
      el.preload = 'auto';
      this.cache.set(url, el);
    }
    return el;
  }

  /**
   * Reproduce una pista de MÚSICA de fondo. Si ya hay otra sonando, la corta.
   * Si es la MISMA pista que ya suena, no reinicia (idempotente).
   */
  playMusic(file: string, opts: { loop?: boolean; volume?: number } = {}): void {
    const url = soundUrl(file);
    if (this.music.url === url && this.music.element && !this.music.element.paused) {
      // Ya está sonando esta pista: solo ajustamos volumen/loop.
      this.music.element.loop = opts.loop ?? this.music.element.loop;
      if (opts.volume !== undefined) this.music.element.volume = opts.volume;
      return;
    }
    // Cortamos la pista previa.
    this.stopMusic();

    const el = this.getElement(url);
    el.loop = opts.loop ?? false;
    el.volume = opts.volume ?? 1;
    el.currentTime = 0;
    this.music.url = url;
    this.music.element = el;

    if (this.unlocked) {
      void el.play().catch(() => {
        /* autoplay puede rechazar antes del gesto; se reintenta en unlock() */
      });
    }
  }

  /** Detiene la música de fondo y la rebobina. */
  stopMusic(): void {
    const el = this.music.element;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    this.music.url = null;
    this.music.element = null;
  }

  /** Pausa la música sin rebobinar (Wollok: cancion.pause()). */
  pauseMusic(): void {
    this.music.element?.pause();
  }

  /** Reanuda la música pausada (Wollok: cancion.resume()). */
  resumeMusic(): void {
    if (this.music.element && this.unlocked) {
      void this.music.element.play().catch(() => {
        /* ignore */
      });
    }
  }

  /**
   * Reproduce un efecto de sonido de una sola vez (Wollok: game.sound(..).play()).
   * No interfiere con la música de fondo. Clona el nodo para permitir solapamientos.
   */
  playSfx(file: string, volume = 1): void {
    if (!this.unlocked) return;
    const url = soundUrl(file);
    const base = this.getElement(url);
    // Clonamos para que SFX rápidos no se pisen entre sí.
    const node = base.cloneNode(true) as HTMLAudioElement;
    node.volume = volume;
    void node.play().catch(() => {
      /* ignore */
    });
  }

  /** URL de la música que está sonando (para depurar / lógica de cambio). */
  get currentMusicUrl(): string | null {
    return this.music.url;
  }
}
