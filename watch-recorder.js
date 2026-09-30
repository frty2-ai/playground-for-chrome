/**
 * The Watch recorder. Lives in the offscreen document next to the speaker.
 *
 * It records an expert using a web application while they explain it:
 *   - the watched tab as video (chrome.tabCapture stream id from the service
 *     worker; WebM at the tab's own shape, long side at most 1920 px, 5 fps),
 *   - the microphone as voice (WebM/Opus), plus speech segments from a
 *     level-based voice detector, so silence is never mistaken for speech,
 *   - the DOM event log that watch.js sends from every frame of the tab,
 *   - a JPEG ~100 ms before and ~800 ms after each action, and a keyframe
 *     when nothing has happened for 5 s.
 * Everything is written to IndexedDB (watch-store.js) as it happens and, when
 * the expert is signed in, uploaded in the background.
 *
 * Its heartbeat is the only thing that lets the page say "watching": every
 * 500 ms it tells the service worker whether both recorders are running,
 * both tracks are live and chunks are still arriving. No heartbeat, no REC.
 *
 * Messages (`target: "recorder"`):
 *   from the service worker: start {streamId, tabId, meta, upload}, stop,
 *                            pause, resume, marker {marker, note}, status
 *   from watch.js in the watched tab: event {event}
 * To the service worker: {type: "watch_heartbeat", status}, {type: "watch_ended", ...}
 */

