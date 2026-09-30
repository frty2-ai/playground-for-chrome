/**
 * Service worker: holds the pairing (session id, learner token, API base) and
 * relays every backend call for the content scripts, so the token never has
 * to live in a page's world and CORS is a non-issue.
 *
 * Messages (from ghost.js / bridge.js / popup.js):
 *   {type: "pair", pairing: {session_id, token, api_base, crm_base, language}}
 *   {type: "pair_with_code", api_base, code}
 *   {type: "get_pairing"}
 *   {type: "unpair"}
 *   {type: "api", method, path, body, multipart}
 *   {type: "speak", url, text, language}  -> resolves when the line has been spoken
 *   {type: "stop_speaking"}
 *
 * It also runs Watch, the recorder experts use to capture a walkthrough (see
 * the "watch" section below and watch-recorder.js), and routes the live
 * tutor (the "tutor" section at the end, tutor.js and tutor-audio.js).
 */

const KEY = 'frty2_pairing';

async function getPairing() {
  const stored = await chrome.storage.local.get(KEY);
  return stored[KEY] || null;
}

async function setPairing(pairing) {
  await chrome.storage.local.set({[KEY]: pairing});
  return pairing;
}

async function clearPairing() {
  await chrome.storage.local.remove(KEY);
}

async function call(pairing, method, path, body, multipart) {
  const headers = {};
  if (pairing && pairing.token) headers.Authorization = `Bearer ${pairing.token}`;
  let payload;
  if (multipart) {
    payload = new FormData();
    for (const [key, value] of Object.entries(body || {})) {
      if (value && value.blob) {
        payload.append(key, new Blob([new Uint8Array(value.blob)], {type: value.type}), value.name);
      } else {
        payload.append(key, value);
      }
    }
  } else if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const base = (pairing && pairing.api_base) || '';
  const response = await fetch(`${base}${path}`, {method, headers, body: payload});
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return {ok: response.ok, status: response.status, data};
}

// ------------------------------------------------------------------ voice
//
// Narration never plays in the Zoho page itself: the page's CSP can forbid
// media from our API, and its autoplay policy can mute a line that starts
// after a network wait. The ElevenLabs clip plays in an offscreen document;
// when there is no clip (voice not configured, budget spent, a line the API
// will not speak) or it cannot play, Chrome's own text-to-speech says it, so
// the guide is never silent.

let creatingOffscreen = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']});
  if (existing.length) return;
  if (!creatingOffscreen) {
    // One document serves both jobs. USER_MEDIA matters: a document whose
    // only reason is AUDIO_PLAYBACK is closed after 30 s without sound, which
    // would end a recording.
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK', 'USER_MEDIA'],
      justification: 'Speak the guide\'s narration; record the tab and microphone while an expert is being watched.',
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

function pickTtsVoice(voices, language) {
  const want = language === 'hi' ? 'hi' : 'en';
  const list = (voices || []).filter((v) => (v.lang || '').toLowerCase().startsWith(want));
  return list.find((v) => /google/i.test(v.voiceName || '') && /-IN$/i.test(v.lang || ''))
    || list.find((v) => /-IN$/i.test(v.lang || ''))
    || list.find((v) => /google/i.test(v.voiceName || ''))
    || list[0] || null;
}

function ttsSpeak(text, language) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    setTimeout(() => done({ok: true, engine: 'tts', timeout: true}), Math.max(45000, text.length * 150));
    chrome.tts.getVoices((voices) => {
      const voice = pickTtsVoice(voices, language);
      const options = {
        lang: (voice && voice.lang) || (language === 'hi' ? 'hi-IN' : 'en-IN'),
        rate: 1.0,
        onEvent: (event) => {
          if (event.type === 'end' || event.type === 'interrupted' || event.type === 'cancelled') done({ok: true, engine: 'tts'});
          else if (event.type === 'error') done({ok: false, error: event.errorMessage || 'tts error'});
        },
      };
      if (voice && voice.voiceName) options.voiceName = voice.voiceName;
      chrome.tts.speak(text, options, () => {
        if (chrome.runtime.lastError) done({ok: false, error: chrome.runtime.lastError.message});
      });
    });
  });
}

async function speak({url, text, language}) {
  // A long line must not outlive the service worker's idle timer.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError), 20000);
  try {
    let clipError = null;
    if (url) {
      try {
        await ensureOffscreen();
        const played = await chrome.runtime.sendMessage({target: 'offscreen', type: 'play', url});
        if (played && played.ok) return played;
        clipError = (played && played.error) || 'no reply from the speaker';
      } catch (error) {
        clipError = String(error && error.message || error);
      }
    }
    if (text) {
      const said = await ttsSpeak(text, language);
      return clipError ? {...said, clip_error: clipError} : said;
    }
    return {ok: false, error: clipError || 'nothing to say'};
  } finally {
    clearInterval(keepAlive);
  }
}

