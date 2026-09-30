/**
 * The ghost cursor. Runs on crm.zoho.*.
 *
 * Talk → Show → Do → Verify → Nudge, from the learner's side:
 *   - pairs with a session through the service worker (bridge or code);
 *   - loads the session's script (intro, show, task) and speaks each step
 *     while performing it: a large Deep Teal cursor with a name tag glides to
 *     each thing it talks about, circles what it wants read, clicks and types
 *     visibly, and drifts while it narrates, so it is on screen for the whole
 *     demonstration, not only when a target resolves;
 *   - hands over, then stays as a small panel: a question box, a mic, and
 *     "I'm done, check my work";
 *   - polls the session queue for nudges, ask-anything scripts and the
 *     celebration when Zoho's records verify the work.
 *
 * Voice is played by the service worker (offscreen document, Chrome TTS as the
 * fallback), never by this page: Zoho's CSP and autoplay rules would mute it.
 * The overlay is a manual popover in the browser's top layer, so it stays
 * above Zoho's own dialogs whatever their z-index.
 *
 * Targets are semantic and resolved at run time (see `resolve`). When a
 * click/type target cannot be found the ghost asks the learner to click it
 * once and remembers the element; a missing highlight is skipped. The screen
 * is never used for grading.
 */

(() => {
  if (window.__frty2Ghost) return;
  window.__frty2Ghost = true;

  const POLL_MS = 3500;
  const RUN_KEY = 'frty2_run';
  const HINT_KEY = 'frty2_hints';
  const CURSOR_KEY = 'frty2_cursor';

  const state = {
    pairing: null,
    session: null,
    script: null,
    language: 'hi',
    muted: false,
    running: false,
    cancel: false,
    hints: {},
    voiceCache: new Map(),
    voiceNote: '',
    pollTimer: null,
    picking: null,
    deferred: [],
    awaitingReady: false,
  };

  // ------------------------------------------------------------------ transport

  const send = (message) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (reply) => {
        if (chrome.runtime.lastError) return resolve({ok: false, error: chrome.runtime.lastError.message});
        resolve(reply || {ok: false});
      });
    } catch (error) {
      resolve({ok: false, error: String(error)});
    }
  });
  const api = (method, path, body, multipart) => send({type: 'api', method, path, body, multipart});
  const sessionPath = (suffix) => `/api/v1/webapps/sessions/${state.pairing.session_id}/${suffix}`;

  async function postEvent(kind, payload) {
    if (!state.pairing) return null;
    const result = await api('POST', sessionPath('events/'), {kind, payload: payload || {}, source: 'extension'});
    if (result.ok && result.data) state.session = result.data;
    return result;
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const hi = () => state.language === 'hi';

  // ------------------------------------------------------------------ overlay

  const B = window.__a42Brand;     // brand.js, injected just before this file
  const {C, ICONS} = B;
  const INK = C.teal;              // the ghost's own colour: Deep Teal, apart from Zoho's blues
  const host = document.createElement('div');
  host.id = 'frty2-ghost-host';
  host.setAttribute('popover', 'manual');
  const shadow = host.attachShadow({mode: 'open'});
  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; font-family: ${B.FONT}; ${B.LIGATURES} -webkit-font-smoothing: antialiased; }

      .ghost { position: fixed; left: 0; top: 0; z-index: 9; pointer-events: none; opacity: 0;
        transform: translate(-300px, -300px); transition: opacity 260ms ease; will-change: transform; }
      .ghost.on { opacity: 1; }
      .ghost .body { position: relative; animation: bob 2.6s ease-in-out infinite; }
      @keyframes bob { 0%, 100% { translate: 0 0; } 50% { translate: 0 -3px; } }
      .ghost .halo { position: absolute; left: -22px; top: -22px; width: 48px; height: 48px; border-radius: 50%;
        background: radial-gradient(circle, rgba(36,91,80,.38) 0%, rgba(185,206,196,.30) 45%, transparent 70%); animation: halo 1.8s ease-out infinite; }
      @keyframes halo { 0% { transform: scale(.6); opacity: .95; } 100% { transform: scale(1.7); opacity: 0; } }
      .ghost svg { position: absolute; left: -3px; top: -3px; width: 46px; height: 52px; overflow: visible;
        filter: drop-shadow(0 0 6px rgba(36,91,80,.55)) drop-shadow(0 6px 10px rgba(20,35,33,.35)); transform-origin: 3px 3px; transition: transform 140ms ease; }
      .ghost.press svg { transform: scale(.78); }
      .ghost .tag { position: absolute; left: 34px; top: 38px; display: flex; align-items: center; gap: 7px; white-space: nowrap;
        background: ${INK}; color: ${C.chalk}; font-size: 12.5px; font-weight: 600; letter-spacing: .01em; padding: 5px 12px 5px 9px;
        border: 1px solid rgba(185,206,196,.35); border-radius: 4px 14px 14px 14px; box-shadow: 0 6px 16px rgba(20,35,33,.35); }
      .ghost .bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; }
      .ghost .bars i { width: 3px; height: 4px; border-radius: 2px; background: ${C.mist}; opacity: .8; }
      .ghost.talking .bars i { animation: eq 700ms ease-in-out infinite; opacity: 1; }
      .ghost.talking .bars i:nth-child(2) { animation-delay: 120ms; }
      .ghost.talking .bars i:nth-child(3) { animation-delay: 240ms; }
      @keyframes eq { 0%, 100% { height: 3px; } 50% { height: 12px; } }
      .ghost.asking .tag { background: ${C.estuary}; }
      .ghost.flipx .tag { left: auto; right: 12px; border-radius: 14px 4px 14px 14px; }
      .ghost.flipy .tag { top: auto; bottom: 10px; }

      .ripple { position: fixed; width: 54px; height: 54px; border-radius: 50%; border: 4px solid ${INK}; pointer-events: none; z-index: 8;
        transform: translate(-50%, -50%) scale(.3); opacity: 0; }
      .ripple.go { animation: ripple 650ms ease-out; }
      @keyframes ripple { 0% { transform: translate(-50%,-50%) scale(.3); opacity: 1; } 100% { transform: translate(-50%,-50%) scale(1.8); opacity: 0; } }
      .spot { position: fixed; border-radius: 12px; border: 3px solid ${INK};
        box-shadow: 0 0 0 9999px rgba(20, 35, 33, .32), 0 0 0 6px rgba(185,206,196,.45), 0 0 26px rgba(36,91,80,.55);
        pointer-events: none; z-index: 2; opacity: 0; transition: all 350ms ease; }
      .spot.on { opacity: 1; }

      .caption { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); max-width: min(760px, 86vw); z-index: 6; pointer-events: none;
        ${B.SURFACE_DARK} color: ${C.chalk}; padding: 14px 22px; border-radius: 20px; font-size: 16px; line-height: 1.5;
        box-shadow: ${B.ELEVATION}; opacity: 0; transition: opacity 250ms; }
      .caption.on { opacity: 1; }
      .caption .who { display: block; font-size: 10.5px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: ${C.mist}; margin-bottom: 4px; }

      .panel { position: fixed; right: 18px; bottom: 18px; width: 380px; z-index: 7; pointer-events: auto; color: ${C.estuary};
        ${B.SURFACE} border-radius: 22px; overflow: hidden; font-size: 13px; }
      .panel.min .body { display: none; }
      .head { display: flex; align-items: center; gap: 10px; padding: 11px 12px 11px 14px; ${B.SURFACE_DARK} color: ${C.chalk}; }
      .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: ${C.mist}; opacity: .6; }
      .dot.ok { opacity: 1; background: ${C.led}; box-shadow: 0 0 0 3px rgba(69,214,154,.22), 0 0 10px 2px rgba(69,214,154,.85); animation: breathe 2.4s ease-in-out infinite; }
      .dot.busy { opacity: 1; background: ${C.led}; box-shadow: 0 0 0 3px rgba(69,214,154,.22), 0 0 10px 2px rgba(69,214,154,.85); animation: breathe 900ms ease-in-out infinite; }
      @keyframes pulse { 50% { opacity: .35; } }
      @keyframes breathe { 50% { box-shadow: 0 0 0 5px rgba(69,214,154,.10), 0 0 16px 4px rgba(69,214,154,.55); } }
      .head b { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .head button { background: transparent; border: 0; color: ${C.mist}; cursor: pointer; font: inherit; font-size: 15px; width: 28px; height: 28px; border-radius: 50%; }
      .head button:hover { background: rgba(243,245,241,.12); color: ${C.chalk}; }
      .body { padding: 12px 16px 14px; }
      .phase { display: flex; gap: 6px; margin-bottom: 10px; }
      .phase span { flex: 1; text-align: center; font-size: 11px; font-weight: 600; padding: 5px 0; border-radius: 999px; background: rgba(20,35,33,.06); color: ${C.muted}; }
      .phase span.now { background: ${INK}; color: ${C.chalk}; }
      .phase span.done { background: rgba(185,206,196,.6); color: ${C.tealDeep}; }
      .status { font-size: 12.5px; color: ${C.muted}; margin: 6px 0 10px; min-height: 18px; }
      .note { font-size: 12px; color: ${C.amberInk}; background: ${C.amberTint}; border: 1px solid rgba(183,121,31,.28); border-radius: 12px; padding: 8px 10px; margin: 6px 0; }
      .task { background: rgba(185,206,196,.28); border: 1px solid rgba(36,91,80,.18); border-radius: 16px; padding: 11px 13px; margin: 8px 0; line-height: 1.5; }
      .task b { display: block; margin-bottom: 4px; font-weight: 600; }
      .task ol { margin: 0; padding-left: 20px; }
      .task li { margin: 3px 0; }
      .task li::marker { color: ${INK}; font-weight: 600; }
      .row { display: flex; gap: 8px; margin-top: 10px; }
      .btn { flex: 1; min-height: 34px; padding: 8px 10px; border-radius: 999px; border: 0; cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 600;
        background: rgba(36,91,80,.10); color: ${INK}; }
      .btn:hover { background: rgba(36,91,80,.17); }
      .btn.primary { background: ${INK}; color: ${C.chalk}; box-shadow: 0 1px 2px rgba(20,35,33,.25), 0 4px 10px -4px rgba(36,91,80,.6); }
      .btn.primary:hover { background: ${C.tealDeep}; }
      .btn.outline { background: transparent; box-shadow: inset 0 0 0 1px rgba(36,91,80,.35); }
      .btn:disabled { opacity: .5; cursor: default; }
      .ask { display: flex; gap: 6px; margin-top: 12px; }
      .ask input { flex: 1; min-width: 0; padding: 9px 14px; border-radius: 999px; border: 1px solid rgba(20,35,33,.18); background: rgba(255,255,255,.7);
        color: ${C.estuary}; font: inherit; font-size: 12.5px; }
      .ask input:focus { outline: none; border-color: ${INK}; box-shadow: 0 0 0 3px rgba(36,91,80,.18); }
      .ask button { flex: none; width: 38px; height: 38px; border-radius: 50%; border: 0; background: ${INK}; color: ${C.chalk}; cursor: pointer; font: inherit; font-size: 16px; }
      .ask button.rec { background: ${C.danger}; animation: pulse 1s infinite; }
      .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; font-size: 12px; color: ${C.muted}; }
      .foot button { background: transparent; border: 1px solid rgba(20,35,33,.18); border-radius: 999px; padding: 3px 10px; cursor: pointer; font: inherit; font-size: 12px; color: ${C.estuary}; }
      .foot button.on { background: ${C.estuary}; color: ${C.chalk}; border-color: ${C.estuary}; }
      .cert { background: rgba(69,214,154,.14); border: 1px solid rgba(69,214,154,.45); border-radius: 16px; padding: 11px 13px; margin-top: 8px; }
      .cert code { font-size: 15px; letter-spacing: .06em; }
      .cert a { color: ${INK}; font-weight: 600; }
      .pill { position: fixed; right: 18px; bottom: 18px; z-index: 7; pointer-events: auto; ${B.SURFACE_DARK} color: ${C.chalk}; padding: 10px 16px;
        border-radius: 999px; font-size: 12.5px; box-shadow: ${B.ELEVATION}; }
      button:focus-visible { outline: 2px solid ${INK}; outline-offset: 2px; }
      .confetti { position: fixed; inset: 0; pointer-events: none; z-index: 10; }
      .confetti i { position: absolute; top: -10px; width: 8px; height: 14px; opacity: .9; animation: fall 2.6s linear forwards; }
      @keyframes fall { to { transform: translateY(110vh) rotate(720deg); opacity: 0; } }
      @media (prefers-reduced-motion: reduce) { .dot { animation: none !important; } }
    </style>
    <div class="ghost" id="ghost">
      <div class="body">
        <div class="halo"></div>
        <svg viewBox="0 0 46 52"><path d="M3 3 L3 39 L12.5 30.5 L19 46 L26.5 42.8 L20 27.5 L33.5 27.5 Z"
          fill="${INK}" stroke="${C.chalk}" stroke-width="3" stroke-linejoin="round"/></svg>
        <div class="tag"><span class="bars"><i></i><i></i><i></i></span><span id="tagText">${B.NAME}</span></div>
      </div>
    </div>
    <div class="ripple" id="ripple"></div>
    <div class="spot" id="spot"></div>
    <div class="caption" id="caption"><span class="who">${B.NAME}</span><span id="captionText"></span></div>
    <div id="panelRoot"></div>
  `;
  const $ = (id) => shadow.getElementById(id);
  const ghostEl = $('ghost'), rippleEl = $('ripple'), spotEl = $('spot'), captionEl = $('caption'), panelRoot = $('panelRoot');

  // The top layer puts the overlay above everything Zoho draws, including
  // modal <dialog>s and popovers opened after ours; `raise` re-stacks us
  // when one of those appears.
  const seenLayers = new WeakSet();
  function raise() {
    if (!host.isConnected) (document.documentElement || document.body).appendChild(host);
    if (typeof host.showPopover !== 'function') return;
    try {
      if (!host.matches(':popover-open')) { host.showPopover(); return; }
      let newer = false;
      for (const el of document.querySelectorAll(':modal, :popover-open')) {
        if (el === host || seenLayers.has(el)) continue;
        seenLayers.add(el); newer = true;
      }
      if (newer) { host.hidePopover(); host.showPopover(); }
    } catch { /* popovers unsupported or the page forbids it: z-index still applies */ }
  }
  raise();
  new MutationObserver(() => { if (!host.isConnected) raise(); })
    .observe(document.documentElement, {childList: true});

  // ------------------------------------------------------------------ the ghost cursor

  const ghost = {x: null, y: null, shown: false, anim: null, wander: 0};

  function saveCursor() { try { sessionStorage.setItem(CURSOR_KEY, JSON.stringify({x: ghost.x, y: ghost.y})); } catch {} }
  function storedCursor() { try { return JSON.parse(sessionStorage.getItem(CURSOR_KEY) || 'null'); } catch { return null; } }

  function place(x, y) {
    ghost.x = x; ghost.y = y;
    ghostEl.style.transform = `translate(${x}px, ${y}px)`;
    ghostEl.classList.toggle('flipx', x > innerWidth - 190);
    ghostEl.classList.toggle('flipy', y > innerHeight - 90);
  }

  function panelCorner() {
    const panel = shadow.querySelector('.panel, .pill');
    const r = panel ? panel.getBoundingClientRect() : {left: innerWidth - 380, top: innerHeight - 260};
    return {x: clamp(r.left + 30, 20, innerWidth - 60), y: clamp(r.top - 12, 20, innerHeight - 60)};
  }

  /** Bring the ghost on screen: where it was on the previous page, else out of the panel. */
  function showCursor() {
    raise();
    if (ghost.x === null) {
      const stored = storedCursor();
      const start = stored && Number.isFinite(stored.x) ? stored : panelCorner();
      place(clamp(start.x, 8, innerWidth - 60), clamp(start.y, 8, innerHeight - 60));
    }
    ghostEl.classList.add('on');
    ghost.shown = true;
  }

  function hideCursor() {
    ghost.wander += 1;
    ghostEl.classList.remove('on', 'talking', 'asking');
    ghost.shown = false;
  }

  /** Walk back into the panel and vanish. */
  async function parkCursor() {
    if (!ghost.shown) return;
    const corner = panelCorner();
    await glideTo(corner.x, corner.y);
    hideCursor();
    try { sessionStorage.removeItem(CURSOR_KEY); } catch {}
  }

  /** Glide along a slight arc, as a hand would, to (x, y). */
  async function glideTo(x, y, {speed = 1} = {}) {
    showCursor();
    x = clamp(x, 6, innerWidth - 12); y = clamp(y, 6, innerHeight - 12);
    const from = {x: ghost.x, y: ghost.y};
    const dist = Math.hypot(x - from.x, y - from.y);
    if (dist < 2) return;
    const duration = clamp(dist * 1.15, 420, 1150) / speed;
    const bend = Math.min(90, dist * 0.2) * (x >= from.x ? 1 : -1);
    const cx = (from.x + x) / 2 - ((y - from.y) / dist) * bend;
    const cy = (from.y + y) / 2 + ((x - from.x) / dist) * bend;
    const frames = [];
    for (let i = 0; i <= 18; i += 1) {
      const t = i / 18, u = 1 - t;
      frames.push({transform: `translate(${u * u * from.x + 2 * u * t * cx + t * t * x}px, ${u * u * from.y + 2 * u * t * cy + t * t * y}px)`});
    }
    if (ghost.anim) ghost.anim.cancel();
    place(x, y);
    saveCursor();
    ghost.anim = ghostEl.animate(frames, {duration, easing: 'cubic-bezier(.35,.05,.2,1)'});
    await ghost.anim.finished.catch(() => {});
  }

  function pointOf(el) {
    const r = el.getBoundingClientRect();
    return {x: r.left + Math.min(r.width / 2, 110), y: r.top + r.height / 2, rect: r};
  }

  async function moveCursorTo(el) {
    raise();
    const before = el.getBoundingClientRect();
    if (before.top < 60 || before.bottom > innerHeight - 40) {
      el.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'smooth'});
      await wait(420);
    }
    const {x, y} = pointOf(el);
    await glideTo(x, y);
  }

  /** Circle an element once: "read this". */
  async function circle(el) {
    const {rect} = pointOf(el);
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const rx = clamp(rect.width / 2 + 16, 30, 260), ry = clamp(rect.height / 2 + 12, 20, 120);
    await glideTo(cx + rx, cy);
    const frames = [];
    for (let i = 0; i <= 24; i += 1) {
      const a = (i / 24) * Math.PI * 2;
      frames.push({transform: `translate(${cx + rx * Math.cos(a)}px, ${cy + ry * Math.sin(a)}px)`});
    }
    if (ghost.anim) ghost.anim.cancel();
    ghost.anim = ghostEl.animate(frames, {duration: 1300, easing: 'ease-in-out'});
    await ghost.anim.finished.catch(() => {});
    const {x, y} = pointOf(el);
    await glideTo(x, y);
  }

  async function press(el) {
    ghostEl.classList.add('press');
    ripple(el);
    await wait(160);
    ghostEl.classList.remove('press');
  }

  /** While a line is being spoken with nothing to point at, drift nearby. */
  function wanderWhile(promise) {
    const token = ++ghost.wander;
    (async () => {
      showCursor();
      const base = {x: ghost.x, y: ghost.y};
      // Out of a corner and towards the page's centre, but not onto the caption.
      if (base.y < 90 || base.x > innerWidth - 120 || base.y > innerHeight - 120) {
        base.x = clamp(innerWidth * 0.55, 80, innerWidth - 140); base.y = clamp(innerHeight * 0.38, 120, innerHeight - 140);
        await glideTo(base.x, base.y);
      }
      let settled = false;
      promise.finally(() => { settled = true; });
      while (!settled && token === ghost.wander) {
        await wait(1800 + Math.random() * 900);
        if (settled || token !== ghost.wander) break;
        const a = Math.random() * Math.PI * 2, d = 25 + Math.random() * 45;
        await glideTo(base.x + Math.cos(a) * d, base.y + Math.sin(a) * d * 0.6, {speed: 0.55});
      }
    })();
  }
  const stopWander = () => { ghost.wander += 1; };

  function ripple(el) {
    const {x, y} = pointOf(el);
    rippleEl.style.left = `${x}px`; rippleEl.style.top = `${y}px`;
    rippleEl.classList.remove('go'); void rippleEl.offsetWidth; rippleEl.classList.add('go');
  }

  let spotTarget = null;
  function spotlight(el) {
    spotTarget = el;
    if (!el) { spotEl.classList.remove('on'); return; }
    const r = el.getBoundingClientRect();
    spotEl.style.left = `${r.left - 6}px`; spotEl.style.top = `${r.top - 6}px`;
    spotEl.style.width = `${r.width + 12}px`; spotEl.style.height = `${r.height + 12}px`;
    spotEl.classList.add('on');
  }
  (function trackSpot() { if (spotTarget && spotEl.classList.contains('on')) spotlight(spotTarget); requestAnimationFrame(trackSpot); })();

  function caption(text) {
    if (!text) { captionEl.classList.remove('on'); return; }
    $('captionText').textContent = text;
    captionEl.classList.add('on');
  }

  // ------------------------------------------------------------------ voice

  function pick(say) {
    if (!say) return '';
    if (typeof say === 'string') return say;
    return say[state.language] || say.en || say.hi || '';
  }

  /** The ElevenLabs clip for a line, or null (the service worker then uses Chrome's voice). */
  async function voiceUrl(text) {
    const key = `${state.language}|${text}`;
    if (state.voiceCache.has(key)) return state.voiceCache.get(key);
    // The API speaks only lines from this session's script or queue, and
    // within a per-session budget, so a token cannot spend the voice credits
    // on anything else.
    const pending = api('POST', '/api/v1/webapps/voice/',
      {session: state.pairing.session_id, text, language: state.language})
      .then((result) => {
        const url = result.ok && result.data ? result.data.url : null;
        const reason = result.data && result.data.reason;
        if (!url && reason && reason !== 'not_narration') noteVoice(reason, result.data.detail);
        if (!url) state.voiceCache.delete(key);     // retry next time; a failure is not forever
        return url;
      })
      .catch(() => { state.voiceCache.delete(key); return null; });
    state.voiceCache.set(key, pending);
    return pending;
  }

  function noteVoice(reason, detail) {
    const why = {
      voice_not_configured: 'the server has no ElevenLabs key',
      voice_budget: 'this session used its narration budget',
      voice_failed: `ElevenLabs refused (${(detail || '').slice(0, 80)})`,
    }[reason] || reason;
    const note = `Using the browser's voice: ${why}.`;
    if (note !== state.voiceNote) { state.voiceNote = note; console.warn('[frty2]', note); renderPanel(); }
  }

  function prefetchVoice(lines) {
    for (const line of lines || []) {
      const text = pick(line);
      if (text) voiceUrl(text);
    }
  }

  function stopAudio() { send({type: 'stop_speaking'}); }

  /** Speak (and caption) one line; resolves when it has been said. */
  async function say(sayObj, {drift = false} = {}) {
    const text = pick(sayObj);
    if (!text) return;
    caption(text);
    const readingMs = Math.max(1600, text.length * (hi() ? 70 : 55));
    ghostEl.classList.add('talking');
    const speaking = (async () => {
      if (state.muted) { await wait(readingMs); return; }
      const url = await voiceUrl(text);
      if (state.cancel) return;
      const started = Date.now();
      const said = await Promise.race([
        send({type: 'speak', url, text, language: state.language}),
        wait(Math.max(60000, readingMs * 3)).then(() => ({ok: false, error: 'timeout'})),
      ]);
      if (!said.ok) {
        if (!state.voiceNote) { state.voiceNote = `No voice available (${said.error || 'unknown'}); reading captions.`; renderPanel(); }
        await wait(Math.max(0, readingMs - (Date.now() - started)));
      }
    })();
    if (drift) wanderWhile(speaking);
    try { await speaking; } finally { ghostEl.classList.remove('talking'); if (drift) stopWander(); }
  }

  // ------------------------------------------------------------------ element resolution

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el === host || (el.closest && el.closest('#frty2-ghost-host'))) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function scopeFor(target) {
    if (target.within === 'dialog') {
      const dialogs = Array.from(document.querySelectorAll(
        'dialog[open], [role="dialog"], [role="alertdialog"], lyte-modal, .lyte-modal, [class*="modal" i], [class*="popup" i], [class*="dialog" i], [class*="overlay" i]'))
        .filter(visible);
      if (dialogs.length) return dialogs[dialogs.length - 1];
    }
    return document;
  }

  const CLICKABLE = 'button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [role="link"], input[type="button"], input[type="submit"], input[type="checkbox"], label, li, span, div, lyte-button, lyte-checkbox, lyte-menu-item';
  const FIELDS = 'input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="combobox"], [role="textbox"], lyte-input, lyte-dropdown';

  const signature = (target) => JSON.stringify(target);

  function cssPath(el) {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      let part = node.localName;
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.localName === node.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function fieldNear(labelEl) {
    const containers = ['tr', 'li', '[class*="row" i]', '[class*="field" i]', '[class*="form" i]', 'div'];
    for (const selector of containers) {
      const container = labelEl.closest(selector);
      if (!container) continue;
      const field = Array.from(container.querySelectorAll(FIELDS)).find(visible);
      if (field) return field;
    }
    let sibling = labelEl.nextElementSibling;
    for (let i = 0; sibling && i < 4; i += 1, sibling = sibling.nextElementSibling) {
      if (sibling.matches(FIELDS) && visible(sibling)) return sibling;
      const inner = Array.from(sibling.querySelectorAll(FIELDS)).find(visible);
      if (inner) return inner;
    }
    if (labelEl.htmlFor) { const byFor = document.getElementById(labelEl.htmlFor); if (byFor) return byFor; }
    return null;
  }

  /** On a read-only record page a label has a value next to it, not an input:
   *  the row that holds both is what a highlight should frame. */
  function rowOf(labelEl) {
    const own = norm(labelEl.textContent).length;
    let node = labelEl;
    for (let i = 0; i < 5 && node.parentElement; i += 1) {
      const parent = node.parentElement;
      const r = parent.getBoundingClientRect();
      if (r.height > 140 || r.width > innerWidth * 0.9) break;
      node = parent;
      if (norm(node.textContent).length > own + 1) return node;
    }
    return labelEl;
  }

  async function resolve(target, {timeoutMs = 0, readOnly = false} = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await resolveOnce(target, readOnly);
      if (found || Date.now() >= deadline) return found;
      await wait(400);
    }
  }

  async function resolveOnce(target, readOnly) {
    if (!target) return null;
    const hint = state.hints[signature(target)];
    if (hint) { try { const el = document.querySelector(hint); if (visible(el)) return el; } catch {} }
    const scope = scopeFor(target);
    if (target.selector) { try { const el = scope.querySelector(target.selector); if (visible(el)) return el; } catch {} }

    if (target.label) {
      const want = norm(target.label);
      const labels = Array.from(scope.querySelectorAll('label, span, div, td, th, dt, p, b, lyte-label, [class*="label" i]'))
        .filter((el) => visible(el) && el.childElementCount <= 2)
        .filter((el) => { const t = norm(el.textContent); return t === want || t === `${want}*` || t.replace(/[:*]$/, '') === want; });
      for (const labelEl of labels) { const field = fieldNear(labelEl); if (field) return field; }
      const byAria = Array.from(scope.querySelectorAll(FIELDS)).find((el) => visible(el) &&
        (norm(el.getAttribute('aria-label')) === want || norm(el.getAttribute('placeholder')) === want || norm(el.name) === want.replace(/ /g, '_')));
      if (byAria) return byAria;
      if (readOnly && labels.length) return rowOf(labels[0]);
    }
    if (target.placeholder) {
      const want = norm(target.placeholder);
      const el = Array.from(scope.querySelectorAll('[placeholder]')).find((e) => visible(e) && norm(e.getAttribute('placeholder')).includes(want));
      if (el) return el;
    }
    if (target.text) {
      const want = norm(target.text);
      const roleWanted = target.role;
      const scored = [];
      for (const el of scope.querySelectorAll(CLICKABLE)) {
        if (!visible(el)) continue;
        const text = norm(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.title);
        if (!text || text.length > want.length + 60) continue;
        let score = 0;
        if (text === want) score = 100;
        else if (text.startsWith(want)) score = 70;
        else if (text.includes(want)) score = 45;
        else continue;
        const role = (el.getAttribute('role') || el.localName).toLowerCase();
        if (roleWanted === 'button' && (role === 'button' || el.localName === 'button' || el.localName === 'lyte-button' || /btn|button/i.test(el.className))) score += 25;
        if (roleWanted === 'link' && (role === 'a' || role === 'link')) score += 20;
        score -= Math.min(30, el.querySelectorAll('*').length);   // prefer the innermost match
        if (el.matches('div, span, li') && !el.onclick && getComputedStyle(el).cursor !== 'pointer' && !el.closest('button, a, [role="button"]')) score -= 35;
        scored.push({el, score, text});
      }
      scored.sort((a, b) => b.score - a.score);
      if (!scored.length) return null;
      const top = scored.filter((s) => s.score >= scored[0].score - 5).slice(0, 4);
      if (top.length === 1) return top[0].el;
      if (typeof target.nth === 'number') return (top[target.nth] || top[0]).el;
      return (await decideBetween(top, target)) || top[0].el;
    }
    return null;
  }

  /** A JEV decision for a genuine tie: which candidate is the one the step means. */
  async function decideBetween(candidates, target) {
    if (!state.pairing) return null;
    const criteria = {};
    candidates.forEach((c, i) => {
      const el = c.el;
      criteria[`c${i}`] = `<${el.localName}${el.className ? ` class="${String(el.className).slice(0, 80)}"` : ''}${el.getAttribute('role') ? ` role="${el.getAttribute('role')}"` : ''}> text "${c.text.slice(0, 60)}" at (${Math.round(el.getBoundingClientRect().left)},${Math.round(el.getBoundingClientRect().top)})`;
    });
    const result = await api('POST', sessionPath('decide/'), {
      state: `On a Zoho CRM page titled "${document.title}", a walkthrough step wants to act on ${JSON.stringify(target)}. Several elements match its text.`,
      questions: {which: {type: 'choice', instructions: 'Which element is the one the step means?', criteria}},
    });
    const choice = result.ok && result.data && result.data.answers && result.data.answers.which && result.data.answers.which.choice;
    const index = choice ? Number(choice.slice(1)) : NaN;
    return Number.isInteger(index) && candidates[index] ? candidates[index].el : null;
  }

  /** Ask the learner to click the missing element once; remember it. The
   *  panel offers "Skip this step" so a wrong guess never strands the demo. */
  function learnTarget(target, describe) {
    return new Promise((resolve) => {
      const text = hi()
        ? `मुझे "${describe}" नहीं मिल रहा। कृपया एक बार उस पर click कीजिए, मैं याद रख लूँगा।`
        : `I cannot find "${describe}" on this screen. Please click it once for me and I will remember it.`;
      caption(text);
      ghostEl.classList.add('asking');
      $('tagText').textContent = hi() ? 'कहाँ है?' : 'Where is it?';
      if (!state.muted) send({type: 'speak', url: null, text, language: state.language});
      const finish = (result) => {
        document.removeEventListener('click', handler, true);
        ghostEl.classList.remove('asking');
        $('tagText').textContent = B.NAME;
        state.picking = null;
        renderPanel();
        resolve(result);
      };
      const handler = (event) => {
        const el = event.target instanceof Element ? event.target : null;
        if (!el || el === host || el.closest('#frty2-ghost-host')) return;
        const path = cssPath(el);
        state.hints[signature(target)] = path;
        try { chrome.storage.local.set({[HINT_KEY]: state.hints}); } catch {}
        postEvent('target_learned', {target, selector: path});
        finish({el, clicked: true});
      };
      state.picking = {skip: () => { postEvent('target_skipped', {target}); finish({el: null, skipped: true}); }};
      document.addEventListener('click', handler, true);
      renderPanel();
      setStatus(hi() ? 'आपके click का इंतज़ार…' : 'Waiting for your click…', 'busy');
    });
  }

  // ------------------------------------------------------------------ actions

  function fire(el, type, init) {
    el.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, view: window, ...init}));
  }

  async function doClick(el) {
    await moveCursorTo(el);
    spotlight(el);
    await wait(450);                         // let the learner see where before it happens
    await press(el);
    const {x, y} = pointOf(el);
    const init = {clientX: x, clientY: y};
    fire(el, 'pointerdown', init); fire(el, 'mousedown', init);
    fire(el, 'pointerup', init); fire(el, 'mouseup', init);
    if (typeof el.click === 'function') el.click(); else fire(el, 'click', init);
    await wait(500);
    spotlight(null);
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
  }

  function editableIn(el) {
    if (el.matches('input, textarea, [contenteditable="true"]')) return el;
    return el.querySelector('input:not([type="hidden"]), textarea, [contenteditable="true"]') || el;
  }

  async function doType(el, value) {
    const field = editableIn(el);
    await moveCursorTo(field);
    spotlight(field);
    await press(field);
    field.focus();
    field.click && field.click();
    const editable = field.isContentEditable;
    if (!editable) { try { field.select(); } catch {} }
    else { const range = document.createRange(); range.selectNodeContents(field); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    let typed = '';
    for (const ch of String(value)) {
      typed += ch;
      let ok = false;
      try { ok = document.execCommand('insertText', false, ch); } catch {}
      if (!ok && !editable) setNativeValue(field, typed);
      await wait(55);
    }
    if (!editable && field.value !== String(value)) setNativeValue(field, String(value));
    field.dispatchEvent(new Event('change', {bubbles: true}));
    if (/date/i.test(field.getAttribute('placeholder') || field.name || field.id || '') || /date/i.test(field.closest('[class*="date" i]') ? 'date' : '')) {
      field.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}));
      field.dispatchEvent(new KeyboardEvent('keyup', {key: 'Enter', code: 'Enter', bubbles: true}));
    }
    await wait(300);
    spotlight(null);
  }

  async function doSelect(el, value) {
    if (el instanceof HTMLSelectElement) {
      await moveCursorTo(el); spotlight(el); await press(el);
      const option = Array.from(el.options).find((o) => norm(o.textContent) === norm(value)) || Array.from(el.options).find((o) => norm(o.textContent).includes(norm(value)));
      if (option) { el.value = option.value; el.dispatchEvent(new Event('change', {bubbles: true})); }
      await wait(300); spotlight(null);
      return Boolean(option);
    }
    const opener = el.matches('input, [role="combobox"]') ? el : (el.querySelector('input, [role="combobox"], [class*="select" i], [class*="drop" i]') || el);
    await doClick(opener);
    const want = norm(value);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const options = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], li, lyte-drop-item, [class*="option" i], [class*="item" i], span, div'))
        .filter((o) => visible(o) && o.childElementCount <= 3);
      const exact = options.find((o) => norm(o.textContent) === want);
      const loose = exact || options.find((o) => norm(o.textContent).includes(want) && norm(o.textContent).length < want.length + 12);
      if (loose) { await doClick(loose); return true; }
      await wait(250);
    }
    // Typeable dropdown: type the value and confirm.
    const input = editableIn(opener);
    if (input && input.matches('input, [contenteditable="true"]')) {
      await doType(input, value);
      input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}));
      return true;
    }
    return false;
  }

  function describe(target) {
    return target.text || target.label || target.placeholder || target.selector || 'that';
  }

  function fixUrl(url) {
    // The org segment of the URL the tab is actually signed into wins over
    // whatever the pool was configured with: a wrong org id would 404, and
    // the learner can only be in one org at a time.
    const org = location.pathname.match(/\/crm\/(org\d+)\//);
    if (!org) return url;
    if (/\/crm\/tab\//.test(url)) return url.replace('/crm/tab/', `/crm/${org[1]}/tab/`);
    return url.replace(/\/crm\/org\d+\//, `/crm/${org[1]}/`);
  }

  /** What to point at before a navigation: the step's `point`, else the
   *  module tab the URL opens ("…/tab/Deals" → the "Deals" tab). */
  function navTarget(step, url) {
    if (step.point) return step.point;
    const tab = url.match(/\/tab\/([A-Za-z_]+)\/?(?:[?#]|$)/);
    return tab ? {text: tab[1].replace(/_/g, ' '), role: 'link'} : null;
  }

  /** Point at something while a line is spoken, if it can be found quickly. */
  async function pointAt(target, speaking) {
    const el = target ? await resolve(target, {timeoutMs: 1500, readOnly: true}) : null;
    if (!el) { wanderWhile(speaking); return null; }
    await moveCursorTo(el);
    return el;
  }

  /** Run one step: speak while acting. A navigation points at where it is
   *  going, clicks it, and falls back to loading the URL. */
  async function runStep(step, run) {
    const action = step.action || {type: 'say'};
    raise();
    postEvent('step_reached', {step_id: step.id, script: run.script.id});
    switch (action.type) {
      case 'navigate': {
        const url = fixUrl(action.url);
        const here = () => location.href.split('#')[0].replace(/\/$/, '');
        if (here() === url.split('#')[0].replace(/\/$/, '')) {
          await say(step.say, {drift: true});
          return 'ok';
        }
        const speaking = say(step.say);
        const el = await pointAt(navTarget(step, url), speaking);
        await speaking;
        stopWander();
        run.index += 1;
        saveRun(run);                          // a full page load resumes at the next step
        if (el) {
          const before = location.href;
          await doClick(el);
          for (let i = 0; i < 12 && location.href === before; i += 1) await wait(250);
          if (location.href !== before) {       // Zoho routed in-page: carry on here
            await wait(1200);
            run.index -= 1;                      // the runner's own increment follows
            return 'ok';
          }
        }
        location.href = url;
        return 'navigating';
      }
      case 'say': case 'pause': {
        const speaking = say(step.say);
        const pointed = step.point ? await pointAt(step.point, speaking) : (wanderWhile(speaking), null);
        if (pointed) spotlight(pointed);
        if (action.type === 'pause') await wait(Number(action.ms) || 800);
        await speaking;
        stopWander();
        spotlight(null);
        return 'ok';
      }
      case 'handover': {
        spotlight(null);
        const speaking = say(step.say);
        wanderWhile(speaking);
        await speaking;
        stopWander();
        await parkCursor();
        return 'handover';
      }
      case 'wait_for': {
        const speaking = say(step.say);
        wanderWhile(speaking);
        await resolve(action.target, {timeoutMs: 8000});
        await speaking;
        stopWander();
        return 'ok';
      }
      case 'highlight': case 'scroll': {
        // Pointing is not essential: if the thing is not on this screen the
        // ghost keeps talking rather than stopping the demonstration.
        const speaking = say(step.say);
        const el = await resolve(action.target, {timeoutMs: 4000, readOnly: true});
        if (!el) {
          postEvent('target_missing', {step_id: step.id, target: action.target, skipped: true});
          wanderWhile(speaking);
        } else {
          spotlight(el);
          await moveCursorTo(el);
          await circle(el);
        }
        await speaking;
        stopWander();
        spotlight(null);
        return 'ok';
      }
      default: {
        const speaking = say(step.say);
        showCursor();
        let el = await resolve(action.target, {timeoutMs: 6000});
        let learnedClick = false;
        if (!el) {
          postEvent('target_missing', {step_id: step.id, target: action.target});
          await speaking;
          const learned = await learnTarget(action.target, describe(action.target));
          el = learned.el; learnedClick = learned.clicked;
          setStatus(hi() ? 'दिखा रहा हूँ…' : 'Showing you…', 'busy');
          if (!el) return 'ok';                 // skipped
        }
        // A click may load a new page (Convert lands on the contact): that
        // page must resume after this step, not repeat it.
        if (action.type === 'click') { saveRun({...run, index: run.index + 1}); if (!learnedClick) await doClick(el); }
        else if (action.type === 'type') await doType(el, action.value);
        else if (action.type === 'select') await doSelect(el, action.value);
        if (step.wait_for) await resolve(step.wait_for, {timeoutMs: 8000});
        await speaking;
        return 'ok';
      }
    }
  }

  function saveRun(run) { try { sessionStorage.setItem(RUN_KEY, JSON.stringify(run)); } catch {} }
  function clearRun() { try { sessionStorage.removeItem(RUN_KEY); } catch {} }
  function loadRun() { try { return JSON.parse(sessionStorage.getItem(RUN_KEY) || 'null'); } catch { return null; } }

  async function runScript(script, kind, startIndex = 0) {
    if (state.running) return;
    state.running = true; state.cancel = false;
    const run = {kind, script, index: startIndex, session_id: state.pairing.session_id};
    prefetchVoice(script.steps.slice(startIndex).map((s) => s.say));
    showCursor();
    setStatus(hi() ? 'दिखा रहा हूँ…' : 'Showing you…', 'busy');
    renderPanel();
    try {
      while (run.index < script.steps.length && !state.cancel) {
        const step = script.steps[run.index];
        const outcome = await runStep(step, run);
        if (outcome === 'navigating') return;   // the next page resumes from sessionStorage
        if (outcome === 'handover') { run.index += 1; break; }
        run.index += 1;
        saveRun(run);
      }
      clearRun();
      spotlight(null);
      if (state.cancel) hideCursor(); else await parkCursor();
      await postEvent('script_finished', {script: script.id, kind});
      if (kind === 'show') {
        await postEvent('handover', {script: script.id});
      }
      setStatus('', 'ok');
    } catch (error) {
      console.error('[frty2] script failed', error);
      postEvent('error', {message: String(error && error.message || error), script: script.id});
      caption(hi() ? 'कुछ गड़बड़ हो गई; आप यहाँ से खुद आगे बढ़िए।' : 'Something went wrong on my side; carry on from here yourself.');
      clearRun(); hideCursor(); spotlight(null);
    } finally {
      state.running = false;
      setTimeout(() => { if (!state.running) caption(''); }, 4000);
      renderPanel();
    }
  }

  async function untilIdle(ms = 9000) {
    const deadline = Date.now() + ms;
    while (state.running && Date.now() < deadline) await wait(150);
  }

  // ------------------------------------------------------------------ the lesson

  async function beginLesson() {
    const intro = state.script.intro || {};
    state.running = true; state.cancel = false;
    renderPanel();
    // Narration for the demonstration synthesises while the intro talks.
    prefetchVoice((state.script.show.steps || []).map((s) => s.say));
    try {
      await postEvent('intro_started');
      showCursor();
      for (const line of intro.say || []) {
        if (state.cancel) break;
        const speaking = say(line);
        if (line && line.point) await pointAt(line.point, speaking); else wanderWhile(speaking);
        await speaking;
        stopWander();
      }
      if (!state.cancel) {
        const speaking = say(intro.ready_prompt);
        state.awaitingReady = true;
        renderPanel();
        const button = shadow.getElementById('start');
        if (button) await moveCursorTo(button); else wanderWhile(speaking);
        await speaking;
      }
    } finally { state.running = false; stopWander(); }
    setStatus(hi() ? 'तैयार हों तो Start दबाइए।' : 'Press Start when ready.', 'ok');
    state.awaitingReady = !state.cancel;
    renderPanel();
  }

  async function startShow() {
    state.awaitingReady = false;
    if (state.running) { state.cancel = true; stopAudio(); await untilIdle(); }
    await postEvent('show_started');
    await runScript(state.script.show, 'show');
  }

  async function ask(text) {
    text = (text || '').trim();
    if (!text) return;
    if (state.running) { state.cancel = true; stopAudio(); await untilIdle(); }
    setStatus(hi() ? 'सोच रहा हूँ…' : 'Thinking…', 'busy');
    const result = await api('POST', sessionPath('ask/'), {text, language: state.language, source: 'extension'});
    if (!result.ok) { setStatus('Could not ask right now.', 'ok'); return; }
    const answer = result.data;
    if (answer.script && answer.script.steps && answer.script.steps.length) {
      await runScript(answer.script, answer.kind === 'generated' ? 'generated' : 'howto');
    } else if (answer.answer) {
      state.running = true; state.cancel = false;
      try { await say({[state.language]: answer.answer, en: answer.answer}, {drift: true}); } finally { state.running = false; }
      await parkCursor();
      setTimeout(() => caption(''), 3000);
      setStatus('', 'ok');
    }
  }

  async function handleInstruction(instruction) {
    const payload = instruction.payload || {};
    switch (instruction.kind) {
      case 'nudge': case 'say': {
        // A nudge that lands mid-demonstration waits for the demo to finish
        // rather than being lost: the queue already marked it delivered.
        if (state.running) { state.deferred.push(instruction); return; }
        state.running = true; state.cancel = false;
        try { await say(payload.say, {drift: true}); } finally { state.running = false; }
        await parkCursor();
        setTimeout(() => caption(''), 4000);
        break;
      }
      case 'run_script': {
        if (payload.script) await runScript(payload.script, 'howto');
        break;
      }
      case 'celebrate': {
        celebrate(payload);
        break;
      }
      default: break;
    }
  }

  function celebrate(payload) {
    confetti();
    state.session = {...(state.session || {}), phase: 'certified', certificate: {code: payload.certificate_code}};
    renderPanel();
    state.running = true; state.cancel = false;
    say(payload.say, {drift: true}).finally(() => { state.running = false; parkCursor(); setTimeout(() => caption(''), 6000); });
  }

  function confetti() {
    const box = document.createElement('div'); box.className = 'confetti';
    const colors = [C.teal, C.mist, C.led, C.estuary, '#E3B25C'];
    for (let i = 0; i < 120; i += 1) {
      const piece = document.createElement('i');
      piece.style.left = `${Math.random() * 100}vw`; piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = `${Math.random() * 1.2}s`; piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      box.appendChild(piece);
    }
    shadow.appendChild(box);
    setTimeout(() => box.remove(), 4200);
  }

  async function checkNow() {
    setStatus(hi() ? 'Zoho के records देख रहा हूँ…' : 'Reading Zoho\'s records…', 'busy');
    const result = await api('POST', sessionPath('check/'), {});
    if (result.ok && result.data) {
      state.session = result.data.session;
      const ev = result.data.evidence;
      if (ev.status !== 'verified') {
        const text = ev.detail || '';
        caption(text);
        setTimeout(() => caption(''), 9000);
      }
      setStatus(ev.status === 'verified' ? '' : (hi() ? 'अभी पूरा नहीं हुआ। ऊपर पढ़िए।' : 'Not there yet. See above.'), 'ok');
      renderPanel();
    } else {
      setStatus('Could not check right now.', 'ok');
    }
  }

  async function poll() {
    if (!state.pairing) return;
    const result = await api('GET', sessionPath('queue/'));
    if (!result.ok) {
      if (result.status === 401 || result.error === 'not_paired') { state.pairing = null; renderPanel(); }
      return;
    }
    const data = result.data || {};
    if (state.session) {
      state.session.phase = data.phase || state.session.phase;
      state.session.verification = data.verification || state.session.verification;
      if (data.certificate) state.session.certificate = data.certificate;
    }
    const pending = [...state.deferred.splice(0), ...(data.instructions || [])];
    for (const instruction of pending) await handleInstruction(instruction);
    // Never rebuild the panel under the learner's typing or a running demo's buttons.
    const typing = shadow.activeElement && shadow.activeElement.id === 'q';
    if (!typing) renderPanel();
  }

  // ------------------------------------------------------------------ mic

  let recognizer = null;
  async function listen() {
    const button = shadow.getElementById('mic');
    if (recognizer) { recognizer.stop(); return; }
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (Speech) {
      recognizer = new Speech();
      recognizer.lang = hi() ? 'hi-IN' : 'en-IN';
      recognizer.interimResults = false; recognizer.maxAlternatives = 1;
      button && button.classList.add('rec');
      recognizer.onresult = (event) => { const text = event.results[0][0].transcript; ask(text); };
      recognizer.onerror = () => setStatus(hi() ? 'सुन नहीं पाया।' : 'Could not hear that.', 'ok');
      recognizer.onend = () => { recognizer = null; button && button.classList.remove('rec'); };
      try { recognizer.start(); } catch { recognizer = null; }
      return;
    }
    // Fallback: record 6 seconds and transcribe through ElevenLabs Scribe.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      const recorder = new MediaRecorder(stream, {mimeType: 'audio/webm'});
      const chunks = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        button && button.classList.remove('rec');
        const blob = new Blob(chunks, {type: 'audio/webm'});
        const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
        const result = await api('POST', '/api/v1/webapps/stt/', {audio: {blob: bytes, type: 'audio/webm', name: 'q.webm'}, language: state.language}, true);
        if (result.ok && result.data && result.data.text) ask(result.data.text);
        else setStatus('Could not transcribe.', 'ok');
      };
      button && button.classList.add('rec');
      recorder.start();
      setTimeout(() => recorder.state === 'recording' && recorder.stop(), 6000);
    } catch { setStatus('Microphone not available.', 'ok'); }
  }

  // ------------------------------------------------------------------ panel

  function setStatus(text, dot) {
    const el = shadow.getElementById('status'); if (el) el.textContent = text || '';
    const d = shadow.getElementById('dot'); if (d) d.className = `dot ${dot || ''}`;
  }

  const PHASES = [['intro', 'Talk'], ['showing', 'Show'], ['doing', 'Do'], ['verified', 'Verify']];
  const PHASE_INDEX = {created: -1, intro: 0, showing: 1, doing: 2, verified: 3, certified: 3};

  function renderPanel() {
    const minimised = Boolean(shadow.querySelector('.panel.min'));
    const statusText = (shadow.getElementById('status') || {}).textContent || '';
    panelRoot.innerHTML = '';
    if (!state.pairing) {
      panelRoot.innerHTML = `<div class="pill">${B.NAME} · not connected. Press “Connect the guide” on your lesson page.</div>`;
      return;
    }
    if (!state.session || !state.script) {
      panelRoot.innerHTML = `<div class="pill">${B.NAME} · loading your lesson…</div>`;
      return;
    }
    const s = state.session;
    const idx = PHASE_INDEX[s.phase] ?? -1;
    const phase = PHASES.map(([key, label], i) => `<span class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${label}</span>`).join('');
    const task = state.script.task || {};
    const steps = (task.instructions && task.instructions[state.language]) || [];
    const h = hi();
    let body = '';
    if (state.picking) {
      body += `<div class="row"><button class="btn" id="skipStep">${h ? 'यह step छोड़ दें' : 'Skip this step'}</button></div>`;
    }
    if (!state.running && !state.awaitingReady && (s.phase === 'created' || s.phase === 'intro')) {
      body += `<div class="row"><button class="btn primary" id="begin">${h ? 'Lesson शुरू करें' : 'Begin the lesson'}</button></div>`;
    }
    if (state.awaitingReady) {
      body += `<div class="row"><button class="btn primary" id="start">Start</button></div>`;
    }
    if (s.phase === 'showing' && !state.running) {
      body += `<div class="row"><button class="btn primary" id="replay">${h ? 'Demo फिर से' : 'Replay the demo'}</button><button class="btn" id="skip">${h ? 'मैं कर लूँगा' : 'Let me do it'}</button></div>`;
    }
    if (s.phase === 'doing') {
      body += `<div class="task"><b>${h ? 'आपका काम' : 'Your task'}: ${(task.title && task.title[state.language]) || ''}</b><ol>${steps.map((t) => `<li>${t}</li>`).join('')}</ol></div>`;
      const v = s.verification || {};
      if (v.status && v.status !== 'verified') body += `<div class="status">${v.detail || ''}</div>`;
      body += `<div class="row"><button class="btn primary" id="done">${h ? 'हो गया, check करो' : 'I’m done, check my work'}</button><button class="btn outline" id="open">${h ? 'Ramesh खोलो' : 'Open Ramesh'}</button></div>`;
    }
    if (s.phase === 'verified' || s.phase === 'certified') {
      const code = s.certificate && s.certificate.code;
      body += `<div class="cert"><b>${h ? 'Verified: Zoho के records इसकी पुष्टि करते हैं।' : 'Verified from Zoho’s own records.'}</b><br>${code ? `Certificate <code>${code}</code>` : ''}${state.pairing.learner_base && code ? `<br><a href="${state.pairing.learner_base}/certificates/${code}" target="_blank">${h ? 'Certificate देखें' : 'View certificate'}</a>` : ''}</div>`;
    }
    if (s.rehearsal) body += `<div class="status">${h ? 'Rehearsal mode: pool Zoho से जुड़ा नहीं है, इसलिए grading नहीं होगी।' : 'Rehearsal mode: the pool is not connected to Zoho, so nothing is graded.'}</div>`;
    if (state.voiceNote) body += `<div class="note">${state.voiceNote.replace(/</g, '&lt;')}</div>`;
    panelRoot.innerHTML = `
      <div class="panel${minimised ? ' min' : ''}" id="panel">
        <div class="head"><span class="dot" id="dot"></span><b>${B.NAME} · ${state.script.records && state.script.records.task_lead ? 'Sharma Two-Wheelers' : 'Zoho CRM'}</b>
          <button id="min" title="Minimise" aria-label="Minimise">${ICONS.minus}</button></div>
        <div class="body">
          <div class="phase">${phase}</div>
          <div class="status" id="status"></div>
          ${body}
          <div class="ask"><input id="q" placeholder="${h ? 'कुछ भी पूछिए: lead ko deal mein kaise convert karte hain?' : 'Ask anything: how do I convert a lead?'}"><button id="mic" title="Speak">🎤</button><button id="send" title="Ask">➤</button></div>
          <div class="foot"><span>${h ? 'भाषा' : 'Language'}: <button id="hi" class="${h ? 'on' : ''}">हिंदी</button> <button id="en" class="${h ? '' : 'on'}">EN</button></span>
            <span><button id="mute" class="${state.muted ? 'on' : ''}">${state.muted ? 'Unmute' : 'Mute'}</button> <button id="stop">${h ? 'रोकें' : 'Stop'}</button></span></div>
        </div>
      </div>`;
    const on = (id, fn) => { const el = shadow.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('begin', beginLesson);
    on('start', startShow);
    on('skipStep', () => state.picking && state.picking.skip());
    on('replay', () => runScript(state.script.show, 'show'));
    on('skip', async () => { await postEvent('handover', {skipped: true}); renderPanel(); });
    on('done', checkNow);
    on('open', () => { if (task.record_url) location.href = fixUrl(task.record_url); });
    on('send', () => { const q = shadow.getElementById('q'); ask(q.value); q.value = ''; });
    const q = shadow.getElementById('q'); if (q) q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { ask(q.value); q.value = ''; } });
    on('mic', listen);
    on('hi', () => { state.language = 'hi'; postEvent('language_changed', {language: 'hi'}); renderPanel(); });
    on('en', () => { state.language = 'en'; postEvent('language_changed', {language: 'en'}); renderPanel(); });
    on('mute', () => { state.muted = !state.muted; if (state.muted) stopAudio(); renderPanel(); });
    on('stop', () => {
      state.cancel = true; state.awaitingReady = false; stopAudio(); clearRun(); stopWander();
      if (state.picking) state.picking.skip();
      hideCursor(); spotlight(null); caption(''); renderPanel();
    });
    on('min', () => shadow.getElementById('panel').classList.toggle('min'));
    if (state.running) setStatus(statusText || (h ? 'दिखा रहा हूँ…' : 'Showing you…'), 'busy'); else setStatus(statusText, 'ok');
  }

  // ------------------------------------------------------------------ boot

  async function loadSession() {
    const [session, script] = await Promise.all([api('GET', sessionPath('')), api('GET', sessionPath('script/'))]);
    if (!session.ok || !script.ok) {
      if (session.status === 401 || session.status === 404) { state.pairing = null; }
      renderPanel();
      return false;
    }
    state.session = session.data; state.script = script.data;
    state.language = state.pairing.language || state.session.language || 'hi';
    // Only the intro is synthesised up front; the demonstration's lines are
    // fetched once the learner begins (credits are finite).
    const intro = state.script.intro || {};
    prefetchVoice([...(intro.say || []), intro.ready_prompt]);
    renderPanel();
    return true;
  }

  async function boot() {
    try { const stored = await chrome.storage.local.get(HINT_KEY); state.hints = stored[HINT_KEY] || {}; } catch {}
    const reply = await send({type: 'get_pairing'});
    state.pairing = reply && reply.pairing || null;
    renderPanel();
    if (!state.pairing) return;
    if (!(await loadSession())) return;
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(poll, POLL_MS);
    poll();
    const pending = loadRun();
    if (pending && pending.session_id === state.pairing.session_id && pending.script && pending.index < pending.script.steps.length) {
      showCursor();                          // back where it was on the last page
      wanderWhile(wait(1800));
      await wait(1800);                      // let Zoho's page finish rendering
      runScript(pending.script, pending.kind, pending.index);
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'pairing_changed') {
      state.pairing = message.pairing || null;
      state.session = null; state.script = null;
      if (state.pairing) boot(); else { if (state.pollTimer) clearInterval(state.pollTimer); renderPanel(); }
    }
  });

  boot();
})();
