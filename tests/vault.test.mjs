// The `vault` tool (ADR 0007 D04, npm test): notes written into the wiki mounts of an installation —
// search across wikis, read, create from a template, append, replace-section — with the one content check
// (the installation's terms, derived terms, linked installations' terms, the organization's markers of a
// personal vault, `mention_assistant`, normalised text, executable content), the write targets (never a
// dot folder, a rule file, a SKILL.md, a nested repository, `skills.from`, a link out of the vault, a
// hard-linked note) and the writes themselves (a temporary file renamed into place). Each test makes a
// temporary installation (ACME Corp) with real `git init` mounts, as tests/helpers/mounts.mjs does.
// Nothing here reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, tool } from './helpers/installation.mjs';
import { ENV, configOf, mounted, repository, skill, write } from './helpers/mounts.mjs';
import { installation } from './helpers/installation.mjs';
import { WRITES } from '../tools/hooks/writes.mjs';
import { GuardRefusal } from '../tools/common/cli.mjs';
import { judgeTarget, writeNote } from '../tools/common/vault.mjs';

const vault = (dir, ...args) => tool(dir, 'vault', args, ENV);
const text = (path) => readFileSync(path, 'utf8');
const NOTES = '# Notes of the team\n';

/** An installation with the wiki `team` (shared, inside; inbox/) and the wiki `own` (personal, outside, the default). */
function fixture({ rules = NOTES, outgoing, change } = {}) {
  const m = mounted();
  write(join(m.team, 'NOTES.md'), rules);
  if (outgoing) write(join(m.dir, '.local', 'outgoing.yaml'), outgoing);
  if (change) change(m);
  return m;
}

/** `file` of the installation with `from` replaced by `to`. */
const reshape = (path, from, to) => { const before = text(path); assert.ok(before.includes(from), `${path} lacks ${from}`); write(path, before.replace(from, to)); };

/** The files in `dir` that are not notes: a temporary file left behind would show here. */
const leftovers = (dir) => readdirSync(dir).filter((name) => name.endsWith('.tmp'));

// -- the connector ----------------------------------------------------------------------------------

test('without a wiki mount the connector is not available; with one it is, no connectors: line needed', () => {
  const dir = installation((t) => t);
  const none = vault(dir, 'search', '--query', 'x');
  assert.equal(none.status, 1, none.output);
  assert.match(none.stderr, /^vault: no usable wiki mount/m);
  const { dir: mountedDir } = fixture();
  assert.ok(!/vault/.test(text(join(mountedDir, 'oikos.yaml')).split('mounts:')[0]), 'oikos.yaml lists no vault connector');
  const some = vault(mountedDir, 'search', '--query', 'nothing-there');
  assert.equal(some.status, 0, some.output);
});

test('a wiki mount with a problem is not used: it is not a repository top, so the vault does not see it', () => {
  const { dir, own } = fixture({ change: ({ dir: d }) => mkdirSync(join(d, 'vaults', 'plain'), { recursive: true }) });
  write(join(dir, '.local', 'mounts.yaml'), `mounts:\n  ${own}:\n    use: [wiki]\n    wiki: { name: own, default: true }\n  ${join(dir, 'vaults', 'plain')}:\n    use: [wiki]\n    wiki: { name: plain }\n`);
  const bad = configOf(dir);
  assert.ok(bad.problems.some((p) => p.includes('plain') && /not the top of a repository/.test(p)), bad.problems.join('\n'));
  const r = vault(dir, 'create', '--title', 'x', '--wiki', 'plain', '--folder', 'inbox', '--text', 'a note');
  assert.equal(r.status, 1, r.output);
  assert.match(r.stderr, /the wiki 'plain' is not used — .*not the top of a repository/);
  assert.ok(!existsSync(join(dir, 'vaults', 'plain', 'inbox')), 'nothing was made there');
  assert.equal(vault(dir, 'search', '--query', 'x').status, 0, 'the usable wikis still work');
  assert.ok(!/plain/.test(vault(dir, 'search', '--query', 'x').stdout), 'and the problem entry is not searched');
});

// -- search and read --------------------------------------------------------------------------------

