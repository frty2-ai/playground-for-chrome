/**
 * The recordings page (watch.html): the one-time permissions a watch needs,
 * the Backstage sign-in used for uploads, and every recording on this
 * computer: its way from upload to lessons learners can open, with download
 * and delete.
 *
 * `#setup` shows the permissions and, once granted, starts the watch the
 * popup asked for. `#<recording id>` highlights one recording (the service
 * worker opens that when a watch ends).
 */

const DEFAULT_API = 'https://api.frty2.wawm.ai';
const EXPERT_KEY = 'frty2_expert';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const send = (message) => chrome.runtime.sendMessage(message).catch((error) => ({ok: false, error: error.message}));

function message(el, text, kind) {
  el.hidden = !text;
  el.textContent = text || '';
  el.className = `msg ${kind || ''}`;
}

// ------------------------------------------------------------------ permissions

async function micState() {
  try { return (await navigator.permissions.query({name: 'microphone'})).state; } catch { return 'prompt'; }
}

async function showPermissions() {
  const access = await chrome.permissions.contains({origins: ['<all_urls>']});
  const mic = await micState();
  $('permAccess').textContent = access ? 'Allowed' : 'Not yet';
  $('permAccess').className = access ? 'yes' : 'no';
  $('permMic').textContent = mic === 'granted' ? 'Allowed' : mic === 'denied' ? 'Blocked' : 'Not yet';
  $('permMic').className = mic === 'granted' ? 'yes' : 'no';
  return {access, mic};
}

$('allow').addEventListener('click', async () => {
  // The access request has to come first, inside the click.
  const access = await chrome.permissions.request({origins: ['<all_urls>']}).catch(() => false);
  let micOk = false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio: true});
    stream.getTracks().forEach((t) => t.stop());
    micOk = true;
  } catch {}
  await showPermissions();
  if (!access) return message($('setupMsg'), 'Watch cannot record without reading the pages you use. Press the button again and choose Allow.', 'err');
  if (!micOk) {
    return message($('setupMsg'), (await micState()) === 'denied'
      ? 'The microphone is blocked for Frty2. Click the icon at the right of the address bar, allow the microphone, then press the button again.'
      : 'Frty2 needs the microphone. Press the button again and choose Allow.', 'err');
  }
  message($('setupMsg'), 'Allowed. Starting the watch…');
  const result = await send({type: 'watch_setup_start'});
  if (result.ok) {
    message($('setupMsg'), 'Watching. Your tab now has a red frame and a “Watching” pill: that is how you know it records.', 'ok');
  } else if (result.error === 'nothing_pending') {
    message($('setupMsg'), 'Allowed. Go back to your application and press Start watching in the Frty2 menu.', 'ok');
  } else {
    message($('setupMsg'), `Allowed, but the watch did not start (${result.detail || result.error}). Go back to your application and press Start watching again.`, 'err');
  }
});

// The live tutor's one question (background.js askForEyes): access to all
// sites, which captureVisibleTab needs to show the tutor the learner's screen.
$('allowEyes').addEventListener('click', async () => {
  const access = await chrome.permissions.request({origins: ['<all_urls>']}).catch(() => false);
  if (!access) return message($('eyesMsg'), 'Not allowed. The tutor will answer without seeing your screen.', 'err');
  message($('eyesMsg'), 'Allowed. You can close this window.', 'ok');
  setTimeout(() => window.close(), 900);
});
$('notNow').addEventListener('click', () => window.close());

// ------------------------------------------------------------------ account

async function account() {
  return (await chrome.storage.local.get(EXPERT_KEY))[EXPERT_KEY] || null;
}

/** Where the next recording will upload, from what is actually stored: a
 *  linked expert session wins over an author sign-in (startWatch does the same). */
