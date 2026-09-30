# Frty2 Guide for Zoho CRM (Chrome extension)

The ghost cursor, plus Watch (below) for experts and the live Tutor (below) for any app. The ghost runs inside the learner's own Zoho CRM tab, shows a skill
while narrating it, hands over, answers questions, and speaks the nudges and
the celebration that the Frty2 backend sends. It never grades from the screen:
verification reads Zoho's records on the server.

The cursor is a large Deep Teal arrow with a "42 Tutor" tag. It is on screen
for the whole demonstration: it glides to whatever the narration names, circles
what it wants read, presses and types visibly, drifts while it talks, and
carries its position across Zoho page loads. The overlay is a manual popover in
the browser's top layer, so Zoho's dialogs cannot cover it.

**Look.** Everything drawn over the learner's app follows the Assure by 42
palette (Estuary, Deep Teal, Mist, Chalk) and is set in Fira Code Nerd Font
with ligatures on; `brand.js` holds the colours, the face, the icons and the
frosted, elevated surface all of it shares. The font is bundled as data in
`vendor/fira-code-nerd/` (subset, OFL and MIT, see its `LICENSE`) and given to
`FontFace` directly, so no page's CSP can block it. `brand.js` and the font
file are injected before `ghost.js` and before `tutor-overlay.js`.

## Watch (for experts)

Watch records an expert using any web application while they explain it,
the raw material for turning expertise into modules
([`docs/plan/expert-capture.md`](../docs/plan/expert-capture.md)). Click the
extension icon on the application's tab, say what you will show, and press
**Start watching this tab** (or the start/stop shortcut). The first time, a
page asks for two permissions: reading the pages you record (to write down
what you click) and the microphone.

What it records, all stamped on one clock:

- the tab as video (WebM at the tab's own shape, long side at most 1920 px, 5 fps) and the microphone as
  voice (WebM/Opus), in 2-second chunks;
- the DOM event log from every frame of the tab: clicks by text, role and
  label, the final value typed (never keystrokes; password, OTP and card-like
  fields masked), selects, checkboxes, Enter/Escape/Tab and chords,
  navigations, dialogs and toasts, network calls (URL pattern, status, time;
  no bodies), and a compact snapshot of the visible controls after each
  action;
- a JPEG about 100 ms before and 800 ms after each action, and a keyframe
  when nothing happened for 5 s;
- speech segments from a level-based voice detector, and the expert's
  markers (Step, Oops, Important, Learners ask here, Never automate this).

**The indicator is deterministic.** The recorder sends a heartbeat every
500 ms saying whether both recorders are running, both tracks are live and
chunks are still arriving. The watched tab shows a red frame and a
"Watching 03:12" pill (with a live microphone meter) only while a heartbeat
younger than 1.5 s says so. Otherwise it shows what is true: an amber dashed
frame for **Private** (paused: nothing is recorded), a warning when the
recorder reports a problem (microphone muted, a recorder stalled), or a grey
"Watch not confirmed" when there is no heartbeat at all. The toolbar badge
follows the same rule (`REC`, `||`, `!`, `?`), and every other tab shows
"Frty2 is watching another tab". Chrome adds its own capture dot on the tab.
The pill also counts actions done without a word since the expert last spoke.

Shortcuts (Chrome drops suggested keys that clash with the browser, so the
pill and the recordings page show the ones actually assigned; change them at
`chrome://extensions/shortcuts`): `Alt+Shift+O` start/stop, `Alt+Shift+K`
step, `Alt+Shift+M` private, `Alt+Shift+U` oops (drop the last 10 s).

**Expert sessions.** Backstage (Web apps → Expert capture) registers an app
and plans sessions in it. A session page's **Link Watch to this session**, or
the public recording page its link opens (`/record/<token>`, for an expert
with no Backstage account), hands the extension the session: the popup then
shows what to record and **Open the app**, and recordings upload into that
session with its link token (`Authorization: CaptureSession …`). An expert can
also type the session's 8-character code in the popup (Watch → Have a session
code?). Cancelling the session, or making a new link, revokes the old one.

Recordings are local first (IndexedDB, written as they happen). When a watch
stops, the recordings page (`watch.html`) opens: download a bundle (a zip
with `screen.webm`, `voice.webm`, `events.jsonl`, `speech.json`,
`markers.json`, `frames/` and a README describing the format), upload, or
delete. Sign in there with a Backstage author account and recordings upload
while they are made, to `/api/v1/webapps/backstage/captures/` (parts are
write-once, so uploads resume blindly after any crash).

Not yet: masking pixels in the video and frames (use **Private**), browser
`alert`/`confirm` dialogs, hover menus. The pill itself appears in the video.

## Tutor (live voice, any app)

The tutor teaches one byte of a module out loud, in the learner's own tab of
the byte's app (any domain), while a cursor shows it. It talks to the backend
over one WebSocket, `ws(s)://<api>/ws/webapps/tutor/`; the backend relays the
live model, owns the lesson and decides every cursor action. The protocol is
[`docs/plan/module-agents.md` §12.4](../docs/plan/module-agents.md): JSON text
frames, and binary audio tagged by its first byte (`0x01` microphone, 16 kHz
PCM16 in 40 ms frames; `0x02` speaker, 24 kHz PCM16).

