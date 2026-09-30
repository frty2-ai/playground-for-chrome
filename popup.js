// The hosted Frty2 API. The lesson page announces the one it actually uses
// (bridge.js stores it as `frty2_api_base`), so this is only the last resort.
const DEFAULT_API = 'https://api.frty2.wawm.ai';

const statusEl = document.getElementById('status');
const apiEl = document.getElementById('api');
const codeEl = document.getElementById('code');

function show(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status ${kind || ''}`;
}

function refresh() {
  chrome.runtime.sendMessage({type: 'get_pairing'}, (reply) => {
    const pairing = reply && reply.pairing;
    if (pairing) {
      show(`Paired with session #${pairing.session_id} (${pairing.language === 'hi' ? 'Hindi' : 'English'}). Open your Zoho CRM tab.`, 'ok');
      apiEl.value = pairing.api_base || '';
    } else {
      show('Not paired yet. Open your lesson page and press “Connect the guide”; use the form below only if that button does nothing.', '');
      chrome.storage.local.get('frty2_api_base', (stored) => {
        apiEl.value = stored.frty2_api_base || DEFAULT_API;
      });
    }
  });
}

document.getElementById('pair').addEventListener('click', () => {
  const api_base = apiEl.value.trim().replace(/\/$/, '');
  const code = codeEl.value.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!api_base || !code) return show('Enter the API address and the code.', 'err');
  chrome.storage.local.set({frty2_api_base: api_base});
  show('Pairing…');
  chrome.runtime.sendMessage({type: 'pair_with_code', api_base, code}, (reply) => {
    if (reply && reply.ok) refresh(); else show(reply && reply.error || 'Could not pair.', 'err');
  });
});

document.getElementById('unpair').addEventListener('click', () => {
  chrome.runtime.sendMessage({type: 'unpair'}, refresh);
});

refresh();

// ------------------------------------------------------------------ watch

const w = (id) => document.getElementById(id);
const watchSend = (message) => chrome.runtime.sendMessage(message).catch((error) => ({ok: false, error: error.message}));
let activeTab = null;

function watchError(text) {
  w('wMsg').hidden = !text;
  w('wMsg').textContent = text || '';
}