function stopSpeaking() {
  chrome.tts.stop();
  chrome.runtime.sendMessage({target: 'offscreen', type: 'stop'}).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages for the offscreen speaker, recorder and tutor line are not ours to answer.
  if (message && (message.target === 'offscreen' || message.target === 'recorder' || message.target === 'tutor')) return false;
  if (message && typeof message.type === 'string' && message.type.startsWith('tutor_')) return handleTutorMessage(message, sender, sendResponse);
  if (message && typeof message.type === 'string' && message.type.startsWith('watch_')) {
    handleWatchMessage(message, sender).then(sendResponse, (error) => sendResponse({ok: false, error: String(error && error.message || error)}));
    return true;
  }
  (async () => {
    try {
      switch (message.type) {
        case 'pair': {
          const pairing = await setPairing(message.pairing);
          sendResponse({ok: true, pairing});
          break;
        }
        case 'pair_with_code': {
          const result = await call({api_base: message.api_base}, 'POST', '/api/v1/webapps/pair/', {code: message.code});
          if (!result.ok) {
            sendResponse({ok: false, error: (result.data && result.data.detail) || `Pairing failed (${result.status})`});
            break;
          }
          const pairing = await setPairing({
            session_id: result.data.session_id,
            token: result.data.access_token,
            api_base: message.api_base,
            crm_base: result.data.crm_base,
            language: result.data.language,
            paired_at: Date.now(),
          });
          sendResponse({ok: true, pairing});
          break;
        }
        case 'get_pairing': {
          sendResponse({ok: true, pairing: await getPairing()});
          break;
        }
        case 'speak': {
          sendResponse(await speak(message));
          break;
        }
        case 'stop_speaking': {
          stopSpeaking();
          sendResponse({ok: true});
          break;
        }
        case 'unpair': {
          await clearPairing();
          sendResponse({ok: true});
          break;
        }
        case 'api': {
          const pairing = await getPairing();
          if (!pairing) {
            sendResponse({ok: false, status: 0, error: 'not_paired'});
            break;
          }
          const result = await call(pairing, message.method || 'GET', message.path, message.body, message.multipart);
          if (result.status === 401) await clearPairing();
          sendResponse(result);
          break;
        }
        default:
          sendResponse({ok: false, error: `unknown message ${message.type}`});
      }
    } catch (error) {
      sendResponse({ok: false, error: String(error && error.message || error)});
    }
  })();
  return true; // async sendResponse
});

// Tell every Zoho tab when the pairing changes, so a ghost already on the
// page starts without a reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[KEY]) return;
  chrome.tabs.query({url: ['https://crm.zoho.in/*', 'https://crm.zoho.com/*', 'https://crm.zoho.eu/*']}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, {type: 'pairing_changed', pairing: changes[KEY].newValue || null}, () => void chrome.runtime.lastError);
    }
  });
});


// ------------------------------------------------------------------ watch
//
// Watch records an expert using a web application while they explain it. The
// recorder lives in the offscreen document; this worker starts and stops it,
// and turns its heartbeat into what the expert sees: the red frame and pill
// in the watched tab (watch.js), a note in every other tab, and the toolbar
// badge. The rule that makes the cue trustworthy: "watching" is shown only
// while a heartbeat younger than BEAT_FRESH_MS says both recorders are
// running. Anything else reads as paused, trouble, or unknown, never as REC.

const WATCH_KEY = 'frty2_watch';            // chrome.storage.session: survives a worker restart
const EXPERT_KEY = 'frty2_expert';          // chrome.storage.local: upload sign-in {api_base, token, email}
const SESSION_KEY = 'frty2_watch_session';  // chrome.storage.local: the linked expert session {api_base, token, session}
const WATCH_SCRIPT_ID = 'frty2-watch';
const BEAT_FRESH_MS = 1500;                // three missed heartbeats

const watch = {state: 'idle', id: null, tabId: null, startedAt: null, beat: null, beatAt: 0, timer: null, lastError: null, keys: {}};

// The shortcuts Chrome actually assigned: a suggested key that clashes with
// the browser is silently dropped, and experts can rebind them, so the UI
// shows these and never a hard-coded key.
async function loadWatchKeys() {
  const commands = await chrome.commands.getAll();
  watch.keys = Object.fromEntries(commands.filter((c) => c.name.startsWith('watch-') && c.shortcut)
    .map((c) => [c.name.slice('watch-'.length), c.shortcut]));
  return watch.keys;
}
loadWatchKeys();
const watchPorts = new Map();               // port -> {tabId, frameId}

function watchView(tabId) {
  let state = watch.state;
  const beat = watch.beat;
  const fresh = beat && Date.now() - watch.beatAt < BEAT_FRESH_MS;
  if (state === 'recording' || state === 'paused') {
    if (!fresh) state = 'unknown';
    else if (beat.state === 'paused') state = 'paused';
    else if (beat.state === 'stopping') state = 'stopping';
    else state = beat.healthy ? 'recording' : 'trouble';
  }
  return {
    state,
    here: tabId !== null && tabId !== undefined && tabId === watch.tabId,
    watched_tab: watch.tabId,
    id: watch.id,
    elapsed_ms: fresh ? beat.elapsed_ms + (Date.now() - watch.beatAt) * (beat.state === 'recording' ? 1 : 0) : null,
    level: fresh ? beat.level : null,
    speaking: Boolean(fresh && beat.speaking),
    unnarrated: fresh ? beat.unnarrated : 0,
    counts: fresh ? beat.counts : null,
    problems: fresh ? beat.problems : [],
    upload: fresh ? beat.upload : null,
    title: (beat && beat.title) || '',
    error: watch.lastError,
    keys: watch.keys,
    sent_at: Date.now(),
  };
}

