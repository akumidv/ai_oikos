// The footprint `sessions` source (npm test): synthetic Claude Code, Qwen Code and Codex transcripts in
// a temporary home — the same scenario rendered in each host's format, so the three hosts must give
// the same numbers. The scenario has typed messages, injected context that is not typed, sidechain and
// sub-agent transcripts that are not read, narration between tool calls (not a final), finals with an
// English and a Russian heading, a declared none, decision codes, an answered and an unanswered
// request, a delegation, a choice dialog, a working folder inside a clone and one beside it, and a
// transcript older than the period (not read). No real home, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { UsageError } from '../tools/common/cli.mjs';
import { gitEnvironment } from '../tools/common/gitwiki.mjs';
import { headingPattern, wordsOf } from '../tools/footprint/meaning.mjs';
import { repoWhere } from '../tools/footprint/sources/git.mjs';
import { collectSessions, requestOf, typedText } from '../tools/footprint/sources/sessions.mjs';
import { cleanEnv, tempDir } from './helpers/installation.mjs';

const PERIOD = { since: '2026-03-01', until: '2026-03-07', tz: 'UTC' };
const at = (day, minute) => new Date(Date.UTC(2026, 2, day, 10, minute)).toISOString();

const FINAL_EN = 'All done.\n\n## Needed from you\n- D-ORDER: pick the order of the steps\n- Q-NAMING confirm the naming';
const FINAL_RU = 'Готово.\n\n## Нужно от вас\n- D-SCOPE: какой объем брать?';
const FINAL_NONE = 'Notes written.\n\n**Needed from you:** nothing';
const TYPED = ['Please add the thing', 'Go with option one', 'Write notes', 'earlier chat', 'thanks', 'old news'];
const NARRATION = ['Looking at the files now', 'Back with the results'];

/** Session A in a clone: typed, injected, narration, tool calls, an answered request, then an unanswered one. */
const sessionA = [
  { step: 'owner', at: at(2, 0), text: TYPED[0] },
  { step: 'wrapped', at: at(2, 1), text: '<system-reminder>Context only.</system-reminder>' },
  { step: 'injected', at: at(2, 2) },
  { step: 'sidechain', at: at(2, 3), text: 'sidechain typed text' },
  { step: 'narration', at: at(2, 4), text: NARRATION[0] },
  { step: 'tool', at: at(2, 5), kind: 'delegation' },
  { step: 'narration', at: at(2, 6), text: NARRATION[1] },
  { step: 'tool', at: at(2, 7), kind: 'choice dialog' },
  { step: 'final', at: at(2, 8), text: FINAL_EN },
  { step: 'owner', at: at(2, 9), text: TYPED[1] },
  { step: 'final', at: at(2, 10), text: FINAL_RU },
];
/** Session B beside the clone: a message before the period, a declared none answered after the period. */
const sessionB = [
  { step: 'owner', at: new Date(Date.UTC(2026, 1, 20, 9)).toISOString(), text: TYPED[3] },
  { step: 'owner', at: at(3, 0), text: TYPED[2] },
  { step: 'final', at: at(3, 1), text: FINAL_NONE },
  { step: 'owner', at: new Date(Date.UTC(2026, 2, 20, 9)).toISOString(), text: TYPED[4] },
];
/** Session C: a typed message in the period, in a transcript last changed years before it. */
const sessionC = [{ step: 'owner', at: at(4, 0), text: TYPED[5] }];

// == hosts: one renderer each, steps → records ==

const claudeRecords = (steps, { session, cwd }) => steps.flatMap((s, i) => {
  const base = { sessionId: session, cwd, timestamp: s.at, uuid: `${session}-${i}` };
  const user = (extra, content) => ({ ...base, type: 'user', message: { role: 'user', content }, ...extra });
  const assistant = (content, extra = {}) => ({ ...base, type: 'assistant', message: { role: 'assistant', content }, ...extra });
  switch (s.step) {
    case 'owner': case 'wrapped': return [user({}, s.text)];
    case 'injected': return [
      user({ isMeta: true }, 'Caveat: injected by the host'),
      user({ isCompactSummary: true, uuid: `${session}-${i}b` }, 'a compaction summary'),
      user({ origin: { kind: 'peer' }, uuid: `${session}-${i}c` }, 'a message from another session'),
      user({ uuid: `${session}-${i}d` }, [{ type: 'tool_result', tool_use_id: 'x', content: 'result' }]),
    ];
    case 'sidechain': return [assistant([{ type: 'text', text: s.text }], { isSidechain: true })];
    case 'narration': case 'final': return [assistant([{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: s.text }])];
    default: return [assistant([{ type: 'tool_use', id: 't', name: s.kind === 'delegation' ? 'Agent' : 'AskUserQuestion', input: {} }])];
  }
});