- **Starting.** A Backstage page posts `frty2:tutor_start {api_base, token,
  byte_id, language, app_url}`; `bridge.js` hands it to the service worker,
  which finds or opens the app's tab, injects `tutor.js`, and has the
  offscreen document connect and send `hello`. The page hears back
  `frty2:tutor_started {ok, error?, detail?, mic?}`. Without access to the
  app's origin the setup page (`watch.html#setup`) opens and the start fails
  with `needs_access`; `frty2:tutor_stop` ends it.
- **Voice.** The socket, the microphone (echo cancellation, noise
  suppression, AGC) and the speaker live in the offscreen document, so a
  page load in the app keeps the session; the service worker puts
  `tutor.js` back after each load. Speaker chunks are scheduled back to back
  on one audio clock; `speech {status: interrupted}` flushes them at once.
  Pause stops the microphone frames.
- **Cursor.** The ghost's look (Deep Teal arrow, glide, circle, spotlight,
  press ripple), on any page. Actions: `point`, `click`, `type`, `select`,
  `navigate`, `drag`, `park`, `none`, each answered with `action_done`.
  Targets are semantic (`text`, `role`, `label`, `placeholder`, `aria`,
  `within: "dialog"`), visible elements only, through open shadow roots; an
  unresolved one is reported (`not_found`, `no_dialog`, `wrong_page`), never
  asked of the learner. `when: speech_start` runs as the audio that followed
  the action starts playing (or after 3 s without audio); `speech_end` when
  that turn's audio has played. The timing is measured in the offscreen
  player, which tells the page `playback {started|ended, ids}`.
- **What the learner does** goes back as `event {events}` in Watch's schema,
  batched every 300 ms, secrets masked. The tutor's own clicks and typing
  are not reported; dialogs, toasts and loads they cause carry `by: "tutor"`.
- **Panel** (bottom right): a status button with a glowing LED (green while
  the lesson is live: Listening / Speaking / Thinking; amber when Paused or
  Reconnecting) that pauses and resumes, the mic level inside it, the latest
  captions, Pause/Resume, Next, Check my work, Stop. `request_frame` sends a JPEG of the visible tab (long side at most
  `max`) with the overlay hidden; it needs the tab to be in front and access
  to all sites (`<all_urls>`, granted on the setup page).
- **Text on screen** (`tutor-overlay.js`, placed with Floating UI from
  `vendor/floating-ui/`): a start card (the lesson waits for its click), a
  label beside the element of each step with the value to type, cards, and
  the task through Do. Drawn from `overlay` messages as text only, timed like
  a glide, kept by the service worker across page loads; clicks on its
  buttons go back as `overlay_event`. **Aa** in the panel turns labels and
  cards off. Injection order: the two Floating UI files, the font data,
  `brand.js`, `tutor-overlay.js`, `tutor.js`.
- **For the run's trace** the tutor also reports what only the browser knows:
  `action_done` carries the element it used, how long it took and the page;
  the offscreen player tells the server when each line actually started and
  finished playing (`playback`); overlays report where they were placed;
  `hello` carries the extension version and browser.
- **Turn-taking** (protocol 3, [docs/plan/tutor-floor.md](../docs/plan/tutor-floor.md)):
  the panel's status line says who has the floor (listening, thinking,
  speaking, watching you work, your turn, paused, voice trouble) as the
  server sends it; `speech interrupted` also stops a glide where it is;
  `cancel {ids}` drops actions still waiting for their speech. The offscreen
  player numbers each turn's audio and reports on a flush how much of each
  turn was heard, and tells the server when the microphone has sent exact
  silence for a second (`mic silent`), so the model hears that the stream
  ended.
- **Putting the screen back** (0.5.1, [docs/plan/tutor-mission.md](../docs/plan/tutor-mission.md) §11):
  when a step's element is gone (a dropdown or dialog closed), the server
  sends the steps that open it again as `when: "now"` actions marked
  `restore: true`; they run in order like any others. The status line shows
  `restoring` ("The screen changed: opening it again…").
- **Seeing the screen.** `captureVisibleTab` needs access to all sites; the
  app's own host is not enough. The first time a learner clicks Start on a
  lesson card, a small window asks for it once (`watch.html#eyes`); without
  it the tutor answers without seeing the screen.

## Voice

