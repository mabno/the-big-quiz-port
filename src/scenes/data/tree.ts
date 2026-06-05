// tree.ts — Port COMPLETO del árbol narrativo de The Big Quiz.
//
// Fuente: src/tree.wlk (clases Estado + ~100 objetos const) + src/juego.wlk
// (flujo de transiciones, lógica de puntaje, música por estado) + src/musica.wlk
// (17 pistas con su volumen y loop). Cada objeto Wollok -> un NarrativeNode con el
// MISMO id (verbatim).
//
// --- Notas de fidelidad (semántica Wollok que el motor TS modela distinto) ---
//
// 1. MÚSICA. En Wollok `musica = [left, right]` y el sonido de transición se
//    disparan en `Estado.transicion()`, que corre sobre el nodo que se ABANDONA
//    (juego.actualizar() llama estadoActual.transicion() y recién adentro se
//    reasigna estadoActual). El motor TS dispara `node.music` al ENTRAR. Por eso
//    traducimos la directiva `musica` del nodo ORIGEN a la propiedad `music` de
//    sus nodos DESTINO (izq -> musica[0], der -> musica[1]). `silence` corta la
//    música de fondo (no hay pista audible). quiz arranca con `dreamscape` desde
//    el inicio (juego.init hacía game.schedule(0,{quiz.alternar()})).
//    OJO con la SEMÁNTICA: poneMusica() hacía cancion.alternar(), un TOGGLE
//    play/pausa de ESA pista (musica.wlk). O sea que [quiz, quiz] sobre un nodo
//    con dreamscape ya sonando NO la re-afirmaba: la PAUSABA. Los pares de
//    toggles del original (init/quiz_6, intro_quiz2/quiz2_caca,
//    intro_quiz3/quiz3_wollok, intro_quiz4/quiz4_wollok) prenden la pista al
//    entrar a cada quiz y la CORTAN al salir. Acá ese resultado audible se
//    modela en los destinos: M.quiz al entrar al quiz, M.silence al salir.
//
// 2. PUNTAJE DE QUIZ. `EstadoQuiz.transicion()` incrementa el puntaje si la
//    respuesta fue correcta, AL SALIR del quiz, antes de que el estado siguiente
//    lea el puntaje. El motor no tiene un "scoreDelta condicional", así que lo
//    modelamos con transiciones-función que leen ctx.playerInput y llaman
//    ctx.addScore(1) cuando acierta. Se conserva `correctAnswer` para que el
//    sfx yay/buzzer lo siga manejando el motor.
//
// 3. ESTADOS QUE TOCAN EL PUNTAJE AL SALIR (EstadoJuegoLag / Dificil / NoJuego /
//    BuenJuego / EstudioEficiente / EstudioIneficiente / Creditos). En Wollok
//    corren reiniciar/incrementar en `transicion()` (al salir). Los modelamos
//    también con transiciones-función (mismo timing que el original).
//
// 4. RAMIFICACIÓN POR PUNTAJE (EstadoQuiz6, EstadoFinExamen). En Wollok
//    `transiciones.get(puntaje)`. Lo modelamos con una transición-función que
//    indexa un array de destinos por ctx.score (con clamp defensivo).
//
// 5. MINIJUEGO (EstadoMinijuego). 3 instancias (minijuego_0, minijuego2_0,
//    minijuego3_0), todas variante 'mono'. Su estadoSiguiente() hardcodea los
//    nodos GLOBALES mono_muerto_0 (perder, score<0) y mono_muerto_1 (ganar,
//    score>=30); NO los per-instancia. Replicamos eso en onEnter.minigame.
//
// 6. COSAS QUE EL MOTOR NO PUEDE EXPRESAR (ver reporte final):
//    - EstadoCobranza (cobrador_0): transición al AZAR (anyOne) entre 2 destinos.
//      Lo modelamos con una transición-función que elige aleatoriamente.
//    - EstadoCreditos: en `right` hacía game.stop() (cerrar el juego). Una pestaña
//      web no puede cerrarse sola: lo modelamos con el nodo `bsod` (pantalla azul
//      de Windows 9X, broma), un nodo HOJA sin salidas — el "reboot" es F5.

import type {
  GameContext,
  MinigameConfig,
  MusicDirective,
  NarrativeNode,
  Transition,
} from '../../engine/types.js';

/** Id del nodo inicial (Wollok: juego.estadoActual = quiz_0, program.wpgm -> juego.init()). */
export const START_NODE = 'quiz_0';

// --- Catálogo de pistas (musica.wlk): file + volumen + loop ---
// silence y quiz se reproducen en loop (juego.inicializarMusica: shouldLoop(true)).
const M = {
  silence: { file: 'silence', volume: 1, loop: true },
  quiz: { file: 'dreamscape', volume: 0.1, loop: true },
  terror: { file: 'horror-background-atmosphere', volume: 0.25, loop: false },
  kevin: { file: 'not-as-it-seems', volume: 0.15, loop: false },
  minijuego: { file: 'minijuego', volume: 0.4, loop: false },
  hero: { file: 'hero', volume: 0.1, loop: false },
  chad: { file: 'can-you-feel-my-heart', volume: 0.1, loop: false },
  last_resort: { file: 'last-resort', volume: 0.1, loop: false },
  zombie: { file: 'zombie', volume: 0.1, loop: false },
  my_way: { file: 'my-way', volume: 0.1, loop: false },
  tension: { file: 'disturbing-call', volume: 0.4, loop: false },
  what_you_deserve: { file: 'what-you-deserve', volume: 0.05, loop: false },
  untitled: { file: 'untitled', volume: 0.1, loop: false },
  eminem: { file: 'till-i-collapse', volume: 0.07, loop: false },
  kevin2: { file: 'volatile-reaction', volume: 0.15, loop: false },
  evanescence: { file: 'bring-me-to-life', volume: 0.1, loop: false },
  in_the_end: { file: 'in-the-end', volume: 0.4, loop: false },
} as const satisfies Record<string, MusicDirective>;

// --- Helpers declarativos ---------------------------------------------------

/**
 * Transición de quiz: ambas direcciones van al MISMO destino, pero si la dirección
 * elegida es la correcta suma 1 al puntaje (replica EstadoQuiz.transicion()).
 * `correctIdx` es el `auxiliar` original (0 = Left, 1 = Right).
 */
function quizGoto(next: string, correctIdx: 0 | 1): Transition {
  return (ctx: GameContext): string => {
    if (ctx.playerInput === correctIdx) ctx.addScore(1);
    return next;
  };
}

/**
 * Transición que aplica un efecto de puntaje AL SALIR (reset y/o suma fija) y luego
 * va a `next`. Replica las clases EstadoJuego.../EstadoEstudio... que mutaban el
 * puntaje en transicion() antes de cambiar de pantalla.
 */