const qwenRecords = (steps, { session, cwd }) => steps.flatMap((s, i) => {
  const base = { sessionId: session, cwd, timestamp: s.at, uuid: `${session}-${i}` };
  const user = (provenance, text, extra = {}) => ({ ...base, type: 'user', provenance, message: { role: 'user', parts: [{ text }] }, ...extra });
  const assistant = (parts, extra = {}) => ({ ...base, type: 'assistant', message: { role: 'model', parts }, ...extra });
  switch (s.step) {
    case 'owner': case 'wrapped': return [user('real_user', s.text)];
    case 'injected': return [
      user('injected', 'context the host added'),
      { ...base, uuid: `${session}-${i}b`, type: 'tool_result', message: { parts: [{ functionResponse: { name: 'x' } }] } },
      { ...base, uuid: `${session}-${i}c`, type: 'system', subtype: 'note' },
    ];
    case 'sidechain': return [user('real_user', s.text, { isSidechain: true })];
    case 'narration': case 'final': return [assistant([{ text: 'hidden thought', thought: true }, { text: s.text }])];
    default: return [assistant([{ functionCall: { name: s.kind === 'delegation' ? 'agent' : 'ask_user_question', args: {} } }])];
  }
});

const codexRecords = (steps, { session, cwd }) => {
  const records = [
    { type: 'session_meta', timestamp: steps[0].at, payload: { id: session, cwd, thread_source: 'user' } },
  ];
  for (const s of steps) {
    const item = (type, payload) => ({ type, timestamp: s.at, payload });
    const message = (role, phase, text) => item('response_item', { type: 'message', role, phase, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
    switch (s.step) {
      case 'owner': case 'wrapped': records.push(
        item('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: s.text }] } }),
        message('user', undefined, s.text), // the twin of the same message, not counted again
      ); break;
      case 'injected': records.push(message('user', undefined, '<environment_context>cwd</environment_context>')); break;
      case 'sidechain': break; // Codex keeps a sub-agent in a rollout of its own
      case 'narration': records.push(message('assistant', 'commentary', s.text)); break;
      case 'final': records.push(message('assistant', 'final_answer', s.text)); break;
      default: records.push(item('response_item', { type: 'function_call', namespace: 'collaboration', name: s.kind === 'delegation' ? 'spawn_agent' : 'request_user_input_async', arguments: '{}' }));
    }
  }
  return records;
};

const toJsonl = (records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;

function write(file, records, { old = false } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof records === 'string' ? records : toJsonl(records));
  if (old) {
    const long = new Date('2020-01-01T00:00:00Z');
    utimesSync(file, long, long);
  }
}

const GIT_ENV = gitEnvironment(null, cleanEnv());
/** A repository with an origin, as the real path `findRepos` would give. */
function clone(dir, remote) {
  mkdirSync(dir, { recursive: true });
  for (const args of [['init', '-q', '-b', 'main'], ['remote', 'add', 'origin', remote]]) {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
  }
  return realpathSync(dir);
}

/**
 * A home with the three hosts' default folders filled with the scenario. Returns the clone's path
 * (`repo`), a second clone beside it whose name starts with the clone's (`notes`, with its working folder `beside`) and the folders.
 */
function fixture() {
  const home = tempDir('home-');
  const work = tempDir('work-');
  const repo = clone(join(work, 'app'), 'https://example.com/acme/app.git');
  const inside = join(repo, 'src');
  const notes = clone(join(work, 'app-notes'), 'https://example.com/acme/notes.git');
  const beside = join(notes, 'drafts');
  const folders = {
    claude: join(home, '.claude', 'projects'),
    qwen: join(home, '.qwen', 'projects'),
    codexSessions: join(home, '.codex', 'sessions'),
    codexArchived: join(home, '.codex', 'archived_sessions'),
  };
  const sessions = [['sa', sessionA, inside], ['sb', sessionB, beside]];
  const old = ['sc', sessionC, inside];
  const slug = '-work-app';
  for (const [session, steps, cwd] of sessions) {
    write(join(folders.claude, slug, `${session}.jsonl`), claudeRecords(steps, { session, cwd }));
    write(join(folders.qwen, slug, 'chats', `${session}.jsonl`), qwenRecords(steps, { session, cwd }));
  }
  write(join(folders.codexSessions, '2026', '03', '02', 'rollout-sa.jsonl'), codexRecords(sessionA, { session: 'sa', cwd: inside }));
  write(join(folders.codexArchived, 'rollout-sb.jsonl'), codexRecords(sessionB, { session: 'sb', cwd: beside }));
  // Transcripts that are never read: sub-agents, a ledger, a rollout of a sub-agent, an old transcript.
  write(join(folders.claude, slug, 'sa', 'subagents', 'agent-1.jsonl'), claudeRecords(sessionC, { session: 'sub', cwd: inside }));
  write(join(folders.qwen, slug, 'subagents', 'agent-1.jsonl'), qwenRecords(sessionC, { session: 'sub', cwd: inside }));
  write(join(folders.qwen, slug, 'chats', 'sa.ledger.jsonl'), qwenRecords(sessionC, { session: 'ledger', cwd: inside }));
  const sub = codexRecords(sessionC, { session: 'sub', cwd: inside });
  sub[0].payload.thread_source = 'subagent';
  write(join(folders.codexSessions, '2026', '03', '04', 'rollout-sub.jsonl'), sub);
  write(join(folders.claude, slug, 'sc.jsonl'), claudeRecords(old[1], { session: 'sc', cwd: old[2] }), { old: true });
  write(join(folders.qwen, slug, 'chats', 'sc.jsonl'), qwenRecords(old[1], { session: 'sc', cwd: old[2] }), { old: true });
  write(join(folders.codexSessions, '2026', '03', '04', 'rollout-sc.jsonl'), codexRecords(old[1], { session: 'sc', cwd: old[2] }), { old: true });
  return { home, repo, notes, inside, beside, folders };
}

const ALL_OFF = { claude: false, qwen: false, codex: false };
const totalsOf = (result) => Object.fromEntries(result.totals);
const run = (f, hosts, extra = {}, options = {}) => collectSessions(
  { hosts, repos: [f.repo, f.notes], ...PERIOD, ...extra }, { env: {}, home: f.home, ...options },
);

/** What the scenario gives per host, whatever its format. */
const EXPECTED = {
  sessions: 2, 'active days': 2, 'owner messages': 3, 'owner words': 10, finals: 3,
  'final words': wordsOf(FINAL_EN) + wordsOf(FINAL_RU) + wordsOf(FINAL_NONE),
  'decision requests': 3, 'with questions': 2, 'declared none': 1, answered: 2, 'distinct codes': 3, delegations: 1, 'choice dialogs': 1,
};

test('sessions: each host alone gives the scenario\'s numbers from its own format', async () => {
  const f = fixture();
  for (const host of ['claude', 'qwen', 'codex']) {
    const result = await run(f, { ...ALL_OFF, [host]: null });
    assert.deepEqual(totalsOf(result), EXPECTED, host);
    assert.equal(result.events.length, 8, host);
    assert.ok(result.events.every((e) => e.id.startsWith(`${host}:`)), host);
  }
});

test('sessions: the events — kind, fields, repository from the working folder, no text', async () => {
  const f = fixture();
  const result = await run(f, { ...ALL_OFF, claude: null });
  assert.equal(result.source, 'sessions');
  assert.equal(result.label, 'sessions (claude 2 transcripts, qwen 0, codex 0)');
  const repoWhereText = repoWhere(f.repo);
  assert.match(repoWhereText, / https:\/\/example\.com\/acme\/app\.git$/);
  const inRepo = result.events.filter((e) => e.detail.session === 'sa');
  assert.deepEqual(inRepo.map((e) => e.kind), ['message', 'delegation', 'choice dialog', 'final', 'message', 'final']);
  for (const e of inRepo) {
    assert.equal(e.where, repoWhereText);
    assert.equal(e.what, 'acme/app: claude session');
    assert.equal(e.detail.host, 'claude');
  }
  const [message, delegation, dialog, final, , russian] = inRepo;
  assert.deepEqual(message, {
    id: 'claude:sa:sa-0', at: at(2, 0), kind: 'message', what: 'acme/app: claude session', where: repoWhereText,
    detail: { host: 'claude', session: 'sa', file: 'claude:-work-app/sa.jsonl', words: 4 },
  });
  assert.equal(message.action, undefined);
  assert.equal(delegation.action, false);
  assert.equal(dialog.action, false);
  assert.deepEqual(delegation.detail, { host: 'claude', session: 'sa', file: 'claude:-work-app/sa.jsonl' });
  assert.deepEqual(final.detail, {
    host: 'claude', session: 'sa', file: 'claude:-work-app/sa.jsonl', words: wordsOf(FINAL_EN), request: true, questions: 2, none: false, codes: ['D-ORDER', 'Q-NAMING'], answered: true,
  });
  assert.equal(final.action, false);
  assert.deepEqual(russian.detail, {
    host: 'claude', session: 'sa', file: 'claude:-work-app/sa.jsonl', words: wordsOf(FINAL_RU), request: true, questions: 1, none: false, codes: ['D-SCOPE'], answered: false,
  });
  const beside = result.events.filter((e) => e.detail.session === 'sb');
  assert.deepEqual(beside.map((e) => e.kind), ['message', 'final']); // the message before the period and the answer after are not events
  for (const e of beside) {
    assert.equal(e.where, repoWhere(f.notes));
    assert.equal(e.what, 'acme/notes: claude session');
  }
  assert.deepEqual(beside[1].detail, {
    host: 'claude', session: 'sb', file: 'claude:-work-app/sb.jsonl', words: wordsOf(FINAL_NONE), request: true, questions: 0, none: true, codes: [], answered: true, // answered by a message after the period
  });
  const text = JSON.stringify(result.events);
  for (const phrase of [...TYPED, ...NARRATION, 'pick the order', 'sidechain typed', 'Notes written', 'какой объем']) assert.ok(!text.includes(phrase), phrase);
  assert.equal(new Set(result.events.map((e) => e.id)).size, result.events.length);
});

test('sessions: the breakdown per repository, parallel places, the notes', async () => {
  const f = fixture();
  const result = await run(f, { claude: null, qwen: null, codex: null });
  assert.equal(result.label, 'sessions (claude 2 transcripts, qwen 2, codex 2)');
  assert.deepEqual(totalsOf(result), Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, k === 'active days' || k === 'distinct codes' ? v : v * 3])));
  const { breakdown } = result;
  assert.equal(breakdown.title, 'per repository');
  assert.deepEqual(breakdown.header, ['Repository', 'Sessions', 'Messages', 'Words', 'Finals', 'Decision requests', 'Delegations', 'Choice dialogs']);
  assert.deepEqual(breakdown.rows, [['acme/app', 3, 6, 24, 6, 6, 3, 3], ['acme/notes', 3, 3, 6, 3, 3, 0, 0]]);
  assert.deepEqual(breakdown.wheres, [repoWhere(f.repo), repoWhere(f.notes)]);
  const notes = result.notes.join('\n');
  assert.match(notes, /claude: .*\.claude\/projects; 2 transcripts read; 1 skipped as older than the period; 0 records unreadable/);
  assert.match(notes, /qwen: .*\.qwen\/projects; 2 transcripts read; 1 skipped as older/);
  assert.match(notes, /codex: .*\.codex\/sessions, .*\.codex\/archived_sessions; 2 transcripts read; 1 skipped as older than the period; 1 skipped as sub-agent or review threads/);
});

