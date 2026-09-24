# Frty2 Guide for Zoho CRM (Chrome extension)

The ghost cursor. It runs inside the learner's own Zoho CRM tab, shows a skill
while narrating it, hands over, answers questions, and speaks the nudges and
the celebration that the Frty2 backend sends. It never grades from the screen:
verification reads Zoho's records on the server.

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
   module, **Get my account**, choose the language, **Connect the guide**.
5. Open https://crm.zoho.in in another tab, signed in as that Zoho user
   (email one-time code). The ghost cursor appears there.

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
- **Fallback:** click the extension icon, enter the API address and the
  8-character code shown on the lesson page.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3. Content scripts on `crm.zoho.in/.com/.eu` and on the learner app origins. |
| `background.js` | Holds the pairing; relays every API call with the token; notifies Zoho tabs when pairing changes. |
| `bridge.js` | On the learner app: forwards `frty2:pair` messages, answers `frty2:ping`. |
| `ghost.js` | The overlay (shadow DOM): cursor, spotlight, captions, panel with mic and question box; the script runner; the queue poller. |
| `popup.html/js` | Status and the code fallback. |

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

Resolution is by visible text, labels next to inputs, placeholders, and ARIA;
ties between candidates are broken with one JEV decision through the backend.
When a target cannot be found the ghost asks the learner to click it once and
remembers the element (`chrome.storage.local`, key `frty2_hints`).

## Origins

Edit `host_permissions` / `content_scripts.matches` in `manifest.json` when
the learner app or API move to a new domain.