function broadcastWatch() {
  for (const [port, info] of watchPorts) {
    try { port.postMessage({type: 'status', status: watchView(info.tabId)}); } catch { watchPorts.delete(port); }
  }
  updateWatchBadge();
}

const BADGES = {
  starting: ['…', '#6b7280', 'Frty2 Watch is starting'],
  recording: ['REC', '#dc2626', 'Frty2 is watching and recording'],
  trouble: ['!', '#f59e0b', 'Frty2 Watch has a problem: open the watched tab'],
  paused: ['||', '#f59e0b', 'Frty2 Watch is paused (private): nothing is recorded'],
  stopping: ['SAVE', '#6b7280', 'Frty2 Watch is saving the recording'],
  unknown: ['?', '#6b7280', 'Frty2 Watch is not answering: it may not be recording'],
};
let badgeShown = null;
function updateWatchBadge() {
  const state = watchView(null).state;
  if (state === badgeShown) return;
  badgeShown = state;
  const badge = BADGES[state];
  chrome.action.setBadgeText({text: badge ? badge[0] : ''});
  if (badge) chrome.action.setBadgeBackgroundColor({color: badge[1]});
  chrome.action.setTitle({title: badge ? badge[2] : 'Frty2 Guide'});
}

async function saveWatch() {
  if (watch.state === 'idle') await chrome.storage.session.remove(WATCH_KEY);
  else await chrome.storage.session.set({[WATCH_KEY]: {state: watch.state, id: watch.id, tabId: watch.tabId, startedAt: watch.startedAt}});
}

function setWatch(patch) {
  Object.assign(watch, patch);
  if (watch.state !== 'idle' && !watch.timer) watch.timer = setInterval(broadcastWatch, 1000);
  if (watch.state === 'idle' && watch.timer) { clearInterval(watch.timer); watch.timer = null; }
  saveWatch();
  broadcastWatch();
}

const recorder = (message) => chrome.runtime.sendMessage({target: 'recorder', ...message});

async function registerWatchScript() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ids: [WATCH_SCRIPT_ID]});
  if (existing.length) return;
  await chrome.scripting.registerContentScripts([{
    id: WATCH_SCRIPT_ID, matches: ['<all_urls>'], js: ['watch.js'], allFrames: true,
    matchOriginAsFallback: true, runAt: 'document_start', persistAcrossSessions: false,
  }]);
}

async function unregisterWatchScript() {
  try { await chrome.scripting.unregisterContentScripts({ids: [WATCH_SCRIPT_ID]}); } catch {}
}

/** Put watch.js where it is needed now: every frame of the watched tab, and
 *  the top of every other page, which then says "watching another tab". */
async function injectWatchScript(tabId) {
  const tabs = await chrome.tabs.query({url: ['http://*/*', 'https://*/*']});
  await Promise.all(tabs.map((tab) => chrome.scripting.executeScript({
    target: {tabId: tab.id, allFrames: tab.id === tabId}, files: ['watch.js'],
  }).catch(() => {})));
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/token|code|secret|key|pass|sig|auth|session/i.test(key)) u.searchParams.set(key, '…');
    }
    return u.toString();
  } catch { return url || ''; }
}

