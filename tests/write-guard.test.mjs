// The write guard (npm test): a changing command runs for real only after its dry run and a user
// prompt since, and only in the strict form `node oikos/tools/<tool>/cli.mjs <verb> …`. The hook
// is driven as a host drives it — `host-hook.mjs write-guard` with the event payload on stdin —
// once in each host's shell tool name; its per-session state goes to a temporary TMPDIR per test.
// The command reader is checked on its own too, for tool names that writes.mjs does not list yet.
// Nothing here runs a tool or reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_ROOT } from '../tools/common/paths.mjs';
import { shellSegments } from '../tools/hooks/common.mjs';
import { CONNECTED_HOSTS, classify, curlConfigArgs, isDryRun, plainCommand, signature, urlHost, withoutRedirections } from '../tools/hooks/write-guard.mjs';

const CORE = realpathSync(CORE_ROOT);
const HOOK = join(CORE, 'tools', 'hooks', 'host-hook.mjs');
const SHELLS = ['Bash', 'run_shell_command'];
const made = [];

process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const tempDir = (prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
};

/** An installation-like folder: `oikos` is a symlink to the core. */
const INST = tempDir('oikos-inst-');
symlinkSync(CORE, join(INST, 'oikos'));

/**
 * A guard session: its own state folder and session id; `prompt()` and `shell()` send one event
 * each, `shell(command, cwd)` from another folder; `stateFile` is where the guard keeps its state.
 */
function session(shellTool, cwd = CORE, env = {}) {
  const state = tempDir('oikos-test-');
  const sessionId = `write-guard-test-${process.pid}-${made.length}`;
  const send = (payload) => {
    const r = spawnSync(process.execPath, [HOOK, 'write-guard'], {
      cwd: CORE,
      input: JSON.stringify({ session_id: sessionId, cwd, permission_mode: 'default', ...payload }),
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: state, ...env },
    });
    assert.equal(r.status, 0, r.stderr);
    const answer = r.stdout.trim() ? JSON.parse(r.stdout) : null;
    assert.equal(answer?.systemMessage, undefined, 'the guard must not fail open');
    return answer;
  };
  return {
    prompt: () => send({ hook_event_name: 'UserPromptSubmit', prompt: 'yes' }),
    shell: (command, at = cwd) => send({ hook_event_name: 'PreToolUse', tool_name: shellTool, tool_input: { command }, cwd: at }),
    send,
    stateFile: join(state, 'oikos-hooks', `writes-${sessionId}.json`),
  };
}

const denied = (answer) => answer?.hookSpecificOutput?.permissionDecision === 'deny';
const reason = (answer) => answer?.hookSpecificOutput?.permissionDecisionReason ?? '';

const JIRA = 'node tools/jira/cli.mjs';
const COMMENT = `${JIRA} comment PROJ-123 --text "Done"`;

for (const shellTool of SHELLS) {
  test(`${shellTool}: a jira write without a dry run is denied, naming the tool and command`, () => {
    const answer = session(shellTool).shell(COMMENT);
    assert.ok(denied(answer), JSON.stringify(answer));
    assert.match(reason(answer), /jira comment changes a remote service/);
    assert.match(reason(answer), /--dry-run/);
  });

  test(`${shellTool}: dry run, then a user prompt, then the same command passes once`, () => {
    const s = session(shellTool);
    assert.equal(s.shell(`${COMMENT} --dry-run`), null);
    const early = s.shell(COMMENT);
    assert.ok(denied(early), JSON.stringify(early));
    assert.match(reason(early), /has not been answered yet/);
    s.prompt();
    assert.equal(s.shell(COMMENT), null);
    assert.ok(denied(s.shell(COMMENT)), 'the confirmed dry run is used up by the run');
  });

  test(`${shellTool}: a changed command after the dry run needs a new dry run`, () => {
    const s = session(shellTool);
    s.shell(`${COMMENT} --dry-run`);
    s.prompt();
    assert.ok(denied(s.shell(`${JIRA} comment PROJ-123 --text "Other"`)));
  });

  test(`${shellTool}: a read and the npm form of a read pass; the npm form of a write is denied`, () => {
    const s = session(shellTool);
    assert.equal(s.shell(`${JIRA} task PROJ-123`), null);
    assert.equal(s.shell('node tools/github/cli.mjs repos'), null);
    assert.equal(s.shell('npm run jira -- task PROJ-123'), null);
    assert.ok(denied(s.shell('npm run confluence -- append 12345 --file note.md')));
  });
}