function scoreGoto(
  next: string,
  effect: { reset?: boolean; add?: number },
): Transition {
  return (ctx: GameContext): string => {
    if (effect.reset) ctx.resetScore();
    if (effect.add) ctx.addScore(effect.add);
    return next;
  };
}

/**
 * Transición por puntaje (EstadoQuiz6 / EstadoFinExamen): indexa `targets` por
 * ctx.score. Wollok hacía `transiciones.get(puntaje)`; clampeamos el índice al
 * rango del array por seguridad (el original confiaba en el rango natural del juego).
 */
/** Resuelve el destino por puntaje (con clamp). Usado por scoreBranch y por quiz_6. */
function pickByScore(targets: readonly string[], score: number): string {
  const i = Math.max(0, Math.min(targets.length - 1, score));
  return targets[i]!;
}

function scoreBranch(targets: readonly string[]): Transition {
  return (ctx: GameContext): string => pickByScore(targets, ctx.score);
}

/** Transición al azar entre destinos (EstadoCobranza.anyOne()). */
function randomGoto(targets: readonly string[]): Transition {
  return (): string => targets[Math.floor(Math.random() * targets.length)]!;
}

// Destinos de quiz_6 (EstadoQuiz6) indexados por puntaje (8 entradas, índices 0-7).
const QUIZ_6_TARGETS: readonly string[] = [
  'resultado_0', 'resultado_1', 'resultado_2', 'resultado_2',
  'resultado_2', 'resultado_3', 'resultado_3', 'resultado_4',
];

// Destinos de examen_9 (EstadoFinExamen) indexados por puntaje:
// 13× recursa_ending (índices 0-12), 5× regulariza_ending (13-17), 6× promocion_ending (18-23).
const EXAMEN_9_TARGETS: readonly string[] = [
  ...Array<string>(13).fill('recursa_ending'),
  ...Array<string>(5).fill('regulariza_ending'),
  ...Array<string>(6).fill('promocion_ending'),
];

// --- Config de minijuego (mono) ---------------------------------------------
// EstadoMinijuego.estadoSiguiente(): score < 0 -> mono_muerto_0 (perder);
// score >= 30 -> mono_muerto_1 (ganar). Nodos win/lose hardcodeados GLOBALES.
// `variant` es el discriminador acordado con el agente del minijuego (clase
// Wollok en minúsculas, sin acentos).
const MONO_MINIGAME: MinigameConfig = {
  winNode: 'mono_muerto_1',
  loseNode: 'mono_muerto_0',
  winScore: 30,
  loseScore: 0,
  music: M.minijuego,
  variant: 'mono',
};

// ============================================================================
// REGISTRO DE NODOS
// ============================================================================