async function startWatch(tabId, meta = {}) {
  if (watch.state !== 'idle') {
    const alive = await recorder({type: 'status'}).catch(() => null);
    if (alive && alive.status && alive.status.state !== 'idle') return {ok: false, error: 'already_watching'};
    setWatch({state: 'idle', id: null, tabId: null, beat: null});
  }
  // Without access to the page its URL is not even readable, so ask first.
  if (!(await chrome.permissions.contains({origins: ['<all_urls>']}))) {
    return {ok: false, error: 'needs_access', detail: 'Watch needs access to the pages you record, to write down what you click.'};
  }
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/.test(tab.url || '')) {
    return {ok: false, error: 'bad_page', detail: 'Open the application you want to record first: browser pages cannot be watched.'};
  }
  setWatch({state: 'starting', tabId, id: null, beat: null, beatAt: 0, lastError: null});
  await loadWatchKeys().catch(() => {});
  try {
    await ensureOffscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId: tabId});
    await registerWatchScript();
    await injectWatchScript(tabId);
    const stored = await chrome.storage.local.get([EXPERT_KEY, SESSION_KEY]);
    const account = stored[EXPERT_KEY] && stored[EXPERT_KEY].token ? stored[EXPERT_KEY] : null;
    // A linked expert session wins: its recordings belong to it.
    const link = stored[SESSION_KEY] && stored[SESSION_KEY].token ? stored[SESSION_KEY] : null;
    const session = link ? link.session : null;
    const upload = link ? {kind: 'session', api_base: link.api_base, token: link.token, session_id: session.id}
      : account ? {kind: 'account', api_base: account.api_base, token: account.token} : null;
    const reply = await recorder({
      type: 'start', streamId, tabId, upload, viewport: {width: tab.width, height: tab.height},
      meta: {
        title: (meta.title || '').trim() || (session && session.title) || tab.title || '',
        intent: (meta.intent || '').trim() || (session && session.brief) || '',
        languages: meta.languages && meta.languages.length ? meta.languages : (session && session.languages) || ['hi', 'en'],
        url: cleanUrl(tab.url), page_title: tab.title || '',
        expert: (session && session.expert_name) || (account ? account.email : null),
        session_id: session ? session.id : null, app: session ? session.app.name : null,
        extension: chrome.runtime.getManifest().version, user_agent: navigator.userAgent,
        started_from: meta.started_from || 'popup',
      },
    });
    if (!reply || !reply.ok) {
      const error = new Error((reply && reply.detail) || (reply && reply.error) || 'The recorder did not start.');
      error.code = reply && reply.error;
      throw error;
    }
    setWatch({state: 'recording', id: reply.id, startedAt: reply.t0});
    return {ok: true, id: reply.id};
  } catch (error) {
    await unregisterWatchScript();
    setWatch({state: 'idle', id: null, tabId: null, beat: null, lastError: error.message});
    return {ok: false, error: error.code || 'start_failed', detail: error.message};
  }
}

async function stopWatch() {
  if (watch.state === 'idle') return {ok: false, error: 'not_watching'};
  setWatch({state: 'stopping'});
  const reply = await recorder({type: 'stop'}).catch((error) => ({ok: false, error: error.message}));
  if (!reply || !reply.ok) watchEnded(null);    // nothing to stop: the recorder is gone
  return reply || {ok: false};
}

async function watchEnded(summary) {
  const id = (summary && summary.id) || watch.id;
  await unregisterWatchScript();
  setWatch({state: 'idle', id: null, tabId: null, beat: null, beatAt: 0});
  if (id) chrome.tabs.create({url: chrome.runtime.getURL(`watch.html#${id}`)});
}

function openWatchSetup(tabId, meta) {
  chrome.storage.session.set({frty2_watch_pending: {tabId, meta}});
  chrome.tabs.create({url: chrome.runtime.getURL('watch.html#setup')});
}

async function handleWatchMessage(message, sender) {
  switch (message.type) {
    case 'watch_start':
      return startWatch(message.tabId, message.meta || {});
    case 'watch_stop':
      return stopWatch();
    case 'watch_pause':
      return recorder({type: 'pause'});
    case 'watch_resume':
      return recorder({type: 'resume'});
    case 'watch_marker':
      return recorder({type: 'marker', marker: message.marker, note: message.note});
    case 'watch_status':
      return {ok: true, status: watchView(message.tabId ?? null)};
    case 'watch_focus': {
      if (watch.tabId === null) return {ok: false};
      const tab = await chrome.tabs.update(watch.tabId, {active: true});
      await chrome.windows.update(tab.windowId, {focused: true});
      return {ok: true};
    }
    case 'watch_heartbeat': {
      // A heartbeat for a recording this worker did not start (it restarted
      // mid-recording) adopts it rather than ignoring it.
      const status = message.status || {};
      if (watch.state === 'idle' && status.state === 'stopping') return {ok: true};   // late, already ended
      const patch = {beat: status, beatAt: Date.now()};
      if (watch.state === 'idle' || watch.state === 'starting' || watch.id !== status.id) {
        Object.assign(patch, {id: status.id, tabId: status.tabId, startedAt: status.started_at});
        if (watch.state !== 'starting') patch.state = 'recording';
      }
      if (status.state === 'stopping') patch.state = 'stopping';
      Object.assign(watch, patch);
      if (patch.state || patch.id) setWatch({}); else broadcastWatch();
      return {ok: true};
    }
    case 'watch_ended':
      await watchEnded(message.summary);
      return {ok: true};
    case 'watch_upload':
      return {ok: true};
    case 'watch_link':
      return linkSession(message.api_base, {token: message.token});
    case 'watch_link_code':
      return linkSession(message.api_base, {code: message.code});
    case 'watch_unlink':
      await chrome.storage.local.remove(SESSION_KEY);
      return {ok: true};
    case 'watch_linked':
      return {ok: true, link: (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY] || null};
    case 'watch_setup_start': {
      const {frty2_watch_pending: pending} = await chrome.storage.session.get('frty2_watch_pending');
      await chrome.storage.session.remove('frty2_watch_pending');
      if (!pending) return {ok: false, error: 'nothing_pending'};
      const result = await startWatch(pending.tabId, pending.meta || {});
      if (result.ok) chrome.tabs.update(pending.tabId, {active: true}).catch(() => {});
      return result;
    }
    default:
      return {ok: false, error: `unknown message ${message.type}`};
  }
}