async function renderAccount() {
  const current = await account();
  const actions = $('accountActions');
  actions.innerHTML = '';
  const button = (label, onClick) => {
    const el = document.createElement('button');
    el.textContent = label;
    el.addEventListener('click', onClick);
    actions.append(el);
  };
  const {frty2_watch_session: link} = await chrome.storage.local.get('frty2_watch_session');
  $('signin').hidden = true;
  if (link && link.token) {
    $('accountLine').innerHTML = `Linked to the expert session <b>${esc(link.session.title)}</b> (${esc(link.session.app.name)}) at ${esc(link.api_base)}.
      New recordings upload into it while you record and become lessons when you stop. No sign-in is needed.`;
    button('Unlink', async () => { await chrome.storage.local.remove('frty2_watch_session'); renderAccount(); refresh(); });
  } else if (current && current.token) {
    $('accountLine').innerHTML = `Signed in as <b>${esc(current.email)}</b> at ${esc(current.api_base)}. New recordings upload while you record and become lessons when you stop.`;
    button('Sign out', async () => { await chrome.storage.local.remove(EXPERT_KEY); renderAccount(); refresh(); });
  } else {
    $('accountLine').textContent = 'Not linked to an expert session and not signed in, so new recordings stay on this computer. '
      + 'Open a session’s recording link from Backstage to link Watch, or sign in as a Backstage author.';
    $('signin').hidden = false;
    const stored = await chrome.storage.local.get('frty2_api_base');
    if (!$('api').value) $('api').value = (current && current.api_base) || stored.frty2_api_base || DEFAULT_API;
  }
}

$('signin').addEventListener('submit', async (event) => {
  event.preventDefault();
  const api_base = $('api').value.trim().replace(/\/$/, '');
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!api_base || !email || !password) return message($('accountMsg'), 'Enter the API, your email and password.', 'err');
  message($('accountMsg'), 'Signing in…');
  try {
    const response = await fetch(`${api_base}/api/v1/authentication/login/`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email, password}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      return message($('accountMsg'), (data && (data.detail || (data.non_field_errors || [])[0])) || `Sign-in failed (${response.status}).`, 'err');
    }
    await chrome.storage.local.set({[EXPERT_KEY]: {api_base, email, token: data.access_token, refresh: data.refresh_token, at: Date.now()}});
    $('password').value = '';
    message($('accountMsg'), 'Signed in. Recordings on this computer can be uploaded now.', 'ok');
    renderAccount();
    refresh();
  } catch (error) {
    message($('accountMsg'), `Cannot reach ${api_base} (${error.message}).`, 'err');
  }
});

