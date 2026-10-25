// The people file `.local/private.yaml` and its tool (npm test): find by alias, name, email and
// folded spelling, several and no matches, the add preview and write, the additive merge that keeps
// comments, refused conflicts and secrets, check, no file, outside an installation; and the sync
// rule that keeps the file named in the installation's `.gitignore`. Each test works in a temporary
// installation (ACME Corp); nothing here reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CORE, cleanEnv, installation, tempDir, tool } from './helpers/installation.mjs';
import { findByAccount, findPeople, normalize, peopleOf, loadPeopleDocument } from '../tools/common/people.mjs';

const people = (dir, args) => tool(dir, 'people', args, {});
const fileOf = (dir) => join(dir, '.local', 'private.yaml');
const seed = (dir, text) => { writeFileSync(fileOf(dir), text); return dir; };
const fresh = () => installation((t) => t);

const SEED = `# my people
version: 1
people:
  - name: Ada Lovelace            # the backend lead
    aliases: [ada, Lovelace, "Al"]
    email: ada@example.com
    accounts:
      jira: "712020:0000-example"
      github: ada-l
    note: backend lead

  - name: Émile Dubois
    aliases: [emi]
    accounts:
      slack: U01EXAMPLE
  - name: Ada Byron
    aliases: [Byron]
`;

test('find: by alias, full name, email, and by spelling without case, diacritics or punctuation', () => {
  const dir = seed(fresh(), SEED);
  for (const query of ['al', 'Ada Lovelace', 'ADA@EXAMPLE.COM', 'lovelace', 'ada, lovelace!']) {
    const r = people(dir, ['find', query]);
    assert.equal(r.status, 0, `${query}: ${r.output}`);
    assert.match(r.stdout, /^Ada Lovelace — backend lead\n {2}aliases: ada, Lovelace, Al\n {2}email: ada@example\.com\n {2}accounts: jira=712020:0000-example, github=ada-l$/m, query);
  }
  for (const query of ['emile', 'ÉMILE DUBOIS', 'dubois emile', 'Émi']) {
    const r = people(dir, ['find', query]);
    assert.equal(r.status, 0, `${query}: ${r.output}`);
    assert.match(r.stdout, /^Émile Dubois$/m);
  }
});

test('find: an exact alias wins over a word match; otherwise several matches say "ask which"', () => {
  const dir = seed(fresh(), SEED);
  const exact = people(dir, ['find', 'ada']);
  assert.equal(exact.status, 0);
  assert.match(exact.stdout, /^Ada Lovelace/m);
  assert.doesNotMatch(exact.stdout, /Byron/, 'the exact alias `ada` is one person; Ada Byron only has the word');
  assert.equal(JSON.parse(people(dir, ['find', 'Ada', '--json']).stdout).length, 1);
  seed(dir, SEED.replace('aliases: [ada, Lovelace, "Al"]', 'aliases: [Lovelace, "Al"]'));
  const both = people(dir, ['find', 'ada']);
  assert.equal(both.status, 0, 'several matches are printed, exit 0');
  assert.match(both.stdout, /^2 matches, ask which:\nAda Lovelace/m);
  assert.match(both.stdout, /^Ada Byron$/m);
});

test('find: no one found exits 1 and points at the tracker and `add`; no file is the same, not an error', () => {
  const dir = fresh();
  const none = people(dir, ['find', 'ada']);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /no one named 'ada' in \.local\/private\.yaml — search the tracker, then `node oikos\/tools\/people\/cli\.mjs add`/);
  assert.ok(!existsSync(fileOf(dir)), 'a find never creates the file');
  seed(dir, SEED);
  const ghost = people(dir, ['find', 'grace']);
  assert.equal(ghost.status, 1);
  assert.match(ghost.stdout, /no one named 'grace'/);
  assert.equal(JSON.parse(people(dir, ['find', 'grace', '--json']).stdout).length, 0);
});

