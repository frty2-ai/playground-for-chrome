/**
 * The live tutor's line to the backend, in the offscreen document (next to
 * the guide's speaker and the Watch recorder, which it does not touch).
 *
 * It holds the WebSocket (`ws(s)://<api>/ws/webapps/tutor/`, protocol in
 * docs/plan/module-agents.md §12.4), because the offscreen document outlives
 * page loads in the learner's tab and the service worker's idle timer:
 *   - microphone: getUserMedia (echo cancellation, noise suppression, AGC) →
 *     tutor-mic-worklet.js → 40 ms frames of 16 kHz PCM16, sent as binary
 *     frames tagged 0x01; nothing is sent while the learner has paused, nor
 *     frames of exact digital silence (a muted input: the panel says so);
 *   - speaker: binary frames tagged 0x02 (24 kHz PCM16) are scheduled back to
 *     back on one Web Audio clock, so consecutive chunks and turns play
 *     without gaps; `speech {status: "interrupted"}` flushes everything;
 *   - JSON both ways, relayed to and from tutor.js through the service worker.
 *
 * Timing is decided here, because only this document knows when a sound
 * actually plays. An `action` with `when: "speech_start"` belongs to the next
 * audio chunk that arrives after it; one with `when: "speech_end"` belongs to
 * the end of the turn whose audio started after it: when that turn's `speech
 * {status: "end"}` comes in, at the end of the audio received so far. (The
 * server sends a beat's actions before the model has said a word of it, often
 * while the previous line is still playing, and the model can take seconds to
 * start: an action is never bound to speech that began before it arrived.) At those moments (on the audio clock) the page is told
 * `playback {status: "started" | "ended", ids}` and runs the actions. It is
 * also told `started` when sound begins after silence and `drained` when the
 * queue runs dry; `drained` goes to the server as well.
 *
 * Messages (`target: "tutor"`, from the service worker):
 *   connect {url, hello, tabId}  -> {ok, mic: "on" | "needs_mic" | "error", error?, detail?}
 *   send {msg, tabId}            JSON for the server (a control message also pauses the mic, or ends)
 *   close {reason}
 *   status                       -> {ok, state}
 * To the service worker: {type: "tutor_from_audio", tabId, msg}, where msg is a
 * server message or one of this document's own:
 *   playback {status, ids?, flushed?}, link {status, detail?}, mic {status: on|paused|muted|needs_mic|error, level?, detail?}
 *
 * Protocol 3 (docs/plan/tutor-floor.md §3.8): `speech {status: "start", turn}`
 * numbers the model's turns; the audio after it belongs to that turn. A flush
 * reports `playback drained {flushed, heard: {turn: ms}, total: {turn: ms}}`,
 * how much of each turn the learner actually heard, so the lesson knows
 * whether a line must be said again. `mic {status: "silent"}` goes to the
 * server once the input has sent exact silence for a second (a mute), and
 * `mic {status: "live"}` when sound returns: the server then tells the model
 * the audio stream ended, so a turn left open closes.
 */

