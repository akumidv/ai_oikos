// The people file of an installation, `.local/private.yaml`: the people a user names in notes and
// chats — display name, the aliases they go by, an email, and the id each tracker or messenger
// takes for them. It holds personal data on purpose (names, emails, accounts) and is git-ignored
// with `.local/`, one file per machine and person; what stays out of it is secrets (they live in
// `.local/.env`). This module is the file's shape and rules: read, match, check, plan an addition.
// Writing is the CLI's (tools/people/cli.mjs). The yaml library's Document API is used throughout,
// so a write keeps the comments, the blank lines and the order of the entries it did not touch.
import { existsSync, readFileSync } from 'node:fs';
import YAML from 'yaml';
import { UsageError } from './cli.mjs';
import { fold } from './files.mjs';
import { BUILT_IN_RULES, outgoingFindings, maskSecret } from './outgoing.mjs';
import { localPath } from './paths.mjs';

/** The file, from the installation's root. */
export const PEOPLE_FILE = '.local/private.yaml';

/** The line, with its comment, that the installation's `.gitignore` carries so the file stays out of git. */
export const PEOPLE_IGNORE_LINE = PEOPLE_FILE;
export const PEOPLE_IGNORE_COMMENT = '# personal data — names, emails, accounts (oikos people file)';

/** The keys of an entry, in the order they are written. */
export const ENTRY_KEYS = Object.freeze(['name', 'aliases', 'email', 'accounts', 'note']);

const HEADER = `# oikos people — personal data on purpose (names, aliases, emails, accounts); git-ignored, never committed.
# Secrets (tokens, passwords, keys) do not belong here: they live in .local/.env.
# Tool: node oikos/tools/people/cli.mjs find | add | check
`;

/**
 * @typedef {object} Person
 * @property {string} name the display name
 * @property {string[]} aliases how notes and chats call the person
 * @property {string|null} email lowercase
 * @property {Record<string, string>} accounts the id the connector takes, by system (jira, github, slack, …)
 * @property {string|null} note one line
 */

/** The file's path; throws outside an installation. */
export const peopleFile = () => localPath('private.yaml');

/** A text for comparing names: case, diacritics and punctuation folded, words separated by one space. */
export const normalize = (text) => fold(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const words = (text) => normalize(text).split(' ').filter(Boolean);

/** The parsed Document of `file`, or a new one with the header when it is absent; a parse error is a usage error. */
export function loadPeopleDocument(file = peopleFile()) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : `${HEADER}version: 1\npeople:\n`;
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new UsageError(`${PEOPLE_FILE}: ${doc.errors[0].message.split('\n')[0]}`);
  return doc;
}

const isMap = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (value == null ? null : String(value).trim() || null);