test('from an installation, through its oikos symlink: dry run, prompt, the write once, then used up', () => {
  const s = session('Bash', INST);
  const write = 'node oikos/tools/jira/cli.mjs comment PROJ-1 --text "Done"';
  assert.match(reason(s.shell(write)), /jira comment changes a remote service/);
  assert.equal(s.shell(`${write} --dry-run`), null);
  s.prompt();
  assert.equal(s.shell(write), null);
  assert.ok(denied(s.shell(write)));
});

test('jira project-init and repos add are guarded like any write; jira reads are not', () => {
  const s = session('Bash', INST);
  const init = 'node oikos/tools/jira/cli.mjs project-init PROJ --alias PJ --repo github:acme/web-ui';
  const add = 'node oikos/tools/jira/cli.mjs repos add PROJ github:acme/web-ui';
  assert.match(reason(s.shell(init)), /jira project-init changes a remote service/);
  assert.match(reason(s.shell(add)), /jira repos changes a remote service/);
  assert.equal(s.shell(`${init} --dry-run`), null);
  assert.equal(s.shell(`${add} --dry-run`), null);
  s.prompt();
  assert.equal(s.shell(init), null);
  assert.equal(s.shell(add), null);
  assert.ok(denied(s.shell(`${add} --dry-run; cat oikos.yaml`)), 'a dry run chained with another command is not a dry run of the same command');
  assert.equal(s.shell('node oikos/tools/jira/cli.mjs info --task PROJ-123'), null);
});

test('jira transition of many tasks: the batch dry run pairs with its real command; one dry run unlocks one write', () => {
  const s = session('Bash', INST);
  const move = 'node oikos/tools/jira/cli.mjs transition --task PROJ-7,PROJ-8 --to Done --comment "Checked on staging."';
  assert.match(reason(s.shell(move)), /jira transition changes a remote service/);
  assert.equal(s.shell(`${move} --dry-run`), null);
  s.prompt();
  assert.ok(denied(s.shell(move.replace('PROJ-7,PROJ-8', 'PROJ-7'))), 'a shorter list is another command: it needs its own dry run');
  assert.equal(s.shell(move), null);
  assert.ok(denied(s.shell(move)), 'the confirmed dry run is used up by the run');
});

test('jira transition and project-init: --skip-pr, --brief, --extended and a quoted pattern keep the signature of their dry run', () => {
  const s = session('Bash', INST);
  const writes = [
    'node oikos/tools/jira/cli.mjs transition --task PROJ-7 --to Done --skip-pr https://github.com/acme/web-ui/pull/31 --brief',
    'node oikos/tools/jira/cli.mjs transition --task PROJ-7,PROJ-8 --to Done --extended --skip-pr https://github.com/acme/web-ui/pull/31',
    "node oikos/tools/jira/cli.mjs project-init PROJ --number-pattern 'FIX[{n}]' --epic-role fixes=PROJ-10 --epic-project PLAN",
  ];
  for (const write of writes) {
    const dry = classify(`${write} --dry-run`, INST).call;
    assert.ok(plainCommand(write) && isDryRun(dry), write);
    assert.equal(signature(dry, INST), signature(classify(write, INST).call, INST), write);
    assert.equal(s.shell(`${write} --dry-run`), null, write);
    s.prompt();
    assert.equal(s.shell(write), null, write);
  }
  assert.equal(signature(classify(writes[2], INST).call, INST), signature(classify(writes[2].replace("'FIX[{n}]'", '"FIX[{n}]"'), INST).call, INST),
    'the quotes are the shell\'s: the pattern is the same word');
});