test('find --account: the one id alone on a line, a missing account exits 1, several people are listed by name', () => {
  const dir = seed(fresh(), SEED);
  const id = people(dir, ['find', 'lovelace', '--account', 'jira']);
  assert.equal(id.status, 0);
  assert.equal(id.stdout, '712020:0000-example\n');
  assert.equal(people(dir, ['find', 'lovelace', '--account', 'JIRA']).stdout, '712020:0000-example\n', 'the system is matched without case');
  const missing = people(dir, ['find', 'lovelace', '--account', 'slack']);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /Ada Lovelace has no slack account in \.local\/private\.yaml/);
  const many = people(seed(dir, SEED.replace('aliases: [ada, Lovelace, "Al"]', 'aliases: [Lovelace]')), ['find', 'ada', '--account', 'jira']);
  assert.match(many.stdout, /^2 matches, ask which:\nAda Lovelace: 712020:0000-example\nAda Byron: \(no jira account\)$/m);
});

test('find --by-account: the person who holds system=value; system and value match without case; --json', () => {
  const dir = seed(fresh(), SEED);
  for (const arg of ['jira=712020:0000-example', 'JIRA=712020:0000-example', 'github=ada-l', 'GitHub= ADA-L ', 'slack=u01example']) {
    const r = people(dir, ['find', '--by-account', arg]);
    assert.equal(r.status, 0, `${arg}: ${r.output}`);
    assert.doesNotMatch(r.stdout, /matches/);
    assert.match(r.stdout, arg.toLowerCase().startsWith('slack')
      ? /^Émile Dubois\n {2}aliases: emi\n {2}accounts: slack=U01EXAMPLE$/m
      : /^Ada Lovelace — backend lead\n {2}aliases: ada, Lovelace, Al\n {2}email: ada@example\.com\n {2}accounts: jira=712020:0000-example, github=ada-l$/m, arg);
  }
  const json = JSON.parse(people(dir, ['find', '--by-account', 'github=ada-l', '--json']).stdout);
  assert.equal(json.length, 1);
  assert.deepEqual(json[0], { name: 'Ada Lovelace', aliases: ['ada', 'Lovelace', 'Al'], email: 'ada@example.com', accounts: { jira: '712020:0000-example', github: 'ada-l' }, note: 'backend lead' });
});

test('find --by-account: no one exits 1 with a message, a value under another system is no match, no file is the same', () => {
  const dir = fresh();
  const none = people(dir, ['find', '--by-account', 'github=ada-l']);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /^no one with github 'ada-l' in \.local\/private\.yaml$/m);
  assert.ok(!existsSync(fileOf(dir)), 'a find never creates the file');
  seed(dir, SEED);
  const other = people(dir, ['find', '--by-account', 'slack=ada-l']);
  assert.equal(other.status, 1);
  assert.match(other.stdout, /no one with slack 'ada-l'/);
  assert.equal(JSON.parse(people(dir, ['find', '--by-account', 'slack=ada-l', '--json']).stdout).length, 0);
  assert.equal(people(dir, ['find', '--by-account', 'jira=7120']).status, 1, 'the whole value, not a part of it');
});

test('find --by-account: several people sharing a value are all listed ("N matches"), although check flags it', () => {
  const dir = seed(fresh(), SEED.replace('  - name: Ada Byron\n', '  - name: Ada Byron\n    accounts:\n      GitHub: ADA-L\n'));
  const r = people(dir, ['find', '--by-account', 'github=ada-l']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^2 matches, ask which:\nAda Lovelace — backend lead\n(?:.*\n)*Ada Byron\n {2}aliases: Byron\n {2}accounts: GitHub=ADA-L$/m);
  assert.equal(JSON.parse(people(dir, ['find', '--by-account', 'github=ada-l', '--json']).stdout).length, 2);
});

test('find --by-account: a value without system=, a positional query or --account is a usage error', () => {
  const dir = seed(fresh(), SEED);
  for (const arg of ['ada-l', '=ada-l', 'github=', ' = ']) {
    const r = people(dir, ['find', '--by-account', arg]);
    assert.equal(r.status, 1, arg);
    assert.match(r.stderr, /--by-account '.*': write system=value/, arg);
  }
  const query = people(dir, ['find', 'ada', '--by-account', 'github=ada-l']);
  assert.equal(query.status, 1);
  assert.match(query.stderr, /--by-account takes no name and no --account/);
  const account = people(dir, ['find', '--by-account', 'github=ada-l', '--account', 'jira']);
  assert.equal(account.status, 1);
  assert.match(account.stderr, /--by-account takes no name and no --account/);
});

