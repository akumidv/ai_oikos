# Route: Gmail like a mail client (IMAP, app password)

`tools/google` reads the corporate Gmail over IMAP (`imap.gmail.com:993`) with a Google **app
password**, the way a desktop mail client does: no Google Cloud project, nothing enabled in the
Claude cloud. Read-only: "All Mail" is opened read-only, so nothing is sent, moved, deleted or
even marked read. Writing (a draft, a reply) goes through the browser route, after confirmation.

## Is it set up?

`node oikos/tools/google/cli.mjs whoami` — signs in and shows the account and the size of All Mail,
or what is missing. The account is `GMAIL_USER`, else `JIRA_EMAIL` — always the organization's one (`organization.email_domain`).

## Setting it up (once per person)

1. The user creates an app password at https://myaccount.google.com/apppasswords with the
   corporate account (it needs Google's 2-Step Verification; if the page is missing, the
   Workspace admin has turned app passwords off — then mail goes through the browser).
2. The user types it in their own terminal: `! node oikos/tools/setup/cli.mjs token GMAIL_APP_PASSWORD`
   (no echo, into `.local/.env`). Never in the chat.
3. The libraries on first use: `node oikos/tools/google/cli.mjs install` shows the plan
   (imapflow + mailparser into `tools/google/node_modules`); `--yes` after the user agrees.

A revoked or changed password: "Gmail refused the app password" — a new one, step 2 again.
Google mails a "Security alert" when an app password is created; that is expected.

## Reading

- `mail <query> [--limit 20]` — the Gmail search box's operators: `from:`, `to:`, `subject:`,
  `after:2026/09/01`, `before:`, `newer_than:7d`, `has:attachment`, `filename:pdf`, `label:`,
  `in:sent`, plain words in any language. Newest first; the id is Gmail's message id.
- `message <id>` — headers, text (HTML turned into text), the list of attachments;
  `--thread` — the whole thread, oldest first.
- `attachment <id> --out <folder> [--name part]` — only when asked; into the scratchpad unless
  the user named a place; office files then go to skill `documents`.

Each command signs in anew (a second or two); search narrowly rather than paging through.

## When it does not work

- "no channel to imap.gmail.com:993" — the network or a proxy blocks IMAP; use the browser.
- "no All Mail folder over IMAP" — in Gmail → Settings → Labels, "Show in IMAP" for All Mail.