test('jira unlink is guarded like any write', () => {
  const s = session('Bash', INST);
  const unlink = 'node oikos/tools/jira/cli.mjs unlink --id 10234';
  assert.match(reason(s.shell(unlink)), /jira unlink changes a remote service/);
  assert.equal(s.shell(`${unlink} --dry-run`), null);
  s.prompt();
  assert.equal(s.shell(unlink), null);
});

test('jira description is guarded like any write, whatever flag the call carries; info --description is a read', () => {
  const s = session('Bash', INST);
  const cli = 'node oikos/tools/jira/cli.mjs description --task PROJ-123';
  assert.equal(s.shell('node oikos/tools/jira/cli.mjs info --task PROJ-123 --description --adf --out d.json'), null);
  assert.match(reason(s.shell(`${cli} --append --file note.md`)), /jira description changes a remote service/);
  // No flag of the command makes it a read, so no shell spelling of one can slip a write past.
  for (const tail of ['--get', '# --get', '> --get', '`true --get`', '$(true --get)', "$'x\\' --get '", '<<< --get', '-- --get']) {
    assert.ok(denied(s.shell(`${cli} --append --text x ${tail}`)), tail);
  }
  assert.equal(s.shell(`${cli} --append --text x --dry-run`), null);
  s.prompt();
  assert.equal(s.shell(`${cli} --append --text x`), null);
});

const EDIT = `${JIRA} edit PROJ-1 --summary X`;

test('--help exempts only the call it is a real option of', () => {
  const s = session('Bash');
  for (const tail of ['# --help', '-- --help', '<<< --help', '"\\--help"']) assert.ok(denied(s.shell(`${EDIT} ${tail}`)), tail);
  assert.equal(s.shell(`${JIRA} edit --help`), null);
  assert.equal(s.shell(`${JIRA} edit PROJ-1 --help`), null);
  assert.equal(s.shell(`${JIRA} edit PROJ-1 --help | head`), null);
  assert.equal(s.shell(`${JIRA} --help`), null);
});

test('a --dry-run the tool does not receive records nothing', () => {
  const s = session('Bash');
  for (const tail of ['# --dry-run', '-- --dry-run', '"\\--dry-run"', '--dry-run 2>&1', '--dry-run | cat', '--dry-run > out.txt']) {
    assert.ok(denied(s.shell(`${EDIT} ${tail}`)), tail);
  }
  s.prompt();
  assert.match(reason(s.shell(EDIT)), /jira edit changes a remote service/);
});

test('the dry run counts only from the same working folder', () => {
  const s = session('Bash');
  const write = 'node oikos/tools/jira/cli.mjs comment PROJ-1 --text x';
  assert.equal(s.shell(`${write} --dry-run`, INST), null);
  s.prompt();
  const other = tempDir('oikos-other-');
  symlinkSync(CORE, join(other, 'oikos'));
  assert.ok(denied(s.shell(write, other)));
  assert.equal(s.shell(write, INST), null);
});

