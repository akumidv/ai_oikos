#!/usr/bin/env node
// The people file of the installation, `.local/private.yaml`: who a name in a note or a chat is, and
// the id each tracker or messenger takes for them. Personal data on purpose, git-ignored with
// `.local/` (the shape and rules are in common/people.mjs). `find` looks a person up by name, alias
// or email, or — `find --by-account system=value` — by an account they hold (the reverse lookup:
// whose Jira id, GitHub login or Slack id is this). `find` and `check` read; `add` previews
// and `--yes` writes — a local write of an open file, the same class as `catalog add`, so it takes
// no --dry-run. No connector, no network: it reads and writes only that one file.
//
// A write goes through the yaml library's Document API, which keeps the comments, the blank lines
// and the order of what it did not touch; nothing is dropped silently. The file is created, and
// set back, with mode 0o600.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runCli, isMain, printJson, UsageError } from '../common/cli.mjs';
import { PEOPLE_FILE, accountOf, addPerson, findByAccount, findPeople, loadPeopleDocument, peopleFile, peopleOf, problemsOf } from '../common/people.mjs';

const TOOL = 'node oikos/tools/people/cli.mjs';

/** `system=value` of the flag `--<flag>` as [system, value]; both parts are required. */
function accountArg(arg, flag = 'account') {
  const at = arg.indexOf('=');
  const system = at < 0 ? '' : arg.slice(0, at).trim().toLowerCase();
  const value = at < 0 ? '' : arg.slice(at + 1).trim();
  if (!system || !value) throw new UsageError(`--${flag} '${arg}': write system=value, e.g. --${flag} jira=712020:0000-example`);
  return [system, value];
}

const describe = (person) => {
  const lines = [`${person.name}${person.note ? ` — ${person.note}` : ''}`];
  if (person.aliases.length) lines.push(`  aliases: ${person.aliases.join(', ')}`);
  if (person.email) lines.push(`  email: ${person.email}`);
  const accounts = Object.entries(person.accounts);
  if (accounts.length) lines.push(`  accounts: ${accounts.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return lines;
};

/** The reverse lookup of `find --by-account system=value`: who holds that account. */
function findByAccountArg(values, positionals) {
  if (positionals.length || values.account) {
    throw new UsageError('--by-account takes no name and no --account: find --by-account <system>=<value> [--json]');
  }
  const [system, value] = accountArg(values['by-account'], 'by-account');
  const found = findByAccount(peopleOf(loadPeopleDocument()), system, value);
  if (values.json) printJson(found);
  else if (!found.length) console.log(`no one with ${system} '${value}' in ${PEOPLE_FILE}`);
  else {
    if (found.length > 1) console.log(`${found.length} matches, ask which:`);
    console.log(found.flatMap(describe).join('\n'));
  }
  return found.length ? 0 : 1;
}

const commands = {
  find: {
    help: 'people whose name, an alias or the email matches: find <query> [--account <system>] — --account prints that id alone; '
      + 'find --by-account <system>=<value> is the reverse: the people who hold that account',
    options: { account: { type: 'string' }, 'by-account': { type: 'string' } },
    run(values, positionals) {
      if (values['by-account'] !== undefined) return findByAccountArg(values, positionals);
      const query = positionals.join(' ').trim();
      if (!query) throw new UsageError('usage: find <name | alias | email> [--account <system>] [--json] | find --by-account <system>=<value> [--json]');
      const found = findPeople(peopleOf(loadPeopleDocument()), query);
      if (!found.length) {
        if (values.json) printJson([]);
        else console.log(`no one named '${query}' in ${PEOPLE_FILE} — search the tracker, then \`${TOOL} add\``);
        return 1;
      }
      const system = values.account;
      if (values.json) {
        printJson(found.map((p) => (system ? { name: p.name, [system]: accountOf(p, system) } : p)));
        return found.length === 1 && system && accountOf(found[0], system) === null ? 1 : 0;
      }
      if (!system) {
        if (found.length > 1) console.log(`${found.length} matches, ask which:`);
        console.log(found.flatMap(describe).join('\n'));
        return 0;
      }
      if (found.length === 1) {
        const id = accountOf(found[0], system);
        if (id === null) {
          console.error(`${found[0].name} has no ${system} account in ${PEOPLE_FILE} — search the connector, then \`${TOOL} add "${found[0].name}" --account ${system}=<id>\``);
          return 1;
        }
        console.log(id);
        return 0;
      }
      console.log(`${found.length} matches, ask which:`);
      for (const p of found) console.log(`${p.name}: ${accountOf(p, system) ?? `(no ${system} account)`}`);
      return 0;
    },
  },

  add: {
    help: 'add or extend a person: add <name> [--alias A]… [--email E] [--account system=value]… [--note T] [--replace] [--yes]; a preview unless --yes',
    options: {
      alias: { type: 'string', multiple: true }, email: { type: 'string' }, account: { type: 'string', multiple: true },
      note: { type: 'string' }, replace: { type: 'boolean' }, yes: { type: 'boolean' },
    },
    run(values, positionals) {
      const name = positionals.join(' ').trim();
      if (!name) throw new UsageError('usage: add <name> [--alias A]… [--email E] [--account system=value]… [--note T] [--replace] [--yes]');
      const file = peopleFile();
      const doc = loadPeopleDocument(file);
      const problems = problemsOf(doc);
      if (problems.length) throw new UsageError(`${PEOPLE_FILE} has problems — \`${TOOL} check\` lists them; fix them first (${problems[0]})`);
      const { before, after, changed } = addPerson(doc, {
        name, aliases: values.alias, email: values.email, note: values.note, replace: values.replace,
        accounts: Object.fromEntries((values.account || []).map(accountArg)),
      });
      const write = Boolean(values.yes) && changed;
      if (values.json) printJson({ file: PEOPLE_FILE, before, after, changed, written: write });
      else {
        console.log(`${before ? (changed ? 'update' : 'unchanged') : 'new'}:`);
        console.log(describe(after).map((line, i) => (i ? line : `  ${line}`)).join('\n'));
      }
      if (!changed) return 0;
      if (!write) {
        if (!values.json) console.log(`would write ${PEOPLE_FILE} — preview only; --yes writes it`);
        return 0;
      }
      mkdirSync(dirname(file), { recursive: true });
      const existed = existsSync(file);
      writeFileSync(file, doc.toString({ lineWidth: 0, flowCollectionPadding: false }), { mode: 0o600 });
      if (existed) chmodSync(file, 0o600);
      if (!values.json) console.log(`wrote ${PEOPLE_FILE}`);
    },
  },

  check: {
    help: 'problems in the file: an alias or email shared by two people, an entry without a name, an unknown key, a secret-looking value',
    options: {},
    run(values) {
      if (!existsSync(peopleFile())) {
        if (values.json) printJson([]);
        else console.log(`no ${PEOPLE_FILE} yet`);
        return 0;
      }
      const found = problemsOf(loadPeopleDocument());
      if (values.json) printJson(found);
      else console.log(found.length ? found.join('\n') : `${PEOPLE_FILE} ok (${peopleOf(loadPeopleDocument()).length} people)`);
      return found.length ? 1 : 0;
    },
  },
};

if (isMain(import.meta.url)) runCli('people', commands);
