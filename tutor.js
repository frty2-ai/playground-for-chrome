/**
 * The live tutor, inside the learner's app tab (any domain: the byte's app).
 * Injected by the service worker (chrome.scripting) when a tutor session
 * starts, and again after every page load in that tab; the WebSocket itself
 * lives in the offscreen document (tutor-audio.js), so it survives the load.
 * Protocol: docs/plan/module-agents.md §12.4.
 *
 * What it does:
 *   - The cursor, in the ghost's look (Deep Teal arrow with a name tag, glide,
 *     circle, press ripple, spotlight), in its own shadow root in the top
 *     layer with pointer-events off. It performs the server's `action`s:
 *     point, click, type, select, navigate, drag, park, none; and answers
 *     each with `action_done {id, ok, detail}`. A target it cannot resolve is
 *     reported (`not_found`, `no_dialog`, `wrong_page`), never asked of the
 *     learner: the backend decides what happens next.
 *   - Timing: `when: "now"` runs at once; `speech_start` runs when the
 *     offscreen player says the audio that followed the action has started;
 *     `speech_end` when that audio has played. The live model can take
 *     many seconds to begin a line (5-28 s measured), so there is no short
 *     timeout: an action whose line was never spoken runs when the next
 *     turn's actions arrive (that turn ended silent), or after 45 s.
 *     Actions run one at a time, in order.
 *   - Page loads: the service worker keeps every action that has not been
 *     answered, and whether its moment has come, so actions sent before a
 *     click that leaves the page (the server sends the next beat's actions
 *     before this one's click has run) run on the next page. A click that
 *     starts a page load is answered on `pagehide`.
 *   - The learner's DOM events in Watch's schema (watch.js: `describe`,
 *     `labelOf`, masking), batched every 300 ms as `event {events}`. What the
 *     tutor's own synthetic actions cause is not reported as the learner's;
 *     dialogs, toasts and loads they cause carry `by: "tutor"`.
 *   - A small panel: who has the floor, as the server says (`floor {state,
 *     text}`: listening, thinking, speaking, watching, waiting, paused,
 *     reconnecting, restoring; docs/plan/tutor-floor.md §3.7), the latest captions,
 *     Pause/Resume, Next, Check my work, Stop, a mic dot.
 *   - `cancel {ids}`: actions still waiting for their speech are dropped
 *     (the server is about to send them again); one already running finishes.
 *   - `request_frame {max}`: the visible tab as JPEG (through the service
 *     worker), with this overlay hidden for the shot.
 *   - On-screen text (`overlay` messages) is drawn by tutor-overlay.js in the
 *     same shadow root; this file hands it the resolver, the audio moments
 *     (`playback started`) and the overlays kept across page loads.
 *
 * The describing helpers below are copied from watch.js so that both write
 * the same event schema; keep them in step.
 */