test('every other spelling of a write call is denied', () => {
  const s = session('Bash');
  const spellings = [
    // The shell's own reading: quoted, escaped, continued, redirected.
    `${JIRA} "comm\\\nent" PROJ-1 --text x --dry-run; true`, `${JIRA} >&2 edit PROJ-1`, `${JIRA} comm* PROJ-1`, `${JIRA} $VERB PROJ-1`,
    // Other folders and paths.
    'cd tools/jira && node cli.mjs edit PROJ-1', 'cd tools/jira; ./cli.mjs edit PROJ-1', 'cd "$D" && node cli.mjs edit PROJ-1',
    'node ./tools/../tools/jira/cli.mjs edit PROJ-1 | cat', 'node tools/j*/cli.mjs edit PROJ-1', 'node "$X/cli.mjs" edit PROJ-1',
    'node -- tools/jira/cli.mjs edit PROJ-1', 'nodejs tools/jira/cli.mjs edit PROJ-1', `exec ${JIRA} edit PROJ-1`, `command -p ${JIRA} edit PROJ-1`,
    // env, wrappers, find, package managers.
    "env -S'node tools/jira/cli.mjs comment PROJ-1 --text x'", "env -S 'node tools/jira/cli.mjs comment PROJ-1'",
    'env --chdi tools/jira node cli.mjs comment PROJ-1', 'env -vC tools/jira node cli.mjs comment PROJ-1', 'env -C tools/jira node cli.mjs edit PROJ-1',
    'find tools/jira -name cli.mjs -execdir node cli.mjs comment PROJ-1 \\;', `timeout 60 ${JIRA} edit PROJ-1`, `xargs ${JIRA} edit`,
    'npm run jira edit PROJ-1 --dry-run', 'npm run jira -- edit PROJ-1 --dry-run', 'npm --prefix . run jira -- comment PROJ-1',
    'npm -w oikos run jira -- comment PROJ-1', 'pnpm -C . jira comment PROJ-1', 'yarn --cwd . jira comment PROJ-1', 'pnpm jira edit PROJ-1',
    'node --run jira -- comment PROJ-1', 'bun --cwd tools/jira cli.mjs comment PROJ-1', `node -r ./x.cjs ${JIRA.slice(5)} comment PROJ-1`,
    `NODE_OPTIONS=--require=./x.cjs ${JIRA} comment PROJ-1`,
    // Code in text.
    `bash -c "${JIRA} edit PROJ-1"`, `echo \`${JIRA} edit PROJ-1\``, `$(${JIRA} edit PROJ-1)`, `echo "${JIRA} edit PROJ-1" | bash`,
    `echo "$(${JIRA} edit PROJ-1)"`, `node -e "import('./tools/jira/cli.mjs')" edit PROJ-1`, `node --import ./tools/jira/cli.mjs x.mjs edit PROJ-1`,
    `python3 -c "import os; os.system('node tools/ji'+'ra/cli.mjs comment P')"`,
    // Readers that can run a command.
    `git -c core.pager="${JIRA} edit PROJ-1" log`, `git config alias.zz '!${JIRA} comment PROJ-1'`, `git config core.fsmonitor '${JIRA} comment PROJ-1'`,
    `sed -n "1e ${JIRA} edit PROJ-1" note.md`, 'rg --pre tools/jira/cli.mjs x edit', `echo "${JIRA} edit X" > x.sh`,
  ];
  for (const command of spellings) assert.ok(denied(s.shell(command)), command);
});

test('a symlink to a tool is the tool', () => {
  const dir = tempDir('oikos-link-');
  symlinkSync(join(CORE, 'tools', 'jira', 'cli.mjs'), join(dir, 'link.mjs'));
  const s = session('Bash', dir);
  assert.match(reason(s.shell('node link.mjs edit PROJ-1')), /jira edit changes a remote service/);
  assert.ok(denied(s.shell('env node link.mjs edit PROJ-1')));
});

test('reads stay free', () => {
  const s = session('Bash');
  const reads = [
    `${JIRA} info --task PROJ-1`, `${JIRA} context PROJ-1 | head`, 'cd tools/jira && node cli.mjs info --task PROJ-1',
    `${JIRA} info --task PROJ-1 > out.json`, `${JIRA} info --task PROJ-1 2>&1 | head -5`,
    'cat tools/jira/cli.mjs', 'grep -n edit tools/jira/cli.mjs', "rg -n 'comment' tools/jira/cli.mjs", 'sed -n 1,40p tools/jira/cli.mjs',
    'git log -p tools/jira/cli.mjs', 'git diff tools/jira/cli.mjs', 'ls tools/*', 'cd tools/jira && grep -c edit cli.mjs',
    'node _aitna/akmon/js/akmon/cli.mjs sync', 'node --test tests/*.test.mjs', 'npm test', 'echo $HOME',
    // A mention in the text of a program that only reads or prints it is harmless.
    `git commit -m "fix ${JIRA} edit"`, `rg "${JIRA} edit" docs`, `echo "${JIRA} edit X"`,
  ];
  for (const command of reads) assert.equal(s.shell(command), null, command);
});

