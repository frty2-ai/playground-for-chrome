/**
 * The brand the learner sees over their app: Assure by 42, palette "Deep Tide".
 * One place for the colours, the type face, the icons and the surface recipe
 * that the cursor, the panel, labels and cards share (ghost.js, tutor.js,
 * tutor-overlay.js). Injected before them; it draws nothing itself.
 *
 *   Estuary  #142321  ink          Deep Teal  #245B50  signature
 *   Mist     #B9CEC4  support      Chalk      #F3F5F1  surface
 *
 * Beside the palette only semantic colours: the live LED (green), caution
 * (amber) and error (red). No magenta anywhere.
 *
 * The face is Fira Code Nerd Font with its ligatures on (the sans Claude's own
 * interface uses is not openly licensed). Its bytes come from
 * vendor/fira-code-nerd/fira-code-nerd.js, injected just before this file,
 * and are handed to FontFace as data, so no page's CSP can block them. The
 * family is registered under a private name, so the page's own text never
 * changes. The same font carries the Material Design icons in ICONS.
 */

(() => {
  if (window.__a42Brand) { window.__a42Brand.loadFont(); return; }

  const C = {
    estuary: '#142321',
    teal: '#245B50',
    tealDeep: '#1B463D',
    mist: '#B9CEC4',
    chalk: '#F3F5F1',
    muted: '#4F5C58',          // Estuary on Chalk, softened: 6.4:1
    hair: 'rgba(20, 35, 33, .12)',
    led: '#45D69A',
    ledText: '#CFF3E1',
    amber: '#B7791F',
    amberInk: '#8A5510',
    amberTint: '#F7EEDC',
    danger: '#A8321F',
    dangerTint: '#F8E7E3',
  };

  const FAMILY = 'A42 Code';
  // Hindi falls through to a Devanagari face; the rest stays monospace.
  const FONT = `"${FAMILY}", "FiraCode Nerd Font", "Fira Code", "Noto Sans Devanagari", "Nirmala UI", ui-monospace, "Cascadia Code", Menlo, Consolas, monospace`;
  const LIGATURES = 'font-variant-ligatures: common-ligatures contextual; font-feature-settings: "calt" 1, "liga" 1;';
  const NAME = '42 Tutor';

  /** Nerd Font (Material Design) code points; only these are in the subset. */
  const ICONS = {
    copy: '\u{F018F}', check: '\u{F012C}', hint: '\u{F06E9}', info: '\u{F02FD}', done: '\u{F05E1}', caution: '\u{F002A}',
    mic: '\u{F036C}', micOff: '\u{F036D}', pause: '\u{F03E4}', play: '\u{F040A}', task: '\u{F08A8}', click: '\u{F0CFE}',
    question: '\u{F0625}', list: '\u{F0756}', close: '\u{F0156}', minus: '\u{F0374}', text: '\u{F0284}', stop: '\u{F04DB}',
    next: '\u{F04AD}', ask: '\u{F1739}', learn: '\u{F1180}',
  };

  /** Frosted surface on Chalk, lifted: Material's level 3, tinted with Estuary. */
  const ELEVATION = '0 1px 2px rgba(20,35,33,.16), 0 6px 16px -2px rgba(20,35,33,.16), 0 22px 44px -14px rgba(20,35,33,.30)';
  const SURFACE = `background: rgba(243,245,241,.86); -webkit-backdrop-filter: blur(18px) saturate(1.5); backdrop-filter: blur(18px) saturate(1.5);
    border: 1px solid rgba(255,255,255,.65); box-shadow: 0 0 0 1px ${C.hair}, ${ELEVATION};`;
  const SURFACE_DARK = 'background: rgba(20,35,33,.90); -webkit-backdrop-filter: blur(18px) saturate(1.4); backdrop-filter: blur(18px) saturate(1.4);';

  /** The cursor's arrow, drawn in 46 × 52. */
  const CURSOR_PATH = 'M3 3 L3 39 L12.5 30.5 L19 46 L26.5 42.8 L20 27.5 L33.5 27.5 Z';

  function loadFont() {
    const fonts = globalThis.__a42Fonts;
    if (!fonts || !document.fonts || typeof FontFace !== 'function') return;
    if ([...document.fonts].some((f) => f.family.replace(/"/g, '') === FAMILY)) return;
    for (const {weight, data} of fonts) {
      try {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const face = new FontFace(FAMILY, bytes.buffer, {weight, style: 'normal', display: 'swap'});
        document.fonts.add(face);
        face.load().catch(() => {});
      } catch { /* the fallback stack still reads well */ }
    }
  }

  loadFont();
  window.__a42Brand = {C, FONT, LIGATURES, NAME, ICONS, ELEVATION, SURFACE, SURFACE_DARK, CURSOR_PATH, loadFont};
})();