(() => {
  if (window.__frty2Tutor) { window.__frty2Tutor.revive(); return; }

  const HOST_ID = 'frty2-tutor-host';
  const CURSOR_KEY = 'frty2_tutor_cursor';
  const BATCH_MS = 300;
  const NO_SPEECH_MS = 45000;        // no speech at all after the action: run anyway
  const SAME_TURN_MS = 500;          // actions arriving this close together belong to one turn
  const END_QUIET_MS = 4000;         // speech_end: its speech was heard and has been quiet this long
  const END_WAIT_MS = 60000;         // speech_end: never wait longer than this
  const RESOLVE_MS = 2500;           // a target may still be animating in
  const ACT_GRACE_MS = 800;          // what the page does just after our action is ours

  const now = () => performance.timeOrigin + performance.now();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const token = Math.random().toString(36).slice(2, 7);
  const log = (...args) => console.info('[frty2 tutor]', ...args);

  const self = {alive: false, n: 0, batch: [], batchTimer: null, acting: 0, actingUntil: 0, chain: Promise.resolve(),
                lastHref: location.href, timers: [], observer: null, navTimer: null, current: null, quietSince: Date.now()};
  const ui = {link: 'connecting', linkDetail: '', paused: false, speaking: false, ended: null, title: '', phase: '', beat: null,
              of: null, note: '', tutor: '', learner: '', draft: {tutor: null, learner: null}, error: '', mic: 'off', micDetail: '', level: 0, min: false,
              floor: '', floorText: ''};
  const waiting = new Map();          // action id -> {a, at, heard, timer}
  const known = new Set();            // action ids this page has queued or run: each runs once

  window.__frty2Tutor = {revive};
  const ov = window.__frty2Overlay;        // tutor-overlay.js, injected just before this file
  const B = window.__a42Brand;             // brand.js, before that
  const {C, ICONS} = B;

  // ------------------------------------------------------------------ messaging

  function send(msg) {
    try {
      chrome.runtime.sendMessage({type: 'tutor_send', msg}).catch(() => {});
    } catch {
      teardown();                    // the extension was reloaded: this copy is orphaned
    }
  }

  function onRuntime(message, sender, sendResponse) {
    if (!message || !self.alive) return false;
    if (message.type === 'tutor_msg' && message.msg) onMsg(message.msg);
    else if (message.type === 'tutor_end') end(message.reason);
    return false;
  }

  function onMsg(msg) {
    switch (msg.type) {
      case 'ready':
        ui.title = pickText(msg.byte && msg.byte.title) || ui.title;
        ui.mode = msg.mode || '';
        break;
      case 'overlay':
        if (ov) ov.handle(msg);
        return;
      case 'state':
        ui.phase = msg.phase || ui.phase;
        if (msg.mode) ui.mode = msg.mode;
        ui.beat = msg.beat ?? null;
        ui.of = msg.of ?? null;
        ui.note = msg.note || '';
        break;
      case 'action':
        onAction(msg);
        return;
      case 'cancel':
        for (const id of msg.ids || []) {
          const entry = waiting.get(id);
          if (entry) { clearInterval(entry.timer); waiting.delete(id); log('cancelled', id); }
        }
        return;
      case 'floor':
        ui.floor = msg.state || '';
        ui.floorText = msg.text || '';
        break;
      case 'caption': {
        // Non-final captions are pieces of the line being spoken (the live
        // model's transcription deltas); the final one is the whole line.
        const who = msg.who === 'learner' ? 'learner' : 'tutor';
        const text = msg.text || '';
        if (msg.final === false) {
          ui[who] = ui.draft[who] === null ? text.trimStart() : ui.draft[who] + text;
          ui.draft[who] = ui[who];
        } else {
          ui[who] = text;
          ui.draft[who] = null;
        }
        break;
      }
      case 'speech':
        if (msg.status === 'interrupted') {
          cancelWaiting('interrupted');
          stopGlide();                                          // the cursor stops where it is
          ui.speaking = false;
          if (ov) ov.handle({op: 'clear', scope: 'beat'});     // the beat is sent again, with its label
        }
        break;
      case 'playback':
        onPlayback(msg);
        break;
      case 'request_frame':
        captureFrame(Number(msg.max) || 768);
        return;
      case 'error':
        ui.error = msg.message || msg.code || 'error';
        break;
      case 'bye':
        ui.ended = msg.reason || 'The lesson has ended.';
        cancelWaiting('ended');
        break;
      case 'link':
        ui.link = msg.status;
        ui.linkDetail = msg.detail || '';
        if (msg.status === 'open') ui.error = '';
        break;
      case 'mic':
        ui.mic = msg.status;
        if (typeof msg.level === 'number') ui.level = msg.level;
        if (msg.detail) ui.micDetail = msg.detail;
        break;
      default:
        return;
    }
    render();
  }

  const pickText = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return value.en || Object.values(value)[0] || '';
  };

  // ------------------------------------------------------------------ timing

  /** `due`: its moment already came (before this page loaded); `heard`: its
   *  turn's speech had begun. */
  function onAction(a, due = false, heard = false) {
    if (a.id !== undefined && a.id !== null) {
      if (known.has(a.id)) return;
      known.add(a.id);
    }
    if (a.when === 'speech_start' || a.when === 'speech_end') {
      // A newer turn's actions: the older ones whose speech never began
      // belonged to a turn that ended without a word. Their moment is past.
      for (const [id, entry] of [...waiting]) {
        if (!entry.heard && Date.now() - entry.at > SAME_TURN_MS) release(id, 'silent_turn');
      }
    }
    if (!due && (a.when === 'speech_start' || a.when === 'speech_end')) {
      const entry = {a, at: Date.now(), heard, timer: null};
      waiting.set(a.id, entry);
      log('queued', a.id, a.do, a.when, Date.now());
      // Fallbacks only: the offscreen player names the action when its moment comes.
      entry.timer = setInterval(() => {
        const age = Date.now() - entry.at;
        if (a.when === 'speech_start') { if (age >= NO_SPEECH_MS) release(a.id, 'no_audio'); return; }
        if (age >= END_WAIT_MS || (!ui.speaking && (entry.heard ? Date.now() - self.quietSince >= END_QUIET_MS : age >= NO_SPEECH_MS))) {
          release(a.id, 'no_audio');
        }
      }, 250);
      return;
    }
    if (due) log('due', a.id, a.do, a.when, Date.now());
    schedule(a);
  }

  function onPlayback(p) {
    if (p.status === 'started') {
      ui.speaking = true;
      for (const entry of waiting.values()) entry.heard = true;
      const ids = Array.isArray(p.ids) && p.ids.length ? p.ids
        : [...waiting.values()].filter((e) => e.a.when === 'speech_start').map((e) => e.a.id);
      for (const id of ids) { const e = waiting.get(id); if (e && e.a.when === 'speech_start') release(id, 'speech_start'); }
      if (ov) ov.release(Array.isArray(p.ids) ? p.ids : []);
    } else if (p.status === 'ended') {
      for (const id of p.ids || []) if (waiting.has(id)) release(id, 'speech_end');
    } else if (p.status === 'drained') {
      ui.speaking = false;
      self.quietSince = Date.now();
    }
    log('playback', p.status, JSON.stringify(p.ids || []), Date.now());
  }

  function release(id, why) {
    const entry = waiting.get(id);
    if (!entry) return;
    waiting.delete(id);
    clearInterval(entry.timer);
    log('release', id, why, Date.now());
    schedule(entry.a);
  }

  function cancelWaiting(detail) {
    for (const [id, entry] of waiting) {
      clearInterval(entry.timer);
      send({type: 'action_done', id, ok: false, detail});
    }
    waiting.clear();
  }

  function schedule(a) {
    self.chain = self.chain.then(() => execute(a)).catch(() => {});
  }

  async function execute(a) {
    if (!self.alive) return;
    log('run', a.id, a.do, a.when || 'now', Date.now());
    self.acting += 1;
    self.current = {a, fired: false, el: null};
    const current = self.current;
    const started = Date.now();
    let result;
    try {
      result = await perform(a);
    } catch (error) {
      result = {ok: false, detail: `error: ${error && error.message || error}`};
    } finally {
      self.acting -= 1;
      self.actingUntil = Date.now() + ACT_GRACE_MS;
      self.current = null;
    }
    log('done', a.id, a.do, result.ok, result.detail || '', Date.now());
    // For the trace: the element the cursor actually used, and how long it took.
    if (!result.deferred) send({type: 'action_done', id: a.id, ok: Boolean(result.ok), detail: result.detail ?? null,
                                ms: Date.now() - started, el: current.el ? describe(current.el) : undefined, url: cleanUrl(location.href)});
  }

  async function perform(a) {
    switch (a.do) {
      case 'none':
        return {ok: true};
      case 'park':
        await parkCursor();
        return {ok: true};
      case 'navigate':
        return navigate(a);
      default:
        break;
    }
    if (!['point', 'click', 'type', 'select', 'drag'].includes(a.do)) return {ok: false, detail: `unknown action ${a.do}`};
    const found = await resolve(a.target);
    if (!found.el) return {ok: false, detail: found.detail};
    const el = found.el;
    if (self.current) self.current.el = el;
    if (a.do === 'point') {
      await moveCursorTo(el);
      spotlight(el);
      await circle(el);
      spotLater(2500);
      return {ok: true};
    }
    if (a.do === 'click') { await doClick(el); return {ok: true}; }
    if (a.do === 'type') return doType(el, a.value == null ? '' : String(a.value));
    if (a.do === 'select') return doSelect(el, a.value == null ? '' : String(a.value));
    const dest = await resolve(a.value && typeof a.value === 'object' ? a.value : null);
    if (!dest.el) return {ok: false, detail: `destination ${dest.detail}`};
    return doDrag(el, dest.el);
  }

  // ------------------------------------------------------------------ resolving targets

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  function shown(el) {
    if (!(el instanceof Element) || el.id === HOST_ID) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  }

  /** querySelectorAll through open shadow roots. */
  function deepAll(root, selector, out = [], depth = 0) {
    for (const el of root.querySelectorAll(selector)) out.push(el);
    if (depth < 6) {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && el.id !== HOST_ID) deepAll(el.shadowRoot, selector, out, depth + 1);
      }
    }
    return out;
  }

  /** The dialog the learner sees on top: a modal in the top layer, else the
   *  last visible dialog that actually receives hits at its centre. */
  function topDialog() {
    const modals = Array.from(document.querySelectorAll(':modal')).filter(shown);
    if (modals.length) return modals[modals.length - 1];
    const dialogs = deepAll(document, DIALOG).filter(shown).reverse();
    for (const dialog of dialogs) {
      const r = dialog.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 40));
      if (hit && (dialog === hit || dialog.contains(hit))) return dialog;
    }
    return dialogs[0] || null;
  }

  function roleOf(el) {
    const role = el.getAttribute('role');
    if (role) return role.toLowerCase();
    const tag = el.localName;
    if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes(el.type))) return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'range', 'file', 'hidden'].includes(el.type))) return 'textbox';
    if (tag === 'input') return el.type;
    return tag;
  }

  function match(have, want) {
    if (!want || !have) return 0;
    if (have === want) return 100;
    const bare = have.replace(/[:*]+\s*$/, '').trim();
    if (bare === want) return 95;
    if (have.length > want.length + 60) return 0;
    if (have.startsWith(want)) return 70;
    if (have.includes(want)) return 50;
    return 0;
  }

  // Anything that can carry the target's words; non-interactive ones score lower.
  const candidates = () => `${INTERACTIVE}, h1, h2, h3, h4, h5, h6, p, td, th, li, dt, dd, span, div, img[alt], [aria-label]`;

  function scoreOf(el, target) {
    const field = el.matches(FIELD);
    const aria = norm(el.getAttribute('aria-label'));
    const placeholder = norm(el.getAttribute('placeholder'));
    const title = norm(el.getAttribute('title'));
    const parts = [];
    if (target.text) {
      const want = norm(target.text);
      const text = field ? '' : norm(el.innerText || el.textContent || (typeof el.value === 'string' ? el.value : '') || el.getAttribute('alt'));
      parts.push(Math.max(match(text, want), match(aria, want) * 0.9, match(title, want) * 0.8));
    }
    if (target.label) {
      const want = norm(target.label);
      parts.push(Math.max(match(norm(labelOf(el)), want), match(aria, want), match(placeholder, want) * 0.85,
                          field ? match(norm(el.name).replace(/_/g, ' '), want) * 0.7 : 0));
    }
    if (target.placeholder) parts.push(match(placeholder, norm(target.placeholder)));
    if (target.aria) parts.push(match(aria, norm(target.aria)));
    if (!parts.length) return 0;
    let score = Math.max(...parts);
    if (score <= 0) return 0;
    score += parts.filter((p) => p > 0).length * 5 - 5;           // more of the target agrees
    if (target.role) {
      const role = roleOf(el);
      const want = String(target.role).toLowerCase();
      if (role === want) score += 25;
      else if (want === 'button' && (role === 'link' || role === 'menuitem' || /btn|button/i.test(String(el.className)))) score += 8;
      else if (want === 'textbox' && field) score += 15;
      else score -= 20;
    }
    if (!field && !el.matches(INTERACTIVE) && typeof el.onclick !== 'function' && getComputedStyle(el).cursor !== 'pointer') score -= 30;
    score -= Math.min(25, el.querySelectorAll('*').length / 2);     // the innermost match
    return score;
  }

  /** A field next to a label written as text (most business apps). */
  function fieldNear(labelEl) {
    for (const selector of ['tr', 'li', '[class*="row" i]', '[class*="field" i]', '[class*="form" i]', 'div']) {
      const container = labelEl.closest(selector);
      if (!container) continue;
      const field = Array.from(container.querySelectorAll(FIELD)).find(shown);
      if (field) return field;
    }
    return null;
  }

  function resolveOnce(target) {
    const dialog = target.within === 'dialog' ? topDialog() : null;
    if (target.within === 'dialog' && !dialog) return {el: null, detail: 'no_dialog'};
    const scope = dialog || document;
    const pool = new Set(deepAll(scope, target.label || target.placeholder ? `${candidates()}, ${FIELD}` : candidates()));
    if (dialog) pool.add(dialog);
    const scored = [];
    for (const el of pool) {
      if (el.closest && el.closest(`#${HOST_ID}`)) continue;
      if (!shown(el)) continue;
      const score = scoreOf(el, target);
      if (score >= 40) scored.push({el, score});
    }
    // "Name" written beside a field: the field, not the text.
    if (target.label) {
      for (const item of scored) {
        if (item.el.matches(FIELD)) continue;
        const field = fieldNear(item.el);
        if (field && norm(item.el.innerText).replace(/[:*]+\s*$/, '').trim() === norm(target.label)) scored.push({el: field, score: item.score + 10});
      }
    }
    if (!scored.length) return {el: null, detail: target.page && !location.pathname.includes(target.page) ? 'wrong_page' : 'not_found'};
    scored.sort((a, b) => b.score - a.score);
    const top = scored.filter((s) => s.score >= scored[0].score - 5);
    // A tie: the one that receives a click at its centre, else the first.
    const hittable = top.find(({el}) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit && (hit === el || el.contains(hit));
    });
    return {el: (hittable || top[0]).el};
  }

  async function resolve(target) {
    if (!target || typeof target !== 'object') return {el: null, detail: 'no_target'};
    if (!target.text && !target.label && !target.placeholder && !target.aria) return {el: null, detail: 'no_target'};
    const deadline = Date.now() + RESOLVE_MS;
    for (;;) {
      const found = resolveOnce(target);
      if (found.el || Date.now() >= deadline) return found;
      await wait(250);
    }
  }

  // ------------------------------------------------------------------ doing things

  function fire(el, type, init, Kind = MouseEvent) {
    el.dispatchEvent(new Kind(type, {bubbles: true, cancelable: true, composed: true, view: window, ...init}));
  }

  function pointer(el, type, x, y) {
    const init = {clientX: x, clientY: y, button: 0, buttons: type.endsWith('down') || type.endsWith('move') ? 1 : 0};
    if (type.startsWith('pointer')) fire(el, type, {...init, pointerId: 1, pointerType: 'mouse', isPrimary: true}, PointerEvent);
    else fire(el, type, init);
  }

  async function doClick(el) {
    await moveCursorTo(el);
    spotlight(el);
    await wait(350);                         // let the learner see where before it happens
    await press(el);
    const {x, y} = pointOf(el);
    pointer(el, 'pointerdown', x, y); pointer(el, 'mousedown', x, y);
    if (typeof el.focus === 'function') el.focus({preventScroll: true});
    pointer(el, 'pointerup', x, y); pointer(el, 'mouseup', x, y);
    if (typeof el.click === 'function') el.click(); else fire(el, 'click', {clientX: x, clientY: y});
    if (self.current) self.current.fired = true;   // a link may be taking the page away now
    await wait(400);
    spotlight(null);
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
  }

  function editableIn(el) {
    if (el.matches('input, textarea, [contenteditable=""], [contenteditable="true"]')) return el;
    return el.querySelector('input:not([type="hidden"]), textarea, [contenteditable=""], [contenteditable="true"]') || el;
  }

  async function doType(el, value) {
    const field = editableIn(el);
    await moveCursorTo(field);
    spotlight(field);
    await press(field);
    field.focus({preventScroll: true});
    const chars = Array.from(value);
    const step = Math.max(1, Math.ceil(chars.length / 28));        // visible typing, at most ~1.5 s
    if (field.isContentEditable) {
      const range = document.createRange(); range.selectNodeContents(field);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      for (let i = 0; i < chars.length; i += step) {
        document.execCommand('insertText', false, chars.slice(i, i + step).join(''));
        await wait(50);
      }
    } else if ('value' in field) {
      if (!chars.length) { setNativeValue(field, ''); field.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'deleteContentBackward'})); }
      for (let i = step; i < chars.length + step; i += step) {
        const upto = Math.min(i, chars.length);
        setNativeValue(field, chars.slice(0, upto).join(''));
        field.dispatchEvent(new InputEvent('input', {bubbles: true, composed: true, inputType: 'insertText', data: chars.slice(Math.max(0, i - step), upto).join('')}));
        await wait(50);
      }
    } else {
      spotlight(null);
      return {ok: false, detail: 'not_editable'};
    }
    field.dispatchEvent(new Event('change', {bubbles: true}));
    await wait(250);
    spotlight(null);
    const got = field.isContentEditable ? field.innerText.trim() : field.value;
    return got === value || field.isContentEditable ? {ok: true} : {ok: false, detail: 'value_rejected'};
  }

  async function doSelect(el, value) {
    const want = norm(value);
    const native = el instanceof HTMLSelectElement ? el : el.querySelector('select');
    if (native) {
      await moveCursorTo(native); spotlight(native); await press(native);
      const options = Array.from(native.options);
      const option = options.find((o) => norm(o.textContent) === want || norm(o.value) === want)
        || options.find((o) => norm(o.textContent).includes(want));
      await wait(250); spotlight(null);
      if (!option) return {ok: false, detail: 'option_not_found'};
      setNativeValue(native, option.value);
      native.dispatchEvent(new Event('input', {bubbles: true}));
      native.dispatchEvent(new Event('change', {bubbles: true}));
      return {ok: true};
    }
    // A custom dropdown: open it, then click the option.
    await doClick(el);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const options = deepAll(document, '[role="option"], [role="menuitem"], [role="menuitemradio"], li, lyte-drop-item, [class*="option" i]')
        .filter((o) => shown(o) && !o.closest(`#${HOST_ID}`) && o.childElementCount <= 3);
      const option = options.find((o) => norm(o.innerText) === want) || options.find((o) => norm(o.innerText).startsWith(want));
      if (option) { await doClick(option); return {ok: true}; }
      await wait(200);
    }
    return {ok: false, detail: 'option_not_found'};
  }

  async function doDrag(source, dest) {
    await moveCursorTo(source);
    spotlight(source);
    await press(source);
    const from = pointOf(source);
    const data = new DataTransfer();
    pointer(source, 'pointerdown', from.x, from.y); pointer(source, 'mousedown', from.x, from.y);
    fire(source, 'dragstart', {clientX: from.x, clientY: from.y, dataTransfer: data}, DragEvent);
    const to = pointOf(dest);
    const steps = 8;
    const glide = glideTo(to.x, to.y);
    for (let i = 1; i <= steps; i += 1) {
      const x = from.x + (to.x - from.x) * (i / steps), y = from.y + (to.y - from.y) * (i / steps);
      const under = document.elementFromPoint(x, y) || dest;
      pointer(under, 'pointermove', x, y); pointer(under, 'mousemove', x, y);
      fire(under, 'dragover', {clientX: x, clientY: y, dataTransfer: data}, DragEvent);
      await wait(60);
    }
    await glide;
    spotlight(dest);
    fire(dest, 'dragenter', {clientX: to.x, clientY: to.y, dataTransfer: data}, DragEvent);
    fire(dest, 'dragover', {clientX: to.x, clientY: to.y, dataTransfer: data}, DragEvent);
    fire(dest, 'drop', {clientX: to.x, clientY: to.y, dataTransfer: data}, DragEvent);
    fire(source, 'dragend', {clientX: to.x, clientY: to.y, dataTransfer: data}, DragEvent);
    pointer(dest, 'pointerup', to.x, to.y); pointer(dest, 'mouseup', to.x, to.y);
    await press(dest);
    await wait(300);
    spotlight(null);
    return {ok: true, detail: 'synthetic_drag'};
  }

  /** Same document (only the hash changes): done at once. Otherwise the
   *  service worker reports the action when the new page has loaded. */
  async function navigate(a) {
    const raw = typeof a.value === 'string' && a.value ? a.value : a.target && (a.target.url || a.target.page);
    if (!raw) return {ok: false, detail: 'no_url'};
    let url;
    try { url = new URL(raw, location.href); } catch { return {ok: false, detail: 'bad_url'}; }
    if (!/^https?:$/.test(url.protocol)) return {ok: false, detail: 'bad_url'};
    if (url.href === location.href) return {ok: true, detail: 'already_there'};
    const here = new URL(location.href);
    if (url.origin === here.origin && url.pathname === here.pathname && url.search === here.search) {
      location.hash = url.hash;
      return {ok: true, detail: 'same_page'};
    }
    await glideTo(innerWidth * 0.3, 20);
    try { await chrome.runtime.sendMessage({type: 'tutor_nav', id: a.id, url: url.href}); } catch {}
    clearTimeout(self.navTimer);
    self.navTimer = setTimeout(() => {         // still here: the page refused to leave
      send({type: 'action_done', id: a.id, ok: false, detail: 'navigation_blocked'});
      chrome.runtime.sendMessage({type: 'tutor_nav', id: null}).catch(() => {});
    }, 8000);
    location.assign(url.href);
    return {ok: true, deferred: true};
  }

  // ------------------------------------------------------------------ frames

  async function captureFrame(max) {
    const host = overlay.host;
    if (host) host.style.setProperty('visibility', 'hidden', 'important');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await wait(40);
    let reply = null;
    try { reply = await chrome.runtime.sendMessage({type: 'tutor_capture', max}); } catch (error) { reply = {ok: false, error: String(error.message || error)}; }
    if (host) host.style.setProperty('visibility', 'visible', 'important');
    if (reply && reply.ok) send({type: 'frame', data: reply.data});
    else send({type: 'frame', data: null, detail: (reply && reply.error) || 'capture_failed'});
  }

  // ------------------------------------------------------------------ describing things (as watch.js)

  const collapse = (s, n = 80) => {
    const text = String(s || '').replace(/\s+/g, ' ').trim();
    return text.length > n ? `${text.slice(0, n - 1)}…` : text;
  };

  const INTERACTIVE = 'a, button, input, select, textarea, label, summary, option, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="textbox"], [role="treeitem"], [role="gridcell"], [contenteditable=""], [contenteditable="true"], lyte-button, lyte-checkbox, lyte-dropdown, lyte-input, lyte-menu-item, lyte-drop-item';
  const FIELD = 'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]), textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"]';
  const DIALOG = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], lyte-modal';
  const NOTICES = `${DIALOG}, [role="alert"], [role="status"][aria-live], [class*="toast" i], [class*="snackbar" i]`;
  const SNAP = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="option"], [role="combobox"], [role="textbox"], [contenteditable="true"], lyte-button, lyte-dropdown, lyte-input, lyte-checkbox';

  const parentOf = (node) => node.parentElement || (node.getRootNode && node.getRootNode() instanceof ShadowRoot ? node.getRootNode().host : null);

  function closestAcross(el, selector) {
    for (let node = el, i = 0; node && i < 40; node = parentOf(node), i += 1) {
      if (node instanceof Element && node.matches(selector)) return node;
    }
    return null;
  }

  function interactiveOf(el) {
    for (let node = el, i = 0; node && i < 8; node = parentOf(node), i += 1) {
      if (node instanceof Element && (node.matches(INTERACTIVE) || typeof node.onclick === 'function')) return node;
    }
    return el;
  }

  function originOf(event) {
    const first = event.composedPath()[0];
    if (first instanceof Element) return first;
    if (first && first.parentElement) return first.parentElement;
    return event.target instanceof Element ? event.target : null;
  }

  const ours = (event) => event.composedPath().some((node) => node && (node.id === HOST_ID || node.id === 'frty2-ghost-host' || node.id === 'frty2-watch-host'));

  function cleanUrl(url) {
    try {
      const u = new URL(url, location.href);
      for (const key of [...u.searchParams.keys()]) {
        if (/token|code|secret|key|pass|sig|auth|session/i.test(key)) u.searchParams.set(key, '…');
      }
      return u.toString();
    } catch { return ''; }
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && !/\d{4,}/.test(node.id)) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      let part = node.localName;
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.localName === node.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function labelOf(el) {
    if (el.labels && el.labels.length) return collapse(el.labels[0].innerText, 60);
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const text = ids.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.innerText).join(' ');
      if (collapse(text)) return collapse(text, 60);
    }
    if (!el.matches(FIELD)) return '';
    for (let node = el, i = 0; node && i < 4; node = node.parentElement, i += 1) {
      let sibling = node.previousElementSibling;
      for (let j = 0; sibling && j < 3; j += 1, sibling = sibling.previousElementSibling) {
        const text = collapse(sibling.innerText, 61);
        if (text && text.length <= 60) return text;
      }
    }
    return '';
  }

  function dialogTitle(dialog) {
    const heading = dialog.querySelector('h1, h2, h3, [role="heading"], [class*="title" i], [class*="header" i]');
    return collapse(heading ? heading.innerText : dialog.getAttribute('aria-label') || '', 60);
  }

  function describe(el) {
    if (!(el instanceof Element)) return null;
    const d = {tag: el.localName};
    const role = el.getAttribute('role');
    if (role) d.role = role;
    const field = el.matches(FIELD);
    const label = labelOf(el);
    if (label) d.label = label;
    if (!field) {
      const text = collapse(el.innerText || el.textContent || (typeof el.value === 'string' ? el.value : ''), 80);
      if (text) d.text = text;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) d.aria = collapse(aria, 80);
    if (el.getAttribute('placeholder')) d.placeholder = collapse(el.getAttribute('placeholder'), 60);
    if (el.getAttribute('title')) d.title = collapse(el.getAttribute('title'), 60);
    if (typeof el.name === 'string' && el.name) d.name = el.name.slice(0, 60);
    if (typeof el.type === 'string' && el.type && el.localName === 'input') d.type = el.type;
    if (el.id && el.id.length < 60 && !/\d{4,}/.test(el.id)) d.el_id = el.id;
    const dialog = closestAcross(el, DIALOG);
    if (dialog) { d.within = 'dialog'; const title = dialogTitle(dialog); if (title) d.dialog = title; }
    if (typeof el.href === 'string' && el.href) d.href = cleanUrl(el.href);
    if (el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio')) d.checked = el.checked;
    const row = closestAcross(el, 'tr, [role="row"]');
    if (row) d.row = collapse(row.innerText, 100);
    if (el.getRootNode() instanceof ShadowRoot) d.shadow = true;
    const r = el.getBoundingClientRect();
    d.rect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    d.css = cssPath(el);
    return d;
  }

  const SECRET = /pass(word|code)?|otp|one.?time|token|secret|\bpin\b|cvv|cvc|card.?(no|num)|\bpan\b|aadha+r|\bssn\b|api.?key/i;
  function sensitive(el) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return true;
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (autocomplete.startsWith('cc-') || autocomplete.includes('password') || autocomplete === 'one-time-code') return true;
    return SECRET.test([el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), labelOf(el)].join(' '));
  }

  function valueOf(el) {
    let value;
    if (el.localName === 'select') value = Array.from(el.selectedOptions).map((o) => collapse(o.innerText, 120)).join(', ');
    else if (el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio')) return el.checked;
    else if (el.localName === 'input' && el.type === 'file') return Array.from(el.files || []).map((f) => ({name: f.name, type: f.type, size: f.size}));
    else if (el.isContentEditable) value = (el.innerText || '').slice(0, 2000);
    else value = String(el.value ?? '').slice(0, 2000);
    return sensitive(el) ? {masked: true, length: value.length} : value;
  }

  function fieldOf(el) {
    if (!(el instanceof Element)) return null;
    if (el.isContentEditable) {
      let root = el;
      while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
      return root;
    }
    return el.matches(FIELD) ? el : null;
  }

  function inView(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  }

  function snapshot() {
    const elements = [];
    let scanned = 0;
    for (const el of document.querySelectorAll(SNAP)) {
      if ((scanned += 1) > 2000 || elements.length >= 80) break;
      if (el.closest(`#${HOST_ID}`) || !inView(el)) continue;
      const r = el.getBoundingClientRect();
      const item = {r: el.getAttribute('role') || el.localName, b: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]};
      const label = labelOf(el);
      const text = el.matches(FIELD) ? '' : collapse(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '', 50);
      if (label) item.l = label;
      if (text) item.t = text;
      if (el.matches(FIELD)) { const v = valueOf(el); if (v !== '' && v !== false) item.v = typeof v === 'string' ? collapse(v, 50) : v; }
      if (closestAcross(el, DIALOG)) item.d = 1;
      elements.push(item);
    }
    const dialogs = Array.from(document.querySelectorAll(DIALOG)).filter(inView);
    return {url: cleanUrl(location.href), title: document.title, dialog: dialogs.length ? dialogTitle(dialogs[dialogs.length - 1]) : undefined,
            viewport: [innerWidth, innerHeight], elements};
  }

  // ------------------------------------------------------------------ the learner's events

  const busy = () => self.acting > 0 || Date.now() < self.actingUntil;

  function emit(kind, data) {
    if (!self.alive) return null;
    const event = {kind, id: `${token}.${self.n += 1}`, t: now(), ...data};
    self.batch.push(event);
    if (!self.batchTimer) self.batchTimer = setTimeout(flushBatch, BATCH_MS);
    return event.id;
  }

  function flushBatch() {
    self.batchTimer = null;
    if (!self.batch.length) return;
    send({type: 'event', events: self.batch.splice(0)});
  }

  let snapTimer = null;
  let snapFor = [];
  function snapshotSoon(id) {
    if (!id) return;
    snapFor.push(id);
    if (snapTimer) return;
    snapTimer = setTimeout(() => {
      snapTimer = null;
      emit('snapshot', {of: snapFor.splice(0), ...snapshot()});
    }, 800);
  }

  // The tutor's own clicks are untrusted events; anything else that arrives
  // while it acts (input, change, submit its typing and clicking caused) is
  // its own too. A trusted click or key during an action is the learner's.
  function onClick(event) {
    if (ours(event) || (busy() && !event.isTrusted)) return;
    const el = interactiveOf(originOf(event));
    const id = emit(event.type, {target: describe(el), x: Math.round(event.clientX), y: Math.round(event.clientY),
                                 button: event.button, synthetic: event.isTrusted ? undefined : true});
    snapshotSoon(id);
  }

  const SPECIAL_KEYS = new Set(['Enter', 'Escape', 'Tab']);
  const MODIFIERS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'CapsLock']);
  function onKey(event) {
    if (ours(event) || (busy() && !event.isTrusted) || MODIFIERS.has(event.key)) return;
    const chord = event.ctrlKey || event.metaKey || event.altKey;
    if (!chord && !SPECIAL_KEYS.has(event.key)) return;
    const el = originOf(event);
    const secret = el && fieldOf(el) && sensitive(fieldOf(el));
    const combo = [event.ctrlKey && 'Ctrl', event.metaKey && 'Meta', event.altKey && 'Alt', event.shiftKey && 'Shift',
                   secret && chord ? 'chord' : event.key].filter(Boolean).join('+');
    const id = emit('key', {key: combo, target: describe(interactiveOf(el))});
    if (event.key === 'Enter') snapshotSoon(id);
  }

  const dirty = new Map();
  function onInput(event) {
    if (ours(event) || busy()) return;
    const field = fieldOf(originOf(event));
    if (!field || field.localName === 'select' || field.type === 'checkbox' || field.type === 'radio' || field.type === 'file') return;
    const entry = dirty.get(field) || {first: now()};
    entry.last = now();
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flushInput(field), 1500);
    dirty.set(field, entry);
  }

  function flushInput(field) {
    const entry = dirty.get(field);
    if (!entry) return;
    dirty.delete(field);
    clearTimeout(entry.timer);
    const id = emit('input', {target: describe(field), value: valueOf(field), typing_ms: Math.round(entry.last - entry.first)});
    snapshotSoon(id);
  }

  function onChange(event) {
    if (ours(event) || busy()) return;
    const field = fieldOf(originOf(event));
    if (!field) return;
    let kind = null;
    if (field.localName === 'select') kind = 'select';
    else if (field.type === 'checkbox' || field.type === 'radio') kind = 'check';
    else if (field.type === 'file') kind = 'file';
    if (!kind) { flushInput(field); return; }
    const id = emit(kind, {target: describe(field), value: valueOf(field)});
    snapshotSoon(id);
  }

  function onFocusOut(event) {
    const field = fieldOf(originOf(event));
    if (field && dirty.has(field)) flushInput(field);
  }

  function onSubmit(event) {
    if (ours(event) || busy()) return;
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    const id = emit('submit', {target: describe(form || originOf(event)), action: form ? cleanUrl(form.action) : undefined});
    snapshotSoon(id);
  }

  function onPaste(event) {
    if (ours(event) || busy()) return;
    const text = event.clipboardData ? event.clipboardData.getData('text') : '';
    emit('paste', {target: describe(interactiveOf(originOf(event))), length: text.length});
  }

  function onDrag(event) {
    if (ours(event) || busy()) return;
    const data = {target: describe(interactiveOf(originOf(event)))};
    if (event.type === 'drop') data.files = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files.length : 0;
    const id = emit(event.type === 'drop' ? 'drop' : 'drag', data);
    if (event.type === 'drop') snapshotSoon(id);
  }

  function checkUrl() {
    if (location.href === self.lastHref) return;
    const from = self.lastHref;
    self.lastHref = location.href;
    const id = emit('navigate', {url: cleanUrl(location.href), from: cleanUrl(from), title: document.title, frame: 'top',
                                 by: busy() ? 'tutor' : undefined});
    snapshotSoon(id);
  }

  const seenNotices = new WeakSet();
  let added = [];
  let noticeTimer = null;
  function onMutations(records) {
    const tutor = busy();
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) added.push({node, tutor});
    if (!noticeTimer) noticeTimer = setTimeout(scanNotices, 300);
  }

  function scanNotices() {
    noticeTimer = null;
    const batch = added.splice(0, 400);
    added = [];
    for (const {node, tutor} of batch) {
      if (!node.isConnected || node.id === HOST_ID) continue;
      const found = node.matches(NOTICES) ? [node] : [];
      found.push(...Array.from(node.querySelectorAll(NOTICES)).slice(0, 4));
      for (const el of found) {
        if (seenNotices.has(el) || !inView(el)) continue;
        seenNotices.add(el);
        const toast = !el.matches(DIALOG);
        const id = emit(toast ? 'toast' : 'dialog', {title: toast ? undefined : dialogTitle(el), text: collapse(el.innerText, 240),
                                                    role: el.getAttribute('role') || el.localName, by: tutor ? 'tutor' : undefined});
        if (!toast) snapshotSoon(id);
      }
    }
  }

  // <dialog>.showModal() adds nothing to the DOM: watch the open attribute too.
  function onDialogToggle(records) {
    const tutor = busy();
    for (const record of records) {
      if (record.type === 'attributes' && record.target.localName === 'dialog' && record.target.open) added.push({node: record.target, tutor});
    }
    if (added.length && !noticeTimer) noticeTimer = setTimeout(scanNotices, 300);
  }

  const LISTENERS = [
    ['click', onClick], ['dblclick', onClick], ['contextmenu', onClick],
    ['keydown', onKey], ['input', onInput], ['change', onChange], ['focusout', onFocusOut], ['submit', onSubmit],
    ['paste', onPaste], ['dragstart', onDrag], ['drop', onDrag],
  ];

  function install() {
    for (const [type, fn] of LISTENERS) window.addEventListener(type, fn, true);
    window.addEventListener('popstate', checkUrl);
    window.addEventListener('hashchange', checkUrl);
    window.addEventListener('pagehide', onPageHide);
    self.observer = new MutationObserver((records) => { onMutations(records); onDialogToggle(records); });
    self.observer.observe(document.documentElement, {childList: true, subtree: true, attributes: true, attributeFilter: ['open']});
    self.timers.push(setInterval(checkUrl, 500));
  }

  /** The page is going away. What the learner just did goes now (a click on
   *  a link is the last thing before the load); an action whose click caused
   *  the load has done its job. Actions not run yet stay with the service
   *  worker and run on the next page. */
  function onPageHide() {
    if (!self.alive) return;
    for (const field of [...dirty.keys()]) flushInput(field);
    clearTimeout(self.batchTimer);
    flushBatch();
    const current = self.current;
    if (current && current.fired) {
      self.current = null;
      send({type: 'action_done', id: current.a.id, ok: true, detail: 'page_changed'});
    }
  }

  function uninstall() {
    for (const [type, fn] of LISTENERS) window.removeEventListener(type, fn, true);
    window.removeEventListener('popstate', checkUrl);
    window.removeEventListener('hashchange', checkUrl);
    window.removeEventListener('pagehide', onPageHide);
    if (self.observer) self.observer.disconnect();
    self.observer = null;
    for (const timer of self.timers) clearInterval(timer);
    self.timers = [];
  }

  // ------------------------------------------------------------------ overlay

  const overlay = {host: null, root: null};
  const CSS_TEXT = `
    * { box-sizing: border-box; font-family: ${B.FONT}; ${B.LIGATURES} -webkit-font-smoothing: antialiased; }
    [hidden] { display: none !important; }
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
      background: ${C.teal}; color: ${C.chalk}; font-size: 12.5px; font-weight: 600; letter-spacing: .01em; padding: 5px 12px 5px 9px;
      border: 1px solid rgba(185,206,196,.35); border-radius: 4px 14px 14px 14px; box-shadow: 0 6px 16px rgba(20,35,33,.35); }
    .ghost .bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; }
    .ghost .bars i { width: 3px; height: 4px; border-radius: 2px; background: ${C.mist}; opacity: .8; }
    .ghost.talking .bars i { animation: eq 700ms ease-in-out infinite; opacity: 1; }
    .ghost.talking .bars i:nth-child(2) { animation-delay: 120ms; }
    .ghost.talking .bars i:nth-child(3) { animation-delay: 240ms; }
    @keyframes eq { 0%, 100% { height: 3px; } 50% { height: 12px; } }
    .ghost.flipx .tag { left: auto; right: 12px; border-radius: 14px 4px 14px 14px; }
    .ghost.flipy .tag { top: auto; bottom: 10px; }
    .ripple { position: fixed; width: 54px; height: 54px; border-radius: 50%; border: 4px solid ${C.teal}; pointer-events: none; z-index: 8;
      transform: translate(-50%, -50%) scale(.3); opacity: 0; }
    .ripple.go { animation: ripple 650ms ease-out; }
    @keyframes ripple { 0% { transform: translate(-50%,-50%) scale(.3); opacity: 1; } 100% { transform: translate(-50%,-50%) scale(1.8); opacity: 0; } }
    .spot { position: fixed; border-radius: 12px; border: 3px solid ${C.teal};
      box-shadow: 0 0 0 9999px rgba(20, 35, 33, .32), 0 0 0 6px rgba(185,206,196,.45), 0 0 26px rgba(36,91,80,.55);
      pointer-events: none; z-index: 2; opacity: 0; transition: all 350ms ease; }
    .spot.on { opacity: 1; }

    .panel { position: fixed; right: 18px; bottom: 18px; width: 380px; z-index: 7; pointer-events: auto; color: ${C.estuary};
      ${B.SURFACE} border-radius: 22px; overflow: hidden; font-size: 13px; }
    .panel.min .body { display: none; }
    .head { display: flex; align-items: center; gap: 8px; padding: 9px 10px 9px 12px; ${B.SURFACE_DARK} color: ${C.chalk}; }
    .brand { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; white-space: nowrap; }
    .brand .mark { flex: none; display: grid; place-items: center; min-width: 28px; height: 28px; padding: 0 6px; border-radius: 999px;
      background: ${C.teal}; color: ${C.chalk}; font-size: 12.5px; font-weight: 700; box-shadow: inset 0 0 0 1px rgba(185,206,196,.35); }
    .head .live { flex: none; display: inline-flex; align-items: center; gap: 7px; max-width: 180px; padding: 4px 6px 4px 10px; border-radius: 999px;
      border: 1px solid rgba(69,214,154,.45); background: rgba(69,214,154,.14); color: ${C.ledText}; font-size: 11.5px; font-weight: 600; cursor: pointer; }
    .head .live:hover { background: rgba(69,214,154,.22); color: #fff; }
    .head .live.warn { border-color: rgba(183,121,31,.6); background: rgba(183,121,31,.18); color: #F5DDB0; }
    .head .live.off { border-color: rgba(185,206,196,.25); background: rgba(185,206,196,.08); color: ${C.mist}; }
    .head .live:disabled { cursor: default; }
    .state { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: ${C.mist}; opacity: .6; }
    .dot.listening, .dot.speaking, .dot.thinking, .dot.watching, .dot.waiting { opacity: 1; background: ${C.led};
      box-shadow: 0 0 0 3px rgba(69,214,154,.22), 0 0 10px 2px rgba(69,214,154,.85); }
    .dot.listening { animation: breathe 2.4s ease-in-out infinite; }
    .dot.speaking { animation: breathe 900ms ease-in-out infinite; }
    .dot.thinking { animation: pulse 1.4s infinite; }
    .dot.waiting { animation: breathe 3.2s ease-in-out infinite; }
    .dot.paused { opacity: 1; background: ${C.amber}; box-shadow: 0 0 6px rgba(183,121,31,.7); }
    .dot.reconnecting { opacity: 1; background: ${C.amber}; box-shadow: 0 0 8px rgba(183,121,31,.8); animation: pulse 1s infinite; }
    .dot.ended { opacity: .5; box-shadow: none; }
    @keyframes pulse { 50% { opacity: .35; } }
    @keyframes breathe { 50% { box-shadow: 0 0 0 5px rgba(69,214,154,.10), 0 0 16px 4px rgba(69,214,154,.55); } }
    .mic { flex: none; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; font-size: 13px; line-height: 1;
      background: rgba(243,245,241,.10); color: ${C.mist}; --lvl: 0; transition: box-shadow 90ms linear, background 90ms linear; }
    .mic.on { background: rgba(69,214,154,.22); color: ${C.led}; box-shadow: 0 0 0 calc(var(--lvl) * 6px) rgba(69,214,154,.28); }
    .mic.bad { background: rgba(168,50,31,.35); color: #F6B7AA; }
    .head > button:not(.live) { flex: none; display: grid; place-items: center; width: 28px; height: 28px; padding: 0; background: transparent; border: 0;
      border-radius: 50%; color: ${C.mist}; cursor: pointer; font-size: 15px; line-height: 1; }
    .head > button:not(.live):hover { background: rgba(243,245,241,.12); color: ${C.chalk}; }
    .head button[data-a="text"]:not(.on) { opacity: .45; }
    .head button:focus-visible, .btn:focus-visible, .panel .note button:focus-visible { outline: 2px solid ${C.led}; outline-offset: 2px; }
    .body { padding: 12px 16px 14px; }
    .lesson { font-size: 14px; font-weight: 600; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .phase { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: ${C.teal}; font-weight: 600; margin: 3px 0 8px; min-height: 13px; }
    .cap { font-size: 13.5px; line-height: 1.55; color: ${C.estuary}; min-height: 22px; max-height: 110px; overflow: auto; }
    .cap.learner { font-size: 12px; color: ${C.muted}; min-height: 0; margin-top: 8px; padding-top: 8px; border-top: 1px solid ${C.hair}; max-height: 56px; }
    .panel .note { font-size: 12px; line-height: 1.45; color: ${C.amberInk}; background: ${C.amberTint}; border: 1px solid rgba(183,121,31,.28);
      border-radius: 12px; padding: 8px 10px; margin-top: 10px; }
    .panel .note.err { color: ${C.danger}; background: ${C.dangerTint}; border-color: rgba(168,50,31,.25); }
    .panel .note button { margin-left: 6px; font: inherit; font-weight: 600; border: 0; background: ${C.teal}; color: ${C.chalk};
      border-radius: 999px; padding: 3px 10px; cursor: pointer; }
    .row { display: flex; gap: 6px; margin-top: 14px; }
    .btn { flex: 1; min-height: 34px; padding: 7px 8px; border-radius: 999px; border: 0; cursor: pointer; font-size: 12px; font-weight: 600;
      background: rgba(36,91,80,.10); color: ${C.teal}; white-space: nowrap; transition: background 120ms ease; }
    .btn:hover { background: rgba(36,91,80,.17); }
    .btn.primary { background: ${C.teal}; color: ${C.chalk}; flex: 1.6; box-shadow: 0 1px 2px rgba(20,35,33,.25), 0 4px 10px -4px rgba(36,91,80,.6); }
    .btn.primary:hover { background: ${C.tealDeep}; }
    .btn.stop { background: transparent; box-shadow: inset 0 0 0 1px rgba(168,50,31,.35); color: ${C.danger}; }
    .btn.stop:hover { background: ${C.dangerTint}; }
    .btn:disabled { opacity: .5; cursor: default; }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none !important; } }
  `;

  function ensureOverlay() {
    if (overlay.host && overlay.host.isConnected) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('popover', 'manual');
    const style = {all: 'initial', display: 'block', position: 'fixed', inset: '0', width: '100vw', height: '100vh', 'max-width': 'none',
                   'max-height': 'none', margin: '0', padding: '0', border: '0', background: 'transparent', overflow: 'visible',
                   'pointer-events': 'none', 'z-index': '2147483647', visibility: 'visible'};
    for (const [key, value] of Object.entries(style)) host.style.setProperty(key, value, 'important');
    const root = host.attachShadow({mode: 'open'});
    // Built from elements, never parsed from a string: pages with Trusted
    // Types refuse innerHTML even from an extension's content script.
    const h = ov.h;
    const sheet = h('style');
    sheet.textContent = CSS_TEXT;
    const btn = (a, label, cls = 'btn', id = null) => h('button', {class: cls, 'data-a': a, id, text: label});
    root.append(sheet,
      h('div', {class: 'ghost', id: 'ghost'}, h('div', {class: 'body'}, h('div', {class: 'halo'}),
        h('svg:svg', {viewBox: '0 0 46 52'}, h('svg:path', {d: B.CURSOR_PATH,
                                                            fill: C.teal, stroke: C.chalk, 'stroke-width': '3', 'stroke-linejoin': 'round'})),
        h('div', {class: 'tag'}, h('span', {class: 'bars'}, h('i'), h('i'), h('i')), h('span', {text: B.NAME})))),
      h('div', {class: 'ripple', id: 'ripple'}),
      h('div', {class: 'spot', id: 'spot'}),
      h('div', {class: 'panel', id: 'panel'},
        h('div', {class: 'head'},
          h('span', {class: 'brand'}, h('span', {class: 'mark', text: '42'}), h('span', {text: B.NAME.replace(/^42\s*/, '')})),
          h('button', {class: 'live', 'data-a': 'pause', id: 'live'}, h('span', {class: 'dot', id: 'dot'}), h('span', {class: 'state', id: 'state'}),
            h('span', {class: 'mic', id: 'mic', title: 'Your microphone', text: ICONS.mic})),
          h('button', {'data-a': 'text', id: 'text', title: 'Text on screen: on or off', 'aria-label': 'Text on screen', text: ICONS.text}),
          h('button', {'data-a': 'min', title: 'Hide or show', 'aria-label': 'Hide or show', text: ICONS.minus})),
        h('div', {class: 'body'},
          h('div', {class: 'lesson', id: 'title', hidden: true}),
          h('div', {class: 'phase', id: 'phase'}),
          h('div', {class: 'cap', id: 'capTutor'}),
          h('div', {class: 'cap learner', id: 'capLearner', hidden: true}),
          h('div', {class: 'note', id: 'note', hidden: true}),
          h('div', {class: 'row'}, btn('pause', 'Pause', 'btn', 'pause'), btn('next', 'Next'), btn('check', 'Check my work', 'btn primary'),
            btn('stop', 'Stop', 'btn stop')))));
    root.addEventListener('click', onOverlayClick);
    (document.documentElement || document.body).appendChild(host);
    overlay.host = host;
    overlay.root = root;
    ov.mount(root, {
      resolve,
      send: (msg) => {
        // Starting a lesson: the tutor may need to see the screen when asked
        // something; the extension asks once for the access that takes.
        if (msg && msg.type === 'overlay_event' && msg.event === 'click' && /^start_/.test(msg.button || '')) {
          chrome.runtime.sendMessage({type: 'tutor_need_eyes'}).catch(() => {});
        }
        send(msg);
      },
      quietMs: () => (ui.speaking ? 0 : Date.now() - self.quietSince),
      avoid: () => [$('panel') && $('panel').getBoundingClientRect()],
    });
    raise();
  }

  const $ = (id) => overlay.root && overlay.root.getElementById(id);

  // The top layer keeps us above the app's own dialogs; one opened later is
  // re-stacked under us.
  const seenLayers = new WeakSet();
  function raise() {
    const host = overlay.host;
    if (!host) return;
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
    } catch {}
  }

  function onOverlayClick(event) {
    const button = event.target.closest && event.target.closest('button');
    if (!button) return;
    const action = button.dataset.a;
    if (action === 'min') { ui.min = !ui.min; render(); return; }
    if (action === 'text') { ov.setEnabled(!ov.enabled()); render(); return; }
    if (action === 'setup') { chrome.runtime.sendMessage({type: 'tutor_open_setup'}).catch(() => {}); return; }
    if (action === 'pause') {
      ui.paused = !ui.paused;
      send({type: 'control', action: ui.paused ? 'pause' : 'resume'});
    } else if (['next', 'check', 'stop'].includes(action)) {
      send({type: 'control', action});
      if (action === 'stop') ui.ended = 'Stopped';
    }
    render();
  }

  function statusOf() {
    if (ui.ended) return ['ended', 'Ended'];
    if (ui.link === 'closed') return ['ended', 'Disconnected'];
    if (ui.link === 'connecting') return ['reconnecting', 'Connecting…'];
    if (ui.link === 'reconnecting') return ['reconnecting', 'Reconnecting…'];
    if (ui.paused) return ['paused', 'Paused'];
    // Who has the floor, from the server: its words, in the lesson's language.
    const DOT = {listening: 'listening', thinking: 'thinking', speaking: 'speaking', watching: 'watching',
                 waiting: 'waiting', paused: 'paused', reconnecting: 'reconnecting', restoring: 'thinking',
                 looking: 'thinking'};
    if (ui.floor && DOT[ui.floor]) return [DOT[ui.floor], ui.floorText || ui.floor];
    if (ui.speaking) return ['speaking', 'Speaking'];
    return ['listening', 'Listening'];
  }

  function render() {
    if (!self.alive) return;
    ensureOverlay();
    raise();
    const [cls, label] = statusOf();
    $('dot').className = `dot ${cls}`;
    $('state').textContent = label;
    const live = $('live');
    live.className = `live${cls === 'ended' ? ' off' : cls === 'paused' || cls === 'reconnecting' ? ' warn' : ''}`;
    live.disabled = Boolean(ui.ended) || ui.link === 'closed';
    live.title = ui.paused ? 'Resume the lesson' : 'Pause the lesson';
    live.setAttribute('aria-label', `${label}. ${live.title}`);
    $('title').textContent = ui.title || '';
    $('title').hidden = !ui.title;
    $('panel').classList.toggle('min', ui.min);
    const phase = ui.phase ? String(ui.phase).charAt(0).toUpperCase() + String(ui.phase).slice(1) : '';
    $('text').setAttribute('aria-pressed', String(ov.enabled()));
    $('text').classList.toggle('on', ov.enabled());
    const mode = ui.phase === 'ready' ? '' : ui.mode === 'follow' ? 'Follow along' : ui.mode === 'demo' ? 'Watch' : '';
    $('phase').textContent = [phase, ui.beat !== null && ui.of ? `${ui.beat} of ${ui.of}` : '', phase && phase !== 'Do' && phase !== 'Done' ? mode : '']
      .filter(Boolean).join(' · ');
    $('capTutor').textContent = ui.tutor;
    $('capLearner').hidden = !ui.learner;
    $('capLearner').textContent = ui.learner ? `You: ${ui.learner}` : '';
    const note = $('note');
    note.className = 'note';
    note.hidden = false;
    if (ui.mic === 'needs_mic') {
      note.replaceChildren('The tutor cannot hear you: allow the microphone for Frty2.', ov.h('button', {'data-a': 'setup', text: 'Allow'}));
    } else if (ui.error) {
      note.className = 'note err'; note.textContent = ui.error;
    } else if (ui.ended && ui.ended !== 'Stopped') {
      note.textContent = ui.ended;
    } else if (ui.link === 'reconnecting' || ui.link === 'closed') {
      note.textContent = ui.linkDetail || 'The connection to the tutor dropped.';
    } else if (ui.mic === 'error') {
      note.textContent = `Microphone: ${ui.micDetail || 'not available'}`;
    } else if (ui.mic === 'muted') {
      note.textContent = 'The tutor hears nothing from your microphone: is it muted?';
    } else if (ui.note) {
      note.textContent = ui.note;
    } else {
      note.hidden = true;
    }
    $('pause').textContent = ui.paused ? 'Resume' : 'Pause';
    for (const button of overlay.root.querySelectorAll('.row button')) button.disabled = Boolean(ui.ended) || ui.link === 'closed';
    const mic = $('mic');
    const hearing = ui.mic === 'on' && !ui.paused;
    const bad = ui.mic === 'needs_mic' || ui.mic === 'error';
    mic.className = `mic${hearing ? ' on' : bad ? ' bad' : ''}`;
    mic.textContent = hearing || !bad ? ICONS.mic : ICONS.micOff;
    mic.style.setProperty('--lvl', hearing ? Math.min(1, ui.level).toFixed(2) : '0');
    mic.title = hearing ? 'The tutor hears you' : ui.paused ? 'Paused: the tutor does not hear you'
      : ui.mic === 'muted' ? 'Your microphone sends no sound' : 'Microphone off';
    const ghostEl = $('ghost');
    if (ghostEl) ghostEl.classList.toggle('talking', ui.speaking && !ui.paused);
  }

  // ------------------------------------------------------------------ the cursor (as ghost.js)

  const ghost = {x: null, y: null, shown: false, anim: null};

  function place(x, y) {
    const el = $('ghost');
    ghost.x = x; ghost.y = y;
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.classList.toggle('flipx', x > innerWidth - 190);
    el.classList.toggle('flipy', y > innerHeight - 90);
    try { sessionStorage.setItem(CURSOR_KEY, JSON.stringify({x, y})); } catch {}
  }

  function panelCorner() {
    const panel = $('panel');
    const r = panel ? panel.getBoundingClientRect() : {left: innerWidth - 360, top: innerHeight - 220};
    return {x: clamp(r.left + 30, 20, innerWidth - 60), y: clamp(r.top - 12, 20, innerHeight - 60)};
  }

  function showCursor() {
    ensureOverlay();
    raise();
    if (ghost.x === null) {
      let start = null;
      try { start = JSON.parse(sessionStorage.getItem(CURSOR_KEY) || 'null'); } catch {}
      if (!start || !Number.isFinite(start.x)) start = panelCorner();
      place(clamp(start.x, 8, innerWidth - 60), clamp(start.y, 8, innerHeight - 60));
    }
    $('ghost').classList.add('on');
    ghost.shown = true;
  }

  async function parkCursor() {
    if (!ghost.shown) return;
    const corner = panelCorner();
    await glideTo(corner.x, corner.y);
    $('ghost').classList.remove('on');
    ghost.shown = false;
    spotlight(null);
  }

  /** The learner took the floor: a glide in progress ends where it is. */
  function stopGlide() {
    if (!ghost.anim) return;
    try { ghost.anim.commitStyles(); } catch {}
    ghost.anim.cancel();
  }

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
      const k = i / 18, u = 1 - k;
      frames.push({transform: `translate(${u * u * from.x + 2 * u * k * cx + k * k * x}px, ${u * u * from.y + 2 * u * k * cy + k * k * y}px)`});
    }
    if (ghost.anim) ghost.anim.cancel();
    place(x, y);
    ghost.anim = $('ghost').animate(frames, {duration, easing: 'cubic-bezier(.35,.05,.2,1)'});
    await ghost.anim.finished.catch(() => {});
  }

  function pointOf(el) {
    const r = el.getBoundingClientRect();
    return {x: r.left + Math.min(r.width / 2, 110), y: r.top + r.height / 2, rect: r};
  }

  async function moveCursorTo(el) {
    const before = el.getBoundingClientRect();
    if (before.top < 60 || before.bottom > innerHeight - 40) {
      el.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'smooth'});
      await wait(420);
    }
    const {x, y} = pointOf(el);
    await glideTo(x, y);
  }

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
    ghost.anim = $('ghost').animate(frames, {duration: 1300, easing: 'ease-in-out'});
    await ghost.anim.finished.catch(() => {});
    const {x, y} = pointOf(el);
    await glideTo(x, y);
  }

  async function press(el) {
    const g = $('ghost');
    g.classList.add('press');
    const {x, y} = pointOf(el);
    const ripple = $('ripple');
    ripple.style.left = `${x}px`; ripple.style.top = `${y}px`;
    ripple.classList.remove('go'); void ripple.offsetWidth; ripple.classList.add('go');
    await wait(160);
    g.classList.remove('press');
  }

  let spotTarget = null;
  let spotTimer = null;
  function spotlight(el) {
    clearTimeout(spotTimer);
    spotTarget = el;
    const spot = $('spot');
    if (!spot) return;
    if (!el) { spot.classList.remove('on'); return; }
    const r = el.getBoundingClientRect();
    spot.style.left = `${r.left - 6}px`; spot.style.top = `${r.top - 6}px`;
    spot.style.width = `${r.width + 12}px`; spot.style.height = `${r.height + 12}px`;
    spot.classList.add('on');
  }
  function spotLater(ms) { const el = spotTarget; spotTimer = setTimeout(() => { if (spotTarget === el) spotlight(null); }, ms); }
  function trackSpot() {
    if (!self.alive) return;
    const spot = $('spot');
    if (spotTarget && spot && spot.classList.contains('on')) {
      if (!spotTarget.isConnected) spotlight(null);
      else {
        const r = spotTarget.getBoundingClientRect();
        spot.style.left = `${r.left - 6}px`; spot.style.top = `${r.top - 6}px`;
      }
    }
    requestAnimationFrame(trackSpot);
  }

  // ------------------------------------------------------------------ lifecycle

  async function revive() {
    if (!self.alive) {
      self.alive = true;
      chrome.runtime.onMessage.addListener(onRuntime);
      install();
      trackSpot();
    }
    let reply = null;
    try { reply = await chrome.runtime.sendMessage({type: 'tutor_hello'}); } catch {}
    if (!reply || !reply.active) { teardown(); return; }
    for (const msg of reply.cache || []) onMsg(msg);
    for (const {msg, due, heard} of reply.actions || []) onAction(msg, due, heard);
    ui.paused = Boolean(reply.paused);
    render();
    for (const {msg, due} of reply.overlays || []) ov.handle(msg, {due, replay: true});
    showCursor();
    if (self.loaded) return;         // injected again into the same document
    self.loaded = true;
    const id = emit('load', {url: cleanUrl(location.href), title: document.title, referrer: cleanUrl(document.referrer), frame: 'top',
                             viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, by: reply.nav_by_tutor ? 'tutor' : undefined});
    snapshotSoon(id);
  }

  function end(reason) {
    cancelWaiting('ended');
    flushBatch();
    if (!ui.ended) ui.ended = reason === 'stopped' ? 'Stopped' : 'The lesson has ended.';
    render();
    setTimeout(teardown, reason === 'stopped' || reason === 'replaced' ? 0 : 3000);
  }

  function teardown() {
    if (!self.alive && !overlay.host) return;
    self.alive = false;
    uninstall();
    for (const entry of waiting.values()) clearInterval(entry.timer);
    waiting.clear();
    clearTimeout(self.batchTimer);
    clearTimeout(self.navTimer);
    try { chrome.runtime.onMessage.removeListener(onRuntime); } catch {}
    if (ov) ov.reset();
    if (overlay.host) { overlay.host.remove(); overlay.host = null; overlay.root = null; }
    delete window.__frty2Tutor;
  }

  revive();
})();
