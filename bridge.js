/**
 * Runs on the learner app. The module page posts a `frty2:pair` message with
 * the session id, a learner token and the API base; this forwards it to the
 * service worker, which stores it for the Zoho tab. It also answers
 * `frty2:ping` so the page can say whether the extension is installed.
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
  if (data.type === 'frty2:unpair') {
    chrome.runtime.sendMessage({type: 'unpair'}, () => void chrome.runtime.lastError);
  }
});

// Announce presence once, for pages that loaded before the listener.
window.postMessage({type: 'frty2:pong', version: chrome.runtime.getManifest().version}, '*');