export const TREE: Record<string, NarrativeNode> = {
  // --- Quiz inicial (EstadoQuiz; quiz_6 = EstadoQuiz6) ---------------------
  // quiz arranca con dreamscape (vol .1, loop) desde el inicio del juego.
  quiz_0: { id: 'quiz_0', image: 'quiz-0', music: M.quiz, correctAnswer: 'left', left: quizGoto('quiz_1', 0), right: quizGoto('quiz_1', 0) },
  quiz_1: { id: 'quiz_1', image: 'quiz-1', correctAnswer: 'right', left: quizGoto('quiz_2', 1), right: quizGoto('quiz_2', 1) },
  quiz_2: { id: 'quiz_2', image: 'quiz-2', correctAnswer: 'right', left: quizGoto('quiz_3', 1), right: quizGoto('quiz_3', 1) },
  quiz_3: { id: 'quiz_3', image: 'quiz-3', correctAnswer: 'left', left: quizGoto('quiz_4', 0), right: quizGoto('quiz_4', 0) },
  quiz_4: { id: 'quiz_4', image: 'quiz-4', correctAnswer: 'right', left: quizGoto('quiz_5', 1), right: quizGoto('quiz_5', 1) },
  quiz_5: { id: 'quiz_5', image: 'quiz-5', correctAnswer: 'right', left: quizGoto('quiz_6', 1), right: quizGoto('quiz_6', 1) },
  // quiz_6 = EstadoQuiz6: suma puntaje si acierta (auxiliar=0) y ramifica por puntaje.
  quiz_6: {
    id: 'quiz_6', image: 'quiz-6', music: M.quiz, correctAnswer: 'left',
    left: (ctx) => { if (ctx.playerInput === 0) ctx.addScore(1); return pickByScore(QUIZ_6_TARGETS, ctx.score); },
    right: (ctx) => { if (ctx.playerInput === 0) ctx.addScore(1); return pickByScore(QUIZ_6_TARGETS, ctx.score); },
  },

  // --- Resultados del primer quiz ------------------------------------------
  // El [quiz, quiz] de quiz_6 ALTERNABA la pista (toggle): dreamscape venía
  // sonando -> PAUSA. La aventura arranca SIN música; por eso M.silence acá
  // (antes decía M.quiz por la mala lectura del toggle y la música del quiz
  // quedaba sonando para siempre).
  resultado_0: { id: 'resultado_0', image: 'resultado-0', sound: 'quiz-0', music: M.silence, left: 'cafe', right: 'mate' },
  resultado_1: { id: 'resultado_1', image: 'resultado-1', sound: 'quiz-1', music: M.silence, left: 'cafe', right: 'mate' },
  resultado_2: { id: 'resultado_2', image: 'resultado-2', sound: 'quiz-2', music: M.silence, left: 'cafe', right: 'mate' },
  resultado_3: { id: 'resultado_3', image: 'resultado-3', sound: 'quiz-3', music: M.silence, left: 'cafe', right: 'mate' },
  resultado_4: { id: 'resultado_4', image: 'resultado-4', sound: 'quiz-4', music: M.silence, left: 'cafe', right: 'mate' },

  // --- Rama CAFÉ -----------------------------------------------------------
  cafe: { id: 'cafe', image: 'cafe', left: 'chad_cafe_solo', right: 'leche' },
  chad_cafe_solo: { id: 'chad_cafe_solo', image: 'chad-cafe-solo', sound: 'chad-0', left: 'ducha_0', right: 'ducha_0' },
  ducha_0: { id: 'ducha_0', image: 'ducha-0', left: 'telefono_0', right: 'chad_ducha' },

  // Llamar al dueño del edificio
  telefono_0: { id: 'telefono_0', image: 'telefono-0', sound: 'que', left: 'telefono_01', right: 'telefono_11' },
  telefono_01: { id: 'telefono_01', image: 'telefono-01', sound: 'tell-me-what-you-want', left: 'telefono_02', right: 'telefono_12' },
  telefono_02: { id: 'telefono_02', image: 'telefono-02', sound: 'me-suda-la-polla', left: 'telefono_03', right: 'telefono_13' },
  telefono_03: { id: 'telefono_03', image: 'telefono-03', sound: 'es-culpa-tuya', left: 'telefono_04', right: 'telefono_14' },
  telefono_04: { id: 'telefono_04', image: 'telefono-04', sound: 'que-quieres-que-haga', left: 'telefono_05', right: 'telefono_15' },
  telefono_05: { id: 'telefono_05', image: 'telefono-05', sound: 'no-quiero', left: 'telefono_06', right: 'telefono_16' },
  telefono_06: { id: 'telefono_06', image: 'telefono-06', sound: 'joder', left: 'intro_quiz4', right: 'videojuego2_1' },

  // Quiz 4 (Wollok-themed: quiz4_wollok = EstadoQuizWollok -> SIII!/NOOO!)
  intro_quiz4: { id: 'intro_quiz4', image: 'intro-quiz3', music: M.quiz, left: 'quiz4_0', right: 'quiz4_0' },
  quiz4_0: { id: 'quiz4_0', image: 'quiz3-0', correctAnswer: 'right', left: quizGoto('quiz4_1', 1), right: quizGoto('quiz4_1', 1) },
  quiz4_1: { id: 'quiz4_1', image: 'quiz3-1', correctAnswer: 'left', left: quizGoto('quiz4_2', 0), right: quizGoto('quiz4_2', 0) },
  quiz4_2: { id: 'quiz4_2', image: 'quiz3-2', correctAnswer: 'right', left: quizGoto('quiz4_3', 1), right: quizGoto('quiz4_3', 1) },
  quiz4_3: { id: 'quiz4_3', image: 'quiz3-3', correctAnswer: 'left', left: quizGoto('quiz4_wollok', 0), right: quizGoto('quiz4_wollok', 0) },
  // EstadoQuizWollok: NO suma puntaje, solo cambia el sfx a SIII!/NOOO! (con "!" literal).
  quiz4_wollok: { id: 'quiz4_wollok', image: 'quiz3-wollok', music: M.quiz, correctAnswer: 'right', quizSounds: ['SIII!', 'NOOO!'], left: 'llaman_puerta_0', right: 'llaman_puerta_0' },

  // Llaman a la puerta (rama examen)
  llaman_puerta_0: { id: 'llaman_puerta_0', image: 'llaman-puerta-0', sound: 'alooo', music: M.terror, left: 'llaman_puerta_1', right: 'llaman_puerta_1' },
  llaman_puerta_1: { id: 'llaman_puerta_1', image: 'llaman-puerta-1', left: 'llaman_puerta_2', right: 'llaman_puerta_2' },
  // musica = [terror, silence]: izq mantiene terror, der corta a silence.
  llaman_puerta_2: { id: 'llaman_puerta_2', image: 'llaman-puerta-2', sound: 'puerta-abre', left: 'filosofia_ending', right: 'abrir_puerta_2' },

  // Rama videojuego (mono minijuego)
  videojuego2_1: { id: 'videojuego2_1', image: 'videojuego-1', music: M.minijuego, left: 'mono_instrucciones2', right: 'videojuego2_2' },
  mono_instrucciones2: { id: 'mono_instrucciones2', image: 'mono-instrucciones', left: 'minijuego2_0', right: 'minijuego2_0' },
  // EstadoMinijuego: lanza el minijuego mono al ENTRAR. Transiciones vacías (hoja).
  minijuego2_0: { id: 'minijuego2_0', image: 'minijuego', sound: 'monomovimiento', onEnter: { minigame: MONO_MINIGAME } },

  // EstadoJuegoDificil (perder mono): reset + 1 -> score 1.
  mono_muerto2_0: { id: 'mono_muerto2_0', image: 'mono-muerto-0', music: M.minijuego, left: scoreGoto('llaman_puerta_0_j', { reset: true, add: 1 }), right: scoreGoto('llaman_puerta_0_j', { reset: true, add: 1 }) },
  // EstadoBuenJuego (ganar mono): reset + 3 -> score 3.
  mono_muerto2_1: { id: 'mono_muerto2_1', image: 'mono-muerto-1', music: M.minijuego, left: scoreGoto('llaman_puerta_0_j', { reset: true, add: 3 }), right: scoreGoto('llaman_puerta_0_j', { reset: true, add: 3 }) },

  // EstadoBuenJuego (videojuego2_2): reset + 3 -> score 3 (pantalla "juego random").
  videojuego2_2: { id: 'videojuego2_2', image: 'videojuego-2', left: scoreGoto('videojuego2_bombas', { reset: true, add: 3 }), right: scoreGoto('videojuego2_ranas', { reset: true, add: 3 }) },
  // bombas/ranas son pantallas estáticas (NO minijuegos interactivos en este source).
  videojuego2_bombas: { id: 'videojuego2_bombas', image: 'videojuego-bombas', left: 'llaman_puerta_0_j', right: 'llaman_puerta_0_j' },
  videojuego2_ranas: { id: 'videojuego2_ranas', image: 'videojuego-ranas', left: 'llaman_puerta_0_j', right: 'llaman_puerta_0_j' },

  // Llaman a la puerta (rama juego)
  llaman_puerta_0_j: { id: 'llaman_puerta_0_j', image: 'llaman-puerta-0', sound: 'alooo', music: M.terror, left: 'llaman_puerta_1_j', right: 'llaman_puerta_1_j' },
  llaman_puerta_1_j: { id: 'llaman_puerta_1_j', image: 'llaman-puerta-1', left: 'llaman_puerta_2_j', right: 'llaman_puerta_2_j' },
  llaman_puerta_2_j: { id: 'llaman_puerta_2_j', image: 'llaman-puerta-2', sound: 'puerta-abre', left: 'filosofia_ending', right: 'abrir_puerta_2_j' },

  // --- Ruptura ending (EstadoFinal) ---------------------------------------
  telefono_16: { id: 'telefono_16', image: 'telefono-16', sound: 'ruptura-ending', left: 'creditos', right: 'creditos' },

  // Tu servicio es desproporcional al precio
  telefono_15: { id: 'telefono_15', image: 'telefono-15', sound: 'lo-que-no-tengo-proporcional', left: 'intro_quiz2', right: 'no_es_un_juego_0' },

  // Quiz 2
  intro_quiz2: { id: 'intro_quiz2', image: 'intro-quiz2', music: M.quiz, left: 'quiz2_0', right: 'quiz2_0' },
  quiz2_0: { id: 'quiz2_0', image: 'quiz2-0', correctAnswer: 'right', left: quizGoto('quiz2_1', 1), right: quizGoto('quiz2_1', 1) },
  quiz2_1: { id: 'quiz2_1', image: 'quiz2-1', correctAnswer: 'left', left: quizGoto('quiz2_2', 0), right: quizGoto('quiz2_2', 0) },
  quiz2_2: { id: 'quiz2_2', image: 'quiz2-2', correctAnswer: 'right', left: quizGoto('quiz2_3', 1), right: quizGoto('quiz2_3', 1) },
  quiz2_3: { id: 'quiz2_3', image: 'quiz2-3', correctAnswer: 'left', left: quizGoto('quiz2_caca', 0), right: quizGoto('quiz2_caca', 0) },
  quiz2_caca: { id: 'quiz2_caca', image: 'quiz2-caca', sound: 'quieres-que-te-haga-caca-en-la-cara', music: M.quiz, correctAnswer: 'right', left: quizGoto('suena_telefono_0', 1), right: quizGoto('suena_telefono_0', 1) },

  // El [quiz, quiz] de quiz2_caca alternaba (toggle): corta la música del quiz 2.
  suena_telefono_0: { id: 'suena_telefono_0', image: 'suena-telefono-0', sound: 'telefono', music: M.silence, left: 'contesta_telefono_0', right: 'suena_telefono_1' },

  // Contestar
  contesta_telefono_0: { id: 'contesta_telefono_0', image: 'contesta-telefono-0', sound: 'me-he-dejado-las-llaves-dentro', left: 'contesta_telefono_1', right: 'contesta_telefono_1' },
  contesta_telefono_1: { id: 'contesta_telefono_1', image: 'contesta-telefono-1', sound: 'no-es-gracioso', left: 'contesta_telefono_apiadarse_0', right: 'contesta_telefono_que_se_cague_0' },
  contesta_telefono_apiadarse_0: { id: 'contesta_telefono_apiadarse_0', image: 'contesta-telefono-apiadarse-0', sound: 'gracias-por-escuchar-mis-plegarias-tio', left: 'contesta_telefono_apiadarse_1', right: 'contesta_telefono_apiadarse_1' },
  contesta_telefono_apiadarse_1: { id: 'contesta_telefono_apiadarse_1', image: 'contesta-telefono-apiadarse-1', left: 'examen_0', right: 'examen_0' },
  contesta_telefono_que_se_cague_0: { id: 'contesta_telefono_que_se_cague_0', image: 'contesta-telefono-que-se-cague-0', sound: 'me-cago-en-tus-muertos', left: 'contesta_telefono_que_se_cague_1', right: 'contesta_telefono_que_se_cague_1' },
  contesta_telefono_que_se_cague_1: { id: 'contesta_telefono_que_se_cague_1', image: 'contesta-telefono-que-se-cague-1', left: 'examen_0', right: 'examen_0' },

  // Me da paja -> vagabundo. musica = [silence, my_way]: izq corta, der arranca my_way.
  suena_telefono_1: { id: 'suena_telefono_1', image: 'suena-telefono-1', sound: 'eres-un-vago-de-mierda', left: 'contesta_telefono_0', right: 'vagabundo_ending' },
  vagabundo_ending: { id: 'vagabundo_ending', image: 'vagabundo-ending', sound: 'vago-ending', music: M.my_way, left: 'creditos', right: 'creditos' },

  // Trabajar en tu proyecto (rama "no es un juego")
  videojuego_0: { id: 'videojuego_0', image: 'videojuego-0', left: 'no_es_un_juego_0', right: 'no_es_un_juego_0' },
  no_es_un_juego_0: { id: 'no_es_un_juego_0', image: 'no-es-un-juego-0', sound: 'como-que-un-juego', left: 'no_es_un_juego_1', right: 'no_es_un_juego_1' },
  no_es_un_juego_1: { id: 'no_es_un_juego_1', image: 'no-es-un-juego-1', sound: 'esto-no-es-un-juego', left: 'libertad_ending', right: 'no_es_un_juego_2' },
  libertad_ending: { id: 'libertad_ending', image: 'libertad-ending', sound: 'libertad-ending', left: 'creditos', right: 'creditos' },
  // EstadoNoJuego: reset + 2 -> score 2.
  no_es_un_juego_2: { id: 'no_es_un_juego_2', image: 'no-es-un-juego-2', left: scoreGoto('ir_a_dormir_juego', { reset: true, add: 2 }), right: scoreGoto('ir_a_dormir_juego', { reset: true, add: 2 }) },
  ir_a_dormir_juego: { id: 'ir_a_dormir_juego', image: 'ir-a-dormir', left: 'juego_0', right: 'juego_0' },

  // Insultos al teléfono -> intro_quiz2 / videojuego_0
  telefono_14: { id: 'telefono_14', image: 'telefono-14', sound: 'mentiroso-de-mierda', left: 'intro_quiz2', right: 'videojuego_0' },
  telefono_13: { id: 'telefono_13', image: 'telefono-13', sound: 'quien-cojones-te-crees-que-eres', left: 'intro_quiz2', right: 'videojuego_0' },
  telefono_12: { id: 'telefono_12', image: 'telefono-12', sound: 'que-dices', left: 'intro_quiz2', right: 'videojuego_0' },
  telefono_11: { id: 'telefono_11', image: 'telefono-11', sound: 'eres-imbecil', left: 'intro_quiz2', right: 'videojuego_0' },

  // --- Rama DUCHA FRÍA (chad) ----------------------------------------------
  chad_ducha: { id: 'chad_ducha', image: 'chad-ducha', sound: 'chad-1', left: 'ducha_1', right: 'ducha_1' },
  ducha_1: { id: 'ducha_1', image: 'ducha-1', left: 'ejercicio_0', right: 'videojuego_3' },

  // Estudiar (ejercicios)
  ejercicio_0: { id: 'ejercicio_0', image: 'ejercicio-0', left: 'ejercicio_1', right: 'ejercicio_2' },
  ejercicio_1: { id: 'ejercicio_1', image: 'ejercicio-1', left: 'ejercicio_8', right: 'ejercicio_8' },
  // EstadoEstudioEficiente: +5 (sin reset).
  ejercicio_8: { id: 'ejercicio_8', image: 'ejercicio-8', left: scoreGoto('ir_a_dormir_examen', { add: 5 }), right: scoreGoto('ir_a_dormir_examen', { add: 5 }) },
  ir_a_dormir_examen: { id: 'ir_a_dormir_examen', image: 'ir-a-dormir', left: 'examen_0', right: 'examen_0' },

  ejercicio_2: { id: 'ejercicio_2', image: 'ejercicio-2', sound: 'chad-2', left: 'ejercicio_3', right: 'ejercicio_4' },
  // musica = [silence, chad]: izq corta, der arranca chad.
  ejercicio_3: { id: 'ejercicio_3', image: 'ejercicio-3', left: 'ejercicio_4', right: 'chad_ending' },
  chad_ending: { id: 'chad_ending', image: 'chad-ending', sound: 'chad-ending', music: M.chad, left: 'creditos', right: 'creditos' },

  // EstadoEstudioIneficiente: +1 (sin reset).
  ejercicio_4: { id: 'ejercicio_4', image: 'ejercicio-4', left: scoreGoto('ejercicio_5', { add: 1 }), right: scoreGoto('ejercicio_5', { add: 1 }) },
  ejercicio_5: { id: 'ejercicio_5', image: 'ejercicio-5', left: 'ejercicio_6', right: 'ejercicio_6' },
  ejercicio_6: { id: 'ejercicio_6', image: 'ejercicio-6', left: 'ejercicio_7', right: 'ejercicio_7' },
  // ejercicio_7 usa imageID "ejercicio-1" (verbatim del source).
  ejercicio_7: { id: 'ejercicio_7', image: 'ejercicio-1', left: 'ir_a_dormir_examen', right: 'ir_a_dormir_examen' },

  // Rama videojuego (estudio) -> mono minijuego o raycasting
  videojuego_3: { id: 'videojuego_3', image: 'videojuego-3', music: M.minijuego, left: 'mono_instrucciones3', right: 'videojuego_raycasting_0' },
  videojuego_raycasting_0: { id: 'videojuego_raycasting_0', image: 'videojuego-raycasting-0', sound: 'chad-2', left: 'videojuego_raycasting_1', right: 'videojuego_raycasting_1' },
  // musica = [silence, chad]: izq corta, der arranca chad.
  videojuego_raycasting_1: { id: 'videojuego_raycasting_1', image: 'videojuego-raycasting-1', left: 'videojuego_raycasting_2', right: 'chad_ending2' },
  // EstadoJuegoLag: reset -> score 0.
  videojuego_raycasting_2: { id: 'videojuego_raycasting_2', image: 'videojuego-raycasting-2', left: scoreGoto('juego_0', { reset: true }), right: scoreGoto('juego_0', { reset: true }) },
  chad_ending2: { id: 'chad_ending2', image: 'chad-ending2', sound: 'chad-ending2', music: M.chad, left: 'creditos', right: 'creditos' },

  mono_instrucciones3: { id: 'mono_instrucciones3', image: 'mono-instrucciones', left: 'minijuego3_0', right: 'minijuego3_0' },
  minijuego3_0: { id: 'minijuego3_0', image: 'minijuego', sound: 'monomovimiento', onEnter: { minigame: MONO_MINIGAME } },
  // EstadoJuegoDificil (perder): reset + 1 -> 1.
  mono_muerto3_0: { id: 'mono_muerto3_0', image: 'mono-muerto-0', music: M.minijuego, left: scoreGoto('ir_a_dormir_juego', { reset: true, add: 1 }), right: scoreGoto('ir_a_dormir_juego', { reset: true, add: 1 }) },
  // EstadoBuenJuego (ganar): reset + 3 -> 3.
  mono_muerto3_1: { id: 'mono_muerto3_1', image: 'mono-muerto-1', music: M.minijuego, left: scoreGoto('ir_a_dormir_juego', { reset: true, add: 3 }), right: scoreGoto('ir_a_dormir_juego', { reset: true, add: 3 }) },

  // --- Rama LECHE / café salvado / cobranza --------------------------------
  leche: { id: 'leche', image: 'leche', sound: 'fridge', left: 'edulcorante', right: 'edulcorante' },
  edulcorante: { id: 'edulcorante', image: 'edulcorante', sound: 'drop-bounce-plastic-bottle', left: 'salvar_cafe', right: 'aceptar_derrota' },
  // musica = [silence, hero]: izq corta, der arranca hero.
  salvar_cafe: { id: 'salvar_cafe', image: 'salvar-cafe', left: 'arrepentimiento', right: 'spiderman_ending' },
  arrepentimiento: { id: 'arrepentimiento', image: 'arrepentimiento', music: M.tension, left: 'cobrador_0', right: 'cobrador_0' },
  // EstadoCobranza: transición al AZAR (anyOne) entre cobrador_ending y cobrador_salvado.
  cobrador_0: { id: 'cobrador_0', image: 'cobrador-0', music: M.tension, left: randomGoto(['cobrador_ending', 'cobrador_salvado']), right: randomGoto(['cobrador_ending', 'cobrador_salvado']) },
  cobrador_ending: { id: 'cobrador_ending', image: 'cobrador-ending', sound: 'coin-drop', left: 'creditos', right: 'creditos' },
  cobrador_salvado: { id: 'cobrador_salvado', image: 'cobrador-salvado', sound: 'coin-drop', left: 'cafe', right: 'mate' },
  spiderman_ending: { id: 'spiderman_ending', image: 'spiderman-ending', sound: 'spiderman-ending', music: M.hero, left: 'creditos', right: 'creditos' },

  aceptar_derrota: { id: 'aceptar_derrota', image: 'aceptar-derrota', left: 'derrame_escritorio', right: 'derrame_compu' },
  // musica = [silence, evanescence]: izq corta, der arranca evanescence.
  derrame_escritorio: { id: 'derrame_escritorio', image: 'derrame-escritorio', sound: 'gasp', left: 'derrame_escritorio_1', right: 'desesperanza_ending' },
  derrame_escritorio_1: { id: 'derrame_escritorio_1', image: 'derrame-escritorio-1', left: 'examen_0', right: 'examen_0' },
  desesperanza_ending: { id: 'desesperanza_ending', image: 'desesperanza-ending', sound: 'desesperanza-ending', music: M.evanescence, left: 'creditos', right: 'creditos' },

  derrame_compu: { id: 'derrame_compu', image: 'derrame-compu', sound: 'gasp', left: 'derrame_compu_1', right: 'compu_caida' },
  // EstadoNoJuego: reset + 2 -> 2.
  derrame_compu_1: { id: 'derrame_compu_1', image: 'derrame-compu-1', left: scoreGoto('juego_0', { reset: true, add: 2 }), right: scoreGoto('juego_0', { reset: true, add: 2 }) },
  // musica = [last_resort, zombie]: izq arranca last_resort, der arranca zombie.
  compu_caida: { id: 'compu_caida', image: 'compu-caida', sound: 'laptop-drop', left: 'suicidio_ending', right: 'zombie_ending' },
  suicidio_ending: { id: 'suicidio_ending', image: 'suicidio-ending', sound: 'suicidio-ending', music: M.last_resort, left: 'creditos', right: 'creditos' },
  zombie_ending: { id: 'zombie_ending', image: 'zombie-ending', sound: 'zombie-ending', music: M.zombie, left: 'creditos', right: 'creditos' },

  // --- Rama MATE -----------------------------------------------------------
  mate: { id: 'mate', image: 'mate', left: 'mate_bueno', right: 'mate_quemao' },
  mate_bueno: { id: 'mate_bueno', image: 'mate-bueno', sound: 'que-rico-esta-este-mate', left: 'intro_quiz3', right: 'videojuego_1' },

  // Quiz 3 (quiz3_wollok = EstadoQuizWollok -> SIII!/NOOO!)
  intro_quiz3: { id: 'intro_quiz3', image: 'intro-quiz3', music: M.quiz, left: 'quiz3_0', right: 'quiz3_0' },
  quiz3_0: { id: 'quiz3_0', image: 'quiz3-0', correctAnswer: 'right', left: quizGoto('quiz3_1', 1), right: quizGoto('quiz3_1', 1) },
  quiz3_1: { id: 'quiz3_1', image: 'quiz3-1', correctAnswer: 'left', left: quizGoto('quiz3_2', 0), right: quizGoto('quiz3_2', 0) },
  quiz3_2: { id: 'quiz3_2', image: 'quiz3-2', correctAnswer: 'right', left: quizGoto('quiz3_3', 1), right: quizGoto('quiz3_3', 1) },
  quiz3_3: { id: 'quiz3_3', image: 'quiz3-3', correctAnswer: 'left', left: quizGoto('quiz3_wollok', 0), right: quizGoto('quiz3_wollok', 0) },
  quiz3_wollok: { id: 'quiz3_wollok', image: 'quiz3-wollok', music: M.quiz, correctAnswer: 'right', quizSounds: ['SIII!', 'NOOO!'], left: 'tocan_puerta_0', right: 'tocan_puerta_0' },

  // Tocan la puerta (rama estudio)
  tocan_puerta_0: { id: 'tocan_puerta_0', image: 'tocan-puerta-0', sound: 'toctoc', music: M.terror, left: 'abrir_puerta_0', right: 'no_abrir_puerta_0' },
  abrir_puerta_0: { id: 'abrir_puerta_0', image: 'abrir-puerta-0', left: 'abrir_puerta_1', right: 'abrir_puerta_1' },
  // musica = [terror, silence]: izq mantiene terror, der corta.
  abrir_puerta_1: { id: 'abrir_puerta_1', image: 'abrir-puerta-1', sound: 'puerta-abre', left: 'filosofia_ending', right: 'abrir_puerta_2' },
  filosofia_ending: { id: 'filosofia_ending', image: 'filosofia-ending', sound: 'filosofia-ending', left: 'creditos', right: 'creditos' },

  // Sueño (examen)
  abrir_puerta_2: { id: 'abrir_puerta_2', image: 'abrir-puerta-2', sound: 'muy-bien', music: M.terror, left: 'facu_aula', right: 'facu_aula' },
  facu_aula: { id: 'facu_aula', image: 'facu-aula', sound: 'campana', left: 'facu_vaso', right: 'facu_vaso' },
  facu_vaso: { id: 'facu_vaso', image: 'facu-vaso', left: 'dilema_supremo', right: 'anti_ecologimo_ending' },
  dilema_supremo: { id: 'dilema_supremo', image: 'dilema-supremo', left: 'fin_del_mundo_ending', right: 'messi_ending' },
  fin_del_mundo_ending: { id: 'fin_del_mundo_ending', image: 'fin-del-mundo-ending', sound: 'fin-del-mundo-ending', left: 'creditos', right: 'creditos' },
  // messi_ending es un Estado normal (NO EstadoFinal): continúa a examen_0_sueno.
  messi_ending: { id: 'messi_ending', image: 'messi-ending', left: 'examen_0_sueno', right: 'examen_0_sueno' },
  anti_ecologimo_ending: { id: 'anti_ecologimo_ending', image: 'anti-ecologimo-ending', sound: 'anti-ecologismo-ending', left: 'creditos', right: 'creditos' },

  // Sueño (juego)
  abrir_puerta_2_j: { id: 'abrir_puerta_2_j', image: 'abrir-puerta-2', sound: 'muy-bien', music: M.terror, left: 'facu_aula_j', right: 'facu_aula_j' },
  facu_aula_j: { id: 'facu_aula_j', image: 'facu-aula', sound: 'campana', left: 'facu_vaso_j', right: 'facu_vaso_j' },
  facu_vaso_j: { id: 'facu_vaso_j', image: 'facu-vaso', left: 'dilema_supremo_j', right: 'anti_ecologimo_ending' },
  dilema_supremo_j: { id: 'dilema_supremo_j', image: 'dilema-supremo', left: 'fin_del_mundo_ending', right: 'messi_ending_j' },
  messi_ending_j: { id: 'messi_ending_j', image: 'messi-ending', left: 'juego_0_sueno', right: 'juego_0_sueno' },

  // No abrir la puerta (jump scare)
  no_abrir_puerta_0: { id: 'no_abrir_puerta_0', image: 'no-abrir-puerta-0', sound: 'toctoc-1', left: 'abrir_puerta_0', right: 'no_abrir_puerta_1' },
  // musica = [silence, terror]: izq corta, der arranca terror.
  no_abrir_puerta_1: { id: 'no_abrir_puerta_1', image: 'no-abrir-puerta-1', sound: 'toctoc-2', left: 'abrir_puerta_0', right: 'no_abrir_puerta_2' },
  no_abrir_puerta_2: { id: 'no_abrir_puerta_2', image: 'no-abrir-puerta-2', left: 'no_abrir_puerta_3', right: 'no_abrir_puerta_3' },
  no_abrir_puerta_3: { id: 'no_abrir_puerta_3', image: 'no-abrir-puerta-3', left: 'no_abrir_puerta_4', right: 'no_abrir_puerta_4' },
  no_abrir_puerta_4: { id: 'no_abrir_puerta_4', image: 'no-abrir-puerta-4', sound: 'jump-scare', left: 'facu_aula', right: 'facu_aula' },

  // Rama videojuego (mate) -> mono minijuego
  videojuego_1: { id: 'videojuego_1', image: 'videojuego-1', music: M.minijuego, left: 'mono_instrucciones', right: 'videojuego_2' },
  mono_instrucciones: { id: 'mono_instrucciones', image: 'mono-instrucciones', left: 'minijuego_0', right: 'minijuego_0' },
  minijuego_0: { id: 'minijuego_0', image: 'minijuego', sound: 'monomovimiento', onEnter: { minigame: MONO_MINIGAME } },
  // mono_muerto_0/_1: nodos GLOBALES de win/lose del minijuego (referenciados por las 3 instancias).
  // EstadoJuegoDificil (perder): reset + 1 -> 1.
  mono_muerto_0: { id: 'mono_muerto_0', image: 'mono-muerto-0', music: M.minijuego, left: scoreGoto('ir_a_dormir_juego', { reset: true, add: 1 }), right: scoreGoto('ir_a_dormir_juego', { reset: true, add: 1 }) },
  // EstadoBuenJuego (ganar): reset + 3 -> 3.
  mono_muerto_1: { id: 'mono_muerto_1', image: 'mono-muerto-1', music: M.minijuego, left: scoreGoto('ir_a_dormir_juego', { reset: true, add: 3 }), right: scoreGoto('ir_a_dormir_juego', { reset: true, add: 3 }) },

  // EstadoBuenJuego (videojuego_2): reset + 3 -> 3.
  videojuego_2: { id: 'videojuego_2', image: 'videojuego-2', left: scoreGoto('videojuego_bombas', { reset: true, add: 3 }), right: scoreGoto('videojuego_ranas', { reset: true, add: 3 }) },
  videojuego_bombas: { id: 'videojuego_bombas', image: 'videojuego-bombas', left: 'ir_a_dormir_juego', right: 'ir_a_dormir_juego' },
  videojuego_ranas: { id: 'videojuego_ranas', image: 'videojuego-ranas', left: 'ir_a_dormir_juego', right: 'ir_a_dormir_juego' },

  // Hervir el agua -> mate ending
  mate_quemao: { id: 'mate_quemao', image: 'mate-quemao', sound: 'thunder', left: 'corte_luz', right: 'corte_luz' },
  corte_luz: { id: 'corte_luz', image: 'corte-luz', sound: 'la-puta-madre-se-corto-la-luz', music: M.what_you_deserve, left: 'mate_ending', right: 'mate_ending' },
  mate_ending: { id: 'mate_ending', image: 'mate-ending', sound: 'mate-ending', music: M.what_you_deserve, left: 'creditos', right: 'creditos' },

  // --- Día 2: EXAMEN -------------------------------------------------------
  examen_0_sueno: { id: 'examen_0_sueno', image: 'examen-0-sueno', sound: 'gallo', left: 'examen_1', right: 'examen_1' },
  examen_0: { id: 'examen_0', image: 'examen-0', sound: 'gallo', left: 'examen_1', right: 'examen_1' },
  // musica = [silence, untitled]: izq corta, der arranca untitled (exament ending).
  examen_1: { id: 'examen_1', image: 'examen-1', left: 'examen_2', right: 'exament_ending' },
  examen_2: { id: 'examen_2', image: 'examen-2', sound: 'ticking-clock', music: M.eminem, left: 'examen_3', right: 'examen_3' },
  examen_3: { id: 'examen_3', image: 'examen-3', sound: 'esto-no-va-a-estar-facil', left: 'quiz_examen_0', right: 'quiz_examen_0' },

  // Quiz del examen (quiz_examen_4 = EstadoQuizWollok -> SIII!/NOOO!)
  quiz_examen_0: { id: 'quiz_examen_0', image: 'quiz-examen-0', sound: 'empiecen-a-escribir', correctAnswer: 'left', left: quizGoto('quiz_examen_1', 0), right: quizGoto('quiz_examen_1', 0) },
  quiz_examen_1: { id: 'quiz_examen_1', image: 'quiz-examen-1', sound: 'perfecto-epico', correctAnswer: 'left', left: quizGoto('quiz_examen_2', 0), right: quizGoto('quiz_examen_2', 0) },
  quiz_examen_2: { id: 'quiz_examen_2', image: 'quiz-examen-2', correctAnswer: 'right', left: quizGoto('quiz_examen_3', 1), right: quizGoto('quiz_examen_3', 1) },
  quiz_examen_3: { id: 'quiz_examen_3', image: 'quiz-examen-3', sound: 'vibracion-0', music: M.eminem, correctAnswer: 'left', left: quizGoto('quiz_examen_4', 0), right: quizGoto('quiz_examen_4', 0) },
  // EstadoQuizWollok: NO suma puntaje, sfx SIII!/NOOO!.
  quiz_examen_4: { id: 'quiz_examen_4', image: 'quiz-examen-4', sound: 'surprise', music: M.eminem, correctAnswer: 'left', quizSounds: ['SIII!', 'NOOO!'], left: 'quiz_examen_5', right: 'quiz_examen_5' },
  quiz_examen_5: { id: 'quiz_examen_5', image: 'quiz-examen-5', sound: 'ticking-clock', correctAnswer: 'left', left: quizGoto('quiz_examen_6', 0), right: quizGoto('quiz_examen_6', 0) },
  quiz_examen_6: { id: 'quiz_examen_6', image: 'quiz-examen-6', correctAnswer: 'left', left: quizGoto('quiz_examen_7', 0), right: quizGoto('quiz_examen_7', 0) },
  quiz_examen_7: { id: 'quiz_examen_7', image: 'quiz-examen-7', sound: 'vibracion-1', correctAnswer: 'right', left: quizGoto('quiz_examen_8', 1), right: quizGoto('quiz_examen_8', 1) },
  quiz_examen_8: { id: 'quiz_examen_8', image: 'quiz-examen-8', sound: 'alarma', correctAnswer: 'right', left: quizGoto('quiz_examen_9', 1), right: quizGoto('quiz_examen_9', 1) },
  quiz_examen_9: { id: 'quiz_examen_9', image: 'quiz-examen-9', sound: 'ambulancia', correctAnswer: 'right', left: quizGoto('quiz_examen_10', 1), right: quizGoto('quiz_examen_10', 1) },
  quiz_examen_10: { id: 'quiz_examen_10', image: 'quiz-examen-10', sound: 'apurate-0', music: M.eminem, correctAnswer: 'right', left: quizGoto('examen_4', 1), right: quizGoto('examen_4', 1) },

  examen_4: { id: 'examen_4', image: 'examen-4', sound: 'apurate-1', music: M.kevin2, left: 'examen_5', right: 'examen_5' },
  examen_5: { id: 'examen_5', image: 'examen-5', sound: 'que-carajos-es-esto', left: 'examen_6', right: 'examen_6' },
  examen_6: { id: 'examen_6', image: 'examen-6', sound: 'wow-wow', left: 'examen_7', right: 'examen_7' },
  examen_7: { id: 'examen_7', image: 'examen-7', sound: 'risa-0', left: 'examen_8', right: 'examen_8' },
  examen_8: { id: 'examen_8', image: 'examen-8', sound: 'risa-1', left: 'examen_9', right: 'examen_9' },
  // EstadoFinExamen: ramifica por puntaje. 24 entradas: 0-12 recursa, 13-17 regulariza, 18-23 promocion.
  examen_9: {
    id: 'examen_9', image: 'examen-9', sound: 'risa-2', music: M.kevin2,
    left: scoreBranch(EXAMEN_9_TARGETS),
    right: scoreBranch(EXAMEN_9_TARGETS),
  },

  // Resultados examen
  promocion_ending: { id: 'promocion_ending', image: 'promocion-ending', sound: 'promocion-ending', left: 'creditos', right: 'creditos' },
  regulariza_ending: { id: 'regulariza_ending', image: 'regulariza-ending', sound: 'regulariza-ending', left: 'creditos', right: 'creditos' },
  recursa_ending: { id: 'recursa_ending', image: 'recursa-ending', sound: 'recursa-ending', left: 'creditos', right: 'creditos' },

  // Quedarse en casa -> Examen't ending
  exament_ending: { id: 'exament_ending', image: 'exament-ending', sound: 'exament-ending', music: M.untitled, left: 'creditos', right: 'creditos' },

  // --- Día 2: JUEGO --------------------------------------------------------
  juego_0_sueno: { id: 'juego_0_sueno', image: 'juego-0-sueno', sound: 'gallo', left: 'final_juego_0', right: 'final_juego_0' },
  juego_0: { id: 'juego_0', image: 'juego-0', sound: 'gallo', left: 'final_juego_0', right: 'final_juego_0' },
  final_juego_0: { id: 'final_juego_0', image: 'final-juego-0', left: 'final_juego_1', right: 'final_juego_1' },
  final_juego_1: { id: 'final_juego_1', image: 'final-juego-1', sound: '1-muy-buenas-tardes-a-todos', music: M.kevin, left: 'final_juego_2', right: 'final_juego_2' },
  final_juego_2: { id: 'final_juego_2', image: 'final-juego-2', sound: '2-get-ready', left: 'final_juego_3', right: 'final_juego_3' },
  final_juego_3: { id: 'final_juego_3', image: 'final-juego-3', sound: '3-me-cago-en-dios-gaste-un-poder', left: 'final_juego_4', right: 'final_juego_4' },
  final_juego_4: { id: 'final_juego_4', image: 'final-juego-4', sound: '4-dale', left: 'final_juego_5', right: 'final_juego_5' },
  final_juego_5: { id: 'final_juego_5', image: 'final-juego-5', sound: '5-el-boton-de-reset', left: 'final_juego_6', right: 'final_juego_6' },
  final_juego_6: { id: 'final_juego_6', image: 'final-juego-6', sound: '6-el-creador-de-esta-mierda', left: 'final_juego_7', right: 'final_juego_7' },
  final_juego_7: { id: 'final_juego_7', image: 'final-juego-7', sound: '7-quien-cono-es-fede', left: 'final_juego_8', right: 'final_juego_8' },
  final_juego_8: { id: 'final_juego_8', image: 'final-juego-8', sound: '8-dale-dale', left: 'final_juego_9', right: 'final_juego_9' },
  final_juego_9: { id: 'final_juego_9', image: 'final-juego-9', sound: 'a-ver-0', left: 'final_juego_10', right: 'final_juego_10' },
  // EstadoFinExamen: ramifica por puntaje. 4 entradas (índice 0-3).
  final_juego_10: {
    id: 'final_juego_10', image: 'final-juego-10', sound: 'ahi-voy',
    left: scoreBranch(['recursa_juego_raycasting', 'recursa_juego_mono', 'regulariza_juego', 'promocion_juego']),
    right: scoreBranch(['recursa_juego_raycasting', 'recursa_juego_mono', 'regulariza_juego', 'promocion_juego']),
  },

  // Resultados juego
  promocion_juego: { id: 'promocion_juego', image: 'promocion-juego', sound: 'perfecto', music: M.kevin, left: 'promocion_juego_ending', right: 'promocion_juego_ending' },
  promocion_juego_ending: { id: 'promocion_juego_ending', image: 'promocion-juego-ending', sound: 'promocion-juego-ending', left: 'creditos', right: 'creditos' },
  regulariza_juego: { id: 'regulariza_juego', image: 'regulariza-juego', music: M.kevin, left: 'regulariza_juego_ending', right: 'regulariza_juego_ending' },
  regulariza_juego_ending: { id: 'regulariza_juego_ending', image: 'regulariza-juego-ending', sound: 'regulariza-juego-ending', left: 'creditos', right: 'creditos' },
  recursa_juego_raycasting: { id: 'recursa_juego_raycasting', image: 'recursa-juego-raycasting', sound: 'tiene-lag-el-juego', music: M.kevin, left: 'recursa_juego_ending', right: 'recursa_juego_ending' },
  recursa_juego_mono: { id: 'recursa_juego_mono', image: 'recursa-juego-mono', sound: 'noo', music: M.kevin, left: 'recursa_juego_ending', right: 'recursa_juego_ending' },
  recursa_juego_ending: { id: 'recursa_juego_ending', image: 'recursa-juego-ending', sound: 'recursa-juego-ending', left: 'creditos', right: 'creditos' },

  // To be continued (sin entrada en init de transiciones del flujo principal, pero definido).
  to_be_continued: { id: 'to_be_continued', image: 'to-be-continued', sound: 'roundabout', left: 'creditos', right: 'creditos' },

  // --- CRÉDITOS (EstadoCreditos) -------------------------------------------
  // En Wollok: `left` reinicia puntaje y vuelve a quiz_0; `right` hacía
  // game.stop() (cerrar el juego). Una pestaña web no puede cerrarse sola, así
  // que `right` va al nodo `bsod` (ver abajo).
  // sonidoDeTransicion original = ah-shit-here-we-go-again (referencia GTA SA)
  // en AMBAS direcciones; acá la DERECHA suena critical-error (Windows XP) para
  // que el crash se escuche justo cuando aparece la BSOD, sin mezclarse con el
  // ah-shit. Por eso el sonido va como transición asimétrica y NO como `sound`
  // del nodo bsod.
  creditos: {
    id: 'creditos', image: 'creditos', music: M.in_the_end,
    quizSounds: ['ah-shit-here-we-go-again', 'critical-error'],
    correctAnswer: 'left', // izq = ah-shit (reiniciar), der = critical-error (BSOD).
    left: scoreGoto('quiz_0', { reset: true }),
    right: 'bsod',
  },

  // --- BSOD (reemplazo del game.stop() original) ---------------------------
  // Nodo HOJA sin salidas: de una pantalla azul no se vuelve (el "reboot" es
  // recargar la página). `silence` corta la música de créditos: la máquina
  // "se colgó". Imagen: Windows 9X BSOD (Wikimedia Commons) -> imagen-bsod.png.
  // El critical-error suena como transición creditos->right (ver arriba).
  // pageBackground tiñe el letterbox de la página del MISMO azul que la imagen
  // (#0000AA, sampleado de imagen-bsod.png) para que la BSOD ocupe todo el visor.
  bsod: { id: 'bsod', image: 'bsod', music: M.silence, pageBackground: '#0000AA' },
};