/** One entry of the file as a Person; anything the entry lacks is empty. Tolerant: `check` reports the shape. */
function personOf(entry) {
  const aliases = Array.isArray(entry.aliases) ? entry.aliases : entry.aliases == null ? [] : [entry.aliases];
  const accounts = isMap(entry.accounts)
    ? Object.fromEntries(Object.entries(entry.accounts).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
    : {};
  return {
    name: text(entry.name) ?? '',
    aliases: aliases.map(text).filter(Boolean),
    email: text(entry.email)?.toLowerCase() ?? null,
    accounts,
    note: text(entry.note),
  };
}

/** The people of the Document `doc`, in file order (an entry that is not a map is skipped). */
export function peopleOf(doc) {
  const list = doc.toJS()?.people;
  return Array.isArray(list) ? list.filter(isMap).map(personOf) : [];
}

/** The strings a person is looked up by: the name and the aliases. */
const namesOf = (person) => [person.name, ...person.aliases].filter(Boolean);

/**
 * The people `query` points at. An exact match — the full name, an alias or the email — wins and
 * is all that is returned; otherwise a person matches when every word of the query is a word of
 * the name or of an alias. Case, diacritics and punctuation do not matter.
 * @param {Person[]} people
 * @param {string} query
 * @returns {Person[]}
 */
export function findPeople(people, query) {
  const wanted = normalize(query);
  if (!wanted) return [];
  const email = String(query).trim().toLowerCase();
  const exact = people.filter((p) => p.email === email || namesOf(p).some((n) => normalize(n) === wanted));
  if (exact.length) return exact;
  const queryWords = words(query);
  return people.filter((p) => {
    const have = new Set(namesOf(p).flatMap(words));
    return queryWords.every((w) => have.has(w));
  });
}

/** The id of `person` in `system` (compared folded), or null. */
export function accountOf(person, system) {
  const key = Object.keys(person.accounts).find((k) => normalize(k) === normalize(system));
  return key === undefined ? null : person.accounts[key];
}

/**
 * The people whose `system` account holds `value` — the reverse of `accountOf`. The system is
 * compared folded; the value is compared trimmed and without case (logins and emails do not
 * distinguish case, and ids that differ only by case are not a realistic clash).
 * @param {Person[]} people
 * @param {string} system
 * @param {string} value
 * @returns {Person[]}
 */
export function findByAccount(people, system, value) {
  const wanted = String(value).trim().toLowerCase();
  if (!wanted) return [];
  return people.filter((p) => accountOf(p, system)?.trim().toLowerCase() === wanted);
}

// -- secrets --------------------------------------------------------------------------------

/** Every string leaf of `value` as [path, string]; `path` is the dotted way to it. */
function* strings(value, path) {
  if (typeof value === 'string') yield [path, value];
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* strings(v, `${path}[${i}]`);
  else if (isMap(value)) for (const [k, v] of Object.entries(value)) yield* strings(v, path ? `${path}.${k}` : k);
}

/**
 * What looks like a secret in `value` (a token prefix, a private-key block, a JWT), as
 * `{ path, shown }` with the secret masked; the file is no place for credentials.
 */
export function secretsIn(value, path = '') {
  const found = [];
  for (const [at, s] of strings(value, path)) {
    for (const f of outgoingFindings(s, BUILT_IN_RULES)) if (f.category === 'secret') found.push({ path: at, shown: maskSecret(f.match) });
  }
  return found;
}

// -- check ----------------------------------------------------------------------------------

const TOP_KEYS = ['version', 'people'];

/** The problems of one entry's own shape, by `tag` (its place in the file): a text each. */
function entryProblems(entry, tag) {
  const out = [];
  if (!text(entry.name)) out.push(`${tag}: no name`);
  for (const k of Object.keys(entry)) if (!ENTRY_KEYS.includes(k)) out.push(`${tag}: unknown key '${k}' (expected ${ENTRY_KEYS.join(', ')})`);
  if (entry.aliases != null && (!Array.isArray(entry.aliases) || entry.aliases.some((a) => typeof a !== 'string'))) out.push(`${tag}: aliases is a list of strings`);
  if (entry.accounts != null && (!isMap(entry.accounts) || Object.values(entry.accounts).some((v) => v == null || typeof v === 'object'))) {
    out.push(`${tag}: accounts maps a system to one id (jira: "…")`);
  }
  for (const s of secretsIn(entry, tag)) out.push(`${s.path}: looks like a secret (${s.shown}) — credentials live in .local/.env, not here`);
  return out;
}

/** The problems of the file's Document `doc`: a text each. */
export function problemsOf(doc) {
  const data = doc.toJS();
  if (data == null) return [];
  if (!isMap(data)) return [`${PEOPLE_FILE}: holds version: and people:, a map`];
  const out = [];
  for (const k of Object.keys(data)) if (!TOP_KEYS.includes(k)) out.push(`unknown key '${k}' (expected ${TOP_KEYS.join(', ')})`);
  if (data.version !== undefined && data.version !== 1) out.push(`version: ${JSON.stringify(data.version)} — this tool reads version 1`);
  if (data.people != null && !Array.isArray(data.people)) return [...out, 'people: is a list of entries'];
  const seen = new Map();
  for (const [i, entry] of (data.people ?? []).entries()) {
    if (!isMap(entry)) { out.push(`people[${i}]: not a map`); continue; }
    const tag = `people[${i}]${text(entry.name) ? ` '${text(entry.name)}'` : ''}`;
    out.push(...entryProblems(entry, tag));
    const person = personOf(entry);
    const keys = [...namesOf(person).map((n) => [normalize(n), `name/alias '${n}'`]), ...(person.email ? [[person.email, `email '${person.email}'`]] : [])];
    for (const [key, what] of keys) {
      const other = seen.get(key);
      if (other !== undefined && other !== i) out.push(`${tag}: ${what} also belongs to people[${other}]`);
      seen.set(key, i);
    }
  }
  return out;
}

// -- add ------------------------------------------------------------------------------------

/**
 * @typedef {object} Addition
 * @property {string} name
 * @property {string[]} [aliases]
 * @property {string|null} [email]
 * @property {Record<string, string>} [accounts]
 * @property {string|null} [note]
 * @property {boolean} [replace] let a differing email, note or account replace the stored one
 */

/** Refuse (a usage error) a value of `addition` that looks like a secret; the message points at `.local/.env`. */
function refuseSecrets(addition) {
  const found = secretsIn({ name: addition.name, aliases: addition.aliases, email: addition.email, accounts: addition.accounts, note: addition.note });
  if (!found.length) return;
  const lines = found.map((f) => `  ${f.path}: ${f.shown}`).join('\n');
  throw new UsageError(`refused: ${found.length > 1 ? 'values look' : 'a value looks'} like a secret — ${PEOPLE_FILE} holds names and ids, not credentials; `
    + `a token or password goes in .local/.env (node oikos/tools/setup/cli.mjs token)\n${lines}`);
}

/** The person at `index` in `people` that `addition` is about (same name, or same email), or -1; two different people is an error. */
function existingIndex(people, addition) {
  const byName = people.findIndex((p) => normalize(p.name) === normalize(addition.name));
  const email = addition.email?.toLowerCase();
  const byEmail = email ? people.findIndex((p) => p.email === email) : -1;
  if (byName >= 0 && byEmail >= 0 && byName !== byEmail) {
    throw new UsageError(`'${addition.name}' is ${people[byName].name} by name but ${people[byEmail].name} by email ${email} — two entries; fix the file or the arguments`);
  }
  return byName >= 0 ? byName : byEmail;
}

/** Append a new entry for `wanted` to the Document `doc`; returns the Person written. */
function appendPerson(doc, wanted) {
  const after = {
    name: wanted.name,
    aliases: [...new Set((wanted.aliases ?? []).map((a) => a.trim()).filter((a) => a && normalize(a) !== normalize(wanted.name)))],
    email: wanted.email,
    accounts: { ...wanted.accounts },
    note: wanted.note,
  };
  const entry = { name: after.name };
  if (after.aliases.length) entry.aliases = after.aliases;
  if (after.email) entry.email = after.email;
  if (Object.keys(after.accounts).length) entry.accounts = after.accounts;
  if (after.note) entry.note = after.note;
  const node = doc.createNode(entry);
  const aliases = node.get('aliases', true);
  if (aliases) aliases.flow = true;
  if (doc.getIn(['people']) == null) doc.setIn(['people'], doc.createNode([]));
  doc.addIn(['people'], node);
  return after;
}

/** Add `alias` to the entry at `index`, keeping the style of the list it joins. */
function appendAlias(doc, index, alias) {
  const existing = doc.getIn(['people', index, 'aliases'], true);
  if (existing && typeof existing.add === 'function') {
    existing.add(doc.createNode(alias));
    return;
  }
  const seq = doc.createNode([...(peopleOf(doc)[index].aliases), alias]);
  seq.flow = true;
  doc.setIn(['people', index, 'aliases'], seq);
}

/** Merge `wanted` additively into the entry at `index` of `doc`: { before, after, changed }. */
function mergePerson(doc, index, wanted) {
  const before = peopleOf(doc)[index];
  const after = { ...before, aliases: [...before.aliases], accounts: { ...before.accounts } };
  const refuse = (what, stored, given) => {
    throw new UsageError(`${before.name} has ${what} '${stored}' in ${PEOPLE_FILE}, not '${given}' — --replace to change it`);
  };

  // Found by its email under another name: the given name is one more way to call the person.
  const named = normalize(wanted.name) === normalize(before.name) ? [] : [wanted.name];
  for (const alias of [...(wanted.aliases ?? []), ...named].map((a) => a.trim()).filter(Boolean)) {
    if ([after.name, ...after.aliases].some((a) => normalize(a) === normalize(alias))) continue;
    appendAlias(doc, index, alias);
    after.aliases.push(alias);
  }
  for (const [field, given] of [['email', wanted.email], ['note', wanted.note]]) {
    if (!given || given === before[field]) continue;
    if (before[field] && !wanted.replace) refuse(field === 'email' ? 'the email' : 'the note', before[field], given);
    doc.setIn(['people', index, field], given);
    after[field] = given;
  }
  for (const [system, given] of Object.entries(wanted.accounts ?? {})) {
    const stored = accountOf(before, system);
    if (stored === given) continue;
    if (stored !== null && !wanted.replace) refuse(`the ${system} account`, stored, given);
    const key = Object.keys(before.accounts).find((k) => normalize(k) === normalize(system)) ?? system;
    doc.setIn(['people', index, 'accounts', key], given);
    after.accounts[key] = given;
  }
  return { before, after, changed: JSON.stringify(before) !== JSON.stringify(after) };
}

/**
 * Plan the addition of `addition` to the Document `doc`, in place, without writing: a new entry,
 * or an additive merge into the person already there (same name, or same email). Aliases and
 * accounts are added; a differing email, note or account is refused unless `replace`. An alias or
 * name that already belongs to another person is refused, as is a secret. The file must pass
 * `problemsOf` first (entry positions are counted over a list of maps).
 * @param {YAML.Document} doc
 * @param {Addition} addition
 * @returns {{ before: Person|null, after: Person, changed: boolean }} the entry as it was and as it will be
 */
export function addPerson(doc, addition) {
  refuseSecrets(addition);
  const name = String(addition.name ?? '').trim();
  if (!name) throw new UsageError('add <name>: the name is required');
  const people = peopleOf(doc);
  const wanted = { ...addition, name, email: text(addition.email)?.toLowerCase() ?? null, note: text(addition.note) };
  const index = existingIndex(people, wanted);
  for (const alias of [name, ...(wanted.aliases ?? [])]) {
    const owner = people.find((p, i) => i !== index && namesOf(p).some((n) => normalize(n) === normalize(alias)));
    if (owner) throw new UsageError(`'${alias}' already belongs to ${owner.name} — two people with one alias make the lookup ambiguous; pick another alias`);
  }
  if (index < 0) return { before: null, after: appendPerson(doc, wanted), changed: true };
  return mergePerson(doc, index, wanted);
}