/** Link Watch to an expert session, by its link token or its short code.
 *  The server is asked either way, so only a live session is ever stored. */
async function linkSession(apiBase, {token, code}) {
  const base = (apiBase || '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(base)) return {ok: false, error: 'bad_api', detail: 'That is not an API address.'};
  let response;
  try {
    response = token
      ? await fetch(`${base}/api/v1/webapps/capture-link/${encodeURIComponent(token)}/`)
      : await fetch(`${base}/api/v1/webapps/capture-pair/`, {method: 'POST', headers: {'Content-Type': 'application/json'},
                                                              body: JSON.stringify({code})});
  } catch (error) {
    return {ok: false, error: 'offline', detail: `Cannot reach ${base} (${error.message}).`};
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return {ok: false, error: data.reason || 'refused', detail: data.detail || `Linking failed (${response.status}).`};
  const {token: pairedToken, ...session} = data;
  const link = {api_base: base, token: token || pairedToken, session, linked_at: Date.now()};
  await chrome.storage.local.set({[SESSION_KEY]: link, frty2_api_base: base});
  return {ok: true, link};
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'frty2-watch') return;
  const info = {tabId: port.sender && port.sender.tab ? port.sender.tab.id : null, frameId: port.sender ? port.sender.frameId : null};
  watchPorts.set(port, info);
  port.onDisconnect.addListener(() => watchPorts.delete(port));
  port.onMessage.addListener(async (message) => {
    if (!message || message.type !== 'control') return;
    const actions = {
      stop: () => stopWatch(),
      pause: () => recorder({type: 'pause'}),
      resume: () => recorder({type: 'resume'}),
      marker: () => recorder({type: 'marker', marker: message.marker, note: message.note}),
      focus: () => handleWatchMessage({type: 'watch_focus'}),
    };
    const run = actions[message.action];
    const reply = run ? await run().catch((error) => ({ok: false, error: error.message})) : {ok: false};
    try { port.postMessage({type: 'control_done', action: message.action, marker: message.marker, ok: Boolean(reply && reply.ok)}); } catch {}
  });
  try { port.postMessage({type: 'status', status: watchView(info.tabId)}); } catch {}
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'watch-toggle') {
    if (watch.state === 'idle') {
      if (!tab) return;
      const result = await startWatch(tab.id, {started_from: 'shortcut'});
      if (!result.ok && (result.error === 'needs_mic' || result.error === 'needs_access')) openWatchSetup(tab.id, {started_from: 'shortcut'});
    } else {
      await stopWatch();
    }
    return;
  }
  if (watch.state === 'idle') return;
  if (command === 'watch-step') recorder({type: 'marker', marker: 'step'}).catch(() => {});
  if (command === 'watch-mistake') recorder({type: 'marker', marker: 'mistake'}).catch(() => {});
  if (command === 'watch-private') {
    const view = watchView(null);
    recorder({type: view.state === 'paused' ? 'resume' : 'pause'}).catch(() => {});
  }
});

// A worker that restarts mid-recording finds the recorder again, or learns
// that it is gone (the recordings page then shows that recording as cut short).
(async () => {
  const stored = (await chrome.storage.session.get(WATCH_KEY))[WATCH_KEY];
  if (!stored) { updateWatchBadge(); return; }
  Object.assign(watch, {state: stored.state, id: stored.id, tabId: stored.tabId, startedAt: stored.startedAt});
  const alive = await recorder({type: 'status'}).catch(() => null);
  if (alive && alive.status && alive.status.state !== 'idle') {
    setWatch({beat: alive.status, beatAt: Date.now()});
  } else {
    await unregisterWatchScript();
    setWatch({state: 'idle', id: null, tabId: null, beat: null});
  }
})();


// ------------------------------------------------------------------ tutor
//
// The live tutor (docs/plan/module-agents.md §12): a voice that teaches a
// byte in the learner's own app tab while a cursor shows it. Three parts:
// tutor.js in that tab (cursor, DOM events, panel), tutor-audio.js in the
// offscreen document (the WebSocket, microphone and speaker), and this
// worker, which starts and stops it and routes JSON between the two by tab.
// Audio never passes through here.
//
// Messages:
//   from bridge.js:        tutor_start {api_base, token, byte_id, language, app_url, mode?} -> {ok, error?, detail?, mic?}
//                          tutor_stop
//   from tutor.js:         tutor_hello -> {active, cache, actions, overlays, paused, nav_by_tutor}
//                          tutor_send {msg}           JSON for the server
//                          tutor_capture {max}        -> {ok, data} the visible tab, JPEG base64
//                          tutor_nav {id, url}        a navigate action is leaving this page
//                          tutor_open_setup, tutor_need_eyes (the start card was clicked)
//   from tutor-audio.js:   tutor_from_audio {tabId, msg}   relayed to the tab as {type: "tutor_msg", msg}
// To tutor.js also: {type: "tutor_end", reason}.