(() => {
  const TAG_MIC = 0x01;
  const TAG_SPEAKER = 0x02;
  const SPEAKER_RATE = 24000;
  // The live model streams speech at about real time (measured 26 Sep 2026:
  // 6.5 s of audio over 6.4 s), so the queue never builds up on its own; a
  // quarter second of buffer after silence absorbs network jitter.
  const LEAD_S = 0.25;
  const START_TTL_MS = 50000;       // a speech_start action waits this long for its speech (the page runs it anyway at 45 s)
  const CONNECT_TIMEOUT_MS = 10000;
  const RETRY_MS = [1000, 2000, 4000, 8000, 8000];
  const END_GRACE_MS = 1500;        // drained with speech_end actions waiting and no "end" yet
  const LEVEL_EVERY_MS = 250;

  let t = null;                     // the one tutor session

  const log = (...args) => console.info('[frty2 tutor-audio]', ...args);

  function toPage(msg) {
    if (!t) return;
    chrome.runtime.sendMessage({type: 'tutor_from_audio', tabId: t.tabId, msg}).catch(() => {});
  }

  // ------------------------------------------------------------------ socket

  function open(session) {
    const ws = new WebSocket(session.url);
    ws.binaryType = 'arraybuffer';
    session.ws = ws;
    toPage({type: 'link', status: session.everOpen ? 'reconnecting' : 'connecting'});
    ws.onopen = () => {
      if (t !== session) { ws.close(1000); return; }
      session.retries = 0;
      session.everOpen = true;
      ws.send(JSON.stringify(session.hello));
      for (const text of session.outbox.splice(0)) ws.send(text);
      log('open', session.url);
      toPage({type: 'link', status: 'open'});
      if (session.onFirstOpen) { session.onFirstOpen(); session.onFirstOpen = null; }
    };
    ws.onmessage = (event) => {
      if (t !== session) return;
      if (typeof event.data === 'string') {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        onServer(session, msg);
      } else if (event.data instanceof ArrayBuffer && event.data.byteLength > 1) {
        if (new Uint8Array(event.data, 0, 1)[0] === TAG_SPEAKER) enqueue(session, event.data);
      }
    };
    ws.onclose = (event) => {
      if (t !== session || session.ws !== ws) return;
      session.ws = null;
      log('closed', event.code, event.reason);
      if (session.onFirstFail) { session.onFirstFail(`closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`); return; }
      // 1000 and the 4xxx range are the server's final word (done, refused).
      const final = session.closing || session.bye || event.code === 1000 || (event.code >= 4000 && event.code < 5000);
      if (!final && session.retries < RETRY_MS.length) {
        const delay = RETRY_MS[session.retries];
        session.retries += 1;
        toPage({type: 'link', status: 'reconnecting', detail: `connection lost (${event.code}); trying again`});
        session.retryTimer = setTimeout(() => { if (t === session) open(session); }, delay);
        return;
      }
      toPage({type: 'link', status: 'closed', detail: session.bye ? session.bye : event.reason || `closed (${event.code})`});
      end(session, 'closed');
    };
    ws.onerror = () => {};
  }

  function sendJson(session, msg) {
    const text = JSON.stringify(msg);
    if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.send(text);
    else if (session.outbox.length < 200) session.outbox.push(text);
  }

  function onServer(session, msg) {
    // The page sees every message first, then any timing event it causes.
    toPage(msg);
    // On-screen text waits for its line's first sound exactly as a glide does.
    if (msg.type === 'overlay' && msg.op === 'show' && msg.when === 'speech_start' && msg.id !== undefined) {
      session.pendingStart.push({id: msg.id, at: Date.now()});
    } else if (msg.type === 'action' && msg.id !== undefined) {
      if (msg.when === 'speech_start') session.pendingStart.push({id: msg.id, at: Date.now()});
      else if (msg.when === 'speech_end') session.pendingEnd.push({id: msg.id, heard: false});
    } else if (msg.type === 'cancel') {
      const ids = new Set(msg.ids || []);
      session.pendingStart = session.pendingStart.filter((p) => !ids.has(p.id));
      session.pendingEnd = session.pendingEnd.filter((p) => !ids.has(p.id));
    } else if (msg.type === 'speech') {
      if (msg.status === 'start' && msg.turn !== undefined) session.turn = msg.turn;
      if (msg.status === 'end') bindEnd(session);
      else if (msg.status === 'interrupted') flush(session);
    } else if (msg.type === 'bye') {
      session.bye = msg.reason || 'bye';
    }
  }

  // ------------------------------------------------------------------ speaker

  function audioContext(session) {
    if (!session.ctx) {
      session.ctx = new AudioContext();
      session.out = session.ctx.createGain();
      session.out.connect(session.ctx.destination);
      session.mute = session.ctx.createGain();       // markers run through a silent branch
      session.mute.gain.value = 0;
      session.mute.connect(session.ctx.destination);
    }
    if (session.ctx.state !== 'running') session.ctx.resume().catch(() => {});
    return session.ctx;
  }

  /** Run fn when the audio clock reaches `when` (seconds), not a timer: the
   *  offscreen document's timers can be throttled, the audio thread is not. */
  function at(session, when, fn) {
    const ctx = session.ctx;
    const gen = session.gen;
    if (when <= ctx.currentTime + 0.005) { fn(); return; }
    const node = ctx.createConstantSource();
    node.offset.value = 0;
    node.connect(session.mute);
    node.onended = () => { node.disconnect(); session.markers.delete(node); if (t === session && session.gen === gen) fn(); };
    session.markers.add(node);
    node.start(when);
    node.stop(when);
  }

  function enqueue(session, data) {
    const ctx = audioContext(session);
    const count = (data.byteLength - 1) >> 1;
    if (!count) return;
    const view = new DataView(data, 1);
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i += 1) samples[i] = view.getInt16(i * 2, true) / 0x8000;
    const buffer = ctx.createBuffer(1, count, SPEAKER_RATE);
    buffer.copyToChannel(samples, 0);
    const now = ctx.currentTime;
    const startAt = session.cursor > now + 0.01 ? session.cursor : now + LEAD_S;
    // The actions waiting for "the next speech" start with this chunk; an old
    // one whose sound never came has already been run by the page.
    const ids = session.pendingStart.filter((p) => Date.now() - p.at < START_TTL_MS).map((p) => p.id);
    session.pendingStart = [];
    for (const p of session.pendingEnd) p.heard = true;   // this turn's speech has begun
    if (!session.playing || ids.length) {
      const fresh = !session.playing;
      at(session, startAt, () => {
        toPage({type: 'playback', status: 'started', ids, fresh});
        // The trace learns when the learner actually heard it, not when it arrived.
        sendJson(session, {type: 'playback', status: 'started', ids, fresh, at: Date.now()});
      });
    }
    session.playing = true;
    clearTimeout(session.endGrace);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(session.out);
    const gen = session.gen;
    source.onended = () => {
      session.sources.delete(source);
      if (t !== session || session.gen !== gen) return;
      if (!session.sources.size && session.ctx.currentTime >= session.cursor - 0.01) drained(session);
    };
    session.sources.add(source);
    source.start(startAt);
    session.cursor = startAt + buffer.duration;
    if (session.turn !== null) {
      // When each turn plays on the audio clock, for "how much was heard".
      const span = session.spans.get(session.turn) || {start: startAt, end: startAt};
      span.end = session.cursor;
      session.spans.set(session.turn, span);
      if (session.spans.size > 8) session.spans.delete(session.spans.keys().next().value);
    }
    session.chunks += 1;
  }

  function emitEnded(session, ids) {
    if (!ids.length) return;
    toPage({type: 'playback', status: 'ended', ids});
    sendJson(session, {type: 'playback', status: 'ended', ids, at: Date.now()});
  }

  /** Take the speech_end actions whose turn has been heard; the others
   *  belong to a turn that has not started yet. */
  function takeHeard(session) {
    const ids = session.pendingEnd.filter((p) => p.heard).map((p) => p.id);
    session.pendingEnd = session.pendingEnd.filter((p) => !p.heard);
    return ids;
  }

  /** The turn's speech has all arrived: its speech_end actions run when the
   *  audio received so far has played. */
  function bindEnd(session) {
    const ids = takeHeard(session);
    if (!ids.length) return;
    const ctx = audioContext(session);
    if (!session.playing || session.cursor <= ctx.currentTime) { emitEnded(session, ids); return; }
    at(session, session.cursor, () => emitEnded(session, ids));
  }

  function drained(session) {
    session.playing = false;
    session.spans.clear();
    toPage({type: 'playback', status: 'drained'});
    sendJson(session, {type: 'playback', status: 'drained', at: Date.now()});
    // speech_end actions whose "end" has not come: a late chunk may still be
    // on its way, so wait a moment before calling the speech over.
    if (session.pendingEnd.some((p) => p.heard)) {
      clearTimeout(session.endGrace);
      session.endGrace = setTimeout(() => {
        if (t === session && !session.playing) emitEnded(session, takeHeard(session));
      }, END_GRACE_MS);
    }
  }

  /** Barge-in: stop what plays and forget what is queued, at once. */
  function flush(session) {
    if (session.ctx && session.sources.size) {
      log('flushed', `${session.sources.size} chunks, ${Math.max(0, session.cursor - session.ctx.currentTime).toFixed(2)} s unplayed`);
    }
    session.gen += 1;
    for (const source of session.sources) { try { source.stop(); } catch {} }
    for (const node of session.markers) { try { node.stop(); } catch {} }
    session.sources.clear();
    session.markers.clear();
    session.pendingStart = [];
    session.pendingEnd = [];
    clearTimeout(session.endGrace);
    const was = session.playing;
    // How much of each turn was heard before the cut (ms), and how long it was.
    const heard = {}, total = {};
    const nowAt = session.ctx ? session.ctx.currentTime : 0;
    for (const [turn, span] of session.spans) {
      if (span.end <= nowAt - 0.05 && !was) continue;
      heard[turn] = Math.round(Math.max(0, Math.min(nowAt, span.end) - span.start) * 1000);
      total[turn] = Math.round((span.end - span.start) * 1000);
    }
    session.spans.clear();
    session.playing = false;
    session.cursor = 0;
    if (was) {
      toPage({type: 'playback', status: 'drained', flushed: true});
      sendJson(session, {type: 'playback', status: 'drained', flushed: true, heard, total, at: Date.now()});
    }
  }

  // ------------------------------------------------------------------ microphone

  async function openMic(session) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1},
      });
    } catch (error) {
      const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      const detail = String(error && error.message || error);
      toPage({type: 'mic', status: denied ? 'needs_mic' : 'error', detail});
      return denied ? 'needs_mic' : 'error';
    }
    if (t !== session) { stream.getTracks().forEach((track) => track.stop()); return 'error'; }
    try {
      const ctx = audioContext(session);
      await ctx.audioWorklet.addModule(chrome.runtime.getURL('tutor-mic-worklet.js'));
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'frty2-tutor-mic', {processorOptions: {frameMs: 40}});
      source.connect(node).connect(session.mute);
      session.mic = {stream, source, node, level: 0, levelAt: 0};
      node.port.onmessage = (event) => onMicFrame(session, event.data);
      stream.getAudioTracks()[0].addEventListener('ended', () => toPage({type: 'mic', status: 'error', detail: 'the microphone stopped'}));
      toPage({type: 'mic', status: 'on'});
      return 'on';
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      toPage({type: 'mic', status: 'error', detail: String(error && error.message || error)});
      return 'error';
    }
  }

  /** Exact digital silence: a muted or virtual input, never a real room. */
  function allZero(frame) {
    const samples = new Int16Array(frame.slice(1));
    for (let i = 0; i < samples.length; i += 1) if (samples[i] !== 0) return false;
    return true;
  }

  function onMicFrame(session, {frame, rms}) {
    if (t !== session || !session.mic) return;
    const mic = session.mic;
    mic.level = Math.max(rms, mic.level * 0.6);
    // Frames of exact zeros are not sent: streamed to the live model they make
    // its replies to the lesson's turns start later and later (probe, 26 Sep
    // 2026: 1.7, 8.3, 18 s over three turns; a -58 dBFS noise floor or no
    // audio at all stays at 0.7-1 s). Sending nothing is what a closed mic does.
    const zero = rms < 1e-4 && allZero(frame);
    mic.zeroSince = zero ? mic.zeroSince || Date.now() : 0;
    // A second of exact silence is a mute or a closed mic: the server tells
    // the model the stream ended (Google: after a pause of more than a second).
    if (zero && !session.paused && !mic.silentSent && Date.now() - mic.zeroSince > 1000) {
      mic.silentSent = true;
      sendJson(session, {type: 'mic', status: 'silent', at: Date.now()});
    } else if (!zero && mic.silentSent) {
      mic.silentSent = false;
      sendJson(session, {type: 'mic', status: 'live', at: Date.now()});
    }
    if (session.paused) mic.level = 0;
    else if (zero) session.zeroFrames += 1;
    else if (session.ws && session.ws.readyState === WebSocket.OPEN) { session.ws.send(frame); session.micFrames += 1; }
    const now = Date.now();
    if (now - mic.levelAt >= LEVEL_EVERY_MS) {
      mic.levelAt = now;
      const muted = !session.paused && mic.zeroSince && now - mic.zeroSince > 2000;
      toPage({type: 'mic', status: session.paused ? 'paused' : muted ? 'muted' : 'on', level: Math.min(1, mic.level * 4)});
    }
  }

  // ------------------------------------------------------------------ lifecycle

  function end(session, reason) {
    if (session.ended) return;
    session.ended = true;
    clearTimeout(session.retryTimer);
    clearTimeout(session.endGrace);
    flush(session);
    if (session.mic) {
      session.mic.stream.getTracks().forEach((track) => track.stop());
      try { session.mic.node.disconnect(); session.mic.source.disconnect(); } catch {}
      session.mic = null;
    }
    if (session.ws) { session.closing = true; try { session.ws.close(1000, reason); } catch {} session.ws = null; }
    if (session.ctx) session.ctx.close().catch(() => {});
    log('ended', reason, `mic frames ${session.micFrames} (${session.zeroFrames} silent, not sent), speaker chunks ${session.chunks}`);
    if (t === session) t = null;
  }

  function connect({url, hello, tabId}) {
    if (t) end(t, 'replaced');
    const session = {
      url, hello, tabId, ws: null, outbox: [], retries: 0, everOpen: false, closing: false, bye: null, ended: false,
      paused: false, ctx: null, out: null, mute: null, mic: null, micFrames: 0, zeroFrames: 0, chunks: 0,
      sources: new Set(), markers: new Set(), cursor: 0, playing: false, gen: 0, turn: null, spans: new Map(),
      pendingStart: [], pendingEnd: [], endGrace: null, retryTimer: null,
    };
    t = session;
    audioContext(session);
    const opened = new Promise((resolve) => {
      const timer = setTimeout(() => fail('the tutor server did not answer in 10 s'), CONNECT_TIMEOUT_MS);
      const fail = (detail) => { clearTimeout(timer); session.onFirstOpen = null; session.onFirstFail = null; resolve({ok: false, detail}); };
      session.onFirstOpen = () => { clearTimeout(timer); session.onFirstFail = null; resolve({ok: true}); };
      session.onFirstFail = fail;
    });
    try {
      open(session);
    } catch (error) {
      end(session, 'bad_url');
      return Promise.resolve({ok: false, error: 'bad_url', detail: String(error && error.message || error)});
    }
    return Promise.all([opened, openMic(session)]).then(([link, mic]) => {
      if (!link.ok) {
        toPage({type: 'link', status: 'closed', detail: link.detail});
        end(session, 'connect_failed');
        return {ok: false, error: 'offline', detail: link.detail, mic};
      }
      return {ok: true, mic};
    });
  }

  function fromPage(msg, tabId) {
    const session = t;
    if (!session || !msg || typeof msg.type !== 'string') return {ok: false, error: 'no_tutor'};
    if (tabId !== undefined && tabId !== session.tabId) return {ok: false, error: 'not_the_tutor_tab'};
    if (msg.type === 'control') {
      if (msg.action === 'pause') session.paused = true;
      else if (msg.action === 'resume' || msg.action === 'start') session.paused = false;
    }
    sendJson(session, msg);
    if (msg.type === 'control' && msg.action === 'stop') {
      // Let the stop reach the server before the socket goes.
      setTimeout(() => { if (t === session) end(session, 'stopped'); }, 300);
    }
    return {ok: true};
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== 'tutor') return false;
    switch (message.type) {
      case 'connect':
        connect(message).then(sendResponse, (error) => sendResponse({ok: false, error: 'connect', detail: String(error && error.message || error)}));
        return true;
      case 'send':
        sendResponse(fromPage(message.msg, message.tabId));
        return false;
      case 'close':
        if (t) end(t, message.reason || 'closed');
        sendResponse({ok: true});
        return false;
      case 'status':
        sendResponse({ok: true, state: t ? {
          tabId: t.tabId, open: Boolean(t.ws && t.ws.readyState === WebSocket.OPEN), paused: t.paused,
          playing: t.playing, mic: Boolean(t.mic), mic_frames: t.micFrames, speaker_chunks: t.chunks,
        } : null});
        return false;
      default:
        return false;
    }
  });
})();