test('a heredoc that names a write call stays denied: its body is read as commands, and `cat > file <<EOF` redirects into a file', () => {
  const s = session('Bash');
  assert.ok(denied(s.shell(`cat <<EOF\n${JIRA} comment P\nEOF`)));
  assert.ok(denied(s.shell(`cat > x.sh <<'EOF'\n${JIRA} comment P\nEOF`)));
});

/**
 * Commands as an agent writes them, from an installation: `allowed` run, `write` is a strict-form
 * write without its dry run, `denied` is anything else the guard refuses, `http` a direct write to
 * a connected service.
 */
const TABLE = {
  allowed: [
    'cd /home/u/workspace/_oikos/acme && ls docs ; head README.md',
    'grep -n -i "oikos" file1 file2',
    "sed -n '179,184p' /home/u/workspace/_oikos/acme/.local/proj-1/notes-jira.md",
    'ls oikos/tools/; for t in jira github gitlab; do node oikos/tools/$t/cli.mjs --help; done',
    'cat /tmp/claude-1000/-home-u-workspace--oikos-acme/x/scratchpad/notes.md',
    'grep -n Review .local/proj-1/{HANDOFF.md,notes-jira.md} | cut -d: -f1 | sort | uniq',
    "F=.local/proj-1/notes-jira.md; sed -n '179,184p;222,226p' $F",
    'ls $P',
    'ls tools/footprint/*',
    'node oikos/tools/jira/cli.mjs search --jql "project = PROJ"',
    'curl -s https://example.atlassian.net/rest/api/3/myself',
    // A loop over the scripts that only reads them; a call of a script that cannot be pinned with a read command.
    'for f in oikos/tools/*/cli.mjs; do grep -c comment $f; done',
    'for t in jira; do node oikos/tools/$t/cli.mjs info --task PROJ-1; done',
    'find oikos/tools -name cli.mjs | sort',
    // Writes elsewhere, and reads of a connected service.
    'curl -X POST https://example.com/hook -d x', 'gh api repos/o/r/issues', 'wget --method=GET https://gitlab.com/api/v4/projects',
    'gh issue create --title x',
    // A GraphQL query reads: its other fields are variables; GET sends fields as query parameters.
    "gh api graphql -f query='query { viewer { login } }'",
    "gh api graphql -F owner=acme -f query='query($owner:String!){ organization(login:$owner){ name } }'",
    'gh api -X GET search/issues -f q=repo:acme/app', "gh api graphql -X POST -f query='{ viewer { login } }'",
    // A special parameter (`$?`) expands to digits, never to a script; a test glob is no cli.mjs.
    'node tools/hooks/leaks.mjs 2>&1 | tail -5; echo "exit=$?"', 'node --test tests/jira-*.test.mjs', 'node --test tests/*.test.mjs',
    // A literal `bash -c` string that only reads is a read.
    'bash -c "ls oikos/tools; head README.md"',
  ],
  write: ['node oikos/tools/jira/cli.mjs comment --task PROJ-1 --text hi'],
  denied: [
    'node oikos/tools/$t/cli.mjs comment --task PROJ-1',
    '"$X/cli.mjs" edit',
    'for t in jira; do node oikos/tools/jira/cli.mjs comment --task PROJ-1 --text x; done',
    // The strict form is the segment as written: a write inside `if` is not a dry run of it.
    'if node oikos/tools/jira/cli.mjs comment --task PROJ-1 --dry-run',
    // A reader's words that a shell then runs, or code in a substitution, are where they may run.
    'echo node oikos/tools/j${X}/cli.mjs comment PROJ-1 | bash', 'echo `node $X/cli.mjs edit PROJ-1`',
    'find oikos/tools -name cli.mjs -exec {} comment PROJ-1 \\;', 'node $F comment PROJ-1', 'node oikos/tools/$t/cli.mjs $VERB',
    // The shell splits an unquoted variable into the script and its command word.
    "CMD='node oikos/tools/jira/cli.mjs comment --task PROJ-1 --text hi'; $CMD",
    "V='oikos/tools/jira/cli.mjs comment PROJ-1'; node $V",
    "for v in 'oikos/tools/jira/cli.mjs comment P'; do node $v; done",
  ],
  http: [
    "curl -X POST https://example.atlassian.net/rest/api/3/issue -d '{}'",
    'curl --data @f.json https://api.github.com/repos/o/r/issues',
    'gh api -X POST repos/o/r/issues -f title=x',
    'wget --post-data=x https://gitlab.com/api/v4/projects/1/issues',
    'curl -sXPUT https://example.atlassian.net/rest/api/3/issue/PROJ-1', 'curl -X POST "$URL"', 'curl --json {} https://slack.com/api/chat.postMessage',
    'timeout 5 curl -T f.txt https://www.googleapis.com/upload/drive/v3/files', 'wget --post-d=x https://gitlab.com/api/v4/x',
    "wget -e 'method=DELETE' https://gitlab.com/api/v4/x", 'gh api repos/o/r/issues --input body.json',
    // A GraphQL mutation, or a query the guard cannot read.
    "gh api graphql -f query='mutation { addComment(input:{}) { clientMutationId } }'",
    'gh api graphql -f query=@q.graphql', 'gh api graphql --input body.json', 'gh api graphql -f query="$Q"',
    "gh api graphql -X PATCH -f query='{ viewer { login } }'", 'gh api -X GET search/issues --input body.json',
  ],
};