function clock(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

async function micState() {
  try { return (await navigator.permissions.query({name: 'microphone'})).state; } catch { return 'prompt'; }
}

async function refreshWatch() {
  const reply = await watchSend({type: 'watch_status', tabId: activeTab ? activeTab.id : null});
  const s = (reply && reply.status) || {state: 'idle'};
  const idle = s.state === 'idle';
  w('watchIdle').hidden = !idle;
  w('watchLive').hidden = idle;
  if (idle) {
    if (s.error) watchError(`The last watch did not start: ${s.error}`);
    return;
  }
  const labels = {recording: 'Watching', trouble: 'Watching, with a problem', paused: 'Private: paused', unknown: 'Not confirmed',
                  starting: 'Starting…', stopping: 'Saving…'};
  w('wLive').className = `live ${s.state}`;
  w('wState').textContent = `${labels[s.state] || s.state}${s.here ? '' : ' (another tab)'}`;
  w('wTime').textContent = typeof s.elapsed_ms === 'number' ? clock(s.elapsed_ms) : '';
  const note = s.state === 'trouble' ? (s.problems || [])[0] : s.state === 'unknown' ? 'No signal from the recorder: it may not be recording.' : '';
  w('wNote').hidden = !note;
  w('wNote').textContent = note || '';
  const live = s.state === 'recording' || s.state === 'trouble' || s.state === 'paused';
  w('wHere').hidden = !live;
  w('wPause').textContent = s.state === 'paused' ? 'Resume' : 'Private';
  w('wGo').hidden = s.here;
}

let linked = null;

async function refreshLink() {
  const reply = await watchSend({type: 'watch_linked'});
  linked = reply && reply.link;
  const session = linked && linked.session;
  w('wSession').hidden = !session;
  w('wFree').hidden = Boolean(session);
  w('wCodeBox').hidden = Boolean(session);
  if (session) {
    w('wSessionTitle').textContent = session.title;
    let host = linked.api_base;
    try { host = new URL(linked.api_base).host; } catch {}
    w('wSessionApp').textContent = `${session.app.name}${session.expert_name ? ` · ${session.expert_name}` : ''} · uploads to ${host}`;
    w('wSessionBrief').textContent = session.brief || '';
    w('wSessionBrief').hidden = !session.brief;
    w('wHow').textContent = 'Open the app, then start. Explain out loud what you do and why.';
  }
  const {frty2_api_base: api} = await chrome.storage.local.get('frty2_api_base');
  if (!w('wApi').value) w('wApi').value = api || DEFAULT_API;
}

w('wOpenApp').addEventListener('click', async () => {
  const url = linked && linked.session && linked.session.app.start_url;
  if (!url) return;
  // Into this tab when it is empty or not a web page; otherwise a new one.
  if (activeTab && !/^https?:/.test(activeTab.url || '')) await chrome.tabs.update(activeTab.id, {url});
  else await chrome.tabs.create({url});
  window.close();
});
w('wUnlink').addEventListener('click', async () => { await watchSend({type: 'watch_unlink'}); refreshLink(); });
w('wLink').addEventListener('click', async () => {
  watchError('');
  const code = w('wCode').value.trim();
  if (!code) return watchError('Enter the session code.');
  const reply = await watchSend({type: 'watch_link_code', api_base: w('wApi').value.trim(), code});
  if (!reply || !reply.ok) return watchError((reply && (reply.detail || reply.error)) || 'Could not link.');
  w('wCode').value = '';
  refreshLink();
});

w('wStart').addEventListener('click', async () => {
  watchError('');
  // A linked session supplies what is shown and in which languages.
  const meta = linked && linked.session ? {started_from: 'popup'} : {
    title: w('wTitle').value.trim(),
    languages: w('wLang').value.split(','),
    started_from: 'popup',
  };
  const access = await chrome.permissions.contains({origins: ['<all_urls>']});
  const mic = await micState();
  if (!access || mic !== 'granted') {
    // Permission prompts do not survive in a popup: a full page asks, then starts.
    await chrome.storage.session.set({frty2_watch_pending: {tabId: activeTab.id, meta}});
    chrome.tabs.create({url: chrome.runtime.getURL('watch.html#setup')});
    window.close();
    return;
  }
  w('wStart').disabled = true;
  w('wStart').textContent = 'Starting…';
  const reply = await watchSend({type: 'watch_start', tabId: activeTab.id, meta});
  w('wStart').disabled = false;
  w('wStart').textContent = '● Start watching this tab';
  if (reply && reply.ok) { window.close(); return; }
  if (reply && (reply.error === 'needs_mic' || reply.error === 'needs_access')) {
    await chrome.storage.session.set({frty2_watch_pending: {tabId: activeTab.id, meta}});
    chrome.tabs.create({url: chrome.runtime.getURL('watch.html#setup')});
    window.close();
    return;
  }
  watchError((reply && (reply.detail || reply.error)) || 'The watch did not start.');
});

w('wStop').addEventListener('click', async () => { await watchSend({type: 'watch_stop'}); window.close(); });
w('wStep').addEventListener('click', () => watchSend({type: 'watch_marker', marker: 'step'}));
w('wPause').addEventListener('click', async () => {
  await watchSend({type: w('wPause').textContent === 'Resume' ? 'watch_resume' : 'watch_pause'});
  refreshWatch();
});
w('wGo').addEventListener('click', async () => { await watchSend({type: 'watch_focus'}); window.close(); });
w('wLibrary').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.tabs.create({url: chrome.runtime.getURL('watch.html')});
  window.close();
});

(async () => {
  [activeTab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (activeTab && !/^https?:/.test(activeTab.url || '')) {
    w('wStart').disabled = true;
    w('wStart').title = 'Open the application you want to record first.';
  }
  const {frty2_expert: expert, frty2_watch_session: link} = await chrome.storage.local.get(['frty2_expert', 'frty2_watch_session']);
  w('wAccount').textContent = link ? 'Uploads into the linked session'
    : expert && expert.token ? `Uploads as ${expert.email}` : 'Recordings stay on this computer';
  await refreshLink();
  refreshWatch();
  setInterval(refreshWatch, 500);
})();
