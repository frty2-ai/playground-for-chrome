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
      show('Not paired yet.', '');
      chrome.storage.local.get('frty2_api_base', (stored) => {
        apiEl.value = stored.frty2_api_base || 'http://localhost:8080';
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
