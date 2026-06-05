// assets.ts — Resolución de nombres de assets a URLs servibles.
//
// El código Wollok referenciaba todo como "assets/<archivo>". Acá los assets viven
// en /public/assets/, que Vite sirve en la raíz como /assets/<archivo>.
// La carpeta original es PLANA (sin subcarpetas), por eso el mapeo es directo,
// pero centralizamos la lógica acá por si en el futuro hubiera subcarpetas.

/** Base pública donde Vite sirve los assets.
 * import.meta.env.BASE_URL respeta el `base` configurado en el build
 * (p. ej. "/the-big-quiz-port/" en GitHub Pages; "/" en dev). Termina en "/". */
const ASSET_BASE = `${import.meta.env.BASE_URL}assets`;

/**
 * Resuelve un nombre de archivo "pelado" a su URL completa.
 * Acepta tanto "banana.png" como "assets/banana.png" (lo normaliza).
 */
export function assetUrl(filename: string): string {
  // Quita un eventual prefijo "assets/" o "/assets/" para evitar duplicados.
  const clean = filename.replace(/^\/?assets\//, '').replace(/^\/+/, '');
  return `${ASSET_BASE}/${clean}`;
}

/**
 * Resuelve el nombre de IMAGEN de un nodo a su URL.
 * Wollok usaba `imageID` (p. ej. "quiz-0") y construía "imagen-quiz-0.png".
 * Si el nombre ya viene como archivo completo ("imagen-*.png" o "*.png"), se respeta.
 */
export function imageUrl(image: string): string {
  if (image.endsWith('.png') || image.endsWith('.jpg')) {
    return assetUrl(image);
  }
  // imageID crudo -> convención original "imagen-<id>.png"
  return assetUrl(`imagen-${image}.png`);
}

/**
 * Resuelve el nombre de un SONIDO/MÚSICA a su URL.
 * Wollok usaba el id de audio (p. ej. "monomovimiento") y construía
 * "assets/<id>.mp3". Si ya trae ".mp3", se respeta.
 */
export function soundUrl(sound: string): string {
  if (sound.endsWith('.mp3')) {
    return assetUrl(sound);
  }
  return assetUrl(`${sound}.mp3`);
}
