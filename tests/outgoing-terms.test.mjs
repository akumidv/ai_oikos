// The words an installation keeps out of outgoing text beyond its own list (ADR 0007 D04, D05, npm test):
// the terms it derives from where it lives, the terms of its linked installations, the organization's
// markers; and which mounts the `vault` connector uses (a problem entry is not one). Pure functions over
// temporary folders — no tool is run and nothing reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_ROOT } from '../tools/common/paths.mjs';
import { MIN_DERIVED_TERM, derivedTerms, linkedTerms, organizationMarkers } from '../tools/common/outgoing-terms.mjs';
import { problemsOf } from '../tools/common/mounts.mjs';
import { installation, tempDir } from './helpers/installation.mjs';
import { repository, write } from './helpers/mounts.mjs';

test('derivedTerms: the root as typed and as it really is, the home folder, the names of .local/; a short or generic name is not a term', () => {
  const real = installation((t) => t);
  const link = join(tempDir('links-'), 'acme-link');
  symlinkSync(real, link, 'dir');
  write(join(real, '.local', 'acquisition-plan.md'), 'x');
  write(join(real, '.local', 'ab.md'), 'x');
  write(join(real, '.local', 'README.md'), 'x');
  write(join(real, '.local', 'AGENTS.md'), 'x');
  write(join(real, '.local', '.env'), 'x');
  const terms = derivedTerms(link, { home: '/home/ada' });
  assert.ok(terms.includes(link) && terms.includes(real), 'the root as typed and the real one');
  assert.ok(terms.includes('/home/ada'), 'the home folder');
  assert.ok(terms.includes('acquisition-plan.md'));
  for (const name of ['ab.md', 'README.md', 'AGENTS.md', '.env']) assert.ok(!terms.includes(name), `${name} is no term`);
  assert.ok(terms.every((t) => t.length >= MIN_DERIVED_TERM), 'none shorter than the minimum');
  assert.ok(!derivedTerms(real, { home: '/' }).includes('/'), 'a short home is no term');
  assert.deepEqual(derivedTerms(join(real, 'nowhere'), { home: '' }).filter((t) => t.includes('nowhere')).length, 1, 'a root without .local/ still gives its path');
});

test('organizationMarkers: the email domain, the hosts of its sites and servers (not the ones every user shares), its task keys, aliases and number templates', () => {
  const cfg = {
    organization: { name: 'ACME Corp', email_domain: '@ACME.example' },
    settings: { JIRA_BASE_URL: 'https://acme.atlassian.net', GITHUB_API_URL: 'https://api.github.com', GITLAB_URL: 'https://gitlab.com', GITHUB_ORG: 'acme-corp', NOT_AN_URL: 'plain' },
    mcp_servers: { knowledge: { type: 'http', url: 'https://kb.example.com/mcp' }, local: { command: 'node' } },
    'task-tracking': {
      jira: {
        defaults: { number_patterns: ['FIX[{n}]'] },
        projects: { PROJ: { key_aliases: ['PJ'], number_patterns: ['T-{n}.'] }, 'owner/repo': {}, OTHER: null },
      },
    },
  };
  const { terms, patterns } = organizationMarkers(cfg);
  assert.deepEqual(terms, ['acme.example', 'acme.atlassian.net', 'kb.example.com']);
  const hit = (text) => patterns.some((p) => p.test(text));
  for (const text of ['PROJ-123', 'see PJ-9', 'OTHER-1', 'FIX[42]', 'T-7.']) assert.ok(hit(text), text);
  for (const text of ['PROJECT-1', 'PROJ', 'owner/repo-1', 'FIX[x]']) assert.ok(!hit(text), text);
  assert.deepEqual(organizationMarkers({}), { terms: [], patterns: [] }, 'an empty configuration has none');
  assert.deepEqual(organizationMarkers({ 'task-tracking': 'broken', settings: [] }).patterns, [], 'a malformed part is skipped');
});

test('linkedTerms: the terms and the derived terms of each mount that is an installation, none of a plain repository or the core; an unreadable file is a problem', () => {
  const other = installation((t) => t);
  repository(other);
  write(join(other, '.local', 'outgoing.yaml'), 'terms: [Initech, Hooli]\nallow: ["a line that is let through"]\n');
  write(join(other, '.local', 'consulting-ledger.md'), 'x');
  const broken = installation((t) => t);
  const plain = repository(tempDir('plain-'));
  const termsOf = (root) => ({ terms: [`read:${root.split('/').pop()}`], problems: [] });
  const read = linkedTerms([{ path: 'a', root: other }, { path: 'b', root: plain }, { path: 'c', root: CORE_ROOT }], termsOf);
  assert.ok(read.terms.includes(`read:${other.split('/').pop()}`), 'the reader is asked for the installation');
  assert.ok(read.terms.includes('consulting-ledger.md') && read.terms.includes(other), 'its derived terms');
  assert.ok(!read.terms.some((t) => t.includes('plain-')), 'a plain repository gives none');
  assert.ok(!read.terms.some((t) => t === CORE_ROOT || t.startsWith('read:_oikos')), 'the core is never an installation');
  const failing = linkedTerms([{ path: 'broken-link', root: broken }], () => ({ terms: [], problems: ['.local/outgoing.yaml does not parse'] }));
  assert.deepEqual(failing.problems, ['linked installation broken-link: .local/outgoing.yaml does not parse']);
});

test('problemsOf: the problems that name a mount, its own entry\'s and the overlaps it is part of; another mount\'s are not', () => {
  const problems = [
    'oikos.yaml: mounts.vaults/team: skills.from: must be a folder inside the mount (relative, no \'..\')',
    '.local/mounts.yaml: mounts./srv/notes/: /srv/notes does not exist — clone or link the repository there',
    'oikos.yaml: mounts.vaults/a: overlaps the mount vaults/b (local)',
    '.local/mounts.yaml: mounts.vaults/b: may not widen the shared mount vaults/b — use: \'wiki\' is not in the shared entry\'s use; dropped',
    'oikos.yaml does not parse (x)',
    'task-tracking.jira: something else',
  ];
  const at = (path) => problemsOf({ path }, problems).length;
  assert.equal(at('vaults/team'), 1);
  assert.equal(at('/srv/notes'), 1, 'a trailing slash on the key is the same mount');
  assert.equal(at('vaults/a'), 1);
  assert.equal(at('vaults/b'), 2, 'its own entry\'s and the overlap');
  assert.equal(at('vaults/none'), 0);
});
