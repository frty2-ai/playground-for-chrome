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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
