/**
 * The recordings page (watch.html): the one-time permissions a watch needs,
 * the Backstage sign-in used for uploads, and every recording on this
 * computer with download, upload and delete.
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
      New recordings upload into it while you record. No sign-in is needed.`;
    button('Unlink', async () => { await chrome.storage.local.remove('frty2_watch_session'); renderAccount(); refresh(); });
  } else if (current && current.token) {
    $('accountLine').innerHTML = `Signed in as <b>${esc(current.email)}</b> at ${esc(current.api_base)}. New recordings upload while you record.`;
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

const busy = new Set();
let liveId = null;
let uploading = false;          // some recording is still going up: keep the page current

function size(bytes) {
  if (!bytes) return '0 MB';
  return bytes > 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function duration(ms) {
  if (ms === null || ms === undefined) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A recording still marked "recording" that no recorder is running was cut
 *  short (browser closed, extension reloaded). Close it with what arrived. */
async function closeOrphans(recordings) {
  for (const rec of recordings) {
    if (rec.state !== 'recording' || rec.id === liveId) continue;
    const parts = await WatchStore.partsOf(rec.id);
    const last = parts.reduce((max, p) => Math.max(max, p.t || 0), 0);
    const bytes = parts.reduce((sum, p) => sum + (p.size || 0), 0);
    const frames = parts.filter((p) => p.stream === 'frames').length;
    // Counts come from the recorder's last checkpoint (at most 5 s old); the
    // parts themselves are the truth for size, length and frames.
    await WatchStore.updateRecording(rec.id, (r) => ({
      ...r, state: 'interrupted', ended_at: Math.round(r.t0 + last), duration_ms: Math.round(last), bytes,
      counts: {...(r.counts || {}), frames}, end_reason: 'the recorder stopped without saving (browser closed or extension reloaded)',
    }));
  }
}

/** Who uploads a recording: the session it was made for (its link token is
 *  kept with it), else the signed-in author. */
async function uploaderFor(rec) {
  const upload = rec.upload || {};
  if (upload.kind === 'session' && upload.token) return {kind: 'session', api_base: upload.api_base, token: upload.token};
  return account();
}

/** One line about this recording's upload, from its own credential: a
 *  session recording never asks for a sign-in it does not need. */
async function uploadLine(rec) {
  const pending = await WatchStore.countPending(rec.id);
  const upload = rec.upload || {};
  const where = upload.kind === 'session' ? `the expert session “${rec.meta.title || ''}”` : (upload.api_base || 'Frty2');
  if (upload.error && upload.error.code !== 'no_account') return {text: `Upload stopped: ${upload.error.detail}`, kind: 'err', pending};
  if (upload.finished && !pending) return {text: `Uploaded to ${where}${upload.kind === 'session' ? ` (${upload.api_base})` : ''}.`, kind: 'ok', pending};
  const uploader = await uploaderFor(rec);
  if (upload.created || (uploader && rec.state === 'recording')) {
    const text = rec.state === 'recording' ? `Uploading to ${where} while recording: ${pending} part${pending === 1 ? '' : 's'} waiting.`
      : pending ? `Uploading to ${where}: ${pending} part${pending === 1 ? '' : 's'} left.` : `Finishing the upload to ${where}…`;
    return {text, kind: '', pending, uploading: Boolean(uploader)};
  }
  if (uploader) return {text: 'Not uploaded yet.', kind: '', pending};
  return {text: 'On this computer only: it was recorded without an expert session or a sign-in. Sign in above to upload it.', kind: '', pending};
}

async function refresh() {
  const status = await send({type: 'watch_status'});
  liveId = status && status.status && status.status.state !== 'idle' ? status.status.id : null;
  let recordings = await WatchStore.listRecordings();
  await closeOrphans(recordings);
  recordings = await WatchStore.listRecordings();
  const list = $('list');

  if (!recordings.length) {
    list.innerHTML = '<section class="empty">No recordings yet. Open the application you want to teach, click the Frty2 icon and press <b>Start watching this tab</b>.</section>';
    return;
  }
  const highlight = location.hash.slice(1);
  const cards = [];
  let stillUploading = false;
  for (const rec of recordings) {
    const live = rec.id === liveId;
    const badge = live ? '<span class="badge live">● Recording now</span>'
      : rec.state === 'interrupted' ? '<span class="badge cut">Cut short</span>' : '<span class="badge saved">Saved</span>';
    const counts = rec.counts || {};
    const line = await uploadLine(rec);
    if (line.uploading) stillUploading = true;
    const started = new Date(rec.t0).toLocaleString();
    const working = busy.has(rec.id);
    const canUpload = Boolean(await uploaderFor(rec));
    const forSession = rec.meta.session_id ? `<div class="sub">Expert session: ${esc(rec.meta.app || '')} · ${esc(rec.meta.title || '')}</div>` : '';
    cards.push(`
      <section class="rec${rec.id === highlight ? ' current' : ''}" data-id="${esc(rec.id)}">
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
        <div class="upload msg ${line.kind}">${esc(line.text)}</div>
        <div class="row">
          <button data-do="download" ${live || working ? 'disabled' : ''}>Download bundle (.zip)</button>
          <button data-do="upload" class="blue" ${live || working || !canUpload || !line.pending && rec.upload && rec.upload.finished ? 'disabled' : ''}>${working ? 'Working…' : 'Upload now'}</button>
          <button data-do="delete" class="danger" ${live || working ? 'disabled' : ''}>Delete from this computer</button>
        </div>
      </section>`);
  }
  list.innerHTML = cards.join('');
  uploading = stillUploading;
}

$('list').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-do]');
  if (!button) return;
  const id = button.closest('[data-id]').dataset.id;
  const action = button.dataset.do;
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
    busy.add(id); refresh();
    try {
      let current = await uploaderFor(await WatchStore.getRecording(id));
      for (let round = 0; round < 500; round += 1) {
        let result = await WatchStore.sync(id, current, {limit: 40});
        if (!result.ok && result.code === 'signed_out' && current.kind !== 'session') {
          current = await refreshToken(current);
          if (!current) { await chrome.storage.local.remove(EXPERT_KEY); renderAccount(); break; }
          result = await WatchStore.sync(id, current, {limit: 40});
        }
        refresh();
        if (!result.ok || result.finished || !result.pending) break;
      }
    } finally { busy.delete(id); refresh(); }
  }
  if (action === 'delete') {
    const pending = await WatchStore.countPending(id);
    const rec = await WatchStore.getRecording(id);
    const uploaded = rec && rec.upload && rec.upload.finished && !pending;
    const question = uploaded
      ? 'Delete the copy on this computer? The uploaded recording stays on Frty2.'
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
  // A recording in progress (or one just saved and still uploading) changes under us.
  setInterval(() => { if (liveId || busy.size || uploading) refresh(); }, 2000);
  chrome.runtime.onMessage.addListener((message) => {
    if (message && (message.type === 'watch_ended' || message.type === 'watch_upload')) setTimeout(refresh, 300);
    return false;
  });
})();