test('add without --yes previews and writes nothing; --yes creates the file with mode 600 and version 1', () => {
  const dir = fresh();
  const args = ['add', 'Ada Lovelace', '--alias', 'ada', '--alias', 'Al', '--email', 'Ada@Example.com', '--account', 'jira=712020:0000-example', '--account', 'github=ada-l', '--note', 'backend lead'];
  const preview = people(dir, args);
  assert.equal(preview.status, 0, preview.output);
  assert.match(preview.stdout, /^new:\n {2}Ada Lovelace — backend lead\n {2}aliases: ada, Al\n {2}email: ada@example\.com\n {2}accounts: jira=712020:0000-example, github=ada-l\nwould write \.local\/private\.yaml/m);
  assert.ok(!existsSync(fileOf(dir)), 'the preview wrote nothing');

  const written = people(dir, [...args, '--yes']);
  assert.equal(written.status, 0, written.output);
  assert.match(written.stdout, /^wrote \.local\/private\.yaml$/m);
  if (process.platform !== 'win32') assert.equal(statSync(fileOf(dir)).mode & 0o777, 0o600);
  const text = readFileSync(fileOf(dir), 'utf8');
  assert.match(text, /^version: 1$/m);
  assert.match(text, /^ {2}- name: Ada Lovelace\n {4}aliases: \[ada, Al\]\n {4}email: ada@example\.com\n {4}accounts:\n {6}jira: 712020:0000-example\n {6}github: ada-l\n {4}note: backend lead\n$/m);
  assert.equal(people(dir, ['find', 'al', '--account', 'github']).stdout, 'ada-l\n', 'what was written is found');
  assert.equal(people(dir, ['check']).status, 0);
});

