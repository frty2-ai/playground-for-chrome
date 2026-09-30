/**
 * Watch, inside the page. Injected into every frame of the watched tab (and
 * the top frame of every other tab) while an expert is being recorded.
 *
 * Two jobs:
 *   1. Write down what the expert does, as semantic events (what was clicked,
 *      by its text, role and label; the final value typed; navigations,
 *      dialogs, network calls), and send them to the recorder. Never typed
 *      characters, never request bodies; secret-looking fields are masked.
 *   2. In the top frame, show whether the watch is on. The indicator is a
 *      function of the last status from the service worker, and that status
 *      says "recording" only while the recorder's heartbeat is fresh and
 *      healthy. A status older than STALE_MS reads as "not confirmed". So the
 *      red frame and "Watching" are never shown on hope.
 *
 * Every other page shows a small note that a different tab is being watched.
 */

(() => {
  if (window.__frty2Watch) { window.__frty2Watch.revive(); return; }

  const TOP = window === window.top;
  const HOST_ID = 'frty2-watch-host';
  const STALE_MS = 2000;
  const token = Math.random().toString(36).slice(2, 7);
  const now = () => performance.timeOrigin + performance.now();

  const self = {alive: false, port: null, status: null, statusAt: 0, capturing: false, loadSent: false, bornAt: Date.now(),
                n: 0, timers: [], retry: null, observer: null, perf: null};
  window.__frty2Watch = {revive};

  // ------------------------------------------------------------------ connection

  function connect() {
    if (!self.alive || self.port) return;
    try {
      self.port = chrome.runtime.connect({name: 'frty2-watch'});
    } catch {
      teardown();                         // the extension was reloaded: this copy is orphaned
      return;
    }
    self.port.onMessage.addListener(onMessage);
    self.port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      self.port = null;
      if (!chrome.runtime || !chrome.runtime.id) { teardown(); return; }
      if (self.alive) self.retry = setTimeout(connect, 1000);
      render();
    });
  }

  function onMessage(message) {
    if (!message) return;
    if (message.type === 'status') {
      self.status = message.status;
      self.statusAt = Date.now();
      if (message.status.state === 'idle') { teardown(); return; }
      const on = message.status.here && ['recording', 'trouble', 'unknown'].includes(message.status.state);
      setCapturing(on);
      render();
    } else if (message.type === 'control_done') {
      const said = {
        step: 'Step marked', mistake: 'Marked: drop the last 10 s', important: 'Marked important',
        question: 'Marked: learners ask here', never_automate: 'Marked: never automate this',
      };
      if (!message.ok) toast('That did not reach the recorder');
      else if (message.action === 'marker') toast(said[message.marker] || 'Marked');
    }
  }

  function control(action, extra) {
    if (!self.port) { toast('Not connected to the recorder'); return; }
    try { self.port.postMessage({type: 'control', action, ...extra}); } catch { toast('Not connected to the recorder'); }
  }

  function revive() {
    if (self.alive) return;
    self.alive = true;
    install();
    connect();
    if (TOP) self.timers.push(setInterval(render, 250));
    self.timers.push(setInterval(checkUrl, 500));
  }

  function teardown() {
    self.alive = false;
    setCapturing(false);
    uninstall();
    for (const timer of self.timers) clearInterval(timer);
    self.timers = [];
    clearTimeout(self.retry);
    if (self.port) { try { self.port.disconnect(); } catch {} self.port = null; }
    self.status = null;
    if (overlay.host) { overlay.host.remove(); overlay.host = null; overlay.root = null; }
  }

  // ------------------------------------------------------------------ describing things

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
    if (first && first.parentElement) return first.parentElement;       // a text node
    return event.target instanceof Element ? event.target : null;
  }

  const ours = (event) => event.composedPath().some((node) => node && (node.id === HOST_ID || node.id === 'frty2-ghost-host'));

  function cleanUrl(url) {
    try {
      const u = new URL(url, location.href);
      for (const key of [...u.searchParams.keys()]) {
        if (/token|code|secret|key|pass|sig|auth|session/i.test(key)) u.searchParams.set(key, '…');
      }
      return u.toString();
    } catch { return ''; }
  }

  function urlPattern(url) {
    try {
      const u = new URL(url, location.href);
      const keys = [...new Set(u.searchParams.keys())];
      return `${u.origin}${u.pathname}${keys.length ? `?${keys.join('&')}` : ''}`;
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
    // A label written next to the field, as most business apps do.
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

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  }

  /** The visible interactive elements, compactly: what a later resolver needs
   *  to find the same control again. */
  function snapshot() {
    const elements = [];
    let scanned = 0;
    for (const el of document.querySelectorAll(SNAP)) {
      if ((scanned += 1) > 2000 || elements.length >= 80) break;
      if (el.closest(`#${HOST_ID}`) || !visible(el)) continue;
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
    const dialogs = Array.from(document.querySelectorAll(DIALOG)).filter(visible);
    return {url: cleanUrl(location.href), title: document.title, dialog: dialogs.length ? dialogTitle(dialogs[dialogs.length - 1]) : undefined,
            viewport: [innerWidth, innerHeight], elements};
  }

  // ------------------------------------------------------------------ emitting

  function emit(kind, data) {
    if (!self.capturing) return null;
    const event = {kind, id: `${token}.${self.n += 1}`, t: now(), ...data};
    try {
      chrome.runtime.sendMessage({target: 'recorder', type: 'event', event}).catch(() => {});
    } catch {
      teardown();
    }
    return event.id;
  }

  let snapTimer = null;
  let snapFor = [];
  function snapshotSoon(id) {
    if (!id) return;
    snapFor.push(id);
    if (snapTimer) return;
    snapTimer = setTimeout(() => {
      snapTimer = null;
      const of = snapFor.splice(0);
      emit('snapshot', {of, ...snapshot()});
    }, 800);
  }

  function setCapturing(on) {
    if (on === self.capturing) return;
    if (!on) for (const field of [...dirty.keys()]) flushInput(field);   // while emit still sends
    self.capturing = on;
    if (on) {
      self.lastHref = location.href;
      if (!self.loadSent) {
        self.loadSent = true;
        const id = emit('load', {url: cleanUrl(location.href), title: document.title, referrer: cleanUrl(document.referrer),
                                 frame: TOP ? 'top' : 'sub', viewport: [innerWidth, innerHeight], dpr: devicePixelRatio});
        snapshotSoon(id);
      }
    }
  }

  // ------------------------------------------------------------------ what the expert does

  function onClick(event) {
    if (!self.capturing || ours(event)) return;
    const el = interactiveOf(originOf(event));
    const id = emit(event.type, {target: describe(el), x: Math.round(event.clientX), y: Math.round(event.clientY),
                                 button: event.button, synthetic: event.isTrusted ? undefined : true});
    snapshotSoon(id);
  }

  const SPECIAL_KEYS = new Set(['Enter', 'Escape', 'Tab']);
  const MODIFIERS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'CapsLock']);
  function onKey(event) {
    if (!self.capturing || ours(event) || MODIFIERS.has(event.key)) return;
    const chord = event.ctrlKey || event.metaKey || event.altKey;
    if (!chord && !SPECIAL_KEYS.has(event.key)) return;       // typing is recorded as the final value, never as keys
    const el = originOf(event);
    const secret = el && fieldOf(el) && sensitive(fieldOf(el));
    const combo = [event.ctrlKey && 'Ctrl', event.metaKey && 'Meta', event.altKey && 'Alt', event.shiftKey && 'Shift',
                   secret && chord ? 'chord' : event.key].filter(Boolean).join('+');
    const id = emit('key', {key: combo, target: describe(interactiveOf(el))});
    if (event.key === 'Enter') snapshotSoon(id);
  }

  const dirty = new Map();
  function onInput(event) {
    if (!self.capturing || ours(event)) return;
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
    if (!self.capturing || ours(event)) return;
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
    if (!self.capturing || ours(event)) return;
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    const id = emit('submit', {target: describe(form || originOf(event)), action: form ? cleanUrl(form.action) : undefined});
    snapshotSoon(id);
  }

  function onPaste(event) {
    if (!self.capturing || ours(event)) return;
    const text = event.clipboardData ? event.clipboardData.getData('text') : '';
    emit('paste', {target: describe(interactiveOf(originOf(event))), length: text.length});
  }

  function onDrag(event) {
    if (!self.capturing || ours(event)) return;
    const data = {target: describe(interactiveOf(originOf(event)))};
    if (event.type === 'drop') data.files = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files.length : 0;
    const id = emit(event.type === 'drop' ? 'drop' : 'drag', data);
    if (event.type === 'drop') snapshotSoon(id);
  }

  const scrolls = new Map();
  function onScroll(event) {
    if (!self.capturing) return;
    const target = event.target;
    if (target instanceof Element && target.closest(`#${HOST_ID}`)) return;
    if (scrolls.has(target)) return;
    scrolls.set(target, setTimeout(() => {
      scrolls.delete(target);
      const page = target === document || target === document.documentElement || target === document.body;
      const box = page ? document.scrollingElement || document.documentElement : target;
      emit('scroll', {container: page ? 'page' : cssPath(target), x: Math.round(box.scrollLeft), y: Math.round(box.scrollTop),
                      height: Math.round(box.scrollHeight), view: Math.round(page ? innerHeight : box.clientHeight)});
    }, 1000));
  }

  function onVisibility() {
    if (TOP) emit('visibility', {state: document.visibilityState});
  }

  function checkUrl() {
    if (!self.capturing || location.href === self.lastHref) return;
    const from = self.lastHref;
    self.lastHref = location.href;
    const id = emit('navigate', {url: cleanUrl(location.href), from: cleanUrl(from), title: document.title, frame: TOP ? 'top' : 'sub'});
    snapshotSoon(id);
  }

  // Dialogs and toasts, as they are added. Batched: business apps add large
  // subtrees at a time.
  const seenNotices = new WeakSet();
  let added = [];
  let noticeTimer = null;
  function onMutations(records) {
    if (!self.capturing) return;
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) added.push(node);
    if (!noticeTimer) noticeTimer = setTimeout(scanNotices, 300);
  }

  function scanNotices() {
    noticeTimer = null;
    const batch = added.splice(0, 400);
    added = [];
    for (const node of batch) {
      if (!node.isConnected || node.id === HOST_ID) continue;
      const found = node.matches(NOTICES) ? [node] : [];
      found.push(...Array.from(node.querySelectorAll(NOTICES)).slice(0, 4));
      for (const el of found) {
        if (seenNotices.has(el) || !visible(el)) continue;
        seenNotices.add(el);
        const toast = !el.matches(DIALOG);
        const id = emit(toast ? 'toast' : 'dialog', {title: toast ? undefined : dialogTitle(el), text: collapse(el.innerText, 240),
                                                    role: el.getAttribute('role') || el.localName});
        if (!toast) snapshotSoon(id);
      }
    }
  }

  // Network calls the page makes: URL pattern, status, time. Repeats of the
  // same pattern within 2 s (polling) are dropped.
  const netSeen = new Map();
  function onResources(list) {
    if (!self.capturing) return;
    for (const entry of list.getEntries()) {
      if (entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest') continue;
      const pattern = urlPattern(entry.name);
      const t = performance.timeOrigin + entry.responseEnd;
      if (!pattern || t - (netSeen.get(pattern) || 0) < 2000) continue;
      netSeen.set(pattern, t);
      emit('net', {url: pattern, status: entry.responseStatus || undefined, ms: Math.round(entry.duration), t});
    }
  }

  const LISTENERS = [
    ['click', onClick], ['dblclick', onClick], ['contextmenu', onClick],
    ['keydown', onKey], ['input', onInput], ['change', onChange], ['focusout', onFocusOut], ['submit', onSubmit],
    ['paste', onPaste], ['dragstart', onDrag], ['drop', onDrag],
  ];

  function install() {
    for (const [type, fn] of LISTENERS) window.addEventListener(type, fn, true);
    document.addEventListener('scroll', onScroll, {capture: true, passive: true});
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('popstate', checkUrl);
    window.addEventListener('hashchange', checkUrl);
    try {
      self.observer = new MutationObserver(onMutations);
      self.observer.observe(document.documentElement || document, {childList: true, subtree: true});
    } catch {}
    try {
      self.perf = new PerformanceObserver(onResources);
      self.perf.observe({type: 'resource', buffered: false});
    } catch {}
  }

  function uninstall() {
    for (const [type, fn] of LISTENERS) window.removeEventListener(type, fn, true);
    document.removeEventListener('scroll', onScroll, {capture: true});
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('popstate', checkUrl);
    window.removeEventListener('hashchange', checkUrl);
    if (self.observer) self.observer.disconnect();
    if (self.perf) self.perf.disconnect();
    self.observer = null; self.perf = null;
  }

  // ------------------------------------------------------------------ the indicator (top frame only)

  const overlay = {host: null, root: null, collapsed: false, menu: false, toastTimer: null, shape: '', reported: false};

  const CSS_TEXT = `
    * { box-sizing: border-box; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; }
    [hidden] { display: none !important; }
    .frame { position: fixed; inset: 0; pointer-events: none; border: 3px solid var(--c); box-shadow: inset 0 0 14px var(--glow); }
    .w { --c: #9ca3af; --glow: transparent; }
    .w.recording, .w.trouble { --c: #e11d48; --glow: rgba(225, 29, 72, .35); }
    .w.paused { --c: #f59e0b; --glow: rgba(245, 158, 11, .25); }
    .w.paused .frame, .w.unknown .frame, .w.starting .frame, .w.stopping .frame { border-style: dashed; }
    .pill { position: fixed; left: 16px; bottom: 16px; display: flex; align-items: center; gap: 8px; max-width: calc(100vw - 32px);
      padding: 6px 6px 6px 12px; border-radius: 999px; background: #111827; color: #f9fafb; pointer-events: auto; user-select: none;
      font: 600 13px/1 "Segoe UI", system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.08); }
    .dot { flex: none; width: 11px; height: 11px; border-radius: 50%; background: var(--c); }
    .recording .dot { animation: blink 1.4s ease-in-out infinite; box-shadow: 0 0 0 3px rgba(225, 29, 72, .3); }
    @keyframes blink { 50% { opacity: .35; } }
    .label { white-space: nowrap; }
    .time { font-variant-numeric: tabular-nums; color: #d1d5db; font-weight: 500; }
    .meter { display: inline-flex; align-items: flex-end; gap: 2px; height: 14px; }
    .meter i { width: 3px; border-radius: 1px; background: #374151; }
    .meter i.on { background: #22c55e; }
    .cov { white-space: nowrap; background: #f59e0b; color: #111827; border-radius: 999px; padding: 4px 8px; font-size: 12px; }
    .note { color: #fde68a; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 360px; }
    .btns { display: flex; gap: 4px; }
    button { all: unset; cursor: pointer; white-space: nowrap; padding: 6px 10px; border-radius: 999px; font: 600 12px/1 "Segoe UI", system-ui, sans-serif;
      color: #e5e7eb; background: rgba(255,255,255,.09); }
    button:hover { background: rgba(255,255,255,.2); }
    button.stop { background: #dc2626; color: #fff; }
    button.stop:hover { background: #b91c1c; }
    button.go { background: #f59e0b; color: #111827; }
    .collapsed .btns, .collapsed .meter, .collapsed .cov, .collapsed .note { display: none; }
    .menu { position: absolute; left: 0; bottom: calc(100% + 8px); display: none; flex-direction: column; gap: 4px; padding: 6px;
      background: #111827; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
    .menu.open { display: flex; }
    .menu button { border-radius: 8px; text-align: left; }
    .toast { position: absolute; left: 0; bottom: calc(100% + 8px); padding: 7px 10px; border-radius: 8px; background: #111827; color: #fff;
      font: 500 12px/1.2 "Segoe UI", system-ui, sans-serif; white-space: nowrap; opacity: 0; transition: opacity 200ms; pointer-events: none; }
    .toast.on { opacity: 1; }
    .chip { position: fixed; top: 10px; right: 10px; display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 10px; border-radius: 999px;
      background: rgba(17, 24, 39, .92); color: #f9fafb; font: 500 12px/1 "Segoe UI", system-ui, sans-serif; pointer-events: auto;
      box-shadow: 0 6px 18px rgba(0,0,0,.3); }
    .chip .dot { width: 9px; height: 9px; }
  `;

  function ensureOverlay() {
    if (overlay.host && overlay.host.isConnected) return true;
    if (!document.documentElement) return false;         // document_start: try again on the next tick
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('popover', 'manual');
    const style = {all: 'initial', display: 'block', position: 'fixed', inset: '0', width: '100vw', height: '100vh', 'max-width': 'none',
                   'max-height': 'none', margin: '0', padding: '0', border: '0', background: 'transparent', overflow: 'visible',
                   'pointer-events': 'none', 'z-index': '2147483647'};
    for (const [key, value] of Object.entries(style)) host.style.setProperty(key, value, 'important');
    const root = host.attachShadow({mode: 'open'});
    root.innerHTML = `<style>${CSS_TEXT}</style><div class="w" id="w"></div>`;
    root.addEventListener('click', onOverlayClick);
    (document.documentElement || document.body).appendChild(host);
    overlay.host = host;
    overlay.root = root;
    overlay.shape = '';
    raise();
    return true;
  }

  // The top layer keeps the indicator above the app's own dialogs; a dialog
  // opened later is re-stacked under it.
  const seenLayers = new WeakSet();
  function raise() {
    const host = overlay.host;
    if (!host || typeof host.showPopover !== 'function') return;
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
    if (action === 'more') { overlay.menu = !overlay.menu; overlay.shape = ''; render(); return; }
    overlay.menu = false;
    if (action === 'collapse') { overlay.collapsed = !overlay.collapsed; overlay.shape = ''; overlay.reported = false; render(); return; }
    if (action === 'marker') control('marker', {marker: button.dataset.m});
    else if (action === 'focus') control('focus');
    else control(action);
    overlay.shape = '';
    render();
  }

  function toast(text) {
    if (!overlay.root) return;
    const el = overlay.root.getElementById('toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(overlay.toastTimer);
    overlay.toastTimer = setTimeout(() => el.classList.remove('on'), 1600);
  }

  const clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };

  /** The one function that decides what the expert sees. */
  function view() {
    const s = self.status;
    if (!self.port || !s || Date.now() - self.statusAt > STALE_MS) {
      return {state: 'unknown', here: s ? s.here : true, note: 'No signal from the recorder: this may not be recording'};
    }
    return {...s, note: s.state === 'trouble' ? (s.problems && s.problems[0]) || 'The recorder reports a problem' : s.state === 'unknown' ? 'No signal from the recorder: this may not be recording' : ''};
  }

  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

  function render() {
    if (!TOP || !self.alive) return;
    if (!self.status && Date.now() - self.bornAt < 1500) return;   // the first status is on its way
    const v = view();
    if (v.here === false) { renderChip(v); return; }
    if (!ensureOverlay()) return;
    raise();
    const label = {
      recording: 'Watching', trouble: 'Watching', paused: 'Private: paused', unknown: 'Watch not confirmed',
      starting: 'Starting the watch…', stopping: 'Saving the recording…',
    }[v.state] || 'Watch';
    const live = v.state === 'recording' || v.state === 'trouble';
    const key = (name) => (v.keys && v.keys[name] ? ` (${v.keys[name]})` : '');
    const buttons = [];
    if (live) {
      buttons.push(`<button data-a="marker" data-m="step" title="Mark the start of a step${key('step')}">Step</button>`);
      buttons.push(`<button data-a="marker" data-m="mistake" title="That was a mistake: drop the last 10 seconds${key('mistake')}">Oops</button>`);
      buttons.push('<button data-a="more" title="More markers">⋯</button>');
      buttons.push(`<button data-a="pause" title="Pause while something private is on screen${key('private')}">Private</button>`);
    }
    if (v.state === 'paused') buttons.push(`<button data-a="resume" class="go" title="Resume watching${key('private')}">Resume</button>`);
    if (live || v.state === 'paused' || v.state === 'unknown') buttons.push(`<button data-a="stop" class="stop" title="Stop and save${key('toggle')}">Stop</button>`);
    buttons.push(`<button data-a="collapse" title="${overlay.collapsed ? 'Show controls' : 'Hide controls'}">${overlay.collapsed ? '›' : '‹'}</button>`);

    const shape = [v.state, overlay.collapsed, overlay.menu, Boolean(v.note)].join('|');
    const w = overlay.root.getElementById('w');
    if (shape !== overlay.shape) {
      overlay.shape = shape;
      w.className = `w ${v.state}${overlay.collapsed ? ' collapsed' : ''}`;
      w.innerHTML = `
        <div class="frame"></div>
        <div class="pill" id="pill">
          <span class="dot"></span><span class="label">${label}</span>
          <span class="time" id="time"></span>
          ${live ? '<span class="meter" id="meter"><i></i><i></i><i></i><i></i><i></i></span>' : ''}
          <span class="cov" id="cov" hidden></span>
          ${v.note ? '<span class="note" id="note"></span>' : ''}
          <span class="btns">${buttons.join('')}</span>
          <div class="menu${overlay.menu ? ' open' : ''}">
            <button data-a="marker" data-m="important">Important</button>
            <button data-a="marker" data-m="question">Learners ask here</button>
            <button data-a="marker" data-m="never_automate">Never automate this</button>
          </div>
          <div class="toast" id="toast"></div>
        </div>`;
    }
    const time = overlay.root.getElementById('time');
    if (time) {
      const elapsed = typeof v.elapsed_ms === 'number' ? v.elapsed_ms + (v.state === 'recording' || v.state === 'trouble' ? Date.now() - self.statusAt : 0) : null;
      time.textContent = elapsed === null ? '' : clock(elapsed);
    }
    const meter = overlay.root.getElementById('meter');
    if (meter) {
      const level = typeof v.level === 'number' ? v.level : 0;
      meter.title = typeof v.level === 'number' ? 'Your microphone' : 'Microphone level unavailable';
      Array.from(meter.children).forEach((bar, i) => {
        bar.style.height = `${4 + i * 2.5}px`;
        bar.classList.toggle('on', level > (i + 0.5) / 5.5);
      });
    }
    const cov = overlay.root.getElementById('cov');
    if (cov) {
      const n = live ? v.unnarrated || 0 : 0;
      cov.hidden = n < 3;
      cov.textContent = `${n} done without a word`;
      cov.title = 'Actions since you last spoke. Say what you did and why before moving on.';
    }
    const note = overlay.root.getElementById('note');
    if (note) { note.textContent = v.note; note.title = v.note; }
    if (live && !overlay.reported) {
      const pill = overlay.root.getElementById('pill');
      const r = pill.getBoundingClientRect();
      overlay.reported = true;
      emit('overlay', {pill: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], frame_px: 3,
                       viewport: [innerWidth, innerHeight]});
    }
  }

  function renderChip(v) {
    if (!ensureOverlay()) return;
    raise();
    const labels = {recording: 'Frty2 is watching another tab', trouble: 'Frty2 is watching another tab',
                    paused: 'Frty2 watch is paused in another tab', starting: 'Frty2 watch is starting in another tab',
                    stopping: 'Frty2 is saving a recording', unknown: 'Frty2 watch: no signal'};
    const shape = `chip|${v.state}`;
    if (shape === overlay.shape) return;
    overlay.shape = shape;
    const w = overlay.root.getElementById('w');
    w.className = `w ${v.state}`;
    w.innerHTML = `<div class="chip" title="This tab is not recorded"><span class="dot"></span><span>${esc(labels[v.state] || 'Frty2 watch')}</span>
      <button data-a="focus">Go to it</button></div>`;
  }

  revive();
})();