const TUTOR_KEY = 'frty2_tutor';            // chrome.storage.session: survives a worker restart
// Injected in this order on every page of the tutor's tab: placement, the
// on-screen text, then the tutor (which uses both).
const TUTOR_FILES = ['vendor/floating-ui/floating-ui.core.umd.min.js', 'vendor/floating-ui/floating-ui.dom.umd.min.js',
                     'vendor/fira-code-nerd/fira-code-nerd.js', 'brand.js', 'tutor-overlay.js', 'tutor.js'];
const TUTOR_CACHED = new Set(['ready', 'state', 'link', 'bye', 'error']);

let tutor = null;                          // {tabId, api_base, byte_id, language, origin, cache, actions, paused, pendingNav, navByTutor}
const tutorLoaded = chrome.storage.session.get(TUTOR_KEY).then((stored) => { tutor = stored[TUTOR_KEY] || tutor; }).catch(() => {});
let tutorSaveTimer = null;

function saveTutor(soon) {
  clearTimeout(tutorSaveTimer);
  const write = () => (tutor ? chrome.storage.session.set({[TUTOR_KEY]: tutor}) : chrome.storage.session.remove(TUTOR_KEY)).catch(() => {});
  if (soon) { tutorSaveTimer = setTimeout(write, 500); return Promise.resolve(); }
  return write();
}

const toTutorAudio = (message) => chrome.runtime.sendMessage({target: 'tutor', ...message});
const toTutorTab = (tabId, message) => chrome.tabs.sendMessage(tabId, message, () => void chrome.runtime.lastError);

