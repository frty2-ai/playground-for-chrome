/**
 * Runs on the learner app. The module page posts a `frty2:pair` message with
 * the session id, a learner token and the API base; this forwards it to the
 * service worker, which stores it for the Zoho tab. It also answers
 * `frty2:ping` so the page can say whether the extension is installed, and
 * `frty2:watch_session` (Backstage's "Record on this computer" and the
 * public recording page), which links Watch to an expert session, and
 * `frty2:tutor_start` / `frty2:tutor_stop` (Backstage's "Try it in the app"),
 * which start the live tutor in the byte's app tab (optional `mode`: "demo",
 * the tutor does each step, or "follow", the learner does it after the
 * tutor's line); the page hears back `frty2:tutor_started {ok, error?, detail?, mic?}`.
 */

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'frty2:ping') {
    // The page says which Frty2 API it talks to; the popup's manual pairing
    // form is pre-filled with it, so nobody has to know the address.
    if (typeof data.api_base === 'string' && /^https?:\/\//.test(data.api_base)) {
      chrome.storage.local.set({frty2_api_base: data.api_base.replace(/\/$/, '')});
    }
    window.postMessage({type: 'frty2:pong', version: chrome.runtime.getManifest().version}, '*');
    return;
  }
  if (data.type === 'frty2:pair' && data.pairing && data.pairing.session_id && data.pairing.token) {
    chrome.runtime.sendMessage({type: 'pair', pairing: {...data.pairing, paired_at: Date.now()}}, (reply) => {
      window.postMessage({type: 'frty2:paired', ok: Boolean(reply && reply.ok), session_id: data.pairing.session_id}, '*');
    });
    return;
  }
  // Backstage (or the public recording page) links Watch to an expert
  // session: recordings then upload into that session with its link token.
  if (data.type === 'frty2:watch_session' && typeof data.token === 'string' && typeof data.api_base === 'string') {
    chrome.runtime.sendMessage({type: 'watch_link', api_base: data.api_base.replace(/\/$/, ''), token: data.token}, (reply) => {
      void chrome.runtime.lastError;
      window.postMessage({type: 'frty2:watch_linked', ok: Boolean(reply && reply.ok), error: reply && (reply.detail || reply.error),
                          session: reply && reply.link ? reply.link.session : null}, '*');
    });
    return;
  }
  // The live tutor: the service worker opens (or finds) the app's tab and
  // connects; the reply says whether it did and whether the mic is on.
  if (data.type === 'frty2:tutor_start' && typeof data.api_base === 'string' && typeof data.token === 'string' && typeof data.app_url === 'string') {
    chrome.runtime.sendMessage({type: 'tutor_start', api_base: data.api_base, token: data.token, byte_id: data.byte_id,
                                language: data.language || 'en', app_url: data.app_url,
                                ...(typeof data.mode === 'string' ? {mode: data.mode} : {})}, (reply) => {
      void chrome.runtime.lastError;
      window.postMessage({type: 'frty2:tutor_started', ok: Boolean(reply && reply.ok), error: reply && reply.error,
                          detail: reply && reply.detail, mic: reply && reply.mic}, '*');
    });
    return;
  }
  if (data.type === 'frty2:tutor_stop') {
    chrome.runtime.sendMessage({type: 'tutor_stop'}, () => void chrome.runtime.lastError);
    return;
  }
  if (data.type === 'frty2:unpair') {
    chrome.runtime.sendMessage({type: 'unpair'}, () => void chrome.runtime.lastError);
  }
});

// Announce presence once, for pages that loaded before the listener.
window.postMessage({type: 'frty2:pong', version: chrome.runtime.getManifest().version}, '*');
