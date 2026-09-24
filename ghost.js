/**
 * The ghost cursor. Runs on crm.zoho.*.
 *
 * Talk → Show → Do → Verify → Nudge, from the learner's side:
 *   - pairs with a session through the service worker (bridge or code);
 *   - loads the session's script (intro, show, task) and speaks each step
 *     while performing it, with a visible cursor, a spotlight and captions;
 *   - hands over, then stays as a small panel: a question box, a mic, and
 *     "I'm done, check my work";
 *   - polls the session queue for nudges, ask-anything scripts and the
 *     celebration when Zoho's records verify the work.
 *
 * Targets are semantic and resolved at run time (see `resolve`). When one
 * cannot be found the ghost asks the learner to click it once and remembers
 * the element for the session. The screen is never used for grading.
 */

(() => {
  if (window.__frty2Ghost) return;
  window.__frty2Ghost = true;

  const POLL_MS = 3500;
  const RUN_KEY = 'frty2_run';
  const HINT_KEY = 'frty2_hints';

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
    pollTimer: null,
    currentAudio: null,
    picking: null,
    deferred: [],
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

  // ------------------------------------------------------------------ overlay

  const host = document.createElement('div');
  host.id = 'frty2-ghost-host';
  const shadow = host.attachShadow({mode: 'open'});
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; }
      .cursor { position: fixed; left: 0; top: 0; width: 34px; height: 40px; z-index: 5; pointer-events: none;
        transform: translate(-200px, -200px); transition: transform 700ms cubic-bezier(.22,.8,.3,1); opacity: 0; filter: drop-shadow(0 4px 10px rgba(0,0,0,.35)); }
      .cursor.on { opacity: 1; }
      .cursor svg { width: 100%; height: 100%; }
      .ripple { position: fixed; width: 44px; height: 44px; border-radius: 50%; border: 3px solid #ff7a1a; pointer-events: none; z-index: 4;
        transform: translate(-50%, -50%) scale(.3); opacity: 0; }
      .ripple.go { animation: ripple 600ms ease-out; }
      @keyframes ripple { 0% { transform: translate(-50%,-50%) scale(.3); opacity: .9; } 100% { transform: translate(-50%,-50%) scale(1.6); opacity: 0; } }
      .spot { position: fixed; border-radius: 10px; border: 3px solid #ff7a1a; box-shadow: 0 0 0 9999px rgba(15, 18, 30, .38), 0 0 24px rgba(255,122,26,.6);
        pointer-events: none; z-index: 2; opacity: 0; transition: all 350ms ease; }
      .spot.on { opacity: 1; }
      .caption { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); max-width: min(760px, 86vw); z-index: 6; pointer-events: none;
        background: rgba(20, 22, 34, .94); color: #fff; padding: 14px 20px; border-radius: 14px; font-size: 17px; line-height: 1.45;
        box-shadow: 0 10px 30px rgba(0,0,0,.35); opacity: 0; transition: opacity 250ms; border-left: 5px solid #ff7a1a; }
      .caption.on { opacity: 1; }
      .caption .who { display: block; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #ffb06b; margin-bottom: 4px; }
      .panel { position: fixed; right: 18px; bottom: 18px; width: 360px; z-index: 7; pointer-events: auto; background: #fff; color: #1a1c24;
        border-radius: 16px; box-shadow: 0 16px 48px rgba(0,0,0,.28); overflow: hidden; font-size: 14px; }
      .panel.min .body { display: none; }
      .head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; background: linear-gradient(135deg, #1f2937, #111827); color: #fff; }
      .dot { width: 10px; height: 10px; border-radius: 50%; background: #9ca3af; }
      .dot.ok { background: #34d399; box-shadow: 0 0 8px #34d399; }
      .dot.busy { background: #fbbf24; animation: pulse 1s infinite; }
      @keyframes pulse { 50% { opacity: .35; } }
      .head b { flex: 1; font-size: 14px; }
      .head button { background: transparent; border: 0; color: #cbd5e1; cursor: pointer; font-size: 13px; padding: 4px 6px; border-radius: 6px; }
      .head button:hover { background: rgba(255,255,255,.12); color: #fff; }
      .body { padding: 12px 14px 14px; }
      .phase { display: flex; gap: 6px; margin-bottom: 10px; }
      .phase span { flex: 1; text-align: center; font-size: 11px; padding: 5px 0; border-radius: 6px; background: #f1f5f9; color: #64748b; }
      .phase span.now { background: #ff7a1a; color: #fff; font-weight: 600; }
      .phase span.done { background: #d1fae5; color: #065f46; }
      .status { font-size: 13px; color: #475569; margin: 6px 0 10px; min-height: 18px; }
      .task { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 10px; padding: 10px 12px; margin: 8px 0; }
      .task b { display: block; margin-bottom: 4px; }
      .task ol { margin: 0; padding-left: 18px; }
      .task li { margin: 2px 0; }
      .row { display: flex; gap: 8px; margin-top: 8px; }
      .btn { flex: 1; padding: 9px 10px; border-radius: 9px; border: 0; cursor: pointer; font-size: 13px; font-weight: 600; background: #e2e8f0; color: #0f172a; }
      .btn.primary { background: #ff7a1a; color: #fff; }
      .btn.ghost { background: transparent; border: 1px solid #cbd5e1; }
      .btn:disabled { opacity: .5; cursor: default; }
      .ask { display: flex; gap: 6px; margin-top: 10px; }
      .ask input { flex: 1; padding: 9px 10px; border-radius: 9px; border: 1px solid #cbd5e1; font-size: 13px; }
      .ask button { width: 40px; border-radius: 9px; border: 0; background: #1f2937; color: #fff; cursor: pointer; font-size: 16px; }
      .ask button.rec { background: #dc2626; animation: pulse 1s infinite; }
      .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; font-size: 12px; color: #64748b; }
      .foot button { background: transparent; border: 1px solid #cbd5e1; border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 12px; color: #334155; }
      .foot button.on { background: #1f2937; color: #fff; border-color: #1f2937; }
      .cert { background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 10px; padding: 10px 12px; margin-top: 8px; }
      .cert code { font-size: 15px; letter-spacing: .06em; }
      .pill { position: fixed; right: 18px; bottom: 18px; z-index: 7; pointer-events: auto; background: #111827; color: #fff; padding: 10px 14px; border-radius: 999px; font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.3); }
      .confetti { position: fixed; inset: 0; pointer-events: none; z-index: 8; }
      .confetti i { position: absolute; top: -10px; width: 8px; height: 14px; opacity: .9; animation: fall 2.6s linear forwards; }
      @keyframes fall { to { transform: translateY(110vh) rotate(720deg); opacity: 0; } }
    </style>
    <div class="cursor" id="cursor">
      <svg viewBox="0 0 34 40"><path d="M3 2 L3 30 L10 23 L15 36 L21 33 L16 21 L26 21 Z" fill="#ff7a1a" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/></svg>
    </div>
    <div class="ripple" id="ripple"></div>
    <div class="spot" id="spot"></div>
    <div class="caption" id="caption"><span class="who">Frty2 guide</span><span id="captionText"></span></div>
    <div id="panelRoot"></div>
  `;
  (document.documentElement || document.body).appendChild(host);
  const $ = (id) => shadow.getElementById(id);
  const cursorEl = $('cursor'), rippleEl = $('ripple'), spotEl = $('spot'), captionEl = $('caption'), panelRoot = $('panelRoot');

  // ------------------------------------------------------------------ cursor & spotlight

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return {x: r.left + Math.min(r.width / 2, 120), y: r.top + r.height / 2, rect: r};
  }

  async function moveCursorTo(el) {
    el.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'smooth'});
    await wait(350);
    const {x, y} = centerOf(el);
    cursorEl.classList.add('on');
    cursorEl.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
    await wait(720);
  }

  function hideCursor() { cursorEl.classList.remove('on'); }

  function ripple(el) {
    const {x, y} = centerOf(el);
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

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------ voice

  function pick(say) {
    if (!say) return '';
    if (typeof say === 'string') return say;
    return say[state.language] || say.en || say.hi || '';
  }

  async function voiceUrl(text) {
    const key = `${state.language}|${text}`;
    if (state.voiceCache.has(key)) return state.voiceCache.get(key);
    // The API speaks only lines from this session's script or queue, and
    // within a per-session budget, so a token cannot spend the voice credits
    // on anything else.
    const result = await api('POST', '/api/v1/webapps/voice/',
      {session: state.pairing.session_id, text, language: state.language});
    const url = result.ok && result.data ? result.data.url : null;
    state.voiceCache.set(key, url);
    return url;
  }

  function prefetchVoice(steps) {
    for (const step of steps || []) {
      const text = pick(step.say);
      if (text) voiceUrl(text).catch(() => {});
    }
  }

  function stopAudio() {
    if (state.currentAudio) { try { state.currentAudio.pause(); } catch {} state.currentAudio = null; }
  }

  /** Speak (and caption) one line; resolves when the audio ends. */
  async function say(sayObj) {
    const text = pick(sayObj);
    if (!text) return;
    caption(text);
    const readingMs = Math.max(1600, text.length * (state.language === 'hi' ? 70 : 55));
    if (state.muted) { await wait(readingMs); return; }
    const url = await voiceUrl(text).catch(() => null);
    if (!url) { await wait(readingMs); return; }
    stopAudio();
    await new Promise((resolve) => {
      const audio = new Audio(url);
      state.currentAudio = audio;
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      audio.addEventListener('ended', finish);
      audio.addEventListener('error', finish);
      audio.play().catch(finish);
      setTimeout(finish, Math.max(readingMs, 45000));
    });
  }

  // ------------------------------------------------------------------ element resolution

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  function visible(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.closest && el.closest('#frty2-ghost-host')) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function scopeFor(target) {
    if (target.within === 'dialog') {
      const dialogs = Array.from(document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], lyte-modal, .lyte-modal, [class*="modal" i], [class*="popup" i], [class*="dialog" i], [class*="overlay" i]'))
        .filter(visible);
      if (dialogs.length) return dialogs[dialogs.length - 1];
    }
    return document;
  }

  const CLICKABLE = 'button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [role="link"], input[type="button"], input[type="submit"], input[type="checkbox"], label, li, span, div, lyte-button, lyte-checkbox, lyte-menu-item';
  const FIELDS = 'input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="combobox"], [role="textbox"], lyte-input, lyte-dropdown';

  function signature(target) {
    return JSON.stringify(target);
  }

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

  async function resolve(target, {timeoutMs = 0} = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await resolveOnce(target);
      if (found || Date.now() >= deadline) return found;
      await wait(400);
    }
  }

  async function resolveOnce(target) {
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

  /** Ask the learner to click the missing element once; remember it. */
  function learnTarget(target, describe) {
    return new Promise((resolve) => {
      const text = state.language === 'hi'
        ? `मुझे "${describe}" नहीं मिल रहा। कृपया एक बार उस पर click कीजिए, मैं याद रख लूँगा।`
        : `I cannot find "${describe}" on this screen. Please click it once for me and I will remember it.`;
      caption(text);
      voiceUrl(text).then((url) => { if (url && !state.muted) { stopAudio(); const a = new Audio(url); state.currentAudio = a; a.play().catch(() => {}); } });
      setStatus(state.language === 'hi' ? 'आपके click का इंतज़ार…' : 'Waiting for your click…', 'busy');
      const handler = (event) => {
        const el = event.target instanceof Element ? event.target : null;
        if (!el || el.closest('#frty2-ghost-host')) return;
        document.removeEventListener('click', handler, true);
        const path = cssPath(el);
        state.hints[signature(target)] = path;
        try { chrome.storage.local.set({[HINT_KEY]: state.hints}); } catch {}
        postEvent('target_learned', {target, selector: path});
        state.picking = null;
        resolve({el, clicked: true});
      };
      state.picking = handler;
      document.addEventListener('click', handler, true);
    });
  }

  // ------------------------------------------------------------------ actions

  function fire(el, type, init) {
    el.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, view: window, ...init}));
  }

  async function doClick(el) {
    await moveCursorTo(el);
    spotlight(el);
    ripple(el);
    const {x, y} = centerOf(el);
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
    ripple(field);
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
      await wait(45);
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
      await moveCursorTo(el); spotlight(el);
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
        .filter((o) => visible(o) && o.childElementCount <= 3 && !o.closest('#frty2-ghost-host'));
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

  /** Run one step: speak while acting; navigation speaks first, then leaves. */
  async function runStep(step, run) {
    const action = step.action || {type: 'say'};
    postEvent('step_reached', {step_id: step.id, script: run.script.id});
    switch (action.type) {
      case 'navigate': {
        await say(step.say);
        run.index += 1;
        saveRun(run);
        const url = fixUrl(action.url);
        if (location.href.split('#')[0] === url.split('#')[0]) { run.index -= 1; return 'stay'; }
        location.href = url;
        return 'navigating';
      }
      case 'say': case 'pause': {
        const speaking = say(step.say);
        if (action.type === 'pause') await wait(Number(action.ms) || 800);
        await speaking;
        return 'ok';
      }
      case 'handover': {
        hideCursor(); spotlight(null);
        await say(step.say);
        return 'handover';
      }
      case 'wait_for': {
        const speaking = say(step.say);
        await resolve(action.target, {timeoutMs: 8000});
        await speaking;
        return 'ok';
      }
      default: {
        const speaking = say(step.say);
        let el = await resolve(action.target, {timeoutMs: 6000});
        let learnedClick = false;
        if (!el) {
          postEvent('target_missing', {step_id: step.id, target: action.target});
          await speaking;
          const learned = await learnTarget(action.target, describe(action.target));
          el = learned.el; learnedClick = learned.clicked;
          setStatus('', 'ok');
        }
        if (action.type === 'click') { if (!learnedClick) await doClick(el); }
        else if (action.type === 'type') await doType(el, action.value);
        else if (action.type === 'select') await doSelect(el, action.value);
        else if (action.type === 'highlight' || action.type === 'scroll') { await moveCursorTo(el); spotlight(el); await speaking; await wait(600); spotlight(null); }
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
    prefetchVoice(script.steps);
    setStatus(state.language === 'hi' ? 'दिखा रहा हूँ…' : 'Showing you…', 'busy');
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
      hideCursor(); spotlight(null);
      await postEvent('script_finished', {script: script.id, kind});
      if (kind === 'show') {
        await postEvent('handover', {script: script.id});
      }
      setStatus('', 'ok');
    } catch (error) {
      console.error('[frty2] script failed', error);
      postEvent('error', {message: String(error && error.message || error), script: script.id});
      caption(state.language === 'hi' ? 'कुछ गड़बड़ हो गई; आप यहाँ से खुद आगे बढ़िए।' : 'Something went wrong on my side; carry on from here yourself.');
      clearRun(); hideCursor(); spotlight(null);
    } finally {
      state.running = false;
      setTimeout(() => caption(''), 4000);
      renderPanel();
    }
  }

  // ------------------------------------------------------------------ the lesson

  async function beginLesson() {
    const intro = state.script.intro || {};
    await postEvent('intro_started');
    renderPanel();
    state.running = true;
    try {
      for (const line of intro.say || []) { if (state.cancel) break; await say(line); }
      await say(intro.ready_prompt);
    } finally { state.running = false; }
    setStatus(state.language === 'hi' ? 'तैयार हों तो Start दबाइए।' : 'Press Start when ready.', 'ok');
    state.awaitingReady = true;
    renderPanel();
  }

  async function startShow() {
    state.awaitingReady = false;
    await postEvent('show_started');
    await runScript(state.script.show, 'show');
  }

  async function ask(text) {
    text = (text || '').trim();
    if (!text) return;
    if (state.running) { state.cancel = true; stopAudio(); await wait(600); }
    setStatus(state.language === 'hi' ? 'सोच रहा हूँ…' : 'Thinking…', 'busy');
    const result = await api('POST', sessionPath('ask/'), {text, language: state.language, source: 'extension'});
    if (!result.ok) { setStatus('Could not ask right now.', 'ok'); return; }
    const answer = result.data;
    if (answer.language && answer.language !== state.language) { /* keep the learner's toggle */ }
    if (answer.script && answer.script.steps && answer.script.steps.length) {
      await runScript(answer.script, answer.kind === 'generated' ? 'generated' : 'howto');
    } else if (answer.answer) {
      state.running = true;
      try { await say({[state.language]: answer.answer, en: answer.answer}); } finally { state.running = false; }
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
        state.running = true;
        try { await say(payload.say); } finally { state.running = false; }
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
    state.running = true;
    say(payload.say).finally(() => { state.running = false; setTimeout(() => caption(''), 6000); });
  }

  function confetti() {
    const box = document.createElement('div'); box.className = 'confetti';
    const colors = ['#ff7a1a', '#34d399', '#60a5fa', '#fbbf24', '#f472b6'];
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
    setStatus(state.language === 'hi' ? 'Zoho के records देख रहा हूँ…' : 'Reading Zoho\'s records…', 'busy');
    const result = await api('POST', sessionPath('check/'), {});
    if (result.ok && result.data) {
      state.session = result.data.session;
      const ev = result.data.evidence;
      if (ev.status !== 'verified') {
        const text = ev.detail || '';
        caption(text);
        setTimeout(() => caption(''), 9000);
      }
      setStatus(ev.status === 'verified' ? '' : (state.language === 'hi' ? 'अभी पूरा नहीं हुआ। ऊपर पढ़िए।' : 'Not there yet. See above.'), 'ok');
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
    renderPanel();
  }

  // ------------------------------------------------------------------ mic

  let recognizer = null;
  async function listen() {
    const button = shadow.getElementById('mic');
    if (recognizer) { recognizer.stop(); return; }
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (Speech) {
      recognizer = new Speech();
      recognizer.lang = state.language === 'hi' ? 'hi-IN' : 'en-IN';
      recognizer.interimResults = false; recognizer.maxAlternatives = 1;
      button && button.classList.add('rec');
      recognizer.onresult = (event) => { const text = event.results[0][0].transcript; ask(text); };
      recognizer.onerror = () => setStatus(state.language === 'hi' ? 'सुन नहीं पाया।' : 'Could not hear that.', 'ok');
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
    panelRoot.innerHTML = '';
    if (!state.pairing) {
      panelRoot.innerHTML = `<div class="pill">Frty2 guide · not connected. Press “Connect the guide” on your lesson page.</div>`;
      return;
    }
    if (!state.session || !state.script) {
      panelRoot.innerHTML = `<div class="pill">Frty2 guide · loading your lesson…</div>`;
      return;
    }
    const s = state.session;
    const idx = PHASE_INDEX[s.phase] ?? -1;
    const phase = PHASES.map(([key, label], i) => `<span class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${label}</span>`).join('');
    const task = state.script.task || {};
    const steps = (task.instructions && task.instructions[state.language]) || [];
    const hi = state.language === 'hi';
    let body = '';
    if (s.phase === 'created' || (s.phase === 'intro' && !state.awaitingReady && !state.running)) {
      body += `<div class="row"><button class="btn primary" id="begin">${hi ? 'Lesson शुरू करें' : 'Begin the lesson'}</button></div>`;
    }
    if (state.awaitingReady) {
      body += `<div class="row"><button class="btn primary" id="start">${hi ? 'Start' : 'Start'}</button></div>`;
    }
    if (s.phase === 'showing' && !state.running) {
      body += `<div class="row"><button class="btn primary" id="replay">${hi ? 'Demo फिर से' : 'Replay the demo'}</button><button class="btn" id="skip">${hi ? 'मैं कर लूँगा' : 'Let me do it'}</button></div>`;
    }
    if (s.phase === 'doing') {
      body += `<div class="task"><b>${hi ? 'आपका काम' : 'Your task'}: ${(task.title && task.title[state.language]) || ''}</b><ol>${steps.map((t) => `<li>${t}</li>`).join('')}</ol></div>`;
      const v = s.verification || {};
      if (v.status && v.status !== 'verified') body += `<div class="status">${v.detail || ''}</div>`;
      body += `<div class="row"><button class="btn primary" id="done">${hi ? 'हो गया, check करो' : 'I’m done, check my work'}</button><button class="btn ghost" id="open">${hi ? 'Ramesh खोलो' : 'Open Ramesh'}</button></div>`;
    }
    if (s.phase === 'verified' || s.phase === 'certified') {
      const code = s.certificate && s.certificate.code;
      body += `<div class="cert"><b>${hi ? 'Verified: Zoho के records इसकी पुष्टि करते हैं।' : 'Verified from Zoho’s own records.'}</b><br>${code ? `Certificate <code>${code}</code>` : ''}${state.pairing.learner_base && code ? `<br><a href="${state.pairing.learner_base}/certificates/${code}" target="_blank">${hi ? 'Certificate देखें' : 'View certificate'}</a>` : ''}</div>`;
    }
    if (s.rehearsal) body += `<div class="status">${hi ? 'Rehearsal mode: pool Zoho से जुड़ा नहीं है, इसलिए grading नहीं होगी।' : 'Rehearsal mode: the pool is not connected to Zoho, so nothing is graded.'}</div>`;
    panelRoot.innerHTML = `
      <div class="panel" id="panel">
        <div class="head"><span class="dot" id="dot"></span><b>Frty2 guide · ${state.script.records && state.script.records.task_lead ? 'Sharma Two-Wheelers' : 'Zoho CRM'}</b>
          <button id="min" title="Minimise">—</button></div>
        <div class="body">
          <div class="phase">${phase}</div>
          <div class="status" id="status"></div>
          ${body}
          <div class="ask"><input id="q" placeholder="${hi ? 'कुछ भी पूछिए: lead ko deal mein kaise convert karte hain?' : 'Ask anything: how do I convert a lead?'}"><button id="mic" title="Speak">🎤</button><button id="send" title="Ask">➤</button></div>
          <div class="foot"><span>${hi ? 'भाषा' : 'Language'}: <button id="hi" class="${hi ? 'on' : ''}">हिंदी</button> <button id="en" class="${hi ? '' : 'on'}">EN</button></span>
            <span><button id="mute" class="${state.muted ? 'on' : ''}">${state.muted ? 'Unmute' : 'Mute'}</button> <button id="stop">${hi ? 'रोकें' : 'Stop'}</button></span></div>
        </div>
      </div>`;
    const on = (id, fn) => { const el = shadow.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('begin', beginLesson);
    on('start', startShow);
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
    on('stop', () => { state.cancel = true; stopAudio(); clearRun(); hideCursor(); spotlight(null); caption(''); });
    on('min', () => shadow.getElementById('panel').classList.toggle('min'));
    if (state.running) setStatus(hi ? 'दिखा रहा हूँ…' : 'Showing you…', 'busy'); else setStatus('', 'ok');
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
    prefetchVoice([...(state.script.intro && state.script.intro.say || []).map((say) => ({say})), ...(state.script.show.steps || [])]);
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
      await wait(1800);   // let Zoho's page finish rendering
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