test('sessions: a host off is noted and not read, a missing folder is noted, an explicit folder and the host\'s home variables are used', async () => {
  const f = fixture();
  const off = await run(f, { claude: null, qwen: false, codex: false });
  assert.match(off.notes.join('\n'), /qwen: off \(sessions\.qwen: false\)/);
  assert.equal(off.label, 'sessions (claude 2 transcripts, qwen 0, codex 0)');
  const missing = await run(f, { claude: join(f.home, 'nowhere'), qwen: null, codex: false });
  assert.match(missing.notes.join('\n'), /claude: .*nowhere not found/);
  assert.equal(totalsOf(missing).sessions, 2);
  // Home variables: another folder than the default under the home.
  const other = tempDir('other-');
  write(join(other, 'projects', '-x', 'sx.jsonl'), claudeRecords([{ step: 'owner', at: at(5, 0), text: 'typed elsewhere' }], { session: 'sx', cwd: f.beside }));
  const viaEnv = await collectSessions({ hosts: { ...ALL_OFF, claude: null }, ...PERIOD }, { env: { CLAUDE_CONFIG_DIR: other }, home: f.home });
  assert.equal(totalsOf(viaEnv)['owner messages'], 1);
  write(join(other, 'sessions', '2026', '03', '05', 'rollout-sx.jsonl'), codexRecords([{ step: 'owner', at: at(5, 0), text: 'typed elsewhere' }], { session: 'sx', cwd: f.beside }));
  const viaCodexHome = await collectSessions({ hosts: { ...ALL_OFF, codex: null }, ...PERIOD }, { env: { CODEX_HOME: other }, home: f.home });
  assert.equal(totalsOf(viaCodexHome)['owner messages'], 1);
  const explicit = await collectSessions({ hosts: { ...ALL_OFF, qwen: f.folders.qwen }, ...PERIOD }, { env: {}, home: tempDir('empty-') });
  assert.equal(totalsOf(explicit).sessions, 2);
});

