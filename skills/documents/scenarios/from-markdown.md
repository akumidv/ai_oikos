# Scenario: a formal document from a markdown note

The user has a document written as a markdown note, usually in their Obsidian vault: a policy, a
procedure, a system description, an audit document. They want it as a Word file and a PDF in the
format of the approved policies (for a compliance platform, an auditor, a customer). **The note stays the
source.** The .docx and .pdf are built from it, and a later change is made in the note and
rebuilt, never edited in Word.

What comes out:
- A4, in the organization's brand — the fonts, logos and accent colour named in the installation's
  `brand:` — or in a neutral look (system fonts, no logos) when there is none. Brand fonts are
  embedded, so the file looks the same without them installed.
- A title page: logo, eyebrow, company, title and subtitle, classification, version, date,
  owner, and any extra fields.
- Change History and Contents on the second page.
- The body: numbered headings, tables, two-level lists, code, and figures with captions.
- A header with the signet, the title and the classification; a footer with the company,
  version, date and "Page X of Y".

## Steps

1. **Shape the note** so the tool can find the parts (all optional except a title):

   ```markdown
   ---
   title: …
   status: draft            # "(draft)" next to the version
   ---
   **ACME Corp**
   # System Processing Documentation — ACME Assistant      ← title — subtitle
   Classification: **Internal**
   ## Change History
   | Date | Version | Created by | Description |
   |---|---|---|---|
   | 29-Sep-2026 | 0.1 | … | Initial draft |          ← the last row gives version and date
   ## Contents                                            ← replaced by one built from the body
   ---                                                   ← the front part ends here
   ## 1. Purpose
   …
   ```

   - Nothing belongs in the document that is not for its readers: no evidence links, working
     notes, `[TO CONFIRM]` markers or wiki-links to private notes. A `[[link]]` prints as its
     text only.
   - A figure's caption is the bold lead of the paragraph just before it, for example
     `**Request processing.** …`.

2. **Figures.**
   - An image embed (`![[name.png]]`, `![](path)`) is found next to the note or in the vault's
     `attachments/`.
   - A ```` ```mermaid ```` block needs a PNG, passed in order with `--figures a.png,b.png`.
     Without one the command stops and writes each block's source to a `.mmd` file.
   - Render the `.mmd` files locally:

     ```bash
     npx -y @mermaid-js/mermaid-cli@11 -i figure-1.mmd -o figure-1.png -s 2 -b white
     ```

   - If mermaid-cli finds no Chrome: `PUPPETEER_EXECUTABLE_PATH=<a local Linux/macOS Chrome>`.
     Otherwise, with the user's agreement, run `npx puppeteer browsers install chrome-headless-shell`.
     This goes into the user's cache, with no system change. Under WSL a Windows `chrome.exe`
     does not work for this.
   - **Never send a diagram to an online renderer** (mermaid.ink, kroki): an internal document's
     architecture must stay local.
   - A wide left-to-right flowchart becomes unreadable on A4. Draw it top-to-bottom (`flowchart TB`),
     and change the note as well, so the note and the document show the same figure.
   - Keep the PNGs in the vault's `attachments/` next to the note.

3. **Build the files.** Write to the scratchpad first:

   ```bash
   node oikos/tools/documents/cli.mjs from-markdown "<note.md>" --out "<scratchpad>/<Title> v0.1.docx" --pdf \
     --figures "<fig1.png>,<fig2.png>" --owner "Chief Technology Officer" \
     --eyebrow "SOC 2 · Internal" --meta "Framework=SOC 2 — CC2.2, PI1.1–PI1.3"
   ```

   - Name the file like the approved policies: `<Product> - <Title> v<version>`.
   - The first run needs `node oikos/tools/documents/cli.mjs install`, which shows the plan. With the
     user's agreement, `--yes` installs the `docx` package into `tools/documents/node_modules`.
     `--pdf` needs LibreOffice (SKILL.md, Tools).
   - The brand's files come from the assets folder: `OIKOS_BRAND_ASSETS`, or the brand plugin
     skill named by `OIKOS_BRAND_PLUGIN` (settings of the installation); `--brand <dir>` overrides.
     Which fonts, logos and colours: `brand:` in the installation's configuration.
     If they are not found, the command says so. Without a company line in the note, the title page
     takes `organization.name`.

4. **Look at every page** before handing the files over. Check that:
   - the tables fit;
   - figures are legible;
   - no code block or table row is split across a page;
   - the contents match the headings.

   `render <file.pdf>` gives only the first page. For every page, use a PDF-to-PNG route the
   machine has: `pdftoppm`, or PyMuPDF in a scratchpad venv.

5. **Hand over.**
   - Put the files where the user keeps such documents (they name it).
   - Uploading them to Drive, the tracker or a compliance platform is the user's step, or a
     separate confirmed step (`workspace`, `task-tracking`, `browser`).
   - For a new version: add a Change History row in the note, set `status` (draft → shared once
     approved), and rebuild.