test('the command table: reads run, writes need their dry run, the rest and direct HTTP writes are denied', () => {
  const s = session('Bash', INST);
  for (const command of TABLE.allowed) assert.equal(s.shell(command), null, command);
  for (const command of TABLE.write) assert.match(reason(s.shell(command)), /jira comment changes a remote service/, command);
  for (const command of TABLE.denied) {
    const answer = s.shell(command);
    assert.ok(denied(answer) && !/connected service/.test(reason(answer)), command);
  }
  for (const command of TABLE.http) assert.match(reason(s.shell(command)), /direct write to a connected service .* use the oikos tool with --dry-run/, command);
});

test('a write inside bash -c, sh -c or eval is denied: the tool call runs as a standalone command', () => {
  const s = session('Bash', INST);
  const nested = [
    'bash -c "node oikos/tools/jira/cli.mjs comment --task PROJ-1 --text x"',
    "sh -c 'curl -X POST https://example.atlassian.net/rest/api/3/issue -d x'",
    'eval "node oikos/tools/jira/cli.mjs comment --task PROJ-1"',
  ];
  for (const command of nested) assert.match(reason(s.shell(command)), /inside `(?:bash -c|sh -c|eval)` is not run from there\. Run the oikos tool call as a standalone command/, command);
});

test('curl reads its config files as its command line: -K, --config and the curlrc', () => {
  const dir = tempDir('oikos-curl-');
  const post = join(dir, 'post.cfg');
  const silent = join(dir, 'silent.cfg');
  writeFileSync(post, 'request = POST\nurl = "https://example.atlassian.net/rest/api/3/issue"\n');
  writeFileSync(silent, 'silent\n');
  const http = /direct write to a connected service/;
  const s = session('Bash', INST);
  assert.match(reason(s.shell(`curl -K ${post}`)), http);
  assert.match(reason(s.shell(`curl --config ${post}`)), http);
  assert.equal(s.shell(`curl -K ${silent} https://api.github.com/user`), null, 'a config that only sets silent leaves the command line to decide');
  assert.match(reason(s.shell(`curl -K ${silent} -X POST https://api.github.com/repos/o/r/issues`)), http);
  assert.match(reason(s.shell('curl -K - https://api.github.com/user')), http, 'a config from standard input cannot be read');
  const home = tempDir('oikos-curl-home-');
  writeFileSync(join(home, '.curlrc'), 'request = POST\n');
  const rc = session('Bash', INST, { CURL_HOME: home });
  assert.match(reason(rc.shell('curl -s https://api.github.com/user')), http);
  assert.equal(rc.shell('curl -q -s https://api.github.com/user'), null, '-q first: curl does not read the curlrc');
});