/** A 7-day access token runs out; the refresh token buys a new one once. */
async function refreshToken(current) {
  if (!current || !current.refresh) return null;
  try {
    const response = await fetch(`${current.api_base}/api/v1/authentication/token/refresh/`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({refresh: current.refresh}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access) return null;
    const next = {...current, token: data.access, refresh: data.refresh || current.refresh, at: Date.now()};
    await chrome.storage.local.set({[EXPERT_KEY]: next});
    return next;
  } catch { return null; }
}

// ------------------------------------------------------------------ recordings
//
// Each recording shows one line of progress from the expert's Stop to the
// learner's link: Upload, Analyse, Write lessons, Check, Ready. The first step
// happens here; the rest happen on the server by themselves and are followed
// from its answer (`lessons` on the capture). One button starts it, and once
// started it cannot be pressed again: it says what is being done instead.

const busy = new Set();         // recordings this page is uploading right now
let liveId = null;
let uploading = false;          // some recording is still going up: keep the page current
let following = false;          // some recording's lessons are still being built: keep asking

const STEPS = ['Upload', 'Analyse', 'Write lessons', 'Check', 'Ready'];
const MAX_UPLOAD_FAILURES = 8;

function size(bytes) {
  if (!bytes) return '0 MB';
  return bytes > 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function duration(ms) {
  if (ms === null || ms === undefined) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function closeOrphans(recordings) {
  for (const rec of recordings) {
    if (rec.state !== 'recording' || rec.id === liveId) continue;
    await WatchStore.closeOrphan(rec);
  }
}

/** Who uploads a recording: the session it was made for (its link token is
 *  kept with it), else the signed-in author. */
async function uploaderFor(rec) {
  const upload = rec.upload || {};
  if (upload.kind === 'session' && upload.token) return {kind: 'session', api_base: upload.api_base, token: upload.token};
  return account();
}

/** The learner link of a recording's module, once there is one. The server
 *  says it whole when it knows where Backstage lives; else it is built on the
 *  Backstage page this recording's session was linked from. */
function moduleLink(rec) {
  const module = rec.lessons && rec.lessons.module;
  if (!module) return '';
  if (module.url) return module.url;
  const base = rec.upload && rec.upload.web_base;
  return base && module.path ? `${base}${module.path}` : '';
}

/**
 * Where a recording is on its way to being lessons, as one object the card
 * is drawn from:
 *   step   index into STEPS of the step being worked on (or reached)
 *   tone   now (working), done, wait (a person is needed), bad, idle
 *   action what the one button does: 'upload' (enabled) or null (disabled)
 *   follow true while the server is still working and should be asked again
 */
async function stageOf(rec, live) {
  const pending = await WatchStore.countPending(rec.id);
  const upload = rec.upload || {};
  const uploader = await uploaderFor(rec);
  const working = busy.has(rec.id);
  const where = upload.kind === 'session' ? `the expert session “${rec.meta.title || ''}”` : 'Frty2';
  if (live) {
    return {step: 0, tone: 'now', pending, title: uploader ? 'Recording, and uploading as you go' : 'Recording',
            detail: uploader ? `${pending} part${pending === 1 ? '' : 's'} waiting to go to ${where}. Lessons are built when you press Stop.`
              : 'Saved on this computer as you record.', button: 'Recording…', action: null, uploading: Boolean(uploader)};
  }
  const uploaded = Boolean(upload.finished) && !pending;
  if (!uploaded) {
    const fatal = upload.error && upload.error.code !== 'no_account' && !working;
    if (fatal) {
      return {step: 0, tone: 'bad', pending, title: 'The upload stopped', detail: upload.error.detail || 'Something went wrong.',
              button: 'Try the upload again', action: uploader ? 'upload' : null};
    }
    if (!uploader) {
      return {step: -1, tone: 'idle', pending, title: 'On this computer only',
              detail: 'It was recorded without an expert session or a sign-in. Sign in above, then upload it to turn it into lessons.',
              button: 'Upload and build lessons', action: null};
    }
    if (working || upload.created) {
      const total = await WatchStore.countParts(rec.id);
      const sent = Math.max(0, total - pending);
      const retry = working && upload.error && upload.error.code !== 'no_account' ? ` Trying again: ${upload.error.detail}` : '';
      return {step: 0, tone: 'now', pending, title: pending ? 'Uploading the recording' : 'Finishing the upload',
              detail: `${sent} of ${total} parts sent to ${where}. Keep Chrome open; you can use other tabs.${retry}`,
              progress: total ? sent / total : 0, button: 'Uploading…', action: null, uploading: true};
    }
    return {step: -1, tone: 'idle', pending, title: 'Ready to upload',
            detail: 'Uploads the recording, then turns it into lessons and a link for learners. Nothing else to press.',
            button: 'Upload and build lessons', action: 'upload'};
  }
  const lessons = rec.lessons;
  if (!lessons) {
    return {step: 1, tone: 'now', pending, title: 'Uploaded', detail: 'Asking what happens next…', button: 'Uploaded', action: null, follow: true};
  }
  const step = Math.max(0, Math.min(4, Number(lessons.step) || 0));
  const labels = {queued: 'Starting…', understanding: 'Analysing…', writing: 'Writing lessons…', checking: 'Checking…',
                  uploading: 'Finishing…', ready: 'Lessons ready', review: 'Waiting for review'};
  const base = {pending, title: lessons.title || 'Uploaded', detail: lessons.detail || '', button: labels[lessons.state] || 'Uploaded', action: null};
  if (lessons.busy) return {...base, step: Math.max(1, step), tone: 'now', follow: true};
  if (lessons.state === 'ready') return {...base, step: 4, tone: 'done', link: moduleLink(rec), module: lessons.module};
  if (lessons.state === 'review') return {...base, step: 4, tone: 'wait'};
  if (lessons.state === 'failed') return {...base, step: Math.max(1, step), tone: 'bad'};
  // Uploaded, and nothing is being built (too short, switched off, cut short…): the upload itself is done.
  return {...base, step: 1, tone: 'wait', stopped: true};
}

function stepsHtml(stage) {
  const items = STEPS.map((name, n) => {
    let state = 'todo';
    if (stage.step >= 0) {
      if (n < stage.step || (stage.tone === 'done' && n === stage.step)) state = 'done';
      else if (n === stage.step) state = stage.tone === 'now' ? 'now' : stage.tone === 'bad' ? 'bad' : stage.tone === 'wait' ? (stage.stopped ? 'todo' : 'wait') : 'todo';
    }
    const mark = state === 'done' ? '✓' : state === 'bad' ? '!' : state === 'wait' ? '…' : String(n + 1);
    return `<li class="${state}"><span class="mark">${mark}</span><span class="name">${esc(name)}</span></li>`;
  });
  return `<ol class="steps" aria-label="From recording to lessons">${items.join('')}</ol>`;
}

function stageHtml(stage) {
  // A negative delay that follows the wall clock keeps the spinner's phase
  // when the card is redrawn (it is redrawn whenever its numbers change).
  const phase = `style="animation-delay:-${Date.now() % 900}ms"`;
  const spinner = stage.tone === 'now' ? `<span class="spin" ${phase}></span>` : '';
  const bar = typeof stage.progress === 'number'
    ? `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(stage.progress * 100)}"><i style="width:${Math.round(stage.progress * 100)}%"></i></div>` : '';
  let link = '';
  if (stage.tone === 'done') {
    const module = stage.module || {};
    const count = module.total ? `<div class="sub">${esc(module.title || '')} · ${module.live} of ${module.total} lesson${module.total === 1 ? '' : 's'} open to learners</div>` : '';
    link = stage.link
      ? `<div class="link"><code>${esc(stage.link)}</code>
           <a class="btn blue" href="${esc(stage.link)}" target="_blank" rel="noopener">Open the lessons</a>
           <button data-do="copy" data-url="${esc(stage.link)}">Copy the link</button></div>${count}`
      : `<div class="sub">The learner link is on this session’s page in Backstage.</div>${count}`;
  }
  return `<div class="pipeline ${esc(stage.tone)}">
      ${stepsHtml(stage)}
      <div class="stage">${spinner}<div><b>${esc(stage.title)}</b><span>${esc(stage.detail)}</span></div></div>
      ${bar}${link}
    </div>`;
}

const drawn = new Map();        // recording id -> what its card was last drawn from

async function refresh() {
  const status = await send({type: 'watch_status'});
  liveId = status && status.status && status.status.state !== 'idle' ? status.status.id : null;
  let recordings = await WatchStore.listRecordings();
  await closeOrphans(recordings);
  recordings = await WatchStore.listRecordings();
  const list = $('list');

  if (!recordings.length) {
    drawn.clear();
    list.innerHTML = '<section class="empty">No recordings yet. Open the application you want to teach, click the Frty2 icon and press <b>Start watching this tab</b>.</section>';
    uploading = false; following = false;
    return;
  }
  const highlight = location.hash.slice(1);
  const cards = [];
  let stillUploading = false;
  let stillFollowing = false;
  for (const rec of recordings) {
    const live = rec.id === liveId;
    const stage = await stageOf(rec, live);
    if (stage.uploading) stillUploading = true;
    if (stage.follow) stillFollowing = true;
    // An upload that was started and then left (the browser was closed) carries
    // on by itself. One that was never started waits for the button.
    const upload = rec.upload || {};
    if (!live && stage.uploading && !busy.has(rec.id) && upload.created && !upload.error) runUpload(rec.id);
    const badge = live ? '<span class="badge live">● Recording now</span>'
      : rec.state === 'interrupted' ? '<span class="badge cut">Cut short</span>' : '<span class="badge saved">Saved</span>';
    const counts = rec.counts || {};
    const started = new Date(rec.t0).toLocaleString();
    const working = busy.has(rec.id);
    const forSession = rec.meta.session_id ? `<div class="sub">Expert session: ${esc(rec.meta.app || '')} · ${esc(rec.meta.title || '')}</div>` : '';
    const body = `
        <div class="spread"><span class="title">${esc(rec.meta.title || rec.meta.page_title || 'Untitled recording')}</span>${badge}</div>
        <div class="sub">${esc(started)} · ${esc(rec.meta.url || '')}</div>
        ${forSession}
        ${rec.meta.intent ? `<p>${esc(rec.meta.intent)}</p>` : ''}
        <div class="stats">
          <span><b>${live ? '…' : duration(rec.duration_ms)}</b> watched</span>
          <span><b>${counts.actions ?? '—'}</b> actions</span>
          <span><b>${counts.speech ?? '—'}</b> spoken passages</span>
          <span><b>${counts.frames ?? '—'}</b> frames</span>
          <span><b>${counts.markers ?? '—'}</b> markers</span>
          <span><b>${size(rec.bytes)}</b></span>
        </div>
        ${rec.end_reason && rec.state === 'interrupted' ? `<div class="sub">${esc(rec.end_reason)}</div>` : ''}
        ${(rec.problems || []).length ? `<div class="msg err">While recording: ${esc(rec.problems.join('; '))}</div>` : ''}
        ${stageHtml(stage)}
        <div class="row">
          <button data-do="upload" class="blue${stage.action ? '' : ' locked'}" ${stage.action === 'upload' && !working ? '' : 'disabled aria-disabled="true"'}>${esc(stage.button)}</button>
          <button data-do="download" ${live || working ? 'disabled' : ''}>Download bundle (.zip)</button>
          <button data-do="delete" class="danger" ${live || working ? 'disabled' : ''}>Delete from this computer</button>
        </div>`;
    cards.push({id: rec.id, current: rec.id === highlight, body, key: body.replace(/animation-delay:-\d+ms/, '')});
  }
  // Redraw only the cards that changed, so a click on a card that did not is never lost to a redraw.
  const ids = cards.map((c) => c.id);
  const shown = [...list.querySelectorAll('section.rec')].map((el) => el.dataset.id);
  const sameOrder = ids.length === shown.length && ids.every((id, n) => id === shown[n]);
  if (!sameOrder) {
    list.innerHTML = cards.map((c) => `<section class="rec${c.current ? ' current' : ''}" data-id="${esc(c.id)}">${c.body}</section>`).join('');
  } else {
    for (const card of cards) {
      if (drawn.get(card.id) === card.key) continue;
      const el = list.querySelector(`section.rec[data-id="${CSS.escape(card.id)}"]`);
      if (el) el.innerHTML = card.body;
    }
  }
  drawn.clear();
  for (const card of cards) drawn.set(card.id, card.key);
  uploading = stillUploading;
  following = stillFollowing;
}

/** Upload one recording to the end. Started by the button, or by this page
 *  finding an upload that was left half-way; never twice at once. */
async function runUpload(id) {
  if (busy.has(id)) return;
  busy.add(id);
  refresh();
  try {
    let current = await uploaderFor(await WatchStore.getRecording(id));
    let failures = 0;
    for (let round = 0; round < 2000 && current; round += 1) {
      let result = await WatchStore.sync(id, current, {limit: 40});
      if (!result.ok && result.code === 'signed_out' && current.kind !== 'session') {
        current = await refreshToken(current);
        if (!current) { await chrome.storage.local.remove(EXPERT_KEY); renderAccount(); break; }
        result = await WatchStore.sync(id, current, {limit: 40});
      }
      refresh();
      if (result.ok && result.finished) break;
      if (!result.ok && WatchStore.FATAL.includes(result.code)) break;
      if (!result.ok) {
        failures += 1;
        if (failures >= MAX_UPLOAD_FAILURES) break;
        await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * failures)));
      } else if (result.busy) {
        // The recorder (or the worker) is sending this recording: wait for it.
        await new Promise((r) => setTimeout(r, 1500));
      } else if (!result.pending) {
        await new Promise((r) => setTimeout(r, 500));      // the last chunks are still being written
      }
    }
  } finally {
    busy.delete(id);
    await refresh();
    followLessons();
  }
}

