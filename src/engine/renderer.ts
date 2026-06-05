// renderer.ts — Render sobre un único <canvas> a resolución lógica del tablero Wollok.
//
// Dimensiones EXACTAS extraídas de juego.wlk:
//   game.width(32)  -> 32 celdas
//   game.height(28) -> 28 celdas
//   game.cellSize(32) -> 32 px por celda
// => resolución lógica 1024x896.
//
// IMPORTANTE — eje Y: en wollok.game el eje Y crece HACIA ARRIBA desde abajo.
// La celda (0,0) es la esquina INFERIOR izquierda. El canvas crece hacia abajo,
// así que convertimos: pixelY = (BOARD_HEIGHT - 1 - cellY) * CELL_SIZE.

import { imageUrl } from './assets.js';

/** Ancho del tablero en celdas (Wollok: game.width(32)). */
export const BOARD_WIDTH = 32;
/** Alto del tablero en celdas (Wollok: game.height(28)). */
export const BOARD_HEIGHT = 28;
/** Tamaño de celda en píxeles (Wollok: game.cellSize(32)). */
export const CELL_SIZE = 32;
/** Resolución lógica en píxeles. */
export const LOGICAL_WIDTH = BOARD_WIDTH * CELL_SIZE; // 1024
export const LOGICAL_HEIGHT = BOARD_HEIGHT * CELL_SIZE; // 896

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Cache de imágenes ya cargadas, indexada por URL. */
  private readonly cache = new Map<string, HTMLImageElement>();
  /** Promesas en vuelo para evitar cargas duplicadas del mismo archivo. */
  private readonly loading = new Map<string, Promise<HTMLImageElement>>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.canvas.width = LOGICAL_WIDTH;
    this.canvas.height = LOGICAL_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('No se pudo obtener el contexto 2D del canvas');
    }
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
    this.applyLetterbox();
    // resize cubre el cambio de tamaño y orientación en navegadores modernos;
    // orientationchange y visualViewport.resize son refuerzos para móvil (barra de
    // URL que aparece/desaparece, rotación) y para que el letterbox encaje en ambas
    // orientaciones sin scroll.
    const relayout = (): void => this.applyLetterbox();
    window.addEventListener('resize', relayout);
    window.addEventListener('orientationchange', relayout);
    window.visualViewport?.addEventListener('resize', relayout);
  }

  /**
   * Escala el canvas (vía CSS) para encajar en la ventana manteniendo la relación
   * de aspecto 1024:896 (8:7), con barras negras (letterboxing) en CUALQUIER
   * orientación. El backing store sigue siendo 1024x896, así que todo el dibujo usa
   * coordenadas lógicas.
   */
  private applyLetterbox(): void {
    // Preferimos visualViewport (refleja el visor real en móvil, sin contar barras
    // del navegador); fallback a innerWidth/innerHeight en escritorio.
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const scale = Math.min(vw / LOGICAL_WIDTH, vh / LOGICAL_HEIGHT);
    this.canvas.style.width = `${LOGICAL_WIDTH * scale}px`;
    this.canvas.style.height = `${LOGICAL_HEIGHT * scale}px`;
  }

  /** Acceso al contexto 2D crudo (para texto en escenas, p. ej. puntaje). */
  get context(): CanvasRenderingContext2D {
    return this.ctx;
  }

  /**
   * Carga una imagen por nombre (imageID crudo o archivo completo) y la cachea.
   * Resuelve la URL vía imageUrl() (-> /assets/...).
   */
  loadImage(name: string): Promise<HTMLImageElement> {
    const url = imageUrl(name);
    const cached = this.cache.get(url);
    if (cached) return Promise.resolve(cached);

    const inFlight = this.loading.get(url);
    if (inFlight) return inFlight;

    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.cache.set(url, img);
        this.loading.delete(url);
        resolve(img);
      };
      img.onerror = () => {
        this.loading.delete(url);
        reject(new Error(`No se pudo cargar la imagen: ${url}`));
      };
      img.src = url;
    });
    this.loading.set(url, promise);
    return promise;
  }

  /** Devuelve la imagen cacheada si existe (sin disparar carga). */
  getCached(name: string): HTMLImageElement | undefined {
    return this.cache.get(imageUrl(name));
  }

  /** Limpia toda la pantalla a negro. */
  clear(): void {
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
  }

  /** Dibuja una imagen de fondo ocupando todo el tablero (Wollok: pantalla). */
  drawBackground(img: HTMLImageElement): void {
    this.ctx.drawImage(img, 0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
  }

  /**
   * Dibuja un sprite en coordenadas de CELDA Wollok (origen abajo-izquierda).
   * Convierte cellY al sistema de pantalla (origen arriba-izquierda).
   * El sprite ocupa una celda (CELL_SIZE x CELL_SIZE) salvo override.
   */
  drawSprite(
    img: HTMLImageElement,
    cellX: number,
    cellY: number,
    widthCells = 1,
    heightCells = 1,
  ): void {
    const px = cellX * CELL_SIZE;
    // Conversión de eje Y: arriba en Wollok = abajo en canvas.
    const py = (BOARD_HEIGHT - cellY - heightCells) * CELL_SIZE;
    this.ctx.drawImage(img, px, py, widthCells * CELL_SIZE, heightCells * CELL_SIZE);
  }

  /**
   * Dibuja texto en coordenadas de CELDA Wollok (p. ej. el marcador de puntaje
   * que en minijuego.wlk vivía en game.at(1, 26)).
   */
  drawText(text: string, cellX: number, cellY: number, color = '#FFFFFF'): void {
    const px = cellX * CELL_SIZE;
    const py = (BOARD_HEIGHT - cellY) * CELL_SIZE;
    this.ctx.fillStyle = color;
    this.ctx.font = `${CELL_SIZE}px monospace`;
    this.ctx.textBaseline = 'bottom';
    this.ctx.fillText(text, px, py);
  }
}