function tutorSocketUrl(apiBase) {
  const url = new URL(apiBase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ws/webapps/tutor/`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** What a page loaded later needs to redraw the panel: the last of each kind;
 *  and to carry on the demonstration: every action not answered yet, marked
 *  `due` once the player said its moment came. The server sends a beat's
 *  actions before the previous beat's click has run, so when that click
 *  leaves the page they must outlive it. */
function noteTutor(msg) {
  if (!tutor || !msg || typeof msg.type !== 'string') return;
  const actions = tutor.actions || (tutor.actions = []);
  if (msg.type === 'overlay') {
    noteOverlay(msg);
  } else if (msg.type === 'action' && msg.id !== undefined && msg.id !== null) {
    if (!actions.some((x) => x.msg.id === msg.id)) actions.push({msg, due: !msg.when || msg.when === 'now'});
    if (actions.length > 50) actions.splice(0, actions.length - 50);
    saveTutor(true);
  } else if (msg.type === 'playback' && Array.isArray(msg.ids) && msg.ids.length && (msg.status === 'started' || msg.status === 'ended')) {
    for (const x of actions) if (msg.ids.includes(x.msg.id)) x.due = true;
    if (msg.status === 'started') for (const x of actions) x.heard = true;
    if (msg.status === 'started') for (const x of Object.values(tutor.overlays || {})) if (msg.ids.includes(x.msg.id)) x.due = true;
    saveTutor(true);
  } else if (msg.type === 'playback' && msg.status === 'started') {
    for (const x of actions) x.heard = true;     // their turn's speech has begun
    saveTutor(true);
  } else if (msg.type === 'speech' && msg.status === 'interrupted') {
    // The player forgot them; the page answers the ones it holds.
    tutor.actions = actions.filter((x) => x.due);
    if (tutor.overlays) delete tutor.overlays.label;
    saveTutor(true);
  }
  let key = null;
  if (TUTOR_CACHED.has(msg.type)) key = msg.type;
  else if (msg.type === 'caption' && msg.final !== false) key = `caption_${msg.who === 'learner' ? 'learner' : 'tutor'}`;
  else if (msg.type === 'mic' && !['on', 'paused', 'muted'].includes(msg.status)) key = 'mic';
  if (key) { tutor.cache[key] = msg; saveTutor(true); }
  if (msg.type === 'link' && msg.status === 'closed') stopTutor('closed', {sendStop: false});
}

/** The on-screen text a page loaded later must redraw: the latest overlay in
 *  each slot, and whether its moment (its line's first sound) has come. */
function noteOverlay(msg) {
  const slots = tutor.overlays || (tutor.overlays = {});
  if (msg.op === 'show' && msg.slot) {
    slots[msg.slot] = {msg, due: msg.when !== 'speech_start'};
  } else if (msg.op === 'update') {
    for (const x of Object.values(slots)) if (x.msg.id === msg.id) x.msg = {...x.msg, ...msg, op: 'show', type: 'overlay'};
  } else if (msg.op === 'hide') {
    for (const [slot, x] of Object.entries(slots)) if (x.msg.id === msg.id) delete slots[slot];
  } else if (msg.op === 'clear') {
    if (msg.scope === 'all') tutor.overlays = {}; else delete slots.label;
  }
  saveTutor(true);
}

async function waitForLoad(tabId, ms = 20000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return tab;
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); chrome.tabs.get(tabId).then(resolve, () => resolve(null)); }
    function listener(id, info) { if (id === tabId && info.status === 'complete') done(); }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** The tab to teach in: the page that asked, if it is the app; else an open
 *  tab of the app; else a new one on app_url. */
async function tutorTab(appUrl, senderTab) {
  const origin = new URL(appUrl).origin;
  const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };
  let tab = senderTab && originOf(senderTab.url) === origin ? senderTab : null;
  if (!tab) tab = (await chrome.tabs.query({})).find((t) => originOf(t.url) === origin) || null;
  if (!tab) tab = await chrome.tabs.create({url: appUrl, active: true, ...(senderTab ? {windowId: senderTab.windowId} : {})});
  tab = await waitForLoad(tab.id);
  if (!tab) throw new Error('The app tab closed before it loaded.');
  await chrome.tabs.update(tab.id, {active: true});
  await chrome.windows.update(tab.windowId, {focused: true}).catch(() => {});
  return tab;
}

async function startTutor(message, sender) {
  const apiBase = String(message.api_base || '').replace(/\/$/, '');
  const appUrl = String(message.app_url || '');
  if (!/^https?:\/\//.test(apiBase)) return {ok: false, error: 'bad_api', detail: 'That is not an API address.'};
  if (!/^https?:\/\//.test(appUrl)) return {ok: false, error: 'bad_app', detail: 'The app address must start with http(s)://.'};
  if (!message.token || message.byte_id === undefined || message.byte_id === null) return {ok: false, error: 'bad_request', detail: 'token and byte_id are required.'};
  await tutorLoaded;
  const origin = new URL(appUrl).origin;
  // Without access to the app's pages the tutor cannot run there. A request
  // needs a click on an extension page, so the setup page asks (as for Watch).
  if (!(await chrome.permissions.contains({origins: [`${origin}/*`]}))) {
    chrome.tabs.create({url: chrome.runtime.getURL('watch.html#setup')});
    return {ok: false, error: 'needs_access', detail: `Frty2 needs access to ${origin}: allow it on the page that just opened, then start the tutor again.`};
  }
  if (tutor) await stopTutor('replaced');
  try {
    const tab = await tutorTab(appUrl, sender && sender.tab);
    tutor = {tabId: tab.id, api_base: apiBase, byte_id: message.byte_id, language: message.language || 'en', origin,
             cache: {}, actions: [], overlays: {}, paused: false, pendingNav: null, navByTutor: false, started_at: Date.now()};
    await saveTutor();
    await chrome.scripting.executeScript({target: {tabId: tab.id}, files: TUTOR_FILES});
    const [{result: page}] = await chrome.scripting.executeScript({
      target: {tabId: tab.id}, func: () => ({url: location.href, title: document.title, viewport: [innerWidth, innerHeight]}),
    });
    await ensureOffscreen();
    const hello = {type: 'hello', token: message.token, byte_id: message.byte_id, language: tutor.language,
                   page: {url: cleanUrl(page.url), title: page.title, viewport: page.viewport},
                   // For the run's trace: which build and browser this was.
                   client: {extension: chrome.runtime.getManifest().version, user_agent: navigator.userAgent,
                            languages: navigator.languages},
                   ...(message.mode === 'demo' || message.mode === 'follow' ? {mode: message.mode} : {})};
    const reply = await toTutorAudio({type: 'connect', url: tutorSocketUrl(apiBase), hello, tabId: tab.id});
    if (!reply || !reply.ok) {
      await stopTutor('connect_failed', {sendStop: false});
      return {ok: false, error: (reply && reply.error) || 'offline', detail: (reply && reply.detail) || 'The tutor server did not answer.'};
    }
    return {ok: true, mic: reply.mic, tab_id: tab.id};
  } catch (error) {
    await stopTutor('start_failed', {sendStop: false});
    return {ok: false, error: 'start_failed', detail: String(error && error.message || error)};
  }
}

async function stopTutor(reason, {sendStop = true} = {}) {
  await tutorLoaded;
  if (!tutor) return {ok: false, error: 'not_running'};
  const {tabId} = tutor;
  tutor = null;
  await saveTutor();
  if (sendStop) await toTutorAudio({type: 'send', msg: {type: 'control', action: 'stop'}}).catch(() => {});
  await toTutorAudio({type: 'close', reason}).catch(() => {});
  toTutorTab(tabId, {type: 'tutor_end', reason});
  return {ok: true};
}

const EYES_ASKED_KEY = 'frty2_tutor_eyes_asked';

/** The tutor sees the learner's screen (captureVisibleTab) only with access
 *  to all sites: access to the app's own host is not enough. Asked once, in a
 *  small window over the lesson, when the learner first starts one. */
async function askForEyes() {
  if (await chrome.permissions.contains({origins: ['<all_urls>']})) return {ok: true, has: true};
  const asked = (await chrome.storage.local.get(EYES_ASKED_KEY))[EYES_ASKED_KEY];
  if (asked) return {ok: true, has: false, asked: true};
  await chrome.storage.local.set({[EYES_ASKED_KEY]: Date.now()});
  await chrome.windows.create({url: chrome.runtime.getURL('watch.html#eyes'), type: 'popup', width: 460, height: 340,
                               focused: true});
  return {ok: true, has: false, asked: false};
}

/** The visible tab as JPEG, its long side at most `max`, base64 without a prefix. */
async function captureTutorFrame(tabId, max) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) return {ok: false, error: 'tab_hidden'};
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'jpeg', quality: 80});
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  let bytes;
  if (scale < 1) {
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bytes = new Uint8Array(await (await canvas.convertToBlob({type: 'image/jpeg', quality: 0.8})).arrayBuffer());
  } else {
    bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
  }
  bitmap.close();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {ok: true, data: btoa(binary)};
}