test('search runs over every wiki and names the vault of each hit; --wiki limits it; dot folders are not searched', () => {
  const { dir, team, own } = fixture();
  write(join(team, 'inbox', 'alpha.md'), '---\ntitle: Alpha plan\n---\nthe importer is slow\n');
  write(join(own, 'ideas', 'beta.md'), 'Importer notes\n');
  write(join(team, '.obsidian', 'hidden.md'), 'importer in a dot folder\n');
  write(join(team, 'CLAUDE.md'), 'importer in a rule file\n');
  write(join(team, 'AGENTS.override.md'), 'importer in a Codex rule file\n');
  const all = vault(dir, 'search', '--query', 'importer');
  assert.equal(all.status, 0, all.output);
  assert.match(all.stdout, /^## team \(vaults\/team\)$/m);
  assert.match(all.stdout, /^## own \(/m);
  assert.match(all.stdout, /inbox\/alpha\.md:4: the importer is slow/);
  assert.match(all.stdout, /ideas\/beta\.md:1: Importer notes/);
  assert.ok(!/hidden|CLAUDE|override/i.test(all.stdout), 'a dot folder and a rule file are not searched');
  const only = vault(dir, 'search', '--query', 'importer', '--wiki', 'own');
  assert.ok(!/## team/.test(only.stdout) && /## own/.test(only.stdout));
  const byTitle = vault(dir, 'search', '--title', 'alpha plan');
  assert.match(byTitle.stdout, /inbox\/alpha\.md/, 'the front matter title matches');
  const json = JSON.parse(vault(dir, 'search', '--query', 'importer', '--json').stdout);
  assert.deepEqual(json.map((r) => r.wiki).sort(), ['own', 'team']);
});

test('read takes a path from the vault root or a note name; a name two notes have lists both; a link out is not a note', () => {
  const { dir, team, own } = fixture();
  write(join(team, 'inbox', 'alpha.md'), 'alpha text\n');
  write(join(own, 'ideas', 'alpha.md'), 'other alpha\n');
  write(join(own, 'ideas', 'beta.md'), 'beta text\n');
  const byPath = vault(dir, 'read', '--note', 'inbox/alpha.md');
  assert.equal(byPath.status, 0, byPath.output);
  assert.match(byPath.stdout, /alpha text/);
  assert.match(byPath.stdout, /wiki 'team'/);
  assert.match(vault(dir, 'read', '--note', 'beta').stdout, /beta text/, 'a name, no extension, found in the vault that has it');
  const twice = vault(dir, 'read', '--note', 'alpha');
  assert.equal(twice.status, 1, twice.output);
  assert.match(twice.stderr, /several wikis \(team, own\)/);
  assert.match(vault(dir, 'read', '--note', 'alpha', '--wiki', 'own').stdout, /other alpha/);
  const outside = tempDir('outside-');
  write(join(outside, 'secret.md'), 'not a note of the vault\n');
  symlinkSync(join(outside, 'secret.md'), join(team, 'inbox', 'link.md'));
  const linked = vault(dir, 'read', '--note', 'inbox/link.md');
  assert.equal(linked.status, 1, 'a link is not a note: the walk does not follow it');
  assert.ok(!linked.output.includes('not a note of the vault'));
});

// -- create, append, replace-section ----------------------------------------------------------------

test('create: the dry run shows the note and writes nothing; the real run writes through a renamed temporary file; an existing note is refused', () => {
  const { dir, team } = fixture();
  const args = ['create', '--title', 'Release plan', '--wiki', 'team', '--text', '# Plan\n\nShip it.\n'];
  const dry = vault(dir, ...args, '--dry-run');
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /Note: inbox\/Release plan\.md \(new\)/);
  assert.match(dry.stdout, /Ship it\./);
  assert.match(dry.stdout, /DRY RUN — nothing written to the vault/);
  assert.ok(!existsSync(join(team, 'inbox')), 'the dry run made nothing');
  const real = vault(dir, ...args);
  assert.equal(real.status, 0, real.output);
  assert.match(real.stdout, /Created inbox\/Release plan\.md in the wiki 'team'.*not committed/);
  assert.equal(text(join(team, 'inbox', 'Release plan.md')), '# Plan\n\nShip it.\n');
  assert.deepEqual(leftovers(join(team, 'inbox')), [], 'no temporary file is left');
  assert.equal(statSync(join(team, 'inbox', 'Release plan.md')).nlink, 1, 'a single name');
  const again = vault(dir, ...args);
  assert.equal(again.status, 1, again.output);
  assert.match(again.stderr, /exists already; edit it with append or replace-section/);
});

test('create: a folder is the inbox or a folder below the root, never the root; --folder goes below it; the default wiki takes the note when none is named', () => {
  const { dir, team, own } = fixture();
  const inRoot = vault(dir, 'create', '--title', 'x', '--wiki', 'own', '--text', 'a');
  assert.equal(inRoot.status, 1, inRoot.output);
  assert.match(inRoot.stderr, /no folder: a note goes into the wiki's inbox .* or a folder below the notes root/);
  assert.equal(vault(dir, 'create', '--title', 'x', '--wiki', 'own', '--folder', '.', '--text', 'a').status, 1, 'the root itself is no folder');
  assert.equal(vault(dir, 'create', '--title', 'Deep note', '--folder', 'a/b/c', '--text', 'deep').status, 0, 'no --wiki: the default wiki (own)');
  assert.equal(text(join(own, 'a', 'b', 'c', 'Deep note.md')), 'deep\n');
  assert.ok(!existsSync(join(team, 'a')), 'and not the other wiki');
  const asked = vault(dir, 'create', '--title', 'x', '--wiki', 'nobody', '--text', 'a');
  assert.equal(asked.status, 1);
  assert.match(asked.stderr, /no wiki named 'nobody'/);
});

test('create: a title becomes a note name; characters a file name cannot hold become -; the path is part of what is checked', () => {
  const { dir, team } = fixture();
  assert.equal(vault(dir, 'create', '--title', 'Plan: a/b?', '--wiki', 'team', '--text', 'x').status, 0);
  assert.ok(existsSync(join(team, 'inbox', 'Plan- a-b-.md')));
  for (const title of ['', '   ', '.hidden']) {
    const r = vault(dir, 'create', '--title', title, '--wiki', 'team', '--text', 'x');
    assert.equal(r.status, 1, `${JSON.stringify(title)}: ${r.output}`);
  }
  const leak = vault(dir, 'create', '--title', 'notes in /tmp/x', '--wiki', 'team', '--text', 'x');
  assert.equal(leak.status, 3, leak.output);
  assert.match(leak.stderr, /refused: content check: path/);
  assert.match(leak.stderr, /title line 1: path/);
});

test('create: the vault\'s template, with {{title}} and {{date}}, the given text where {{body}} stands, its front matter merged in', () => {
  const { dir, team } = fixture({ rules: '---\nrequired: [title, tags]\nlanguage: en\n---\n# Rules\n' });
  write(join(team, 'templates', 'note.md'), '---\n# the schema\ntitle: "{{title}}"\ncreated: {{date}}\ntags: []\n---\n# {{title}}\n\n{{body}}\n\n## Links\n');
  reshape(join(dir, 'oikos.yaml'), 'wiki: { name: team, rules: NOTES.md, inbox: inbox/ }', 'wiki: { name: team, rules: NOTES.md, template: templates/note.md, inbox: inbox/ }');
  const r = vault(dir, 'create', '--title', 'Importer', '--wiki', 'team', '--text=---\ntags: [infra]\n---\nIt batches the rows.\n');
  assert.equal(r.status, 0, r.output);
  const note = text(join(team, 'inbox', 'Importer.md'));
  assert.match(note, /^---\n# the schema\ntitle: "Importer"\ncreated: \d{4}-\d{2}-\d{2}\ntags:\n {2}- infra\n---\n# Importer\n\nIt batches the rows\.\n\n## Links\n$/, note);
  const noBody = vault(dir, 'create', '--title', 'Bare', '--wiki', 'team');
  assert.equal(noBody.status, 0, noBody.output);
  assert.match(text(join(team, 'inbox', 'Bare.md')), /^---\n# the schema\ntitle: "Bare"\n/);
});

test('create: a front matter key the vault requires is missing: refused, nothing written', () => {
  const { dir, team } = fixture({ rules: '---\nrequired: [title, tags]\n---\n# Rules\n' });
  const r = vault(dir, 'create', '--title', 'No tags', '--wiki', 'team', '--text=---\ntitle: No tags\n---\nbody\n');
  assert.equal(r.status, 3, r.output);
  assert.match(r.stderr, /refused: note rules: the wiki 'team' requires the front matter key\(s\) tags/);
  assert.ok(!existsSync(join(team, 'inbox')));
  const none = vault(dir, 'create', '--title', 'Plain', '--wiki', 'team', '--text', 'body only');
  assert.equal(none.status, 3, 'no front matter at all lacks them too');
  assert.equal(vault(dir, 'create', '--title', 'Full', '--wiki', 'team', '--text=---\ntitle: Full\ntags: [a]\n---\nbody\n').status, 0);
});

test('wiki.rules that do not read, or a missing file, refuse the write: a vault whose rules cannot be read gets no note', () => {
  const { dir, team } = fixture({ rules: '---\nallow: [teleport]\n---\n' });
  const unknown = vault(dir, 'create', '--title', 'x', '--wiki', 'team', '--text', 'a');
  assert.equal(unknown.status, 1, unknown.output);
  assert.match(unknown.stderr, /allow: unknown kind 'teleport'/);
  write(join(team, 'NOTES.md'), '---\nspeed: fast\n---\n');
  assert.match(vault(dir, 'create', '--title', 'x', '--wiki', 'team', '--text', 'a').stderr, /unknown key 'speed'/);
  write(join(team, 'NOTES.md'), '---\nrequired: [a\n---\n');
  assert.match(vault(dir, 'create', '--title', 'x', '--wiki', 'team', '--text', 'a').stderr, /front matter does not parse/);
  const gone = fixture();
  reshape(join(gone.dir, 'oikos.yaml'), 'rules: NOTES.md', 'rules: MISSING.md');
  assert.match(vault(gone.dir, 'create', '--title', 'x', '--wiki', 'team', '--text', 'a').stderr, /wiki\.rules: MISSING\.md is not a file in the vault/);
  reshape(join(gone.dir, 'oikos.yaml'), 'rules: MISSING.md', 'rules: ../NOTES.md');
  assert.match(vault(gone.dir, 'create', '--title', 'x', '--wiki', 'team', '--text', 'a').stderr, /must be a file inside the vault/);
});

test('append and replace-section change an existing note; the dry run shows the section and writes nothing; the mode of the file stays', () => {
  const { dir, team } = fixture();
  const file = join(team, 'inbox', 'plan.md');
  write(file, '# Plan\n\n## Steps\n\none\n\n## Risks\n\nnone\n');
  chmodSync(file, 0o600);
  const dry = vault(dir, 'append', '--note', 'plan', '--heading', 'Next', '--text', 'two', '--dry-run');
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /Note: inbox\/plan\.md \(exists\)/);
  assert.match(dry.stdout, /## Next\n\ntwo/);
  assert.ok(!text(file).includes('Next'), 'nothing written');
  assert.equal(vault(dir, 'append', '--note', 'plan', '--heading', 'Next', '--text', 'two').status, 0);
  assert.match(text(file), /## Risks\n\nnone\n\n## Next\n\ntwo\n$/);
  const replaced = vault(dir, 'replace-section', '--note', 'inbox/plan.md', '--heading', 'Steps', '--text', 'one and two');
  assert.equal(replaced.status, 0, replaced.output);
  assert.match(text(file), /## Steps\n\none and two\n\n## Risks/);
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the mode stays');
  assert.deepEqual(leftovers(join(team, 'inbox')), []);
  const missingHeading = vault(dir, 'replace-section', '--note', 'plan', '--heading', 'Nope', '--text', 'x');
  assert.equal(missingHeading.status, 1);
  assert.match(missingHeading.stderr, /heading "Nope" found 0 times/);
  const noNote = vault(dir, 'append', '--note', 'ghost', '--text', 'x');
  assert.equal(noNote.status, 1);
  assert.match(noNote.stderr, /no note "ghost" in any wiki/);
});

// -- the content check ------------------------------------------------------------------------------

const refusedWith = (r, categories) => {
  assert.equal(r.status, 3, r.output);
  assert.match(r.stderr, new RegExp(`^refused: content check: ${categories}`, 'm'));
};

test('the check refuses a local path, a secret and the installation\'s terms — also split by emphasis, a zero-width character or a line break', () => {
  const { dir, team } = fixture({ outgoing: 'terms: [Globex]\n' });
  const create = (body) => vault(dir, 'create', '--title', 'Check', '--wiki', 'team', '--text', body);
  refusedWith(create('see /home/ada/notes'), 'path');
  refusedWith(create(`token ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`), 'secret');
  for (const body of ['about Globex', 'about **Glo**bex', 'about Glo\u200Bbex', 'about _G_lobex', 'about Glo\nbex', 'about Glo-\nbex', 'about ＧＬＯＢＥＸ', 'about `Glo`bex']) {
    refusedWith(create(body), 'term');
  }
  assert.ok(!existsSync(join(team, 'inbox')), 'nothing was written');
  assert.equal(create('a clean note about batching').status, 0);
});

test('the check refuses what is derived from the installation: its root, the names of .local/ files; a short or common name is no term', () => {
  const { dir } = fixture();
  write(join(dir, '.local', 'acquisition-plan.md'), 'private\n');
  write(join(dir, '.local', 'ab.md'), 'short\n');
  write(join(dir, '.local', 'README.md'), 'common\n');
  const create = (body) => vault(dir, 'create', '--title', 'Derived', '--wiki', 'team', '--text', body);
  refusedWith(create('see acquisition-plan.md for it'), 'term');
  refusedWith(create(`it lives in ${dir}`), '[a-z, ]*term');
  assert.equal(create('ab.md and README.md are only names').status, 0, 'a short name and a generic name are no terms');
});

test('the check refuses the assistant unless the mount sets mention_assistant: allow (a personal vault, where it is normal)', () => {
  const { dir, own } = fixture();
  refusedWith(vault(dir, 'create', '--title', 'Tool', '--wiki', 'team', '--text', 'I ran oikos today'), 'assistant');
  write(join(dir, '.local', 'mounts.yaml'), `mounts:\n  ${own}:\n    use: [wiki]\n    wiki: { name: own, default: true }\n    mention_assistant: allow\n`);
  const ok = vault(dir, 'create', '--title', 'Tool', '--wiki', 'own', '--folder', 'inbox', '--text', 'I ran oikos today');
  assert.equal(ok.status, 0, ok.output);
  refusedWith(vault(dir, 'create', '--title', 'Path', '--wiki', 'own', '--folder', 'inbox', '--text', 'at /home/ada/x oikos'), 'path');
});

test('the language check is on only where wiki.rules says English', () => {
  const { dir, team } = fixture();
  assert.equal(vault(dir, 'create', '--title', 'Plain', '--wiki', 'team', '--text', 'Привет, мир').status, 0, 'off without a language');
  write(join(team, 'NOTES.md'), '---\nlanguage: en\n---\n');
  refusedWith(vault(dir, 'create', '--title', 'English', '--wiki', 'team', '--text', 'Привет, мир'), 'language');
  write(join(team, 'NOTES.md'), '---\nlanguage: de\n---\n');
  assert.equal(vault(dir, 'create', '--title', 'German', '--wiki', 'team', '--text', 'Привет, мир').status, 0, 'another language leaves the check off');
});

test('the check covers the front matter, the headings and the path, not only the body', () => {
  const { dir } = fixture({ outgoing: 'terms: [Globex]\n' });
  refusedWith(vault(dir, 'create', '--title', 'Front', '--wiki', 'team', '--text=---\nowner: Globex\n---\nclean body'), 'term');
  const front = vault(dir, 'create', '--title', 'Front', '--wiki', 'team', '--text=---\nowner: Globex\n---\nclean body');
  assert.match(front.stderr, /frontmatter line 1: term/);
  const heading = vault(dir, 'create', '--title', 'Head', '--wiki', 'team', '--text', '## Globex plan\n\nclean');
  assert.match(heading.stderr, /body line 1: term/);
  refusedWith(vault(dir, 'create', '--title', 'Globex plan', '--wiki', 'team', '--text', 'clean'), 'term');
  write(join(dir, 'vaults', 'team', 'inbox', 'n.md'), '# N\n');
  assert.match(vault(dir, 'append', '--note', 'n', '--heading', 'Globex', '--text', 'clean').stderr, /heading line 1: term/);
});

test('executable or fetching content is refused unless wiki.rules allows that kind', () => {
  const { dir, team } = fixture();
  const create = (body) => vault(dir, 'create', '--title', 'Code', '--wiki', 'team', '--text', body);
  const kinds = {
    '```dataviewjs\ndv.pages()\n```': 'dataviewjs',
    'now `$= dv.current().file.name`': 'inline-js',
    'name <% tp.file.title %>': 'template-tag',
    'a <script>alert(1)</script>': 'script',
    '[x](javascript:alert(1))': 'script',
    '<iframe src="/a"></iframe>': 'iframe',
    '![a](https://example.com/a.png)': 'remote-embed',
    '![[https://example.com/a.png]]': 'remote-embed',
    '<img src="https://example.com/a.png">': 'remote-embed',
    '![a](//example.com/a.png)': 'remote-embed',
    '<img srcset="https://example.com/a.png 1x">': 'remote-embed',
    '<video poster="https://example.com/a.png"></video>': 'remote-embed',
    '![a][r]\n\n[r]: https://example.com/a.png': 'remote-embed',
    '<img\n  src="https://example.com/a.png">': 'remote-embed',
    '<div style="background:url(https://example.com/a.png)">x</div>': 'remote-embed',
  };
  for (const [body, kind] of Object.entries(kinds)) {
    const r = create(body);
    refusedWith(r, 'executable');
    assert.match(r.stderr, new RegExp(`executable — ${kind}`), body);
  }
  assert.equal(create('a [link](https://example.com), a local ![[diagram.png]], a $x$=5 formula').status, 0, 'a link, a local embed and a formula are fine');
  assert.equal(vault(dir, 'create', '--title', 'Plain', '--wiki', 'team', '--text', '![](img/a.png) ![a][r] Tom & Jerry, R&amp;D\n\n[r]: img/a.png\n').status, 0, 'a local image, a local reference and an ampersand are fine');
  write(join(team, 'NOTES.md'), '---\nallow: [remote-embed, dataviewjs]\n---\n');
  assert.equal(vault(dir, 'create', '--title', 'Embed', '--wiki', 'team', '--text', '![a](https://example.com/a.png)').status, 0, 'allowed by the vault');
  assert.equal(vault(dir, 'create', '--title', 'Js', '--wiki', 'team', '--text', '```dataviewjs\n1\n```').status, 0);
  refusedWith(vault(dir, 'create', '--title', 'Tag', '--wiki', 'team', '--text', '<% x %>'), 'executable');
});

test('a personal vault also keeps the organization\'s markers out: its email domain, its hosts, its task keys; a shared vault does not', () => {
  const { dir, team } = fixture({ change: ({ dir: d }) => reshape(join(d, 'oikos.yaml'), 'mounts:', 'task-tracking:\n  jira:\n    projects:\n      PROJ: {}\nmounts:') });
  assert.deepEqual(configOf(dir).problems, []);
  for (const body of ['mail ada@acme.example', 'see https://acme.atlassian.net/browse/X', 'it is PROJ-123']) {
    refusedWith(vault(dir, 'create', '--title', 'Mark', '--wiki', 'own', '--folder', 'inbox', '--text', body), 'term');
    assert.equal(vault(dir, 'create', '--title', 'Mark', '--wiki', 'team', '--text', body).status, 0, `the shared vault: ${body}`);
    rmSync(join(team, 'inbox', 'Mark.md'));
  }
  assert.equal(vault(dir, 'create', '--title', 'Plain', '--wiki', 'own', '--folder', 'inbox', '--text', 'proj-less text about PROJECT work').status, 0, 'a key is KEY-123, not a word');
});

test('the terms of a linked installation — its own words and its derived terms — are kept out, in the vault and in every other check', () => {
  const other = installation((t) => t);
  repository(other);
  write(join(other, '.local', 'outgoing.yaml'), 'terms: [Initech]\n');
  write(join(other, '.local', 'consulting-ledger.md'), 'x\n');
  const { dir } = fixture();
  const mounts = join(dir, '.local', 'mounts.yaml');
  write(mounts, `${text(mounts)}  ${other}:\n`);
  assert.deepEqual(configOf(dir).problems, [], 'a linked installation registered without use is no problem');
  const create = (body) => vault(dir, 'create', '--title', 'Linked', '--wiki', 'team', '--text', body);
  refusedWith(create('about Initech'), 'term');
  refusedWith(create('see consulting-ledger.md'), 'term');
  refusedWith(create(`in ${other}`), '[a-z, ]*term');
  assert.equal(create('about batching').status, 0);
  const check = tool(dir, 'outgoing', ['check', '--text', 'about Initech'], ENV);
  assert.equal(check.status, 3, 'every check takes them: the read-only `outgoing check`');
  assert.match(check.stdout, /term — Initech/);
  assert.equal(tool(dir, 'outgoing', ['check', '--text', 'about batching'], ENV).status, 0);
});

test('a linked installation whose outgoing.yaml does not read fails closed: every check refuses, dry run and real run, naming the file; a missing file is fine', () => {
  const other = installation((t) => t);
  repository(other);
  write(join(other, '.local', 'outgoing.yaml'), 'terms: [unclosed\n');
  const { dir, team } = fixture();
  const mounts = join(dir, '.local', 'mounts.yaml');
  write(mounts, `${text(mounts)}  ${other}:\n`);
  const file = join(other, '.local', 'outgoing.yaml');
  for (const args of [['--dry-run'], []]) {
    const r = vault(dir, 'create', '--title', 'Linked', '--wiki', 'team', '--text', 'about batching', ...args);
    assert.equal(r.status, 3, r.output);
    assert.match(r.stderr, /^refused: content check: the terms file .* of a linked installation cannot be used/m);
    assert.ok(r.stderr.includes(file), `names the file: ${r.stderr}`);
  }
  assert.ok(!existsSync(join(team, 'inbox')), 'nothing was written');
  const check = tool(dir, 'outgoing', ['check', '--text', 'about batching'], ENV);
  assert.equal(check.status, 3, 'the read-only check refuses as well');
  assert.ok(check.stderr.includes(file), check.stderr);
  rmSync(file);
  assert.equal(vault(dir, 'create', '--title', 'Linked', '--wiki', 'team', '--text', 'about batching').status, 0, 'a missing file adds no terms and is no error');
});

test('an allow: line does not lift executable content, with a term or a path on the same line it still lifts those; wiki.rules is the only way', () => {
  const { dir, team } = fixture({ outgoing: 'terms: [Globex]\nallow: [Project Phoenix]\n' });
  const create = (body) => vault(dir, 'create', '--title', 'Allow', '--wiki', 'team', '--text', body);
  for (const body of ['Project Phoenix <script>alert(1)</script>', 'Project Phoenix ![a](https://example.com/a.png)', 'Project Phoenix `$= dv.current()`']) {
    const r = create(body);
    refusedWith(r, 'executable');
    assert.match(r.stderr, /executable — /, body);
  }
  assert.ok(!existsSync(join(team, 'inbox')), 'nothing was written');
  assert.equal(create('Project Phoenix and Globex in /home/ada/x').status, 0, 'a line with an allowed entry still passes a term and a path');
  write(join(team, 'NOTES.md'), '---\nallow: [script]\n---\n');
  rmSync(join(team, 'inbox', 'Allow.md'));
  assert.equal(create('Project Phoenix <script>alert(1)</script>').status, 0, 'the vault allows the kind');
});

test('the check is not fooled by blanks: a run of spaces, a no-break space, an entity or a zero-width character inside a term of two words', () => {
  const { dir, team } = fixture({ outgoing: 'terms: [Acme Corp]\n' });
  const create = (body) => vault(dir, 'create', '--title', 'Blanks', '--wiki', 'team', '--text', body);
  for (const body of ['met Acme  Corp', 'met Acme&nbsp;Corp', 'met Acme Corp', 'met Acme Corp', 'met Acme&#32;Corp', 'met Acme​Corp']) refusedWith(create(body), 'term');
  assert.ok(!existsSync(join(team, 'inbox')), 'nothing was written');
  assert.equal(create('met Acme and then Corp, R&amp;D').status, 0);
});

// -- writeNote: the folders are judged again at the write ---------------------------------------------

/** A vault root and a folder outside it, as real paths, and the target `rel` judged in it. */
function judged(rel, { folders = [] } = {}) {
  const root = realpathSync(tempDir('wn-vault-'));
  const outside = realpathSync(tempDir('wn-outside-'));
  for (const folder of folders) mkdirSync(join(root, folder), { recursive: true });
  return { root, outside, target: judgeTarget({ root }, [], rel) };
}

const changed = (e) => e instanceof GuardRefusal && /^refused: vault target .*: .* it changed after it was judged; nothing written/.test(e.message);

test('writeNote makes folders one at a time and writes through a temporary file that is renamed away', () => {
  const { root, target } = judged('a/b/N.md');
  writeNote(target, 'x\n');
  assert.equal(text(join(root, 'a', 'b', 'N.md')), 'x\n');
  assert.deepEqual(leftovers(join(root, 'a', 'b')), []);
});

test('writeNote refuses a folder that was swapped for a link after the target was judged, and writes nothing outside', () => {
  const swapped = judged('inbox/N.md', { folders: ['inbox'] });
  rmSync(join(swapped.root, 'inbox'), { recursive: true });
  symlinkSync(swapped.outside, join(swapped.root, 'inbox'), 'dir');
  assert.throws(() => writeNote(swapped.target, 'x'), (e) => changed(e) && /inbox is a link/.test(e.message));
  assert.deepEqual(readdirSync(swapped.outside), [], 'nothing was written through the link');

  const nested = judged('a/b/N.md', { folders: ['a'] });
  symlinkSync(nested.outside, join(nested.root, 'a', 'b'), 'dir');
  assert.throws(() => writeNote(nested.target, 'x'), (e) => changed(e) && /a\/b is a link/.test(e.message), 'a folder that is to be made, and is a link now');
  assert.deepEqual(readdirSync(nested.outside), []);

  const inside = judged('a/b/N.md');
  mkdirSync(join(inside.root, 'real'));
  symlinkSync(join(inside.root, 'real'), join(inside.root, 'a'), 'dir');
  assert.throws(() => writeNote(inside.target, 'x'), changed, 'a link that stays inside the vault is a change too');
  assert.deepEqual(readdirSync(join(inside.root, 'real')), []);
});

test('writeNote refuses a folder that is not the one that was judged — replaced by another folder, or by a file', () => {
  const other = judged('inbox/N.md', { folders: ['inbox'] });
  renameSync(join(other.root, 'inbox'), join(other.root, 'old-inbox')); // kept, so its inode is not reused
  mkdirSync(join(other.root, 'inbox'));
  assert.throws(() => writeNote(other.target, 'x'), (e) => changed(e) && /not the one that was judged/.test(e.message));
  assert.deepEqual(readdirSync(join(other.root, 'inbox')), [], 'nothing was written');

  const file = judged('inbox/N.md', { folders: ['inbox'] });
  rmSync(join(file.root, 'inbox'), { recursive: true });
  write(join(file.root, 'inbox'), 'a file now');
  assert.throws(() => writeNote(file.target, 'x'), (e) => changed(e) && /not a folder/.test(e.message));
});

test('an allow: line of .local/outgoing.yaml is the one override: it lets a line through, the dry run lists it; a short entry is ignored; there is no --allow-flagged', () => {
  const { dir } = fixture({ outgoing: 'terms: [Globex]\nallow: ["Globex is public", "Globex"]\n' });
  const create = (body, ...more) => vault(dir, 'create', '--title', 'Allowed', '--wiki', 'team', '--text', body, ...more);
  const dry = create('Globex is public knowledge\nand clean', '--dry-run');
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /1 line\(s\) let pass by allow: in \.local\/outgoing\.yaml/);
  assert.match(dry.stdout, /body line 1: let pass by allow: "Globex is public"/);
  assert.match(dry.stdout, /problem: \.local\/outgoing\.yaml: allow: "Globex" is shorter than 8 characters — ignored/);
  refusedWith(create('Globex is private'), 'term');
  const flag = create('Globex is private', '--allow-flagged');
  assert.equal(flag.status, 1, 'the tool has no such flag');
  assert.match(flag.stderr, /allow-flagged/);
  assert.equal(create('Globex is public knowledge').status, 0);
});

test('a flagged dry run prints its preview and exits 3 with `flagged:`; it advises an allow: line, never a flag; a secret withholds the preview', () => {
  const { dir } = fixture({ outgoing: 'terms: [Globex]\n' });
  const dry = vault(dir, 'create', '--title', 'Flag', '--wiki', 'team', '--text', 'about Globex', '--dry-run');
  assert.equal(dry.status, 3, dry.output);
  assert.match(dry.stdout, /CHECK outgoing text: 1 finding\(s\)/);
  assert.match(dry.stdout, /New note text/);
  assert.match(dry.stderr, /^flagged: content check: term — the real run refuses this text; fix the text, or have the user add an allow: line for it to \.local\/outgoing\.yaml/m);
  assert.ok(!/--allow-flagged/.test(dry.stderr));
  const token = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`;
  const secret = vault(dir, 'create', '--title', 'Flag', '--wiki', 'team', '--text', `use ${token}`, '--dry-run');
  assert.equal(secret.status, 3);
  assert.ok(!secret.output.includes(token), 'the secret is not printed');
  assert.ok(!/New note text/.test(secret.stdout), 'the preview is withheld');
});

// -- the write targets ------------------------------------------------------------------------------

const refusedTarget = (r, why) => {
  assert.equal(r.status, 3, r.output);
  assert.match(r.stderr, /^refused: vault target /m);
  if (why) assert.match(r.stderr, why);
};

test('a note is never written in a dot folder, as a dot file, a rule file or a SKILL.md, outside the vault or by a path with ..', () => {
  const { dir, team } = fixture();
  const make = (title, folder) => vault(dir, 'create', '--title', title, '--wiki', 'team', '--folder', folder, '--text', 'x');
  for (const folder of ['.obsidian', '.git/hooks', '.claude/rules', 'inbox/.hidden', '.qwen']) refusedTarget(make('Note', folder), /starts with a dot/);
  for (const title of ['CLAUDE', 'claude.local', 'AGENTS', 'AGENTS.override', 'agents.OVERRIDE.md', 'QWEN', 'GEMINI', 'agents.MD']) refusedTarget(make(title, 'inbox'), /rule file/);
  refusedTarget(make('SKILL', 'inbox'), /SKILL\.md is never written/);
  for (const folder of ['../escape', 'inbox/../../escape', '/etc', 'C:/x', 'a//b', 'a\\b']) refusedTarget(make('Note', folder), /inside the vault: relative/);
  assert.ok(!existsSync(join(team, '.obsidian')) && !existsSync(join(team, '.claude')));
  assert.ok(!existsSync(join(team, 'inbox')) || readdirSync(join(team, 'inbox')).length === 0);
});

test('a note is never written in a nested repository, under any mount\'s skills.from, or as the vault\'s own rules or template', () => {
  const { dir, team, own } = fixture();
  repository(join(team, 'inbox', 'sub'));
  refusedTarget(vault(dir, 'create', '--title', 'N', '--wiki', 'team', '--folder', 'inbox/sub', '--text', 'x'), /inbox\/sub is a nested repository/);
  refusedTarget(vault(dir, 'create', '--title', 'N', '--wiki', 'team', '--folder', 'inbox/sub/deeper', '--text', 'x'), /nested repository/);
  // a wiki that is also a skills mount: its skills folder is no place for a note
  const mixed = repository(join(own, '..', `mixed-${process.pid}`));
  skill(mixed, 'skills', 'helper');
  const mounts = join(dir, '.local', 'mounts.yaml');
  write(mounts, `${text(mounts)}  ${mixed}:\n    use: [wiki, skills]\n    skills: { from: skills, prefix: mixed }\n    wiki: { name: mixed, rules: RULES.md }\n`);
  write(join(mixed, 'RULES.md'), '# rules\n');
  assert.deepEqual(configOf(dir).problems, []);
  refusedTarget(vault(dir, 'create', '--title', 'N', '--wiki', 'mixed', '--folder', 'skills/helper/notes', '--text', 'x'), /under skills of the mount .*, where skills live/);
  refusedTarget(vault(dir, 'create', '--title', 'N', '--wiki', 'mixed', '--folder', 'skills', '--text', 'x'), /where skills live/);
  assert.equal(vault(dir, 'create', '--title', 'N', '--wiki', 'mixed', '--folder', 'notes', '--text', 'x').status, 0, 'outside skills/ the same vault takes notes');
  refusedTarget(vault(dir, 'append', '--note', 'RULES', '--wiki', 'mixed', '--text', 'allow: all'), /it is RULES\.md, the note rules or the template of the wiki 'mixed'/);
});

test('the vault\'s own rules file is not a note to write over: append to it is refused', () => {
  const { dir, team } = fixture();
  const r = vault(dir, 'append', '--note', 'NOTES.md', '--wiki', 'team', '--text', 'allow: everything');
  refusedTarget(r, /it is NOTES\.md, the note rules or the template of the wiki 'team'/);
  assert.equal(text(join(team, 'NOTES.md')), NOTES);
});

test('a target is judged as it really is: a link out of the vault, a link into a dot folder, a note that is a link — refused', () => {
  const { dir, team } = fixture();
  const outside = tempDir('outside-');
  mkdirSync(join(team, 'inbox'), { recursive: true });
  symlinkSync(outside, join(team, 'inbox', 'out'), 'dir');
  refusedTarget(vault(dir, 'create', '--title', 'N', '--wiki', 'team', '--folder', 'inbox/out', '--text', 'x'), /outside the vault/);
  refusedTarget(vault(dir, 'create', '--title', 'N', '--wiki', 'team', '--folder', 'inbox/out/more', '--text', 'x'), /outside the vault/);
  assert.deepEqual(readdirSync(outside), [], 'nothing was written outside');
  mkdirSync(join(team, '.git-like'), { recursive: true });
  mkdirSync(join(team, '.dot'), { recursive: true });
  symlinkSync(join(team, '.dot'), join(team, 'inbox', 'to-dot'), 'dir');
  refusedTarget(vault(dir, 'create', '--title', 'N', '--wiki', 'team', '--folder', 'inbox/to-dot', '--text', 'x'), /resolves to .*\.dot.*starts with a dot/);
  symlinkSync(join(outside, 'target.md'), join(team, 'inbox', 'Linked.md'));
  refusedTarget(vault(dir, 'create', '--title', 'Linked', '--wiki', 'team', '--text', 'x'), /outside the vault/);
  assert.ok(!existsSync(join(outside, 'target.md')), 'a dangling link is not written through');
  symlinkSync(join(team, '.later'), join(team, 'inbox', 'dangling'), 'dir');
  refusedTarget(vault(dir, 'create', '--title', 'N', '--wiki', 'team', '--folder', 'inbox/dangling', '--text', 'x'), /resolves to \.later.*starts with a dot/);
  assert.ok(!existsSync(join(team, '.later')), 'a dangling link into a dot folder is not made good');
});

test('a link that stays inside the vault is followed and the note lands at its real place, still judged there', () => {
  const { dir, team } = fixture();
  mkdirSync(join(team, 'real'), { recursive: true });
  symlinkSync(join(team, 'real'), join(team, 'inbox'), 'dir');
  const ok = vault(dir, 'create', '--title', 'Through', '--wiki', 'team', '--text', 'x');
  assert.equal(ok.status, 0, ok.output);
  assert.equal(text(join(team, 'real', 'Through.md')), 'x\n');
  assert.match(ok.stdout, /Created real\/Through\.md/, 'reported at its real path');
});

test('a hard-linked note is refused: a write through it would change every other name', () => {
  const { dir, team } = fixture();
  const outside = tempDir('outside-');
  write(join(outside, 'shared.md'), '# Shared\n\n## S\n\nbody\n');
  mkdirSync(join(team, 'inbox'), { recursive: true });
  linkSync(join(outside, 'shared.md'), join(team, 'inbox', 'hard.md'));
  const r = vault(dir, 'append', '--note', 'hard', '--wiki', 'team', '--heading', 'More', '--text', 'x');
  refusedTarget(r, /more than one hard link/);
  refusedTarget(vault(dir, 'replace-section', '--note', 'hard', '--wiki', 'team', '--heading', 'S', '--text', 'x'), /more than one hard link/);
  assert.equal(text(join(outside, 'shared.md')), '# Shared\n\n## S\n\nbody\n', 'the other name is unchanged');
});

test('a dry run judges the target too: a refused place is refused in the dry run', () => {
  const { dir } = fixture();
  refusedTarget(vault(dir, 'create', '--title', 'N', '--wiki', 'team', '--folder', '.obsidian', '--text', 'x', '--dry-run'), /starts with a dot/);
});

// -- the write guard --------------------------------------------------------------------------------

test('the vault write verbs are listed in the write guard: create, append and replace-section, not search or read', () => {
  assert.deepEqual(WRITES.vault, ['create', 'append', 'replace-section']);
});