test('sessions: no host folder at all is a usage error, naming each host', async () => {
  const f = fixture();
  await assert.rejects(run(f, ALL_OFF), (e) => e instanceof UsageError && /claude: off/.test(e.message));
  await assert.rejects(
    collectSessions({ hosts: { claude: null, qwen: null, codex: null }, ...PERIOD }, { env: {}, home: tempDir('empty-') }),
    (e) => e instanceof UsageError && /no transcript folder/.test(e.message) && /claude:.*not found/.test(e.message),
  );
});

test('sessions: a folder outside every clone is the place itself; no repos given', async () => {
  const f = fixture();
  const result = await run(f, { ...ALL_OFF, claude: null }, { repos: [] });
  assert.deepEqual(result.breakdown.rows.map((r) => r[0]), ['src', 'drafts']);
  assert.deepEqual(result.breakdown.wheres, [f.inside, f.beside]);
});

test('sessions: the period keeps events by working day, finals are decided over the whole transcript', async () => {
  const f = fixture();
  const narrow = await run(f, { ...ALL_OFF, claude: null }, { since: '2026-03-03', until: '2026-03-03' });
  assert.deepEqual(narrow.events.map((e) => e.kind), ['message', 'final']);
  assert.equal(narrow.events[1].detail.answered, true);
  // The working day starts at 04:00: A's 10:00 messages stay on the day, 00:00 on the 3rd is the 2nd's.
  const early = join(f.folders.claude, '-work-app', 'se.jsonl');
  write(early, claudeRecords([{ step: 'owner', at: new Date(Date.UTC(2026, 2, 8, 1, 0)).toISOString(), text: 'late night' }], { session: 'se', cwd: f.beside }));
  const shifted = await run(f, { ...ALL_OFF, claude: null }, { until: '2026-03-07', dayStartsMin: 240 });
  assert.equal(totalsOf(shifted)['owner messages'], 4); // 01:00 on the 8th belongs to the 7th
});

