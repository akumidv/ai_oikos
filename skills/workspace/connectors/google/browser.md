# Route: Google in the shared browser

Gmail, Drive, Docs/Sheets/Slides and Calendar in the oikos Chrome (skill `browser`). The user
signs in once in that window; the session stays in the profile under `.local/.browser/`.
Nothing is enabled in the Claude cloud and no token is kept.

## Start

1. `node oikos/tools/browser/cli.mjs status`; if nothing runs, `start --url https://mail.google.com`
   (or `https://drive.google.com`).
2. If the page asks for a sign-in, hand over: the user signs in with the
   organization's account (Google, then its SSO if it has one). **Never type an address, password or code.**
3. Check the account: `take_snapshot` shows it in the account button ("Google Account: …").
   Several signed-in accounts: add `?authuser=<corporate email>` to the URLs below, or use the
   `/u/<n>/` the page itself uses.

Prefer `take_snapshot` (text and element ids) to screenshots; open URLs directly rather than
clicking through menus.

## Gmail

- **Search**: `https://mail.google.com/mail/u/0/#search/<query>` with Gmail operators, URL-encoded
  — `from:`, `to:`, `subject:`, `after:2026/09/01`, `before:`, `has:attachment`,
  `filename:pdf`, `label:`, `in:sent`. The snapshot lists the threads (sender, subject, date,
  snippet); open one by clicking its row.
- **Read a thread**: the snapshot of the open thread has every message; expand collapsed ones
  ("Expand all") before summarising.
- **Attachment**: only when asked. The attachment's download control saves it to the browser's
  download folder; then work on it from there (skill `documents` for office files).
- **Draft a reply**: say the recipients, subject and full text first; after the user's yes, open
  Reply, `fill` the text, and leave it as a draft. **Send** is a separate confirmed step.

## Drive and Docs

- **Search**: `https://drive.google.com/drive/u/0/search?q=<words>`; add `type:document`,
  `type:spreadsheet`, `type:pdf`, `owner:me`, `after:2026-09-01` in the query as in the Drive
  search box. A folder: `https://drive.google.com/drive/folders/<id>`.
- **Read a native Doc** as text: open it, then `evaluate_script` with
  `async () => (await fetch(location.pathname.replace(/\/edit.*$/, '/export?format=txt'))).text()`
  — the page's own session exports it; nothing is saved. A Sheet: `/export?format=csv&gid=<gid>`
  (gid from the URL, one sheet per call). Slides: `/export/txt`. A `.gdoc`/`.gsheet` from the
  Drive folder: `node oikos/tools/google/cli.mjs link <file>` gives these URLs; fetch one the same
  way from any open docs.google.com page.
- **As a file** (docx/xlsx/pdf) for the `documents` skill: navigate to
  `…/d/<id>/export?format=docx` (or `xlsx`, `pdf`; Slides `…/export/pptx`); it lands in the
  download folder.
- **A file uploaded to Drive** (a pdf, a docx): the preview's snapshot has its text for a quick
  look; for the file itself use the Download control, only when asked.

## Calendar

- A day or a week: `https://calendar.google.com/calendar/u/0/r/day/2026/9/29`
  (`/r/week/…`, `/r/month/…`); the snapshot lists the events with times.
- Free/busy for a proposal: read the week, then propose slots; creating an event is a confirmed
  step (SKILL.md, Writing).

## When it does not work

- A Cloudflare Access or an unexpected sign-in page: the browser's proxy route (skill `browser`,
  Setup and troubleshooting).
- Google shows a different account or "choose an account": ask the user which one; never pick.
- No graphical session: the user cannot sign in there (skill `browser`); suggest the Drive
  folder or connectors route, or a machine with a display.