Narration never plays inside the Zoho page (its CSP and autoplay policy can
silence it). The service worker plays each ElevenLabs clip in an offscreen
document (`offscreen.html`); when there is no clip or it cannot play, Chrome's
own text-to-speech (`chrome.tts`, a Hindi voice for Hindi) says the line. If
the server cannot produce clips, the panel says why in a yellow note ("Using
the browser's voice: …").

## Install it (any machine, from the public repo)

This folder is published as https://github.com/frty2-ai/playground-for-chrome
(`extension/publish.sh` syncs it), so no checkout of the main repository is
needed on the demo machine.

1. Download https://github.com/frty2-ai/playground-for-chrome/archive/refs/heads/main.zip
   and unzip it. On a Mac that gives a folder `playground-for-chrome-main`
   in Downloads with `manifest.json` directly inside it.
2. Chrome → `chrome://extensions` → turn on **Developer mode** (top right).
3. **Load unpacked** → choose that folder. "Frty2 Guide for Zoho CRM" appears
   with its icon; pin it from the puzzle-piece menu if you like.
4. Sign in to the learner app (https://frty2-learner.vercel.app), open the
   module, **Get my account**, **Open Zoho CRM** and sign in there as that
   user (email one-time code), back on the lesson choose the language,
   **Begin the lesson**, then **Connect the guide**.
5. Switch to the Zoho tab: the ghost cursor's panel is bottom-right.

The whole demo, with what can go wrong at each step, is written up in
[`docs/plan/zoho-demo.md`](https://github.com/frty2-ai/playground/blob/main/docs/plan/zoho-demo.md).

To update later: download the ZIP again and use the extension card's reload
button after replacing the folder (or Load unpacked the new folder).

## Load it from this repository (developers)

1. Chrome → `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → choose this `extension/` folder.
3. Open the lesson page in the learner app; it reports "Extension found".

## How it pairs with a lesson

- **Automatic:** the lesson page's **Connect the guide** button posts the
  session id, the learner's token and the API base to `bridge.js`, which the
  service worker stores. Any `crm.zoho.*` tab then shows the guide.
- **Fallback:** click the extension icon (puzzle piece → Frty2 Guide). The
  API address is the backend the lesson page talks to, pre-filled from the
  page's own ping (`https://api.frty2.wawm.ai` for the hosted demo;
  `http://localhost:8080` only when the backend runs on your machine). The
  code is the 8 characters the lesson page shows under **Connect the guide**
  once **Begin the lesson** has been pressed; it is single-use, lives 15
  minutes, and the page renews it while it is open.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3. Content scripts on `crm.zoho.in/.com/.eu` and on the learner app origins. |
| `background.js` | Holds the pairing; relays every API call with the token; notifies Zoho tabs when pairing changes; runs Watch; starts, stops and routes the tutor. |
| `bridge.js` | On the learner app and Backstage: forwards `frty2:pair`, `frty2:watch_session` and `frty2:tutor_start`/`_stop` messages, answers `frty2:ping`. |
| `ghost.js` | The overlay (shadow DOM, top layer): cursor, spotlight, captions, panel with mic and question box; the script runner; the queue poller. |
| `offscreen.html/js` | The speaker: plays narration clips for the service worker. Also hosts the Watch recorder and the tutor's line (`tutor-audio.js`). |
| `popup.html/js` | Start/stop Watch; the learner pairing status and the code fallback. |
| `watch.js` | Watch in the page: the event log (every frame of the watched tab) and the indicator (top frame). |
| `watch-recorder.js` | Watch's recorder, in the offscreen document: tab video, voice, frames, voice activity, heartbeat, upload. |
| `watch-level-worklet.js` | Microphone level on the audio thread; its messages also pace the heartbeat. |
| `watch-store.js` | IndexedDB storage, the bundle zip, and the resumable upload. |
| `watch.html` / `watch-page.js` | Permissions, the upload sign-in, and the recordings on this computer. |
| `tutor.js` | The live tutor in the learner's app tab: cursor and target resolver, action timing, DOM events, panel, frames. |
| `tutor-audio.js` | The tutor's WebSocket, microphone and speaker, in the offscreen document; decides when speech starts and ends. |
| `tutor-mic-worklet.js` | Microphone to 16 kHz PCM16 in 40 ms frames, on the audio thread. |

## The script DSL the runner executes

```json
{"id": "s05", "say": {"en": "Now Convert.", "hi": "अब Convert।"},
 "action": {"type": "click", "target": {"text": "Convert", "role": "button"}},
 "wait_for": {"within": "dialog", "text": "Convert"}}
```

Actions: `navigate {url}`, `click {target}`, `type {target, value}`,
`select {target, value}`, `highlight {target}`, `wait_for {target}`,
`pause {ms}`, `say`, `handover`. Targets: `{text, role}`, `{label}`,
`{placeholder}`, `{selector}`, plus `within: "dialog"` and `nth`.

A step (or an intro line) may carry `point: {target}`: the cursor glides there
while the line is spoken. Before a `navigate` the ghost points at, and clicks,
`point` or else the module tab named in the URL (`…/tab/Deals` → "Deals"), and
loads the URL itself only if Zoho did not route there. A `highlight` whose
target is missing is skipped; a missing `click`/`type`/`select` target asks the
learner to click it once, with **Skip this step** on the panel.

Resolution is by visible text, labels next to inputs, placeholders, and ARIA;
ties between candidates are broken with one JEV decision through the backend.
When a target cannot be found the ghost asks the learner to click it once and
remembers the element (`chrome.storage.local`, key `frty2_hints`).

## Origins

Edit `host_permissions` / `content_scripts.matches` in `manifest.json` when
the learner app or API move to a new domain.