test('add merges additively into the same name or email, keeps comments, blank lines and order, and tightens the mode', () => {
  const dir = seed(fresh(), SEED);
  const r = people(dir, ['add', 'Ada Lovelace', '--alias', 'countess', '--alias', 'ADA', '--account', 'slack=U02EXAMPLE', '--yes']);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, /^update:\n {2}Ada Lovelace — backend lead\n {2}aliases: ada, Lovelace, Al, countess\n/m, 'a known alias is not added twice');
  const text = readFileSync(fileOf(dir), 'utf8');
  assert.match(text, /^# my people\nversion: 1\n/);
  assert.match(text, /- name: Ada Lovelace # the backend lead\n {4}aliases: \[ada, Lovelace, "Al", countess\]\n/);
  assert.match(text, /slack: U02EXAMPLE\n {4}note: backend lead\n\n {2}- name: Émile Dubois/, 'the blank line and the next entry stay');
  assert.ok(text.indexOf('Ada Lovelace') < text.indexOf('Émile') && text.indexOf('Émile') < text.indexOf('Ada Byron'), 'the order stays');
  if (process.platform !== 'win32') assert.equal(statSync(fileOf(dir)).mode & 0o777, 0o600);

  const byEmail = people(dir, ['add', 'A. Lovelace', '--email', 'ada@example.com', '--yes']);
  assert.equal(byEmail.status, 0, byEmail.output);
  assert.match(byEmail.stdout, /aliases: ada, Lovelace, Al, countess, A\. Lovelace/, 'found by its email, the given name becomes an alias');
  assert.equal(peopleOf(loadPeopleDocument(fileOf(dir))).length, 3, 'no new entry');

  const same = people(dir, ['add', 'Ada Lovelace', '--alias', 'ada', '--yes']);
  assert.match(same.stdout, /^unchanged:/m);
  assert.doesNotMatch(same.stdout, /wrote/);
});

test('add refuses an alias of another person, and a differing email, note or account unless --replace', () => {
  const dir = seed(fresh(), SEED);
  const before = readFileSync(fileOf(dir), 'utf8');
  const alias = people(dir, ['add', 'Grace Hopper', '--alias', 'emi', '--yes']);
  assert.equal(alias.status, 1);
  assert.match(alias.stderr, /'emi' already belongs to Émile Dubois/);
  const byName = people(dir, ['add', 'Grace Hopper', '--alias', 'Ada Byron', '--yes']);
  assert.match(byName.stderr, /'Ada Byron' already belongs to Ada Byron/, 'a full name counts as an alias');
  const merge = people(dir, ['add', 'Ada Lovelace', '--alias', 'Byron', '--yes']);
  assert.match(merge.stderr, /'Byron' already belongs to Ada Byron/, 'a merge may not take another person\'s alias');
  for (const [args, pattern] of [
    [['--email', 'other@example.com'], /has the email 'ada@example\.com' in \.local\/private\.yaml, not 'other@example\.com' — --replace/],
    [['--note', 'frontend lead'], /has the note 'backend lead' in \.local\/private\.yaml, not 'frontend lead' — --replace/],
    [['--account', 'jira=999'], /has the jira account '712020:0000-example' in \.local\/private\.yaml, not '999' — --replace/],
  ]) {
    const r = people(dir, ['add', 'Ada Lovelace', ...args, '--yes']);
    assert.equal(r.status, 1, r.output);
    assert.match(r.stderr, pattern);
  }
  assert.equal(readFileSync(fileOf(dir), 'utf8'), before, 'a refusal writes nothing');

  const replaced = people(dir, ['add', 'Ada Lovelace', '--email', 'other@example.com', '--note', 'frontend lead', '--account', 'jira=999', '--replace', '--yes']);
  assert.equal(replaced.status, 0, replaced.output);
  const [ada] = findPeople(peopleOf(loadPeopleDocument(fileOf(dir))), 'ada lovelace');
  assert.deepEqual([ada.email, ada.note, ada.accounts.jira], ['other@example.com', 'frontend lead', '999']);
});

test('add refuses a value that looks like a secret and points at .local/.env; personal data is not refused', () => {
  const dir = fresh();
  const token = `ghp_${'a1B2'.repeat(9)}`;
  for (const args of [['--account', `github=${token}`], ['--note', `token ${token}`], ['--alias', token]]) {
    const r = people(dir, ['add', 'Ada Lovelace', ...args, '--yes']);
    assert.equal(r.status, 1, r.output);
    assert.match(r.stderr, /refused: a value looks like a secret/);
    assert.match(r.stderr, /\.local\/\.env/);
    assert.ok(r.stderr.includes('ghp_… (40 characters)'), 'the secret is masked');
    assert.ok(!r.output.includes(token), 'the secret is never printed');
  }
  assert.ok(!existsSync(fileOf(dir)), 'nothing was written');
  const key = people(dir, ['add', 'Ada Lovelace', '--note=-----BEGIN PRIVATE KEY-----', '--yes']);
  assert.equal(key.status, 1);
  const personal = people(dir, ['add', 'Ada Lovelace', '--email', 'ada@example.com', '--note', 'lives in /home/ada, speaks Russian: привет', '--yes']);
  assert.equal(personal.status, 0, 'paths, names and other languages are the point of this file');
});

test('add: a malformed --account, a missing name and a file with problems are usage errors', () => {
  const dir = fresh();
  assert.match(people(dir, ['add', 'Ada Lovelace', '--account', 'jira']).stderr, /write system=value/);
  assert.equal(people(dir, ['add']).status, 1);
  seed(dir, 'version: 1\npeople:\n  - aliases: [x]\n');
  const r = people(dir, ['add', 'Ada Lovelace', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has problems — `node oikos\/tools\/people\/cli\.mjs check` lists them/);
  seed(dir, 'people: [unclosed\n');
  assert.match(people(dir, ['find', 'x']).stderr, /people: \.local\/private\.yaml:/);
});

test('check: a shared alias or email, an entry without a name, an unknown key, a secret; exit 1', () => {
  const dir = seed(fresh(), SEED);
  const ok = people(dir, ['check']);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /private\.yaml ok \(3 people\)/);
  seed(dir, `version: 1
extra: 1
people:
  - name: Ada Lovelace
    aliases: [ada, Al]
    email: ada@example.com
    colour: red
  - name: Ada Byron
    aliases: [AL, "Ada Lovelace"]
    email: ADA@example.com
    accounts:
      github: ghp_${'a1B2'.repeat(9)}
  - aliases: [nobody]
  - just a string
`);
  const r = people(dir, ['check']);
  assert.equal(r.status, 1);
  for (const pattern of [
    /unknown key 'extra'/,
    /people\[0\] 'Ada Lovelace': unknown key 'colour'/,
    /people\[1\] 'Ada Byron': name\/alias 'AL' also belongs to people\[0\]/,
    /people\[1\] 'Ada Byron': name\/alias 'Ada Lovelace' also belongs to people\[0\]/,
    /people\[1\] 'Ada Byron': email 'ada@example\.com' also belongs to people\[0\]/,
    /people\[1\] 'Ada Byron'\.accounts\.github: looks like a secret \(ghp_… \(40 characters\)\)/,
    /people\[2\]: no name/,
    /people\[3\]: not a map/,
  ]) assert.match(r.stdout, pattern);
  assert.ok(!r.stdout.includes(`ghp_${'a1B2'.repeat(9)}`), 'the secret is masked in the report');
  const json = JSON.parse(people(dir, ['check', '--json']).stdout);
  assert.ok(Array.isArray(json) && json.length >= 8);
});

test('check with no file says so and passes', () => {
  const r = people(fresh(), ['check']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no \.local\/private\.yaml yet/);
});

test('outside an installation the tool is a usage error', () => {
  const r = spawnSync(process.execPath, [join(CORE, 'tools', 'people', 'cli.mjs'), 'find', 'ada'],
    { cwd: tempDir('outside-'), encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no oikos installation here/);
});

test('findByAccount: folded system, trimmed case-less value, an empty value finds no one', () => {
  const all = peopleOf(loadPeopleDocument(fileOf(seed(fresh(), SEED))));
  assert.deepEqual(findByAccount(all, 'GITHUB', ' Ada-L ').map((p) => p.name), ['Ada Lovelace']);
  assert.deepEqual(findByAccount(all, 'github', ''), []);
  assert.deepEqual(findByAccount(all, 'jira', 'ada-l'), []);
});

test('normalize folds case, diacritics and punctuation', () => {
  assert.equal(normalize('  Émile-Dubois, Jr.! '), 'emile dubois jr');
});

// == the .gitignore line, kept by sync ==

const LINE = '.local/private.yaml';
const GITIGNORE = '# mine\n.local/\n.env\n/oikos\n';

test('sync appends the people file to an existing .gitignore once, leaving every other line alone', () => {
  const dir = fresh();
  writeFileSync(join(dir, '.gitignore'), GITIGNORE);
  const before = tool(dir, 'sync', ['--check']);
  assert.equal(before.status, 1, 'out of date');
  assert.match(before.stdout, /out of date: \.gitignore \(\.local\/private\.yaml\)/);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), GITIGNORE, '--check changes nothing');

  const first = tool(dir, 'sync', []);
  assert.equal(first.status, 0, first.output);
  assert.match(first.stdout, /wrote: \.gitignore \(\.local\/private\.yaml\)/);
  const text = readFileSync(join(dir, '.gitignore'), 'utf8');
  assert.equal(text, `${GITIGNORE}\n# personal data — names, emails, accounts (oikos people file)\n${LINE}\n`);

  const again = tool(dir, 'sync', []);
  assert.doesNotMatch(again.stdout, /\.gitignore/);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), text, 'a second run changes nothing');
  assert.equal(tool(dir, 'sync', ['--check']).status, 0, 'green after');
});

test('sync completes a .gitignore without a final newline, and leaves one that has the line', () => {
  const dir = fresh();
  writeFileSync(join(dir, '.gitignore'), '.local/\n/oikos');
  assert.equal(tool(dir, 'sync', []).status, 0);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), `.local/\n/oikos\n\n# personal data — names, emails, accounts (oikos people file)\n${LINE}\n`);
  const named = '.local/\n.local/private.yaml\n';
  writeFileSync(join(dir, '.gitignore'), named);
  assert.equal(tool(dir, 'sync', ['--check']).status, 0);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), named);
});

test('sync leaves an installation without a .gitignore alone and says nothing about it', () => {
  const dir = fresh();
  const r = tool(dir, 'sync', []);
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.stdout, /gitignore/);
  assert.ok(!existsSync(join(dir, '.gitignore')));
  assert.equal(tool(dir, 'sync', ['--check']).status, 0);
});