test('sessions: a transcript that cannot be statted and a folder that cannot be listed are counted and noted, the rest is read', { skip: process.getuid?.() === 0 }, async () => {
  const f = fixture();
  const locked = join(f.folders.claude, '-locked'); // listed (r), but its files cannot be statted (no x)
  const sealed = join(f.folders.claude, '-sealed'); // cannot be listed at all
  write(join(locked, 'x.jsonl'), claudeRecords(sessionA, { session: 'sx', cwd: f.inside }));
  mkdirSync(sealed);
  chmodSync(locked, 0o444);
  chmodSync(sealed, 0o000);
  try {
    const result = await run(f, { ...ALL_OFF, claude: null });
    assert.deepEqual(totalsOf(result), EXPECTED);
    assert.match(result.notes.join('\n'), /claude: .*; 2 file\(s\) or folder\(s\) could not be read \(/);
    // What could not be read makes the crawl partial: the store merges it by id.
    assert.equal(result.partial, true);
    assert.deepEqual(result.partialReasons, ['2 transcript file(s) or folder(s) could not be read']);
  } finally {
    chmodSync(locked, 0o755);
    chmodSync(sealed, 0o755);
  }
});

test('requestOf: a none-item is the whole item — a longer item that starts with a none word keeps its questions and codes', () => {
  const of = (text) => requestOf(text, headingPattern(), '\\b[DQ]-[A-Z0-9]+(?:-[A-Z0-9]+)*\\b');
  assert.deepEqual(of('## Needed from you\n- Nonetheless, D-ORDER: pick A or B'), { request: true, questions: 1, none: false, codes: ['D-ORDER'] });
  assert.deepEqual(of('## Needed from you\n- None of the three options fits? D-SCOPE'), { request: true, questions: 1, none: false, codes: ['D-SCOPE'] });
  assert.deepEqual(of('## Needed from you\n- Нет, давайте D-X'), { request: true, questions: 1, none: false, codes: ['D-X'] });
  for (const none of ['Nothing.', '**None**', 'None!', '— ', 'Ничего.', '**Нет**', 'No new questions.']) {
    assert.deepEqual(of(`## Needed from you\n- ${none}`), { request: true, questions: 0, none: true, codes: [] }, none);
  }
  assert.deepEqual(of('**Needed from you:** nothing.'), { request: true, questions: 0, none: true, codes: [] });
});

test('requestOf: a code line may be a markdown heading, and code lines follow the configured decision code pattern', () => {
  const headings = headingPattern();
  const dq = '\\b[DQ]-[A-Z0-9]+(?:-[A-Z0-9]+)*\\b';
  assert.deepEqual(requestOf('## Needed from you\n### D-ORDER — pick the order\n#### **Q-NAME** confirm', headings, dq), { request: true, questions: 2, none: false, codes: ['D-ORDER', 'Q-NAME'] });
  // a project's own code shape: lines starting with it are items, `D-` lines are not
  const own = '\\bADR-[0-9]+\\b';
  assert.deepEqual(requestOf('## Needed from you\nADR-12 choose the shape\n**ADR-13** and the name\nD-OLD ignored', headings, own), { request: true, questions: 2, none: false, codes: ['ADR-12', 'ADR-13'] });
  assert.deepEqual(requestOf('## Needed from you\nD-OLD not a code here', headings, new RegExp(own)), { request: true, questions: 1, none: false, codes: [] }); // the prose line, no code found
});

test('typedText: wrappers and caveats are removed, injected text and interruptions are not typed', () => {
  assert.equal(typedText('<system-reminder>x</system-reminder>\nWrite it'), 'Write it');
  assert.equal(typedText('<command-name>/x</command-name><local-command-stdout>out</local-command-stdout>'), null);
  assert.equal(typedText('Caveat: the messages below\nReal text'), 'Real text');
  for (const injected of [
    '[Request interrupted by user]', 'Another Claude session sent a message', '[Subagent hand-back] done', '<agent-message from="x">',
    '<task-notification>done</task-notification>', 'Stop hook feedback: x', 'PreToolUse-hook output', 'sessionstart hook ran', '   ',
  ]) assert.equal(typedText(injected), null, injected);
});

test('requestOf: headings, bullets, code lines, the prose line, declared none, codes in the first 80 characters', () => {
  const headings = headingPattern();
  const codes = '\\b[DQ]-[A-Z0-9]+(?:-[A-Z0-9]+)*\\b';
  const of = (text) => requestOf(text, headings, codes);
  assert.deepEqual(of('Done.\nnothing asked'), { request: false, questions: 0, none: false, codes: [] });
  assert.deepEqual(of('## Needed from you\n1. D-A: first\n2) Q-B-C second\n* plain'), { request: true, questions: 3, none: false, codes: ['D-A', 'Q-B-C'] });
  assert.deepEqual(of('**Needed from you:** D-ONE choose\n\n**D-TWO** and more'), { request: true, questions: 2, none: false, codes: ['D-ONE', 'D-TWO'] });
  assert.deepEqual(of('## Нужно от вас\n\nКакой вариант берем?'), { request: true, questions: 1, none: false, codes: [] });
  assert.deepEqual(of('Нужно от вас: нет'), { request: true, questions: 0, none: true, codes: [] });
  assert.deepEqual(of('## Нужно от вас\n- ничего\n- —'), { request: true, questions: 0, none: true, codes: [] });
  assert.deepEqual(of('## Needed from you\n- No new questions'), { request: true, questions: 0, none: true, codes: [] });
  assert.deepEqual(of('## Needed from you\n- Нетрудно ли выбрать? D-X'), { request: true, questions: 1, none: false, codes: ['D-X'] }); // "нет" inside a word is not none
  assert.deepEqual(of(`## Needed from you\n- ${'word '.repeat(20)}D-FAR`), { request: true, questions: 1, none: false, codes: [] });
  assert.equal(requestOf('## Requires\n- D-Q', headingPattern(['Requires']), codes).codes[0], 'D-Q');
});

// == transcript files, scoping to --repos, machine prompts ==

test('sessions: every event names its transcript (host:path under the host folder) and the result lists the files read — also those that gave no event', async () => {
  const f = fixture();
  const all = await run(f, { claude: null, qwen: null, codex: null });
  assert.deepEqual(all.filesRead.sort(), [
    'claude:-work-app/sa.jsonl', 'claude:-work-app/sb.jsonl',
    'codex:2026/03/02/rollout-sa.jsonl', 'codex:2026/03/04/rollout-sub.jsonl', 'codex:rollout-sb.jsonl',
    'qwen:-work-app/chats/sa.jsonl', 'qwen:-work-app/chats/sb.jsonl',
  ]);
  assert.ok(all.events.every((e) => all.filesRead.includes(e.detail.file)));
  assert.equal(all.partial, undefined);
  // A transcript read whose events all lie outside the period is still a file read; one older than the period is not.
  const quiet = await run(f, { ...ALL_OFF, claude: null }, { since: '2026-03-06', until: '2026-03-06' });
  assert.deepEqual(quiet.events, []);
  assert.deepEqual(quiet.filesRead.sort(), ['claude:-work-app/sa.jsonl', 'claude:-work-app/sb.jsonl']);
});

test('sessions: with repos only the sessions inside those clones or their worktrees count, the others are skipped and noted', async () => {
  const f = fixture();
  const only = await run(f, { ...ALL_OFF, claude: null }, { repos: [f.repo] });
  assert.equal(totalsOf(only).sessions, 1);
  assert.deepEqual(only.events.map((e) => e.detail.session), ['sa', 'sa', 'sa', 'sa', 'sa', 'sa']);
  assert.match(only.notes.join('\n'), /1 session outside --repos skipped/);
  assert.deepEqual(only.breakdown.rows.map((r) => r[0]), ['acme/app']);
  // Without repos nothing is skipped and nothing is noted.
  const none = await run(f, { ...ALL_OFF, claude: null }, { repos: [] });
  assert.equal(totalsOf(none).sessions, 2);
  assert.doesNotMatch(none.notes.join('\n'), /outside --repos/);
  // Both clones given: nothing outside.
  assert.doesNotMatch((await run(f, { ...ALL_OFF, claude: null })).notes.join('\n'), /outside --repos/);
});

test('sessions: a worktree of a clone counts — inside the clone\'s folder, and a linked worktree elsewhere through its git common directory', async () => {
  const f = fixture();
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', ...args], { encoding: 'utf8', env: GIT_ENV });
    assert.equal(r.status, 0, r.stderr);
  };
  git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const linked = join(tempDir('linked-'), 'feature');
  const nested = join(f.repo, '.worktrees', 'x');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
  git(f.repo, 'worktree', 'add', '-q', '-b', 'nested', nested);
  const unrelated = clone(join(tempDir('other-'), 'else'), 'https://example.com/acme/else.git');
  const steps = [{ step: 'owner', at: at(5, 0), text: 'work in a worktree' }];
  for (const [session, cwd] of [['wl', linked], ['wn', nested], ['wo', unrelated]]) {
    write(join(f.folders.claude, '-wt', `${session}.jsonl`), claudeRecords(steps, { session, cwd }));
  }
  const result = await run(f, { ...ALL_OFF, claude: null }, { repos: [f.repo] });
  assert.deepEqual(result.events.filter((e) => e.kind === 'message' && e.at === at(5, 0)).map((e) => e.detail.session).sort(), ['wl', 'wn']);
  assert.ok(result.events.filter((e) => ['wl', 'wn'].includes(e.detail.session)).every((e) => e.what === 'acme/app: claude session' && e.where === repoWhere(f.repo)));
  assert.match(result.notes.join('\n'), /2 sessions outside --repos skipped/); // sb (the other clone) and the unrelated one
});

