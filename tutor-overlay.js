/**
 * On-screen text for the live tutor: labels beside elements, value chips,
 * cards and the task. Design: docs/plan/tutor-overlays.md.
 *
 * Injected before tutor.js, into the same content-script world, with Floating
 * UI's two UMD files (vendor/floating-ui) before it. It draws inside the
 * tutor's shadow root, from `overlay` messages the server sends:
 *
 *   {op: "show", id, slot, kind, when, target?, title?, text?, note?, tone?, value?,
 *    items?, values?, values_title?, progress?, buttons?}
 *   {op: "update", id, ...fields}   {op: "hide", id}   {op: "clear", scope: "beat" | "all"}
 *
 * and answers `overlay_event {id, event, button?, detail?, t}` through the
 * tutor's `send`. It never decides what to show or when: a `speech_start`
 * overlay waits until the offscreen player says its line's audio began (or,
 * if no audio comes, until 8 s of quiet), exactly like a cursor action.
 *
 * What it guarantees:
 *   - text only (createElement and textContent): nothing from a message is
 *     ever parsed as markup, so a page with Trusted Types cannot break it and
 *     a message cannot inject into the page;
 *   - one overlay per slot; a new one replaces the old;
 *   - a label never covers its element, the panel or the cards: placement tries
 *     the four sides and rejects any that overlap; with none left it docks at
 *     the top of the screen and says so (`docked`);
 *   - labels let every click through (pointer-events off); cards are surfaces;
 *   - a label whose element goes away is looked for once, then hidden;
 *   - `Text on screen` off hides labels and cards (not the start card or task).
 */