let asking = false;
/** Ask the server how the lessons of every uploaded recording are coming on.
 *  `all`: also the ones that had settled (on page load: a person may have
 *  published or rebuilt them since). */
async function followLessons(all = false) {
  if (asking) return;
  asking = true;
  try {
    for (const rec of await WatchStore.listRecordings()) {
      const upload = rec.upload || {};
      if (!upload.finished || rec.id === liveId) continue;
      const settled = rec.lessons && !rec.lessons.busy;
      if (settled && !(all && rec.lessons.state !== 'ready')) continue;
      const uploader = await uploaderFor(rec);
      if (uploader) await WatchStore.lessons(rec.id, uploader);
    }
  } finally {
    asking = false;
  }
  await refresh();
}

$('list').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-do]');
  if (!button || button.disabled) return;
  const id = button.closest('[data-id]').dataset.id;
  const action = button.dataset.do;
  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(button.dataset.url);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy the link'; }, 1500);
    } catch { prompt('Copy the link:', button.dataset.url); }
    return;
  }
  if (action === 'download') {
    busy.add(id); refresh();
    try {
      const {blob, filename} = await WatchStore.bundle(id);
      const url = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement('a'), {href: url, download: filename});
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } catch (error) {
      alert(`Could not build the bundle: ${error.message}`);
    } finally { busy.delete(id); refresh(); }
  }
  if (action === 'upload') {
    // Locked at once, before anything is sent: a second click finds it disabled.
    button.disabled = true;
    button.classList.add('locked');
    button.textContent = 'Uploading…';
    await WatchStore.updateRecording(id, (r) => ({...r, upload: {...(r.upload || {}), error: null}}));
    runUpload(id);
  }
  if (action === 'delete') {
    const pending = await WatchStore.countPending(id);
    const rec = await WatchStore.getRecording(id);
    const uploaded = rec && rec.upload && rec.upload.finished && !pending;
    const question = uploaded
      ? 'Delete the copy on this computer? The uploaded recording and its lessons stay on Frty2.'
      : 'This recording is not (fully) uploaded. Deleting it here loses it for good. Delete it?';
    if (!confirm(question)) return;
    await WatchStore.deleteRecording(id);
    refresh();
  }
});