test('curlConfigArgs: long names with or without dashes, = : or space, quoted values, comments', () => {
  const text = '# a comment\nrequest = POST\ndata: x\n--json {}\n-X PUT\nurl "https://example.com/a b"\nsilent\n';
  assert.deepEqual(curlConfigArgs(text), ['--request=POST', '--data=x', '--json={}', '-X', 'PUT', '--url=https://example.com/a b', '--silent']);
});

test('a site of the installation\'s settings is a connected host', () => {
  const env = { OIKOS_HOME: tempDir('oikos-none-'), GITLAB_URL: 'https://gitlab.acme.example' };
  assert.match(reason(session('Bash', INST, env).shell('curl -X POST https://gitlab.acme.example/api/v4/projects/1/issues')), /connected service/);
  assert.equal(session('Bash', INST).shell('curl -X POST https://gitlab.acme.example/api/v4/projects/1/issues'), null);
});

test('a write with quoted shell characters in its text runs after its dry run; a quoted --dry-run is text', () => {
  const s = session('Bash', INST);
  for (const comment of ["node oikos/tools/jira/cli.mjs comment PROJ-1 --text 'a; b | c'", 'node oikos/tools/jira/cli.mjs comment PROJ-1 --text "\\$x"']) {
    assert.equal(s.shell(`${comment} --dry-run`), null, comment);
    s.prompt();
    assert.equal(s.shell(comment), null, comment);
  }
  const quoted = 'node oikos/tools/jira/cli.mjs comment PROJ-1 --text "use --dry-run here"';
  assert.match(reason(s.shell(quoted)), /jira comment changes a remote service/);
});

test('a state file of the wrong shape is a fresh state: the guard denies, never fails open', () => {
  for (const content of ['{}', 'null', '[]', '{"prompts":"9","dryRuns":{}}', '{"prompts":9,"dryRuns":[]}', '{"prompts":9,"dryRuns":{"x":"0"}}', 'not json']) {
    const s = session('Bash');
    mkdirSync(join(s.stateFile, '..'), { recursive: true });
    writeFileSync(s.stateFile, content);
    assert.match(reason(s.shell(COMMENT)), /jira comment changes a remote service/, content);
    writeFileSync(s.stateFile, content);
    s.prompt();
    assert.ok(denied(s.shell(COMMENT)), content);
  }
});

test('a payload cwd that is not a string is the process folder', () => {
  const s = session('Bash');
  const answer = s.send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: COMMENT }, cwd: 42 });
  assert.match(reason(answer), /jira comment changes a remote service/);
});

test('a 50k-word command is decided in under 2 s', () => {
  const s = session('Bash');
  const words = Array.from({ length: 50000 }, (_, i) => `w${i}`).join(' ');
  for (const [command, expectDeny] of [[`echo tools/jira/cli.mjs comment ${words}`, false], [`${JIRA} comment ${words}`, true]]) {
    const started = Date.now();
    assert.equal(denied(s.shell(command)), expectDeny);
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  }
});

/** The verdict classify gives `command` from the core, for the tools of `writes`. */
const verdict = (command, writes) => {
  const result = classify(command, CORE, writes);
  return result.call ? `${result.verdict} ${result.call.tool} ${result.call.verb}` : result.verdict;
};