function answeredTutorAction(id) {
  if (!tutor || !tutor.actions) return;
  const before = tutor.actions.length;
  tutor.actions = tutor.actions.filter((x) => x.msg.id !== id);
  if (tutor.actions.length !== before) saveTutor(true);
}

function handleTutorMessage(message, sender, sendResponse) {
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  // The two hot paths stay synchronous, so messages keep their order.
  if (message.type === 'tutor_from_audio') {
    toTutorTab(message.tabId, {type: 'tutor_msg', msg: message.msg});
    noteTutor(message.msg);
    return false;
  }
  if (message.type === 'tutor_send') {
    const msg = message.msg;
    toTutorAudio({type: 'send', msg, tabId}).catch(() => {});
    if (msg && msg.type === 'action_done' && tutor && tutor.tabId === tabId) answeredTutorAction(msg.id);
    if (msg && msg.type === 'overlay_event' && ['dismiss', 'hidden'].includes(msg.event) && tutor && tutor.tabId === tabId) {
      noteOverlay({op: 'hide', id: msg.id});
    }
    if (msg && msg.type === 'overlay_event' && msg.event === 'click' && String(msg.button || '').startsWith('start_') && tutor) {
      noteOverlay({op: 'hide', id: msg.id});
    }
    if (msg && msg.type === 'control' && tutor && tutor.tabId === tabId) {
      if (msg.action === 'pause' || msg.action === 'resume') { tutor.paused = msg.action === 'pause'; saveTutor(true); }
      if (msg.action === 'stop') stopTutor('stopped', {sendStop: false});
    }
    return false;
  }
  const reply = (promise) => { promise.then(sendResponse, (error) => sendResponse({ok: false, error: String(error && error.message || error)})); return true; };
  switch (message.type) {
    case 'tutor_start':
      return reply(startTutor(message, sender));
    case 'tutor_stop':
      return reply(stopTutor('stopped'));
    case 'tutor_hello':
      return reply(tutorLoaded.then(() => {
        if (!tutor || tutor.tabId !== tabId) return {active: false};
        const answer = {active: true, cache: Object.values(tutor.cache), actions: tutor.actions || [], paused: tutor.paused,
                        nav_by_tutor: tutor.navByTutor, overlays: Object.values(tutor.overlays || {})};
        tutor.navByTutor = false;
        return answer;
      }));
    case 'tutor_capture':
      if (!tutor || tutor.tabId !== tabId) { sendResponse({ok: false, error: 'not_the_tutor_tab'}); return false; }
      return reply(captureTutorFrame(tabId, Math.max(64, Number(message.max) || 768)));
    case 'tutor_nav':
      if (tutor && tutor.tabId === tabId) { tutor.pendingNav = message.id === null ? null : {id: message.id, url: message.url, at: Date.now()}; saveTutor(); }
      sendResponse({ok: true});
      return false;
    case 'tutor_open_setup':
      chrome.tabs.create({url: chrome.runtime.getURL('watch.html#setup')});
      sendResponse({ok: true});
      return false;
    case 'tutor_need_eyes':
      askForEyes().then(sendResponse, () => sendResponse({ok: false}));
      return true;
    default:
      sendResponse({ok: false, error: `unknown message ${message.type}`});
      return false;
  }
}

// A page load in the tutor's tab: put tutor.js back (the socket stays open in
// the offscreen document) and settle a navigate action that caused it.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  await tutorLoaded;
  if (!tutor || tutor.tabId !== tabId) return;
  const nav = tutor.pendingNav;
  tutor.pendingNav = null;
  tutor.navByTutor = Boolean(nav);
  if (nav) answeredTutorAction(nav.id);      // answered below, not replayed by the new page
  saveTutor();
  let injected = true;
  try {
    await chrome.scripting.executeScript({target: {tabId}, files: TUTOR_FILES});
  } catch {
    injected = false;                        // a page Frty2 has no access to, or a browser page
  }
  if (nav) {
    toTutorAudio({type: 'send', tabId, msg: {type: 'action_done', id: nav.id, ok: injected, detail: injected ? 'loaded' : 'no_access'}}).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await tutorLoaded;
  if (tutor && tutor.tabId === tabId) stopTutor('tab_closed');
});
