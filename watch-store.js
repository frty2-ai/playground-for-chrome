/**
 * Local-first storage for Watch recordings, shared by the recorder (the
 * offscreen document) and the recordings page (watch.html). One IndexedDB
 * database in the extension's origin:
 *
 *   recordings  {id, state, t0, started_at, ended_at, duration_ms, meta, counts, bytes, upload, lessons}
 *   parts       {rid, stream, seq, t, mime, blob | text, size, uploaded}
 *
 * Streams: `video` and `audio` are MediaRecorder chunks (concatenate in seq
 * order for a playable WebM), `events` are batches of JSON lines, `frames` are
 * one JPEG each. A part is written the moment it exists, so a crash loses at
 * most one chunk interval. Uploading marks parts, never deletes them; only the
 * expert deletes a recording.
 */

// eslint-disable-next-line no-unused-vars
const WatchStore = (() => {
  const DB_NAME = 'frty2-watch';
  const DB_VERSION = 1;
  const MIME = {video: 'video/webm', audio: 'audio/webm', events: 'application/x-ndjson', frames: 'image/jpeg'};

  let opening = null;
  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('recordings', {keyPath: 'id'});
          const parts = db.createObjectStore('parts', {keyPath: ['rid', 'stream', 'seq']});
          parts.createIndex('rid', 'rid');
          parts.createIndex('pending', ['rid', 'uploaded']);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { opening = null; reject(request.error); };
      });
    }
    return opening;
  }

  const done = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  async function store(name, mode) {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  // ---------------------------------------------------------------- recordings

  async function putRecording(recording) {
    await done((await store('recordings', 'readwrite')).put(recording));
    return recording;
  }

  async function getRecording(id) {
    return done((await store('recordings', 'readonly')).get(id));
  }

  async function listRecordings() {
    const all = await done((await store('recordings', 'readonly')).getAll());
    return all.sort((a, b) => (b.t0 || 0) - (a.t0 || 0));
  }

  /** Read-modify-write in one transaction, so the recorder and the uploader
   *  never overwrite each other's fields. */
  async function updateRecording(id, patch) {
    const db = await open();
    const tx = db.transaction('recordings', 'readwrite');
    const os = tx.objectStore('recordings');
    const current = await done(os.get(id));
    if (!current) return null;
    const next = typeof patch === 'function' ? patch(current) : {...current, ...patch};
    os.put(next);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    return next;
  }

  async function deleteRecording(id) {
    const db = await open();
    const tx = db.transaction(['recordings', 'parts'], 'readwrite');
    tx.objectStore('recordings').delete(id);
    const parts = tx.objectStore('parts');
    const keys = await done(parts.index('rid').getAllKeys(IDBKeyRange.only(id)));
    for (const key of keys) parts.delete(key);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  }

  // ---------------------------------------------------------------- parts

  async function putPart(part) {
    const row = {uploaded: 0, mime: MIME[part.stream], ...part};
    row.size = row.size ?? (row.blob ? row.blob.size : new Blob([row.text || '']).size);
    await done((await store('parts', 'readwrite')).put(row));
    return row;
  }

  /** Every part of a recording (optionally one stream), in seq order. */
  async function partsOf(rid, stream) {
    const range = stream
      ? IDBKeyRange.bound([rid, stream, 0], [rid, stream, Infinity])
      : IDBKeyRange.bound([rid, '', 0], [rid, '￿', Infinity]);
    return done((await store('parts', 'readonly')).getAll(range));
  }

  async function pendingParts(rid, limit = 50) {
    const index = (await store('parts', 'readonly')).index('pending');
    return done(index.getAll(IDBKeyRange.only([rid, 0]), limit));
  }

  async function countPending(rid) {
    const index = (await store('parts', 'readonly')).index('pending');
    return done(index.count(IDBKeyRange.only([rid, 0])));
  }

  async function countParts(rid) {
    return done((await store('parts', 'readonly')).index('rid').count(IDBKeyRange.only(rid)));
  }

  async function markParts(rid, stream, seqs, uploaded) {
    const db = await open();
    const tx = db.transaction('parts', 'readwrite');
    const os = tx.objectStore('parts');
    for (const seq of seqs) {
      const row = await done(os.get([rid, stream, seq]));
      if (row && row.uploaded !== uploaded) { row.uploaded = uploaded; os.put(row); }
    }
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  }

  // ---------------------------------------------------------------- bundle (zip)

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes, crc = 0xffffffff) {
    for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return crc;
  }

  function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return {time, day};
  }

  /** A stored (uncompressed) zip: media is already compressed, and storing
   *  keeps the whole bundle as references to the recorded blobs. */
  async function zip(entries, when) {
    const {time, day} = dosDateTime(when);
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const pieces = entry.pieces.map((p) => (p instanceof Blob ? p : new Blob([p])));
      let crc = 0xffffffff;
      let size = 0;
      for (const piece of pieces) {
        const bytes = new Uint8Array(await piece.arrayBuffer());
        crc = crc32(bytes, crc);
        size += bytes.length;
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      if (size > 0xfffffffe || offset > 0xfffffffe) throw new Error('This recording is too large for a bundle (4 GB).');
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);          // names are UTF-8
      local.setUint16(8, 0, true);               // stored
      local.setUint16(10, time, true);
      local.setUint16(12, day, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      chunks.push(local.buffer, name, ...pieces);
      const record = new DataView(new ArrayBuffer(46));
      record.setUint32(0, 0x02014b50, true);
      record.setUint16(4, 20, true);
      record.setUint16(6, 20, true);
      record.setUint16(8, 0x0800, true);
      record.setUint16(10, 0, true);
      record.setUint16(12, time, true);
      record.setUint16(14, day, true);
      record.setUint32(16, crc, true);
      record.setUint32(20, size, true);
      record.setUint32(24, size, true);
      record.setUint16(28, name.length, true);
      record.setUint32(42, offset, true);
      central.push(record.buffer, name);
      offset += 30 + name.length + size;
    }
    const centralSize = central.reduce((sum, part) => sum + (part.byteLength ?? part.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, end.buffer], {type: 'application/zip'});
  }

  const README = `Frty2 Watch bundle
==================

An expert's walkthrough of a web application: what they did (events.jsonl),
what they said (voice.webm) and what the screen showed (screen.webm, frames/).
Nothing here is interpreted; it is the raw record the understanding pass
reads (docs/plan/expert-capture.md).

Time
  Every "t" is milliseconds since the watch began (meta.json "t0" is that
  instant as a Unix epoch in ms). Media timelines skip private pauses: to map
  an event time to a media time, subtract the paused intervals before it
  (meta.json "pauses", also "pause"/"resume" events). meta.json "streams"
  says when each media recorder started.

Files
  meta.json       the recording: app, intent, languages, versions, streams, counts
  events.jsonl    one JSON object per line, in the order they were recorded
  speech.json     voice activity from the extension's own detector [{t0, t1}]
  markers.json    the expert's markers (step, mistake, important, ...)
  screen.webm     the watched tab, VP8/VP9, at the tab's shape (long side at
                  most 1920 px; meta.json "streams" has the size), 5 fps
  voice.webm      the microphone, Opus
  frames/         JPEGs of the tab; each "frame" event names its file and the
                  event it belongs to (role "before" ~100 ms earlier, "after"
                  ~800 ms later, "key" when nothing happened for 5 s)

Event kinds
  load, navigate, click, dblclick, contextmenu, input, select, check, file,
  key (Enter/Escape/Tab and chords only, never typed characters), submit,
  paste (length only), drag, drop, scroll, dialog, toast, net (URL pattern,
  status, duration; no bodies), visibility, snapshot (visible interactive
  elements ~800 ms after an action), overlay (where Frty2's own indicator
  sat on screen), speech, marker, frame, pause, resume, watch_start, watch_end.

Values of password, one-time-code, card and similarly labelled fields are
recorded as {"masked": true, "length": n}. The video and frames are not
masked: use "Private" (pause) while such things are on screen.
`;

  function stamp(t0) {
    const d = new Date(t0);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  async function bundle(id) {
    const recording = await getRecording(id);
    if (!recording) throw new Error('No such recording.');
    const parts = await partsOf(id);
    const byStream = {video: [], audio: [], events: [], frames: []};
    for (const part of parts) (byStream[part.stream] || []).push(part);
    for (const list of Object.values(byStream)) list.sort((a, b) => a.seq - b.seq);

    const lines = byStream.events.map((p) => p.text || '').join('');
    const events = lines.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const speech = events.filter((e) => e.kind === 'speech').map(({t0, t1, peak_db}) => ({t0, t1, peak_db}));
    const markers = events.filter((e) => e.kind === 'marker');
    const root = `frty2-watch-${stamp(recording.t0)}-${id.slice(0, 8)}`;
    const json = (value) => JSON.stringify(value, null, 2);

    const entries = [
      {name: `${root}/README.txt`, pieces: [README]},
      {name: `${root}/meta.json`, pieces: [json({...recording, upload: undefined})]},
      {name: `${root}/events.jsonl`, pieces: [lines]},
      {name: `${root}/speech.json`, pieces: [json(speech)]},
      {name: `${root}/markers.json`, pieces: [json(markers)]},
    ];
    if (byStream.video.length) entries.push({name: `${root}/screen.webm`, pieces: byStream.video.map((p) => p.blob)});
    if (byStream.audio.length) entries.push({name: `${root}/voice.webm`, pieces: byStream.audio.map((p) => p.blob)});
    for (const frame of byStream.frames) entries.push({name: `${root}/${frameFile(frame.seq)}`, pieces: [frame.blob]});
    return {blob: await zip(entries, new Date(recording.t0)), filename: `${root}.zip`};
  }

  const frameFile = (seq) => `frames/f${String(seq).padStart(6, '0')}.jpg`;

  // ---------------------------------------------------------------- upload

  async function sha256Hex(blob) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  class UploadError extends Error {
    constructor(code, detail) { super(detail || code); this.code = code; }
  }

  async function request(account, method, path, body, headers = {}) {
    // An expert session's link token, or a Backstage author's sign-in.
    const scheme = account.kind === 'session' ? 'CaptureSession' : 'Bearer';
    const init = {method, headers: {Authorization: `${scheme} ${account.token}`, ...headers}};
    if (body instanceof Blob) init.body = body;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    let response;
    try {
      response = await fetch(`${account.api_base}${path}`, init);
    } catch (error) {
      throw new UploadError('offline', `Cannot reach ${account.api_base} (${error.message}).`);
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (response.status === 401 && account.kind === 'session') {
      throw new UploadError('link_revoked', (data && data.detail) || 'The recording link no longer works (the session was cancelled or given a new link).');
    }
    if (response.status === 401) throw new UploadError('signed_out', 'The upload sign-in has expired. Sign in again on the recordings page.');
    if (response.status === 403) throw new UploadError('not_author', 'This account is not a Backstage author, so it cannot upload recordings.');
    return {status: response.status, data};
  }

  const CAPTURES = '/api/v1/webapps/backstage/captures/';

  /**
   * Push whatever the server does not have yet. Safe to call from several
   * places at once and after any crash: the server keys every part by
   * (recording, stream, seq) and ignores exact repeats. Only one caller
   * uploads a recording at a time (the recorder, the recordings page and the
   * service worker's alarm all call this): the others are told `busy` and
   * wait, so a recording is never sent twice over.
   */
  async function sync(id, account, options = {}) {
    if (!account || !account.token || !account.api_base) return {ok: false, code: 'no_account'};
    if (typeof navigator === 'undefined' || !navigator.locks) return syncNow(id, account, options);
    return navigator.locks.request(`frty2-upload-${id}`, {ifAvailable: true}, async (lock) => {
      if (!lock) return {ok: true, busy: true, sent: 0, pending: await countPending(id), finished: false};
      return syncNow(id, account, options);
    });
  }

  async function syncNow(id, account, {limit = 400} = {}) {
    const base = CAPTURES;
    try {
      let recording = await getRecording(id);
      if (!recording) return {ok: false, code: 'missing'};
      if (!(recording.upload && recording.upload.created)) {
        const created = await request(account, 'POST', base, {
          id, title: recording.meta.title || '', intent: recording.meta.intent || '',
          app_url: recording.meta.url || '', languages: recording.meta.languages || [],
          started_at: new Date(recording.t0).toISOString(), meta: recording.meta,
          session: account.kind === 'session' ? undefined : recording.meta.session_id || undefined,
        });
        if (created.status !== 200 && created.status !== 201) {
          throw new UploadError('refused', (created.data && created.data.detail) || `The server refused the recording (${created.status}).`);
        }
        // What the server already holds (a resumed upload from elsewhere) is done.
        for (const [stream, info] of Object.entries(created.data.parts || {})) await markParts(id, stream, info.seqs, 1);
        recording = await updateRecording(id, (r) => ({...r, upload: {...(r.upload || {}), created: true, api_base: account.api_base}}));
      }
      let sent = 0;
      while (sent < limit) {
        const batch = await pendingParts(id, 20);
        if (!batch.length) break;
        for (const part of batch) {
          const body = part.blob || new Blob([part.text || ''], {type: part.mime});
          const reply = await request(account, 'PUT', `${base}${id}/parts/${part.stream}/${part.seq}/`, body, {
            'Content-Type': part.mime || 'application/octet-stream',
            'X-Capture-T': String(part.t ?? ''),
            'X-Content-SHA256': await sha256Hex(body),
          });
          if (reply.status === 200 || reply.status === 201) await markParts(id, part.stream, [part.seq], 1);
          else if (reply.status === 409) await markParts(id, part.stream, [part.seq], 2);   // never overwrite the server
          else throw new UploadError('refused', (reply.data && reply.data.detail) || `Upload of ${part.stream} #${part.seq} failed (${reply.status}).`);
          sent += 1;
        }
      }
      const pending = await countPending(id);
      recording = await getRecording(id);
      const ended = recording.state !== 'recording';
      if (!pending && ended && !(recording.upload && recording.upload.finished)) {
        const finished = await request(account, 'PATCH', `${base}${id}/`, {
          state: recording.state === 'finished' ? 'finished' : 'interrupted',
          ended_at: recording.ended_at ? new Date(recording.ended_at).toISOString() : null,
          duration_ms: recording.duration_ms ?? null,
          meta: {...recording.meta, counts: recording.counts, streams: recording.streams, pauses: recording.pauses},
        });
        if (finished.status !== 200) throw new UploadError('refused', `The server did not accept the end of the recording (${finished.status}).`);
        // The server's answer already says what happens next (the lessons
        // are queued the moment it learns the recording is complete).
        const lessons = finished.data && finished.data.lessons ? {...finished.data.lessons, at: Date.now()} : null;
        await updateRecording(id, (r) => ({...r, upload: {...(r.upload || {}), finished: true, error: null, at: Date.now()},
                                           lessons: lessons || r.lessons || null}));
      } else {
        await updateRecording(id, (r) => ({...r, upload: {...(r.upload || {}), error: null, at: Date.now()}}));
      }
      return {ok: true, sent, pending, finished: !pending && ended};
    } catch (error) {
      const code = error.code || 'error';
      await updateRecording(id, (r) => ({...r, upload: {...(r.upload || {}), error: {code, detail: error.message}, at: Date.now()}})).catch(() => {});
      return {ok: false, code, detail: error.message};
    }
  }

  // ---------------------------------------------------------------- lessons

  /**
   * What the server is doing with an uploaded recording: understanding it,
   * writing lessons, the module link, or why nothing was built. Kept on the
   * recording, so the page shows the last known answer before it asks again.
   */
  async function lessons(id, account) {
    if (!account || !account.token || !account.api_base) return {ok: false, code: 'no_account'};
    try {
      const reply = await request(account, 'GET', `${CAPTURES}${id}/`);
      if (reply.status !== 200 || !reply.data || !reply.data.lessons) {
        return {ok: false, code: reply.status === 404 ? 'missing' : 'refused', detail: `The server answered ${reply.status}.`};
      }
      const status = {...reply.data.lessons, at: Date.now()};
      await updateRecording(id, (r) => ({...r, lessons: status}));
      return {ok: true, lessons: status};
    } catch (error) {
      return {ok: false, code: error.code || 'error', detail: error.message};
    }
  }

  /** A recording still marked "recording" that no recorder is running was cut
   *  short (browser closed, extension reloaded). Close it with what arrived. */
  async function closeOrphan(rec) {
    const parts = await partsOf(rec.id);
    const last = parts.reduce((max, p) => Math.max(max, p.t || 0), 0);
    const bytes = parts.reduce((sum, p) => sum + (p.size || 0), 0);
    const frames = parts.filter((p) => p.stream === 'frames').length;
    // Counts come from the recorder's last checkpoint (at most 5 s old); the
    // parts themselves are the truth for size, length and frames.
    return updateRecording(rec.id, (r) => (r.state !== 'recording' ? r : {
      ...r, state: 'interrupted', ended_at: Math.round(r.t0 + last), duration_ms: Math.round(last), bytes,
      counts: {...(r.counts || {}), frames}, end_reason: 'the recorder stopped without saving (browser closed or extension reloaded)',
    }));
  }

  /** Errors that another attempt cannot fix: the expert has to do something. */
  const FATAL = ['signed_out', 'not_author', 'no_account', 'link_revoked'];

  return {
    open, putRecording, getRecording, listRecordings, updateRecording, deleteRecording,
    putPart, partsOf, pendingParts, countPending, countParts, markParts, bundle, frameFile, sync, lessons, closeOrphan, FATAL,
  };
})();
