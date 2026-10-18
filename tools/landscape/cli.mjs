#!/usr/bin/env node
// What oikos reaches and with which skill and connector, computed on request from the skills'
// frontmatter, the installation's oikos.yaml and its resource notes
// (tools/common/landscape.mjs) — the overview is never written into a file.
import { runCli, printJson, UsageError } from '../common/cli.mjs';
import { loadLandscape } from '../common/landscape.mjs';

const AUTH = { none: 'none', git: 'git access', token: 'personal API token', connector: 'claude.ai connector', browser: 'browser sign-in (user)', sso: 'SSO' };

// Not every resource needs an oikos skill: the host itself reaches an MCP server it is configured
// with and a connector the person authorised. Saying which is which keeps that list from being
// read as a backlog.
const DIRECT = { mcp: 'the MCP server in the agent host', connector: 'the claude.ai connector' };
const howReached = (r) => DIRECT[r.kind] || DIRECT[r.auth] || null;

function pick(items, key, ids, what) {
  if (!ids.length) return items;
  const unknown = ids.filter((id) => !items.some((i) => i[key] === id));
  if (unknown.length) throw new UsageError(`unknown ${what}: ${unknown.join(', ')} (known: ${items.map((i) => i[key]).join(', ')})`);
  return items.filter((i) => ids.includes(i[key]));
}

function warn(problems) {
  if (problems.length) console.error(`${problems.length} problem(s) in the notes or skills — node oikos/tools/sync/cli.mjs --check`);
}

const commands = {
  resources: {
    help: 'the organization\'s resources (resources/): what each is for, the skills that reach it, sign-in [id…]',
    options: {},
    run(v, ids) {
      const { resources, problems } = loadLandscape();
      const shown = pick(resources, 'resource', ids, 'resource');
      if (v.json) return printJson(shown);
      if (!resources.length) console.log('No resource notes: this installation describes its organization in resources/<id>.md.');
      const reached = shown.filter((r) => r.skills.length);
      const unreached = shown.filter((r) => !r.skills.length);
      for (const r of reached) {
        const creds = [AUTH[r.auth] || r.auth, ...r.auth_env].join(', ');
        console.log(`${r.resource} — ${r.title}\n  ${r.purpose}\n  skills: ${r.skills.join(', ')} (via ${r.via.join(', ')}) · sign-in: ${creds} · ${r.url}\n  note: ${r.file}\n`);
      }
      const direct = unreached.filter((r) => howReached(r));
      const open = unreached.filter((r) => !howReached(r));
      if (direct.length) {
        console.log('Reached without an oikos skill — the agent host reaches these on its own:');
        for (const r of direct) console.log(`  ${r.resource} — ${r.title} · ${howReached(r)} · ${r.file}`);
      }
      if (open.length) {
        console.log('No route of ours yet:');
        for (const r of open) console.log(`  ${r.resource} — ${r.title} · sign-in: ${AUTH[r.auth] || r.auth} · ${r.file}`);
      }
      warn(problems);
    },
  },
  skills: {
    help: 'oikos skills: what each covers, when to use it, its connectors and the ones this installation uses [name…]',
    options: {},
    run(v, names) {
      const { skills, resources, problems } = loadLandscape();
      const shown = pick(skills, 'dir', names, 'skill');
      if (v.json) return printJson(shown);
      for (const s of shown) {
        // configured: what the installation lists, default first; nothing listed means no connector
        const use = s.configured.length ? `${s.configured.join(', ')} (default ${s.configured[0]})` : '—';
        const reaches = resources.filter((r) => r.skills.includes(s.dir)).map((r) => r.resource);
        console.log(`${s.dir} — ${s.surface}\n  when: ${s.when_to_use}\n  connectors: ${s.connectors.join(', ') || '— (works by itself)'} · used here: ${use}`
          + `${reaches.length ? `\n  resources: ${reaches.join(', ')}` : ''}\n  read: ${s.file}${s.connectors.length ? ', then connectors/<connector>.md' : ''}\n`);
      }
      warn(problems);
    },
  },
};

runCli('landscape', commands);