test('sessions: a message matching a skip pattern is not an owner message — nowhere in messages, words, active days or answered; the others stay', async () => {
  const f = fixture();
  const steps = [
    { step: 'owner', at: at(6, 0), text: 'Nightly digest: run the checks' },
    { step: 'final', at: at(6, 1), text: FINAL_EN },
    { step: 'owner', at: at(6, 2), text: 'NIGHTLY DIGEST again' },
  ];
  write(join(f.folders.claude, '-sp', 'sp.jsonl'), claudeRecords(steps, { session: 'sp', cwd: f.inside }));
  const before = await run(f, { ...ALL_OFF, claude: null });
  const patterns = await run(f, { ...ALL_OFF, claude: null }, { skipPrompts: [/^Nightly digest/] });
  assert.equal(totalsOf(before)['owner messages'], 5);
  assert.equal(totalsOf(patterns)['owner messages'], 4); // the case-sensitive pattern leaves "NIGHTLY DIGEST again"
  assert.match(patterns.notes.join('\n'), /1 message matching sessions_skip_prompts skipped/);
  const both = await run(f, { ...ALL_OFF, claude: null }, { skipPrompts: [/^Nightly digest/i] });
  const t = totalsOf(both);
  assert.equal(t['owner messages'], 3);
  assert.equal(t['active days'], 2); // the 6th has only machine messages
  assert.equal(t['owner words'], 10);
  assert.equal(t.answered, 2); // the request of the 6th is not answered by a machine prompt
  assert.match(both.notes.join('\n'), /2 messages matching sessions_skip_prompts skipped/);
  assert.equal(both.events.filter((e) => e.detail.session === 'sp' && e.kind === 'message').length, 0);
  // Every owner message of the session was a tool's: the session counts nowhere (its final, words, codes included) and the note counts it.
  assert.equal(both.events.filter((e) => e.detail.session === 'sp').length, 0);
  assert.equal(t.sessions, totalsOf(before).sessions - 1);
  assert.equal(t['decision requests'], totalsOf(before)['decision requests'] - 1);
  assert.equal(t.finals, totalsOf(before).finals - 1);
  assert.match(both.notes.join('\n'), /1 session started by a tool skipped/);
  // A session that keeps an owner message stays whole and is not counted as a tool's.
  assert.equal(patterns.events.filter((e) => e.detail.session === 'sp' && e.kind === 'final').length, 1);
  assert.doesNotMatch(patterns.notes.join('\n'), /started by a tool/);
});