// ------------------------------------------------------------------ boot

async function showKeys() {
  const names = {toggle: 'start/stop', step: 'step', private: 'private', mistake: 'oops'};
  const keys = (await chrome.commands.getAll()).filter((c) => c.name.startsWith('watch-'))
    .map((c) => ({name: names[c.name.slice(6)] || c.name, key: c.shortcut}));
  const set = keys.filter((k) => k.key);
  $('keys').innerHTML = `${set.length ? `Shortcuts: ${set.map((k) => `<kbd>${esc(k.key)}</kbd> ${esc(k.name)}`).join(', ')}.` : ''}
    ${set.length < keys.length ? 'Some shortcuts are not set (Chrome drops keys that clash); choose them at <b>chrome://extensions/shortcuts</b>.' : ''}`;
}

(async () => {
  showKeys();
  const setup = location.hash.startsWith('#setup');
  $('setup').hidden = !setup;
  if (setup) await showPermissions();
  if (location.hash.startsWith('#eyes')) {
    // Only the question: the rest of the page is for experts who record.
    for (const el of document.querySelectorAll('main > *')) el.hidden = el.id !== 'eyes';
    $('eyes').hidden = false;
    return;
  }
  await renderAccount();
  await refresh();
  followLessons(true);
  // A recording in progress (or one just saved and still uploading) changes under us.
  setInterval(() => { if (liveId || busy.size || uploading || following) refresh(); }, 2000);
  // The server works on an uploaded recording for a few minutes: ask how it is going.
  setInterval(() => { if (following) followLessons(); }, 4000);
  chrome.runtime.onMessage.addListener((message) => {
    if (message && (message.type === 'watch_ended' || message.type === 'watch_upload')) setTimeout(refresh, 300);
    return false;
  });
})();