(() => {
  const CHUNK_MS = 2000;           // MediaRecorder timeslice: a crash loses at most this much
  const HEARTBEAT_MS = 500;
  const EVENT_FLUSH_MS = 2000;
  const KEYFRAME_MS = 5000;
  const FRAME_BEFORE_MS = 100;
  const FRAME_AFTER_MS = 800;
  const UPLOAD_EVERY_MS = 5000;
  const RING = 3;                   // recent screen images kept for "before" frames

  // Actions a learner would have to repeat: they get frames and count
  // towards "done without saying anything".
  const ACTIONS = new Set(['click', 'dblclick', 'contextmenu', 'input', 'select', 'check', 'file', 'submit', 'key', 'drop', 'paste']);
  const FRAMED = new Set([...ACTIONS, 'navigate', 'dialog', 'marker']);

  const now = () => performance.timeOrigin + performance.now();
  const round = (t) => Math.round(t * 10) / 10;

  let rec = null;

  // ------------------------------------------------------------------ lifecycle

  /** The frame size to capture at: the tab's own shape, its long side at
   *  most 1920 px. A fixed 16:9 box letterboxes any other window and shrinks
   *  the page's text until the understanding pass cannot read it. */
  function captureSize(viewport) {
    const w = Math.max(320, Number(viewport && viewport.width) || 1280);
    const h = Math.max(240, Number(viewport && viewport.height) || 720);
    const scale = Math.min(1, 1920 / Math.max(w, h));
    const even = (n) => Math.max(2, Math.round(n * scale / 2) * 2);   // VP9 wants even sides
    return {width: even(w), height: even(h)};
  }

  async function start({streamId, tabId, meta, upload, viewport}) {
    if (rec) return {ok: false, error: 'already_watching'};
    const size = captureSize(viewport);
    const id = crypto.randomUUID();
    let screen = null;
    let voice = null;
    try {
      screen = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {mandatory: {chromeMediaSource: 'tab', chromeMediaSourceId: streamId,
                            maxWidth: size.width, maxHeight: size.height, maxFrameRate: 5}},
      });
    } catch (error) {
      return {ok: false, error: 'screen', detail: String(error && error.message || error)};
    }
    try {
      voice = await navigator.mediaDevices.getUserMedia({
        audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1},
      });
    } catch (error) {
      screen.getTracks().forEach((t) => t.stop());
      const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      return {ok: false, error: denied ? 'needs_mic' : 'mic', detail: String(error && error.message || error)};
    }

    const t0 = now();
    rec = {
      id, tabId, t0, meta, upload,
      state: 'recording',
      screen, voice,
      videoTrack: screen.getVideoTracks()[0],
      micTrack: voice.getAudioTracks()[0],
      seq: {video: 0, audio: 0, events: 0, frames: 0},
      lastChunk: {video: t0, audio: t0},
      writes: new Set(),
      writeError: null,
      events: [],
      eventCount: 0,
      counts: {events: 0, actions: 0, frames: 0, speech: 0, markers: 0},
      bytes: 0,
      pauses: [],
      pausedAt: null,
      ring: [],
      lastStored: null,
      lastFrameAt: t0,
      afters: [],                 // pending "after" captures: {at, refs, timer}
      vad: {floor: -60, active: 0, quiet: 0, speaking: false, start: 0, lastActive: 0, peak: -100},
      level: null,
      lastSpeechEnd: -Infinity,
      unnarrated: 0,
      problems: [],               // make the watch unhealthy: the indicator says so
      notes: [],                  // worth keeping, but the recording is fine
      timers: [],
      lastBeat: 0,
      upload: upload || null,
      uploadState: upload ? {pending: 0, error: null} : null,
      streams: {},
    };

    const settings = rec.videoTrack.getSettings();
    await WatchStore.putRecording({
      id, state: 'recording', t0, started_at: Math.round(t0),
      meta: {...meta, capture_id: id, t0: Math.round(t0)},
      counts: rec.counts, bytes: 0, pauses: [], streams: {},
      // A session's link token is kept with the recording, so an upload cut
      // short can finish later even after the extension links elsewhere.
      upload: upload ? {api_base: upload.api_base, kind: upload.kind,
                        ...(upload.kind === 'session' ? {token: upload.token, session_id: upload.session_id} : {})} : null,
    });

    rec.videoRecorder = startRecorder('video', screen, ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
      // ~1 Mbps at 1280x720, more for bigger frames: screen text stays sharp.
      {videoBitsPerSecond: Math.min(3_000_000, Math.round(1_000_000 * (size.width * size.height) / (1280 * 720)))});
    rec.audioRecorder = startRecorder('audio', voice, ['audio/webm;codecs=opus', 'audio/webm'], {audioBitsPerSecond: 48_000});
    rec.streams = {
      video: {mime: rec.videoRecorder.mimeType, started_t: round(now() - t0), width: settings.width, height: settings.height, fps: 5},
      audio: {mime: rec.audioRecorder.mimeType, started_t: round(now() - t0), sample_rate: rec.micTrack.getSettings().sampleRate},
    };

    rec.videoTrack.addEventListener('ended', () => finish('the watched tab closed or stopped being captured'));
    rec.micTrack.addEventListener('ended', () => { if (rec) rec.problems.push('microphone disconnected'); });

    startFrames();
    await startLevel();

    log({kind: 'watch_start', t: 0, url: meta.url, title: meta.title, streams: rec.streams});
    rec.timers.push(setInterval(tick, HEARTBEAT_MS));
    rec.timers.push(setInterval(flushEvents, EVENT_FLUSH_MS));
    if (rec.upload) rec.timers.push(setInterval(uploadSoon, UPLOAD_EVERY_MS));
    beat(true);
    return {ok: true, id, t0};
  }

  function startRecorder(stream, media, types, options) {
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const recorder = new MediaRecorder(media, {...options, ...(mimeType ? {mimeType} : {})});
    recorder.addEventListener('dataavailable', (event) => {
      if (!rec) return;
      rec.lastChunk[stream] = now();
      if (!event.data || !event.data.size) return;
      rec.seq[stream] += 1;
      rec.bytes += event.data.size;
      write({rid: rec.id, stream, seq: rec.seq[stream], t: round(now() - rec.t0), blob: event.data, mime: recorder.mimeType});
    });
    recorder.addEventListener('error', (event) => { if (rec) rec.problems.push(`${stream} recorder failed: ${event.error && event.error.message}`); });
    recorder.start(CHUNK_MS);
    return recorder;
  }

  /** Every write is tracked so stopping waits for the last one. */
  function write(part) {
    const current = rec;
    const pending = WatchStore.putPart(part)
      .catch((error) => { if (current) current.writeError = `cannot save to this computer (${error.message})`; })
      .finally(() => current && current.writes.delete(pending));
    current.writes.add(pending);
    return pending;
  }

  function stopRecorder(recorder) {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === 'inactive') return resolve();
      recorder.addEventListener('stop', () => resolve(), {once: true});
      try { recorder.stop(); } catch { resolve(); }
    });
  }

  let finishing = null;
  function finish(reason) {
    if (!rec) return Promise.resolve(null);
    if (!finishing) finishing = doFinish(reason).finally(() => { finishing = null; });
    return finishing;
  }

  async function doFinish(reason) {
    const r = rec;
    if (r.pausedAt !== null) closePause();
    r.state = 'stopping';
    beat(true);
    for (const timer of r.timers) clearInterval(timer);
    await Promise.all([stopRecorder(r.videoRecorder), stopRecorder(r.audioRecorder)]);
    if (r.vad.speaking) endSpeech(now());
    for (const pending of r.afters.splice(0)) { clearTimeout(pending.timer); await captureAfter(r, pending); }
    const endedAt = now();
    log({kind: 'watch_end', t: round(endedAt - r.t0), reason: reason || 'stopped by the expert'});
    await flushEvents();
    await Promise.all([...r.writes]);
    stopMedia(r);

    const paused = r.pauses.reduce((sum, p) => sum + (p.t1 - p.t0), 0);
    // Closing the tab is an ordinary way to end; "interrupted" is kept for a
    // recorder that died without getting here (the recordings page marks it).
    const state = 'finished';
    const saved = await WatchStore.updateRecording(r.id, (row) => ({
      ...row, state, ended_at: Math.round(endedAt), duration_ms: Math.round(endedAt - r.t0 - paused),
      counts: r.counts, bytes: r.bytes, pauses: r.pauses, streams: r.streams,
      problems: [...new Set(r.problems)], notes: [...new Set(r.notes)], end_reason: reason || null,
    }));
    const summary = {id: r.id, state, duration_ms: saved && saved.duration_ms, counts: r.counts, bytes: r.bytes, reason: reason || null};
    rec = null;
    chrome.runtime.sendMessage({type: 'watch_ended', summary}).catch(() => {});
    if (r.upload) drainUploads(r.id, r.upload);
    return summary;
  }

  function stopMedia(r) {
    try { r.frameReader && r.frameReader.cancel(); } catch {}
    try { r.frameVideo && (r.frameVideo.srcObject = null); } catch {}
    for (const item of r.ring) { try { item.bitmap.close(); } catch {} }
    r.ring = [];
    try { r.audioContext && r.audioContext.close(); } catch {}
    r.screen.getTracks().forEach((t) => t.stop());
    r.voice.getTracks().forEach((t) => t.stop());
  }

  function pause() {
    if (!rec || rec.state !== 'recording') return false;
    if (rec.vad.speaking) endSpeech(now());
    try { rec.videoRecorder.pause(); rec.audioRecorder.pause(); } catch {}
    rec.pausedAt = now();
    rec.state = 'paused';
    log({kind: 'pause', t: round(rec.pausedAt - rec.t0), reason: 'private'});
    beat(true);
    return true;
  }

  function closePause() {
    const t = now();
    rec.pauses.push({t0: round(rec.pausedAt - rec.t0), t1: round(t - rec.t0)});
    rec.pausedAt = null;
    return t;
  }

  function resume() {
    if (!rec || rec.state !== 'paused') return false;
    const t = closePause();
    try { rec.videoRecorder.resume(); rec.audioRecorder.resume(); } catch {}
    rec.lastChunk.video = t; rec.lastChunk.audio = t;
    rec.state = 'recording';
    log({kind: 'resume', t: round(t - rec.t0)});
    beat(true);
    return true;
  }

  // ------------------------------------------------------------------ events

  function log(event) {
    rec.events.push(event);
    rec.counts.events += 1;
  }

  async function flushEvents() {
    if (!rec || !rec.events.length) return;
    const batch = rec.events.splice(0);
    rec.seq.events += 1;
    await write({rid: rec.id, stream: 'events', seq: rec.seq.events, t: batch[0].t,
                 text: batch.map((e) => JSON.stringify(e)).join('\n') + '\n'});
  }

  function onPageEvent(event, sender) {
    if (!rec || rec.state !== 'recording') return;
    if (!sender.tab || sender.tab.id !== rec.tabId) return;
    const at = typeof event.t === 'number' ? event.t : now();
    const t = round(at - rec.t0);
    const entry = {...event, t, frame_id: sender.frameId};
    if (sender.frameId) entry.frame_url = sender.url;
    log(entry);
    if (ACTIONS.has(event.kind)) {
      rec.counts.actions += 1;
      const narrated = rec.vad.speaking || at - rec.lastSpeechEnd < 3000;
      if (!narrated) rec.unnarrated += 1;
    }
    if (FRAMED.has(event.kind)) frameEvent(entry, at);
  }

  function marker(kind, note) {
    if (!rec) return false;
    const at = now();
    const entry = {kind: 'marker', marker: kind, t: round(at - rec.t0), note: note || undefined};
    if (kind === 'mistake') entry.drop_seconds = 10;
    log(entry);
    rec.counts.markers += 1;
    if (rec.state === 'recording') frameEvent(entry, at);
    return true;
  }

  // ------------------------------------------------------------------ frames

  function remember(bitmap) {
    rec.ring.push({bitmap, t: now()});
    while (rec.ring.length > RING) {
      const old = rec.ring.shift();
      if (old !== rec.lastStored) { try { old.bitmap.close(); } catch {} }
    }
  }

  /** Keep the last few screen images. VideoFrames are copied to bitmaps and
   *  closed at once so the capture pipeline's buffers are never held. */
  function startFrames() {
    const r = rec;
    if (typeof MediaStreamTrackProcessor === 'function') {
      const processor = new MediaStreamTrackProcessor({track: r.videoTrack.clone()});
      r.frameReader = processor.readable.getReader();
      (async () => {
        for (;;) {
          let result;
          try { result = await r.frameReader.read(); } catch { break; }
          if (result.done) break;
          const frame = result.value;
          if (rec !== r || r.state === 'paused') { frame.close(); continue; }
          try { remember(await createImageBitmap(frame)); } catch {} finally { frame.close(); }
        }
      })();
      return;
    }
    // Older Chrome: read the last painted frame off a video element.
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = r.screen;
    video.play().catch(() => {});
    r.frameVideo = video;
    r.timers.push(setInterval(async () => {
      if (rec !== r || r.state === 'paused' || video.readyState < 2) return;
      try { remember(await createImageBitmap(video)); } catch {}
    }, 200));
  }

  function storeFrame(item, role, of) {
    // A frame is evidence, never a reason to break the recording.
    return storeFrameOnce(item, role, of).catch((error) => {
      if (rec && rec.notes.length < 50) rec.notes.push(`frame capture failed (${error.message})`);
      return null;
    });
  }

  async function storeFrameOnce(item, role, of) {
    const r = rec;
    if (!r || !item) return null;
    if (r.lastStored === item && r.lastStoredNo) {
      if (of) log({kind: 'frame', frame: r.lastStoredNo, role, of, t: round(item.t - r.t0), same_as_previous: true});
      return r.lastStoredNo;
    }
    const {bitmap} = item;
    const {width, height} = bitmap;          // read now: the bitmap may be closed while encoding
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const previous = r.lastStored;
    r.lastStored = item;
    const n = r.seq.frames += 1;
    r.lastStoredNo = n;
    r.lastFrameAt = now();
    if (previous && !r.ring.includes(previous)) { try { previous.bitmap.close(); } catch {} }
    const blob = await canvas.convertToBlob({type: 'image/jpeg', quality: 0.72});
    r.counts.frames += 1;
    r.bytes += blob.size;
    write({rid: r.id, stream: 'frames', seq: n, t: round(item.t - r.t0), blob});
    log({kind: 'frame', frame: n, role, of: of || undefined, t: round(item.t - r.t0),
         file: WatchStore.frameFile(n), w: width, h: height});
    return n;
  }

  function frameEvent(entry, at) {
    const r = rec;
    const ref = entry.id || `${entry.kind}@${entry.t}`;
    // Before: the newest image painted at least 100 ms before the event.
    const before = [...r.ring].reverse().find((item) => item.t <= at - FRAME_BEFORE_MS) || r.ring[0];
    storeFrame(before, 'before', ref);
    // After: ~800 ms later. Events within 300 ms of each other share one
    // capture; every other event keeps its own, on its own time.
    const due = at + FRAME_AFTER_MS;
    const near = r.afters.find((pending) => Math.abs(pending.at - due) < 300);
    if (near) { near.refs.push(ref); return; }
    const pending = {at: due, refs: [ref]};
    pending.timer = setTimeout(() => {
      r.afters = r.afters.filter((p) => p !== pending);
      captureAfter(r, pending);
    }, FRAME_AFTER_MS);
    r.afters.push(pending);
  }

  async function captureAfter(r, pending) {
    if (rec !== r) return;
    const newest = r.ring[r.ring.length - 1];
    for (const ref of pending.refs) await storeFrame(newest, 'after', ref);
  }

  function keyframe() {
    const r = rec;
    if (r.state !== 'recording' || now() - r.lastFrameAt < KEYFRAME_MS) return;
    const newest = r.ring[r.ring.length - 1];
    r.lastFrameAt = now();
    if (newest && newest !== r.lastStored) storeFrame(newest, 'key');
  }

  // ------------------------------------------------------------------ voice level and speech

  async function startLevel() {
    const r = rec;
    try {
      const context = new AudioContext();
      r.audioContext = context;
      await context.audioWorklet.addModule(chrome.runtime.getURL('watch-level-worklet.js'));
      const source = context.createMediaStreamSource(r.voice);
      const node = new AudioWorkletNode(context, 'frty2-level');
      const silent = context.createGain();
      silent.gain.value = 0;
      source.connect(node).connect(silent).connect(context.destination);
      node.port.onmessage = (message) => { if (rec === r) onLevel(message.data); };
      if (context.state !== 'running') await context.resume().catch(() => {});
      r.levelOk = context.state === 'running';
    } catch (error) {
      r.levelOk = false;
      r.notes.push(`voice level unavailable (${error.message}); recording continues`);
    }
  }

  /** A level-based voice detector, per 50 ms block: an adaptive noise floor,
   *  150 ms to start speech, 600 ms of quiet to end it, 300 ms minimum. */
  function onLevel({rms, peak}) {
    const r = rec;
    const t = now();
    const db = 20 * Math.log10(rms + 1e-9);
    r.level = Math.max(0, Math.min(1, (db + 60) / 50));
    r.levelAt = t;
    if (t - r.lastBeat >= HEARTBEAT_MS) tick();
    if (r.state !== 'recording') return;
    const vad = r.vad;
    vad.floor = db < vad.floor ? vad.floor + (db - vad.floor) * 0.5 : vad.floor + 0.05;
    const active = db > Math.max(vad.floor + 10, -52);
    if (active) {
      vad.active += 1; vad.quiet = 0; vad.lastActive = t;
      vad.peak = Math.max(vad.peak, 20 * Math.log10(peak + 1e-9));
      if (!vad.speaking && vad.active >= 3) {
        vad.speaking = true;
        vad.start = t - 150;
        r.unnarrated = 0;
      }
    } else {
      vad.quiet += 1;
      if (!vad.speaking) vad.active = 0;
      if (vad.speaking && vad.quiet >= 12) endSpeech(vad.lastActive + 50);
    }
  }

  function endSpeech(end) {
    const r = rec;
    const vad = r.vad;
    vad.speaking = false; vad.active = 0; vad.quiet = 0;
    r.lastSpeechEnd = end;
    if (end - vad.start >= 300) {
      log({kind: 'speech', t: round(vad.start - r.t0), t0: round(vad.start - r.t0), t1: round(end - r.t0),
           peak_db: Math.round(vad.peak * 10) / 10});
      r.counts.speech += 1;
    }
    vad.peak = -100;
  }

  // ------------------------------------------------------------------ health and heartbeat

  function health() {
    const r = rec;
    const problems = [...new Set(r.problems)];
    const t = now();
    if (r.videoTrack.readyState !== 'live') problems.push('screen capture ended');
    if (r.micTrack.readyState !== 'live') problems.push('microphone ended');
    else if (r.micTrack.muted) problems.push('microphone muted by the system');
    if (r.state === 'recording') {
      for (const [name, recorder] of [['screen', r.videoRecorder], ['voice', r.audioRecorder]]) {
        if (recorder.state !== 'recording') problems.push(`${name} recorder is ${recorder.state}`);
      }
      if (t - r.lastChunk.video > CHUNK_MS * 2 + 1500) problems.push('screen recording stalled');
      if (t - r.lastChunk.audio > CHUNK_MS * 2 + 1500) problems.push('voice recording stalled');
    }
    if (r.writeError) problems.push(r.writeError);
    return problems;
  }

  function status() {
    if (!rec) return {state: 'idle'};
    const r = rec;
    const t = now();
    const paused = r.pauses.reduce((sum, p) => sum + (p.t1 - p.t0), 0) + (r.pausedAt !== null ? t - r.pausedAt : 0);
    const problems = health();
    return {
      id: r.id, tabId: r.tabId, state: r.state, healthy: problems.length === 0, problems,
      started_at: Math.round(r.t0), elapsed_ms: Math.round(t - r.t0 - paused),
      level: r.levelOk && r.levelAt && t - r.levelAt < 1500 ? Math.round(r.level * 100) / 100 : null,
      speaking: r.vad.speaking, unnarrated: r.unnarrated,
      counts: r.counts, bytes: r.bytes, upload: r.uploadState, title: r.meta.title || r.meta.page_title || '',
      sent_at: Date.now(),
    };
  }

  function beat(force) {
    if (!rec) return;
    const t = now();
    if (!force && t - rec.lastBeat < HEARTBEAT_MS - 50) return;
    rec.lastBeat = t;
    chrome.runtime.sendMessage({type: 'watch_heartbeat', status: status()}).catch(() => {});
  }

  function tick() {
    if (!rec || rec.state === 'stopping') return;
    beat(false);
    keyframe();
    checkpoint();
  }

  /** Keep the saved row current, so a recording cut short (browser closed,
   *  extension reloaded) still says what it holds. */
  function checkpoint() {
    const r = rec;
    const t = now();
    if (t - (r.checkpointAt || 0) < 5000) return;
    r.checkpointAt = t;
    WatchStore.updateRecording(r.id, (row) => ({...row, counts: {...r.counts}, bytes: r.bytes, pauses: [...r.pauses], streams: r.streams,
                                                 duration_ms: status().elapsed_ms})).catch(() => {});
  }

  // ------------------------------------------------------------------ upload

  let uploading = false;
  async function uploadSoon() {
    const r = rec;
    if (!r || !r.upload || uploading) return;
    uploading = true;
    try {
      const result = await WatchStore.sync(r.id, r.upload, {limit: 60});
      if (rec === r) r.uploadState = {pending: result.pending ?? r.uploadState.pending, error: result.ok ? null : result.detail || result.code};
    } finally { uploading = false; }
  }

  /** After the watch ends, keep sending until the server has everything. */
  async function drainUploads(id, account) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      while (uploading) await new Promise((r) => setTimeout(r, 500));
      uploading = true;
      let result;
      try { result = await WatchStore.sync(id, account, {limit: 400}); } finally { uploading = false; }
      chrome.runtime.sendMessage({type: 'watch_upload', id, result}).catch(() => {});
      if (result.ok && result.finished) return;
      if (!result.ok && ['signed_out', 'not_author', 'no_account', 'link_revoked'].includes(result.code)) return;
      await new Promise((r) => setTimeout(r, result.ok ? 200 : Math.min(60000, 2000 * (attempt + 1))));
    }
  }

  // ------------------------------------------------------------------ messages

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== 'recorder') return false;
    switch (message.type) {
      case 'event':
        onPageEvent(message.event || {}, sender);
        return false;
      case 'start':
        start(message).then(sendResponse, (error) => {
          if (rec) { stopMedia(rec); rec = null; }
          sendResponse({ok: false, error: 'start', detail: String(error && error.message || error)});
        });
        return true;
      case 'stop':
        finish(null).then((summary) => sendResponse({ok: Boolean(summary), summary}));
        return true;
      case 'pause':
        sendResponse({ok: pause(), status: status()});
        return false;
      case 'resume':
        sendResponse({ok: resume(), status: status()});
        return false;
      case 'marker':
        sendResponse({ok: marker(message.marker, message.note), status: status()});
        return false;
      case 'status':
        sendResponse({ok: true, status: status()});
        return false;
      default:
        return false;
    }
  });
})();
