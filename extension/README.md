# oikos browser extension

A Chrome extension (Manifest V3; Chrome, Edge and other Chromium browsers) that adds small
helpers to the company's web resources. The popup on the toolbar icon says what oikos is, turns
each helper on or off (the choice follows the Chrome profile), and shows what the helpers did on
the open tab.

## Helpers

| Site | Helper | What it does |
|---|---|---|
| Jira (`*.atlassian.net`, not `/wiki`) | Hide Agents | Hides the *Agents* block under the description. |

A helper either **hides** blocks by their titles — their frames are held at `about:blank`, so an
app panel is not loaded or rendered at all — or **opens** them when an issue opens, once per
issue, so a panel you close stays closed.

The helpers and the titles they look for are one table in [common/helpers.js](common/helpers.js).

## Install

The extension is loaded unpacked from the oikos folder, so a `git pull` updates it:

1. Open `chrome://extensions` (Edge: `edge://extensions`) and switch on **Developer mode**.
2. **Load unpacked** → choose the `extension/` folder of your oikos clone. Under WSL choose it
   through `\\wsl.localhost\<distro>\…\oikos\extension`.
3. Pin the oikos icon on the toolbar if you want the popup at hand.

After an update (`git pull`) press **Reload** on the extension's card and reload the open Jira
tabs. The shared browser of the `browser` skill is a separate Chrome profile: load the extension
there the same way once.

## How it works

- `common/helpers.js` — the helpers by site, and the on/off settings (`chrome.storage.sync`).
- `common/sections.js` — finds a block of the page by its visible title and hides it: the block
  gets `data-oikos-hidden` (`display: none` from `common/sections.css`, injected before the page
  is built), every frame in it is held at `about:blank`. Nodes are never removed: the page's
  React owns them. Where a block ends is taken from the other known titles around it (a block is
  the largest ancestor of its title that holds no other title), not from Jira's class names or
  test ids, which change with releases; a block that would come out too large is left visible.
- `sites/jira/content.js` — runs at `document_start`, follows the page with a
  `MutationObserver` and acts in its callback, before the browser paints what was added.
- `popup/` — the popup.

**When a helper misses a block** (Jira renamed a title or changed the layout): the popup shows
the helper's state on the open tab, and **Copy diagnostics** copies what the helpers found and
the path from each title up the page. Hand that to the agent in oikos development mode; a
renamed title is a change in `common/helpers.js`, a new neighbouring section a landmark in
`sites/jira/content.js`.

A new site is an entry in `SITES`, a `sites/<site>/content.js`, and a `content_scripts` entry in
`manifest.json` limited to that site's host.