test('classify: a hyphenated tool is matched whole, and a shorter name never takes it', () => {
  const both = { github: ['repos'], 'github-issues': ['create'] };
  assert.equal(verdict('node tools/github-issues/cli.mjs create --repo acme/app', both), 'write github-issues create');
  assert.equal(verdict('node tools/github/cli.mjs repos', both), 'write github repos');
  assert.equal(verdict('node tools/github/cli.mjs repos', { 'github-issues': ['repos'] }), 'free');
  assert.equal(verdict('node tools/github-issues/cli.mjs create', { github: ['create'] }), 'free');
});

test('classify: an expanding path names an unknown tool where it may run; a reader of a tool is free', () => {
  assert.deepEqual(classify('node "$X/cli.mjs" edit PROJ-1', CORE).tools, ['?']);
  assert.equal(classify('node "$X/cli.mjs" edit PROJ-1', CORE).verdict, 'denied');
  assert.deepEqual(classify('node "$X/cli.mjs" --help', CORE), { verdict: 'free', tools: ['?'] });
  assert.equal(verdict('grep -n edit tools/jira/cli.mjs'), 'free');
  assert.equal(verdict('timeout 60 node tools/jira/cli.mjs edit P'), 'denied');
  assert.equal(verdict('timeout 60 node $X/cli.mjs edit P'), 'denied');
  // A tool's name and a path in a reader are not mentions; a package runner's script name is.
  for (const command of ['for t in jira; do echo $t edit; done', 'ls $P', 'grep edit {a,b}.md', 'ls tools/footprint/*']) {
    assert.deepEqual(classify(command, CORE).tools, [], command);
  }
  assert.deepEqual(classify('npm run jira -- edit P', CORE), { verdict: 'denied', tools: ['jira'] });
});

test('classify: a direct HTTP write is denied by its host; the hosts are a parameter', () => {
  const post = 'curl -X POST https://gitlab.acme.example/api/v4/projects/1/issues -d x';
  assert.equal(verdict(post), 'free');
  assert.equal(classify(post, CORE, undefined, [...CONNECTED_HOSTS, 'gitlab.acme.example']).http, 'curl to gitlab.acme.example');
  assert.equal(classify('curl -X POST $U', CORE).http, 'curl to a host the shell expands');
  assert.equal(verdict('curl -X GET https://api.github.com/user'), 'free');
  assert.equal(verdict('gh pr merge 12'), 'free');
  assert.equal(urlHost('https://me:$T@Example.Atlassian.net:443/rest'), 'example.atlassian.net');
});

test('the lexer keeps a backslash in double quotes unless bash drops it', () => {
  const [{ tokens }] = shellSegments('x "\\--help" "\\$a" "a\\\nb" c\\\nd');
  assert.deepEqual(tokens, ['x', '\\--help', '$a', 'ab', 'cd']);
});

test('plainCommand: quoted text is plain; operators, substitutions, globs and comments are not', () => {
  assert.ok(plainCommand("node x.mjs --text 'a; b | c $(d) # e *'"));
  assert.ok(plainCommand('node x.mjs --text "a; b | c" \\$HOME'));
  for (const command of ['a; b', 'a | b', 'a > f', 'a "$X"', 'a `b`', 'a # c', 'a "open', 'a\nb', 'a &', 'a *', 'a ~/x', 'a\r']) {
    assert.ok(!plainCommand(command), JSON.stringify(command));
  }
});

test('withoutRedirections, isDryRun and signature read tokens and the folder, not text', () => {
  assert.equal(withoutRedirections('a 2>&1 b >f <<< "x y" c').replace(/\s+/g, ' '), 'a b c');
  const { call } = classify('node tools/jira/cli.mjs edit P --dry-run -- --dry-run', CORE);
  assert.ok(isDryRun(call));
  assert.equal(signature(call, CORE), JSON.stringify([CORE, 'node', 'tools/jira/cli.mjs', 'edit', 'P', '--', '--dry-run']));
  assert.ok(!isDryRun(classify('node tools/jira/cli.mjs edit P -- --dry-run', CORE).call));
});