test('sessions: a side-agent note the owner forwards is an owner message of the owner\'s own words; the note\'s words are noteWords, and skip patterns see the owner\'s words only (D-FP3-SIDE-NOTE)', async () => {
  const f = fixture();
  const preamble = 'Here is a note offered by a side agent:';
  const quote = '> the note says to wait\n>\n> then rerun the checks';
  const quoteWords = wordsOf('the note says to wait then rerun the checks');
  const base = (i, content) => ({
    sessionId: 'sn', cwd: f.inside, timestamp: at(6, 20 + i), uuid: `sn-${i}`, type: 'user', origin: { kind: 'human' }, message: { role: 'user', content },
  });
  const records = [
    base(0, `${preamble}\n\n${quote}\n\nPlease apply it now`), // a comment after the note
    base(1, `${preamble}\n\n${quote}`), // no comment: the forward alone is the owner's act
    base(2, [{ type: 'text', text: '<ide_opened_file>The user opened a.js</ide_opened_file>' }, { type: 'text', text: `Look at this.\n\n${preamble}\n\n${quote}` }]), // a comment before, in blocks
    base(3, `${preamble}\n\n${quote}\n\nNightly digest: apply it`), // the owner's words match a skip pattern: a tool's
    { ...base(4, 'x'), origin: { kind: 'peer' }, message: { role: 'user', content: `${preamble}\n\n${quote}` } }, // a peer's record is not the owner's
  ];
  write(join(f.folders.claude, '-sn', 'sn.jsonl'), records);
  const host = { ...ALL_OFF, claude: null };
  const events = (await run(f, host, { skipPrompts: [/^Nightly digest/, /the note/] })).events.filter((e) => e.detail.session === 'sn');
  assert.deepEqual(events.map((e) => [e.kind, e.detail.words, e.detail.noteWords]), [
    ['message', 4, quoteWords], ['message', 0, quoteWords], ['message', 3, quoteWords],
  ]);
  assert.ok(events.every((e) => e.action !== false));
  assert.ok(!JSON.stringify(events).includes('wait'), 'no text is stored');
  // Without patterns the fourth counts too, with its own words; a message with no note carries no noteWords.
  const all = (await run(f, host)).events.filter((e) => e.detail.session === 'sn');
  assert.deepEqual(all.map((e) => e.detail.words), [4, 0, 3, wordsOf('Nightly digest: apply it')]);
  assert.equal((await run(f, host)).events.find((e) => e.kind === 'message' && e.detail.session === 'sa').detail.noteWords, undefined);
  assert.match((await run(f, host, { skipPrompts: [/^Nightly digest/] })).notes.join('\n'), /1 message matching sessions_skip_prompts skipped/);
});