(() => {
  if (window.__frty2Overlay) return;

  const B = window.__a42Brand;          // brand.js, injected just before this file
  const {C, ICONS} = B;
  const SHADOW_ROOM = 52;              // the dock scrolls, so it clips: room inside it for a card's shadow to fade
  const QUIET_SHOW_MS = 8000;          // a speech_start overlay whose speech never comes
  const ENABLED_KEY = 'frty2_tutor_text';
  const SIDES = ['top', 'bottom', 'right', 'left'];
  const ARROW_EDGES = {bottom: ['Right', 'Bottom'], top: ['Left', 'Top'], left: ['Left', 'Bottom'], right: ['Top', 'Right']};
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const st = {root: null, layer: null, dock: null, deps: null, items: new Map(), pending: new Map(), enabled: true, timer: null};

  /** Elements from data, never from markup. */
  function h(tag, attrs, ...children) {
    const svg = tag.startsWith('svg:');
    const el = svg ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'text') el.textContent = String(value);
      else if (key === 'class') el.setAttribute('class', value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const CSS = `
    .ov-layer, .ov-dock { position: fixed; pointer-events: none; }
    .ov-layer { inset: 0; z-index: 5; }
    .ov-dock { right: 0; bottom: 260px; width: ${380 + 18 + 32}px; z-index: 6; display: flex; flex-direction: column; gap: 12px; overflow-y: auto;
      padding: 12px 18px ${SHADOW_ROOM}px 32px; }
    .ov { font-family: ${B.FONT}; ${B.LIGATURES} color: ${C.estuary}; -webkit-font-smoothing: antialiased;
      animation: ov-in 200ms cubic-bezier(.2,.8,.2,1); }
    @keyframes ov-in { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: none; } }
    .ov.off { display: none !important; }
    .ov .ic { font-style: normal; font-weight: 400; line-height: 1; }

    .ov-label { position: fixed; left: 0; top: 0; max-width: 320px; pointer-events: none; visibility: hidden;
      background: rgba(243,245,241,.96); -webkit-backdrop-filter: blur(14px) saturate(1.4); backdrop-filter: blur(14px) saturate(1.4);
      border: 2px solid ${C.teal}; border-radius: 16px; padding: 8px 12px 9px; box-shadow: ${B.ELEVATION}; }
    .ov-label.placed { visibility: visible; }
    .ov-label.docked { left: 50% !important; top: 14px !important; transform: translateX(-50%); }
    .ov-label .verb { display: block; font-size: 10.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: ${C.teal}; }
    .ov-label .name { display: block; margin-top: 1px; font-size: 14px; font-weight: 600; line-height: 1.35; }
    .ov-label .note { display: block; margin-top: 4px; font-size: 12px; line-height: 1.45; color: ${C.muted}; }
    .ov-label.caution { border-color: ${C.amber}; }
    .ov-label.caution .verb { color: ${C.amberInk}; }
    .ov-label.caution .note { color: ${C.amberInk}; font-weight: 500; }
    .ov-label.caution .note::before { content: "${ICONS.caution}  "; }
    .ov-value { display: flex; align-items: flex-start; gap: 8px; margin-top: 7px; }
    .ov-value code { flex: 1; min-width: 0; font: 500 12.5px/1.45 ${B.FONT}; ${B.LIGATURES} white-space: pre-wrap; word-break: break-word;
      background: ${C.estuary}; color: ${C.chalk}; border-radius: 10px; padding: 6px 10px; }
    .ov-value button { pointer-events: auto; }
    .ov-arrow { position: absolute; width: 12px; height: 12px; background: rgb(243,245,241); border: 2px solid ${C.teal}; transform: rotate(45deg); }
    .ov-label.caution .ov-arrow { border-color: ${C.amber}; }

    .ov-card { pointer-events: auto; ${B.SURFACE} border-radius: 20px; padding: 14px 16px; font-size: 13px; line-height: 1.55; }
    .ov-card header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 8px; row-gap: 8px; }
    .ov-card header b { grid-column: 1; font-size: 15px; font-weight: 600; line-height: 1.35; text-wrap: balance; }
    .ov-card header button { grid-column: 2; grid-row: 1; align-self: start; }
    .ov-card .kicker { grid-column: 1; grid-row: 1; justify-self: start; display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px 3px 8px; border-radius: 999px; font-size: 10.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
      background: rgba(36,91,80,.10); color: ${C.teal}; }
    .ov-card .kicker .ic { font-size: 13px; letter-spacing: 0; }
    .ov-card.hint .kicker { background: rgba(185,206,196,.55); color: ${C.tealDeep}; }
    .ov-card.seen .kicker { background: rgba(69,214,154,.18); color: #17603F; }
    .ov-card.start .kicker { background: ${C.teal}; color: ${C.chalk}; }
    .ov-card.caution .kicker { background: ${C.amberTint}; color: ${C.amberInk}; }
    .ov-card.caution { box-shadow: 0 0 0 1px rgba(183,121,31,.45), ${B.ELEVATION}; }
    .ov-card p { margin: 8px 0 0; }
    .ov-card ul, .ov-card ol { margin: 10px 0 0; padding: 0; list-style: none; counter-reset: ov-step; }
    .ov-card li { position: relative; margin: 6px 0 0; padding-left: 26px; }
    .ov-card ul li::before { content: ""; position: absolute; left: 8px; top: .62em; width: 6px; height: 6px; border-radius: 50%; background: ${C.teal}; }
    .ov-card ol li { counter-increment: ov-step; }
    .ov-card ol li::before { content: counter(ov-step); position: absolute; left: 0; top: 1px; width: 19px; height: 19px; border-radius: 50%;
      display: grid; place-items: center; font-size: 11px; font-weight: 600; background: rgba(185,206,196,.6); color: ${C.tealDeep}; }
    .ov-card .vals { margin-top: 12px; padding-top: 10px; border-top: 1px solid ${C.hair}; }
    .ov-card .vals > span { font-size: 10.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: ${C.muted}; }
    .ov-card .val { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; margin-top: 6px; }
    .ov-card .val > span { font-size: 12px; color: ${C.muted}; }
    .ov-card .val code { font: 500 12.5px/1.4 ${B.FONT}; ${B.LIGATURES} background: rgba(20,35,33,.06); border: 1px solid ${C.hair};
      border-radius: 8px; padding: 3px 8px; word-break: break-word; }
    .ov-card .fine { margin-top: 10px; font-size: 12px; color: ${C.muted}; }
    .ov-card .bar { height: 6px; border-radius: 999px; background: rgba(36,91,80,.14); margin-top: 6px; overflow: hidden; }
    .ov-card .bar i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, ${C.teal}, #2F7A6A); transition: width 300ms ease; }
    .ov-card .btns { display: flex; gap: 8px; margin-top: 14px; }
    .ov button { font: inherit; ${B.LIGATURES} cursor: pointer; border-radius: 999px; border: 0; min-height: 30px; min-width: 24px;
      transition: background 120ms ease, box-shadow 120ms ease; }
    .ov-card .btns button { flex: 1; padding: 8px 14px; min-height: 36px; font-size: 13px; font-weight: 600; background: rgba(36,91,80,.10); color: ${C.teal}; }
    .ov-card .btns button:hover { background: rgba(36,91,80,.16); }
    .ov-card .btns button.primary { background: ${C.teal}; color: ${C.chalk}; box-shadow: 0 1px 2px rgba(20,35,33,.25), 0 4px 10px -4px rgba(36,91,80,.6); }
    .ov-card .btns button.primary:hover { background: ${C.tealDeep}; }
    .ov-card .btns button:disabled { opacity: .55; cursor: default; }
    .ov-card .x, .ov-card .fold { width: 28px; height: 28px; min-height: 28px; padding: 0; display: grid; place-items: center;
      background: transparent; color: ${C.muted}; font-size: 16px; line-height: 1; }
    .ov-card .x:hover, .ov-card .fold:hover { background: rgba(20,35,33,.07); color: ${C.estuary}; }
    .ov-card.folded > :not(header) { display: none; }
    .ov .copy { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px 4px 8px; font-size: 12px; font-weight: 600;
      background: rgba(36,91,80,.10); color: ${C.teal}; white-space: nowrap; }
    .ov .copy:hover { background: rgba(36,91,80,.18); }
    .ov .copy .ic { font-size: 13px; }
    .ov .copy.done { background: rgba(69,214,154,.18); color: #17603F; }
    .ov button:focus-visible { outline: 2px solid ${C.teal}; outline-offset: 2px; }

    .ov-start { position: fixed; left: 50%; top: 18%; transform: translateX(-50%); width: min(480px, calc(100vw - 32px)); padding: 20px 22px 18px; border-radius: 24px; }
    .ov-start header b { font-size: 18px; }
    .ov-start p { font-size: 13.5px; }

    @media (prefers-reduced-motion: reduce) { .ov { animation: none; } .ov-card .bar i { transition: none; } }
  `;

  // ------------------------------------------------------------------ mounting

  function mount(root, deps) {
    st.deps = deps;
    if (st.root === root && st.layer && st.layer.isConnected) return;
    st.root = root;
    const style = h('style');
    style.textContent = CSS;
    st.layer = h('div', {class: 'ov-layer'});
    st.dock = h('div', {class: 'ov-dock', role: 'region', 'aria-label': 'Lesson cards', 'aria-live': 'polite'});
    root.append(style, st.layer, st.dock);
    root.addEventListener('click', onClick);
    try { st.enabled = sessionStorage.getItem(ENABLED_KEY) !== 'off'; } catch {}
    clearInterval(st.timer);
    st.timer = setInterval(tick, 250);
    requestAnimationFrame(track);
  }

  function reset() {
    clearInterval(st.timer);
    st.timer = null;
    st.items.clear();
    st.pending.clear();
    st.root = st.layer = st.dock = null;
  }

  const send = (event, id, extra) => st.deps && st.deps.send({type: 'overlay_event', id, event, t: Date.now(), ...extra});

  // ------------------------------------------------------------------ messages

  /** `due`: its moment already came (before this page loaded). `replay`: a
   *  copy the service worker kept across a page load. */
  function handle(msg, {due = false, replay = false} = {}) {
    if (!msg || !st.root) return;
    if (msg.op === 'show') {
      for (const [id, entry] of st.pending) if (entry.msg.slot === msg.slot) st.pending.delete(id);
      if (msg.when === 'speech_start' && !due) { st.pending.set(msg.id, {msg, at: Date.now(), replay}); return; }
      display(msg, replay);
    } else if (msg.op === 'update') {
      const pending = st.pending.get(msg.id);
      if (pending) Object.assign(pending.msg, fieldsOf(msg));
      const item = st.items.get(msg.id);
      if (item) { Object.assign(item.msg, fieldsOf(msg)); rerender(item); }
    } else if (msg.op === 'hide') {
      st.pending.delete(msg.id);
      remove(msg.id);
    } else if (msg.op === 'clear') {
      for (const [id, entry] of [...st.pending]) if (msg.scope === 'all' || entry.msg.slot === 'label') st.pending.delete(id);
      for (const item of [...st.items.values()]) if (msg.scope === 'all' || item.msg.slot === 'label') remove(item.msg.id);
    }
  }

  const fieldsOf = (msg) => Object.fromEntries(Object.entries(msg).filter(([k]) => !['type', 'op', 'id'].includes(k)));

  /** The player says these ids' speech has begun (or, with none named, that
   *  speech began after silence: everything waiting for it). */
  function release(ids) {
    const list = Array.isArray(ids) && ids.length ? ids : [...st.pending.keys()];
    for (const id of list) {
      const entry = st.pending.get(id);
      if (!entry) continue;
      st.pending.delete(id);
      display(entry.msg, entry.replay);
    }
  }

  function tick() {
    if (!st.deps) return;
    const quiet = st.deps.quietMs();
    for (const [id, entry] of [...st.pending]) {
      if (Date.now() - entry.at >= QUIET_SHOW_MS && quiet >= QUIET_SHOW_MS) {
        st.pending.delete(id);
        display(entry.msg, entry.replay, 'no_speech');
      }
    }
  }

  // ------------------------------------------------------------------ drawing

  async function display(msg, replay = false, why = null) {
    for (const item of [...st.items.values()]) if (item.msg.slot === msg.slot && item.msg.id !== msg.id) remove(item.msg.id, true);
    remove(msg.id, true);
    const item = {msg: {...msg}, el: null, target: null, rect: null, placing: false, lost: false};
    item.el = build(item.msg);
    st.items.set(msg.id, item);
    applyEnabled(item);
    if (msg.kind === 'start') {
      item.el.classList.add('ov-start');
      st.layer.append(item.el);
    } else if (msg.kind === 'label' || msg.target) {
      st.layer.append(item.el);
      const found = msg.target ? await st.deps.resolve(msg.target) : {el: null, detail: 'no_target'};
      if (st.items.get(msg.id) !== item) return;            // hidden or replaced while looking
      if (!found.el) {
        if (replay && msg.kind === 'label') { remove(msg.id, true); return; }    // a stale copy: drop it quietly
        dockItem(item, found.detail);
      } else {
        item.target = found.el;
        await place(item);
      }
    } else {
      // Docked cards: the card slot above the task.
      if (msg.slot === 'task') st.dock.append(item.el);
      else st.dock.prepend(item.el);
      fitDock();
    }
    send('shown', msg.id, why ? {detail: why} : {});
  }

  /** The dock grows up from the panel; when it would leave the screen, the
   *  task folds to its title (the learner can unfold it). */
  function fitDock() {
    if (!st.dock) return;
    const r = st.dock.getBoundingClientRect();
    if (r.top >= 8 && st.dock.scrollHeight <= st.dock.clientHeight + 1) return;
    for (const item of st.items.values()) if (item.msg.slot === 'task') item.el.classList.add('folded');
  }

  function dockItem(item, detail) {
    if (item.msg.kind === 'label') {
      item.el.classList.add('docked', 'placed');
      const arrow = item.el.querySelector('.ov-arrow');
      if (arrow) arrow.hidden = true;
    } else {
      st.dock.prepend(item.el);
    }
    send('docked', item.msg.id, {detail: detail || 'not_found'});
  }

  function build(msg) {
    return msg.kind === 'label' ? buildLabel(msg) : buildCard(msg);
  }

  function buildLabel(msg) {
    const el = h('div', {class: `ov ov-label ${msg.tone === 'caution' ? 'caution' : ''}`, 'aria-hidden': 'true'},
      h('span', {class: 'verb', text: msg.title || ''}),
      h('span', {class: 'name', text: msg.text || ''}),
      msg.note ? h('span', {class: 'note', text: msg.note}) : null,
      msg.value ? h('div', {class: 'ov-value'}, h('code', {text: msg.value}),
        msg.value.length > 20 || /[^\w\s.,'?!-]/.test(msg.value) ? copyButton(msg.id, null) : null) : null,
      h('div', {class: 'ov-arrow'}));
    return el;
  }

  const KICKER = {hint: [ICONS.hint, 'Hint'], seen: [ICONS.done, 'Done'], concept: [ICONS.info, 'Good to know'],
                  task: [ICONS.task, 'Your turn'], start: [ICONS.learn, B.NAME]};

  function copyButton(id, value) {
    return h('button', {class: 'copy', 'data-ov-copy': id, 'data-value': value, title: 'Copy this value'},
      h('i', {class: 'ic', 'aria-hidden': 'true', text: ICONS.copy}), h('span', {class: 'lbl', text: 'Copy'}));
  }

  function copyShows(button, label, done) {
    const icon = button.querySelector('.ic');
    const text = button.querySelector('.lbl');
    if (icon) icon.textContent = done ? ICONS.check : ICONS.copy;
    if (text) text.textContent = label; else button.textContent = label;
    button.classList.toggle('done', done);
  }

  function buildCard(msg) {
    const kind = msg.kind || 'card';
    const buttons = msg.buttons || [];
    const closable = kind !== 'start' && kind !== 'task';
    const card = h('section', {class: `ov ov-card ${kind} ${msg.tone === 'caution' ? 'caution' : ''}`, role: 'region', 'aria-label': msg.title || 'Lesson card'},
      h('header', null,
        h('b', {text: msg.title || ''}),
        kind === 'task' ? h('button', {class: 'fold', 'data-ov-fold': msg.id, 'aria-label': 'Fold or unfold', text: ICONS.minus}) : null,
        closable ? h('button', {class: 'x', 'data-ov-close': msg.id, 'aria-label': 'Close', text: ICONS.close}) : null),
      msg.text ? h('p', {text: msg.text}) : null,
      (msg.items || []).length ? h(kind === 'task' ? 'ol' : 'ul', null, (msg.items || []).map((text) => h('li', {text}))) : null,
      (msg.values || []).length ? h('div', {class: 'vals'}, h('span', {text: msg.values_title || ''}),
        (msg.values || []).map((v) => h('div', {class: 'val'}, h('span', {text: `${v.name}:`}), h('code', {text: v.value}),
          copyButton(msg.id, v.value)))) : null,
      msg.progress ? h('div', {class: 'fine prog'}, h('span', {text: msg.progress.text || ''}),
        h('div', {class: 'bar'}, bar(msg.progress))) : null,
      msg.note ? h('div', {class: 'fine', text: msg.note}) : null,
      buttons.length ? h('div', {class: 'btns'}, buttons.map((b, i) =>
        h('button', {class: i === 0 ? 'primary' : '', 'data-ov-btn': b.id, 'data-ov-id': msg.id, text: b.label}))) : null);
    if (KICKER[kind] && kind !== 'task') {
      const [icon, label] = msg.tone === 'caution' ? [ICONS.caution, KICKER[kind][1]] : KICKER[kind];
      card.querySelector('header').prepend(h('span', {class: 'kicker'}, h('i', {class: 'ic', 'aria-hidden': 'true', text: icon}), label));
    }
    return card;
  }

  function bar(p) {
    const fill = h('i');
    fill.style.width = `${Math.round(100 * Math.min(1, (Number(p.done) || 0) / Math.max(1, Number(p.of) || 1)))}%`;
    return fill;
  }

  function rerender(item) {
    const fresh = build(item.msg);
    if (item.el.classList.contains('folded')) fresh.classList.add('folded');
    if (item.el.classList.contains('ov-start')) fresh.classList.add('ov-start');
    item.el.replaceWith(fresh);
    item.el = fresh;
    applyEnabled(item);
    if (item.target) place(item);
  }

  function remove(id, quiet = false) {
    const item = st.items.get(id);
    if (!item) return;
    st.items.delete(id);
    item.el.remove();
    if (!quiet) send('hidden', id);
  }

  // ------------------------------------------------------------------ placement

  const inflate = (r, n) => ({left: r.left - n, top: r.top - n, right: r.right + n, bottom: r.bottom + n});
  const hits = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const inView = (b) => b.left >= 4 && b.top >= 4 && b.right <= innerWidth - 4 && b.bottom <= innerHeight - 4;

  function avoidRects() {
    const out = (st.deps.avoid() || []).filter(Boolean);
    for (const card of st.dock.children) out.push(card.getBoundingClientRect());
    for (const item of st.items.values()) if (item.msg.kind === 'start') out.push(item.el.getBoundingClientRect());
    return out.filter((r) => r.width > 0 && r.height > 0).map((r) => inflate(r, 6));
  }

  async function place(item) {
    const F = globalThis.FloatingUIDOM;
    if (!F || !item.target || item.placing) return;
    item.placing = true;
    try {
      const target = item.target;
      const reference = {getBoundingClientRect: () => target.getBoundingClientRect(), contextElement: target};
      const arrow = item.el.querySelector('.ov-arrow');
      const keepClear = [inflate(target.getBoundingClientRect(), 4), ...avoidRects()];
      for (const side of SIDES) {
        const pos = await F.computePosition(reference, item.el, {
          strategy: 'fixed', placement: side,
          middleware: [F.offset(14), F.shift({padding: 8}), ...(arrow ? [F.arrow({element: arrow, padding: 12})] : [])],
        });
        const box = {left: pos.x, top: pos.y, right: pos.x + item.el.offsetWidth, bottom: pos.y + item.el.offsetHeight};
        if (!inView(box) || keepClear.some((r) => hits(box, r))) continue;
        Object.assign(item.el.style, {left: `${pos.x}px`, top: `${pos.y}px`});
        item.el.classList.remove('docked');
        item.el.classList.add('placed');
        if (arrow) {
          const a = pos.middlewareData.arrow || {};
          const staticSide = {top: 'bottom', bottom: 'top', left: 'right', right: 'left'}[pos.placement.split('-')[0]];
          arrow.hidden = false;
          Object.assign(arrow.style, {left: a.x != null ? `${a.x}px` : '', top: a.y != null ? `${a.y}px` : '', right: '', bottom: ''});
          arrow.style[staticSide] = '-8px';
          // A square turned 45°: the two edges on the element's side draw the point.
          for (const edge of ['Top', 'Right', 'Bottom', 'Left']) {
            arrow.style[`border${edge}Color`] = ARROW_EDGES[staticSide].includes(edge) ? '' : 'transparent';
          }
        }
        item.rect = rectKey(target);
        if (!item.placedOnce) {
          item.placedOnce = true;
          send('placed', item.msg.id, {detail: pos.placement, box: [Math.round(pos.x), Math.round(pos.y), item.el.offsetWidth, item.el.offsetHeight],
                                       target: rectKey(target)});
        }
        return;
      }
      if (!item.el.classList.contains('docked')) dockItem(item, 'no_room');
      item.rect = rectKey(target);
    } finally {
      item.placing = false;
    }
  }

  const rectKey = (el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`; };

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** Follow the element as the page scrolls or re-lays out; find it again
   *  once if the app re-rendered it; else the label goes. */
  function track() {
    if (!st.root) return;
    if (st.dock && st.deps) {
      const panel = st.deps.avoid()[0];
      if (panel) {
        const bottom = Math.max(18, innerHeight - panel.top + 12) - SHADOW_ROOM;
        st.dock.style.bottom = `${bottom}px`;
        st.dock.style.maxHeight = `${Math.max(120 + SHADOW_ROOM, innerHeight - bottom - 8)}px`;
      }
    }
    for (const item of st.items.values()) {
      if (!item.target || item.placing) continue;
      if (!visible(item.target)) {
        if (item.lost) continue;
        item.lost = true;
        st.deps.resolve(item.msg.target).then((found) => {
          if (st.items.get(item.msg.id) !== item) return;
          if (found.el) { item.target = found.el; item.lost = false; place(item); } else remove(item.msg.id);
        });
        continue;
      }
      if (rectKey(item.target) !== item.rect) place(item);
    }
    requestAnimationFrame(track);
  }

  // ------------------------------------------------------------------ the learner's clicks

  function onClick(event) {
    const button = event.target.closest && event.target.closest('button');
    if (!button) return;
    if (button.dataset.ovBtn) {
      const id = button.dataset.ovId;
      const which = button.dataset.ovBtn;
      send('click', id, {button: which});
      if (which === 'got_it') remove(id, true);
      if (which.startsWith('start_')) {
        for (const b of button.parentElement.querySelectorAll('button')) b.disabled = true;
        button.textContent = '…';
      }
    } else if (button.dataset.ovClose) {
      remove(button.dataset.ovClose, true);
      send('dismiss', button.dataset.ovClose);
    } else if (button.dataset.ovFold) {
      const item = st.items.get(button.dataset.ovFold);
      if (item) item.el.classList.toggle('folded');
    } else if (button.dataset.ovCopy) {
      const item = st.items.get(button.dataset.ovCopy);
      const value = button.dataset.value || (item && item.msg.value) || '';
      navigator.clipboard.writeText(value).then(() => {
        copyShows(button, 'Copied', true);
        setTimeout(() => copyShows(button, 'Copy', false), 1500);
      }, () => copyShows(button, 'Select it', false));
      send('copy', button.dataset.ovCopy);
    }
  }

  // ------------------------------------------------------------------ text on or off

  const keepsWhenOff = (item) => item.msg.kind === 'start' || item.msg.kind === 'task';
  function applyEnabled(item) { item.el.classList.toggle('off', !st.enabled && !keepsWhenOff(item)); }

  function setEnabled(on) {
    st.enabled = Boolean(on);
    try { sessionStorage.setItem(ENABLED_KEY, st.enabled ? 'on' : 'off'); } catch {}
    for (const item of st.items.values()) applyEnabled(item);
    send('toggle', null, {detail: st.enabled ? 'on' : 'off'});
  }

  window.__frty2Overlay = {h, mount, reset, handle, release, setEnabled, enabled: () => st.enabled};
})();
