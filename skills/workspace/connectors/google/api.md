# Route: the Google APIs with a local sign-in

**Off by default.** It needs an OAuth client in a Google Cloud project, so the commands below
refuse unless the user set `OIKOS_GOOGLE_API=1` (`.local/.env`, or the shell as a fallback); the
agent does not suggest it. `logout --yes` works either way.

`tools/google` reads Gmail, Drive and Calendar over Google's REST APIs with the user's own
sign-in. The token stays on the machine (`.local/google/`, mode 600; the secret guard denies
reading it); nothing is enabled in the Claude cloud. Read-only: nothing is sent, shared, deleted
or changed at Google — writing goes through the browser route, after confirmation.

## Is it set up?

`node oikos/tools/google/cli.mjs whoami` — the account and scopes (`mail`, `drive`, `calendar`), or
what is missing. The account must be the corporate one; `auth` refuses any other.

## Setting it up (once per person)

1. **OAuth client** — the user, in https://console.cloud.google.com with the corporate account:
   a project (their own, or one the company gave them) → APIs & Services → enable **Gmail API**,
   **Google Drive API**, **Google Calendar API** → OAuth consent screen: **Internal** →
   Credentials → Create credentials → OAuth client ID → **Desktop app** → Download JSON.
   If the organisation does not let people create projects, the Workspace admin gives one.
2. `node oikos/tools/google/cli.mjs client <downloaded.json>` — copies it into `.local/google/`; the
   downloaded file can then be deleted.
3. **Sign-in** — the user runs `! node oikos/tools/google/cli.mjs auth` (their browser opens; they sign
   in (through the organization's SSO, if any) and allow read access). `--scopes mail,drive` asks for less. With the browser
   on another machine (no display here): `--print`, open the URL there, and paste the address
   the browser ended on (`http://127.0.0.1:…`) into that terminal — not into the chat.

`logout --yes` revokes the sign-in and deletes the token; `auth` again after "expired or
revoked" (a consent screen left in "Testing" expires tokens after 7 days — use Internal).

## Mail

- `mail <query>` — Gmail search box operators: `from:`, `to:`, `subject:`, `after:2026/09/01`,
  `before:`, `has:attachment`, `filename:pdf`, `label:`, `in:sent`, `newer_than:7d`; `--limit`.
- `message <id>` — headers, text (HTML turned into text), the list of attachments;
  `--thread` — the whole thread.
- `attachment <id> --out <folder> [--name part]` — only when asked; into the scratchpad unless
  the user named a place; office files then go to skill `documents`.

## Drive

- `files <words>` — by name or text across My Drive and shared drives; `--type document |
  spreadsheet | presentation | pdf | folder`, `--folder <id|url>` (one folder's content),
  `--q "<Drive query>"` for anything else.
- `read <id|url|file.gdoc>` — the text: a Doc (`--format md` keeps headings and tables), a
  Sheet as CSV (first sheet), Slides as text, a text file as is. Other files: `download`.
- `download <id|url|file.gdoc> --out <folder> [--format docx|xlsx|pptx|pdf|…]` — a native file
  exported (default its office format), anything else as it is.

## Calendar

`events [--from 2026-09-29] [--to 2026-10-03] [--calendar <email>]` — the week from today by
default; own response in brackets. Free slots are worked out from it; creating an event is a
confirmed step in the browser (SKILL.md, Writing).

## When it does not work

- "not enabled in the … project" — enable that API in the client's project (step 1).
- "no channel" — the machine does not reach `*.googleapis.com`; check the proxy, or use the
  browser route.
- A 403 about the organisation's policy — the Workspace admin restricts API access for this
  client; use the browser route and tell the user.
