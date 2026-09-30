/**
 * The guide's speaker. An offscreen document (reason AUDIO_PLAYBACK) owned by
 * the extension, so narration plays whatever Zoho's page CSP says about media
 * and without waiting for a click on the page.
 *
 * Messages (from background.js only, marked `target: "offscreen"`):
 *   {type: "play", url}  -> resolves when the clip ends, fails or is replaced
 *   {type: "stop"}
 */

let current = null;

function stop(reason) {
  if (!current) return;
  const {audio, done} = current;
  current = null;
  try { audio.pause(); } catch {}
  done({ok: true, stopped: reason});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;
  if (message.type === 'stop') {
    stop('stopped');
    sendResponse({ok: true});
    return false;
  }
  if (message.type === 'play') {
    stop('replaced');
    const audio = new Audio(message.url);
    const started = Date.now();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (current && current.audio === audio) current = null;
      sendResponse({...result, ms: Date.now() - started});
    };
    current = {audio, done};
    audio.addEventListener('ended', () => done({ok: true, engine: 'elevenlabs'}));
    audio.addEventListener('error', () => done({ok: false, error: `audio error ${audio.error ? audio.error.code : ''}`.trim()}));
    audio.play().catch((error) => done({ok: false, error: String(error && error.message || error)}));
    return true;
  }
  return false;
});