test('sessions: the owner\'s answer to a Codex choice dialog (the reply wrapper in a user message) is an owner message and answers the request before it', async () => {
  const f = fixture();
  const reply = '<send_user_message_question_reply>{"answers":{"order":"first"}}</send_user_message_question_reply>';
  const steps = [
    { step: 'owner', at: at(6, 0), text: 'Plan it' },
    { step: 'tool', at: at(6, 1), kind: 'choice dialog' },
    { step: 'final', at: at(6, 2), text: FINAL_EN },
    { step: 'owner', at: at(6, 3), text: reply },
  ];
  write(join(f.folders.codexSessions, '2026', '03', '06', 'rollout-dlg.jsonl'), codexRecords(steps, { session: 'dlg', cwd: f.inside }));
  const result = await run(f, { ...ALL_OFF, codex: null });
  const mine = result.events.filter((e) => e.detail.session === 'dlg');
  assert.deepEqual(mine.map((e) => e.kind), ['message', 'choice dialog', 'final', 'message']);
  assert.ok(mine[3].detail.words > 0 && mine[3].action === undefined);
  assert.equal(mine[2].detail.answered, true);
  // Skip patterns apply to what a tool typed, not to this reply, unless the installation says so.
  const skipped = await run(f, { ...ALL_OFF, codex: null }, { skipPrompts: [/^Plan/] });
  assert.equal(skipped.events.filter((e) => e.detail.session === 'dlg' && e.kind === 'message').length, 1);
});

test('sessions: the owner\'s answer to a Claude Code or Qwen choice dialog is an owner message of its chosen words, counted at the answer\'s time', async () => {
  const f = fixture();
  const claudeBase = (i, extra) => ({ sessionId: 'cd', cwd: f.inside, timestamp: at(6, i), uuid: `cd-${i}`, ...extra });
  const question = (i, id) => claudeBase(i, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [] } }] } });
  const result = (i, id, content, extra = {}, isError = undefined) => claudeBase(i, {
    type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, ...extra,
  });
  const claude = [
    claudeBase(0, { type: 'user', message: { role: 'user', content: 'Plan it' } }),
    question(2, 'q1'),
    // The answer as the host writes it: toolUseResult.answers maps each question to the chosen label.
    result(3, 'q1', 'Your questions have been answered: "Which order?"="first then second". You can now continue.', { toolUseResult: { questions: [], answers: { 'Which order?': 'first then second' } } }),
    question(4, 'q2'),
    // The same answer in a transcript without toolUseResult: read from the pairs in the result text.
    result(5, 'q2', 'The user answered: "Which scope?"="narrow", "Which name?"="keep it".'),
    question(6, 'q3'),
    result(7, 'q3', "The user doesn't want to proceed with this tool use.", {}, true), // declined: no answer
    result(8, 'other-tool', 'a tool result of another call'),
  ];
  write(join(f.folders.claude, '-cd', 'cd.jsonl'), claude);
  const claudeResult = await run(f, { ...ALL_OFF, claude: null });
  const mine = claudeResult.events.filter((e) => e.detail.session === 'cd');
  assert.deepEqual(mine.map((e) => e.kind), ['message', 'choice dialog', 'message', 'choice dialog', 'message', 'choice dialog']);
  const messages = mine.filter((e) => e.kind === 'message');
  assert.deepEqual(messages.map((e) => [e.at, e.detail.words, e.action]), [[at(6, 0), 2, undefined], [at(6, 3), 3, undefined], [at(6, 5), 3, undefined]]);
  assert.ok(!JSON.stringify(mine).includes('first then second'), 'no text is stored');

  const qwenBase = (i, extra) => ({ sessionId: 'cd', cwd: f.inside, timestamp: at(6, i), uuid: `cdq-${i}`, ...extra });
  const answer = (i, status, display) => qwenBase(i, {
    type: 'tool_result', provenance: 'tool_result', message: { parts: [{ functionResponse: { id: 'c', name: 'ask_user_question', response: { output: 'x' } } }] },
    toolCallResult: { callId: 'c', status, resultDisplay: display },
  });
  const qwen = [
    qwenBase(0, { type: 'user', provenance: 'real_user', message: { role: 'user', parts: [{ text: 'Plan it' }] } }),
    qwenBase(2, { type: 'assistant', message: { role: 'model', parts: [{ functionCall: { name: 'ask_user_question', args: {} } }] } }),
    answer(3, 'success', { type: 'ask_user_question_answers', answers: [{ question: 'Which order?', answer: 'first then second' }] }),
    answer(4, 'cancelled', 'cancelled by the user'),
  ];
  write(join(f.folders.qwen, '-cd', 'chats', 'cd.jsonl'), qwen);
  const qwenResult = await run(f, { ...ALL_OFF, qwen: null });
  const theirs = qwenResult.events.filter((e) => e.detail.session === 'cd');
  assert.deepEqual(theirs.map((e) => e.kind), ['message', 'choice dialog', 'message']);
  assert.deepEqual(theirs.filter((e) => e.kind === 'message').map((e) => [e.at, e.detail.words]), [[at(6, 0), 2], [at(6, 3), 3]]);
});
