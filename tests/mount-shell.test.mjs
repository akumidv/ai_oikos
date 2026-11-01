// The boundary of an installation in the shell and in the search tools (ADR 0007 D02 and D05, task S4):
// a redirection or a git write into a mount, git's target taken from `-C`, `--git-dir`, `--work-tree`,
// the variables and a `cd` (F15), submodule recursion, `clean -ff` and `-c` as writes, a search whose
// scope lies above the installation and a command that names a path of an installation that is not
// registered (F10). The hooks run as a host runs them (`host-hook.mjs <guard>`, tests/helpers/mounts.mjs)
// from temporary installations (ACME Corp) with real `git init` mounts; nothing here runs git or reaches
// the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { cleanEnv, installation, tempDir } from './helpers/installation.mjs';
import { hook, mounted, repository, write } from './helpers/mounts.mjs';
import { STATE_DIR } from '../tools/hooks/common.mjs';

const stranger = realpathSync(installation((t) => t));
const friend = repository(realpathSync(installation((t) => t))); // a registered mount is a repository (D01)
const { dir, team, dev, own } = mounted({ local: `  ${friend}:\n` });
const parent = dirname(dir);
const plain = realpathSync(tempDir('plain-'));
const outside = realpathSync(repository(tempDir('not-a-mount-')));
mkdirSync(join(dir, 'notes'));
write(join(dir, 'notes', 'a.md'), 'a\n');
symlinkSync(stranger, join(dir, 'link-stranger'), 'dir');
symlinkSync(team, join(dir, 'link-team'), 'dir');
mkdirSync(join(team, 'sub'));
symlinkSync(join(team, 'sub'), join(dir, 'link-team-sub'), 'dir');
write(join(team, 'shared.md'), 'shared\n');
linkSync(join(team, 'shared.md'), join(dir, 'notes', 'shared.md'));

/** The shell guard's answer to `command` run from `cwd`: its reason when denied, else null. */
function shell(command, cwd = dir) {
  const answer = hook(dir, 'git-guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } }).hookSpecificOutput;
  return answer?.permissionDecision === 'deny' ? answer.permissionDecisionReason : null;
}
/** The package guard's answer to a search tool's call from `cwd`. */
function search(toolName, input, cwd = dir) {
  const answer = hook(dir, 'package-guard', { hook_event_name: 'PreToolUse', tool_name: toolName, cwd, tool_input: input }).hookSpecificOutput;
  return answer?.permissionDecision === 'deny' ? answer.permissionDecisionReason : null;
}
/** A file tool's write as the package guard answers it: its reason when denied, else null. */
function edit(toolName, input, cwd = dir) {
  const answer = hook(dir, 'package-guard', { hook_event_name: 'PreToolUse', tool_name: toolName, cwd, tool_input: input }).hookSpecificOutput;
  return answer?.permissionDecision === 'deny' ? answer.permissionDecisionReason : null;
}
const MOUNT = /oikos mount guard: .* writes into the mount `.+` — an installation writes only into itself/;
const SCOPE = /oikos boundary guard: .* would search .*, a folder above this installation/;
const OTHER = /oikos boundary guard: `.+` names a path in another installation/;
const HARD = /oikos boundary guard: .* writes to .*, a file with more than one hard link/;

function assertDenied(commands, pattern, cwd) {
  for (const command of commands) assert.match(shell(command, cwd) ?? '(allowed)', pattern, command);
}
function assertAllowed(commands, cwd) {
  for (const command of commands) assert.equal(shell(command, cwd), null, command);
}

test('a redirection into a mount is denied, inside or outside the installation, whatever way the path is spelled', () => {
  assertDenied([
    `echo x > ${team}/note.md`,
    `echo x >> ${dev}/log`,
    `echo x > vaults/team/note.md`,
    `echo x > ./vaults/team/../team/note.md`,
    `echo x > link-team/note.md`,
    `echo x > "${team}/a note.md"`,
    `echo x 2> ${team}/err`,
    `echo x &> ${team}/both`,
    `echo x > ${own}/note.md`,
    `cat notes/a.md > ${own}/copy.md`,
    `cd vaults/team && echo x > note.md`,
    `cd ${team} && echo x > sub/../note.md`,
    `echo x > ${team}/$NAME`,
    `echo x > ${team}/new-*`,
    `echo x >| ${team}/note.md`,
    `bash -c 'echo x > ${team}/note.md'`,
  ], MOUNT);
});

test('a redirection that writes into the installation, a temporary folder or nowhere, and a read of a mount, pass', () => {
  assertAllowed([
    'echo x > notes/b.md',
    `echo x > ${tempDir('out-')}/b.md`,
    'echo x > /dev/null',
    'node -e 1 2>&1',
    `cat vaults/team/NOTES.md > notes/copy.md`,
    `cat < ${team}/NOTES.md`,
    `cat ${own}/NOTES.md`,
    `cd vaults/team && cat NOTES.md > ../../notes/copy.md`,
    `echo '> ${team}/x' > notes/c.md`,
    'echo x > $OUT',
  ]);
});

test('a path is judged component by component: a link is followed before the next `..` (ADR 0007 D02, F4)', () => {
  assertDenied([
    'echo x > link-team-sub/../note.md',
    'echo x > ./link-team-sub/../../team/note.md',
    'git -C link-team-sub/.. add x',
    'git -C link-team-sub -C .. add x',
    'cd link-team-sub/.. && git add x',
    'git --git-dir=link-team-sub/../.git add x',
  ], MOUNT);
  assertAllowed(['echo x > link-team/../notes/b.md', 'git -C link-team/.. status', 'echo x > notes/../notes/c.md']);
  for (const [name, input] of [
    ['Write', { file_path: `${dir}/link-team-sub/../note.md`, content: 'x' }],
    ['Edit', { file_path: 'link-team-sub/../note.md', old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: 'notes/../link-team-sub/../note.md', edits: [] }],
    ['NotebookEdit', { notebook_path: 'link-team/sub/../x.ipynb' }],
  ]) assert.match(edit(name, input) ?? '(allowed)', /is inside the mount/, `${name} ${JSON.stringify(input)}`);
  for (const [name, input] of [
    ['Write', { file_path: `${dir}/link-team/../notes/b.md`, content: 'x' }],
    ['Edit', { file_path: 'notes/a.md', old_string: 'a', new_string: 'b' }],
  ]) assert.equal(edit(name, input), null, `${name} ${JSON.stringify(input)}`);
});

test('a write to a file with a second name is refused, since the other name may be in a mount (ADR 0007 D02)', () => {
  assertDenied([
    'echo x > notes/shared.md',
    'echo x >> ./notes/shared.md',
    'cd notes && echo x > shared.md',
  ], HARD);
  assertAllowed(['echo x > notes/a.md', 'cat notes/shared.md', 'echo x > notes/new.md']);
  for (const [name, input] of [
    ['Write', { file_path: join(dir, 'notes', 'shared.md'), content: 'x' }],
    ['Edit', { file_path: 'notes/shared.md', old_string: 'a', new_string: 'b' }],
  ]) assert.match(edit(name, input) ?? '(allowed)', HARD, `${name} ${JSON.stringify(input)}`);
  assert.equal(edit('Edit', { file_path: 'notes/a.md', old_string: 'a', new_string: 'b' }), null);
});

test('a git write into a mount is denied; the target comes from -C, --git-dir, --work-tree, the variables and a cd (F15)', () => {
  assertDenied([
    `git -C ${team} commit -m x`,
    `git -C vaults/team add notes.md`,
    `git -C vaults -C team add notes.md`,
    `git -C ${own} checkout -b feature`,
    `git -C ${team} fetch`,
    `git -C ${team} stash`,
    `git -C ${team} tag v1`,
    `git -C ${team} branch feature`,
    `git -C ${team} reset --hard`,
    `git -C ${team} remote add origin x`,
    `git --git-dir=${team}/.git add x`,
    `git --git-dir ${team}/.git --work-tree ${team} commit -m x`,
    `git --work-tree=${team} checkout .`,
    `git --work-tree ${team} --git-dir .git checkout .`,
    `GIT_DIR=${team}/.git git commit -m x`,
    `GIT_WORK_TREE=${team} git checkout .`,
    `GIT_DIR=${team}/.git GIT_WORK_TREE=${team} git add x`,
    `env GIT_DIR=${team}/.git git add x`,
    `export GIT_DIR=${team}/.git; git add x`,
    `GIT_DIR=${team}/.git; git add x`,
    `env -C ${team} git commit -m x`,
    `cd ${team} && git commit -m x`,
    `cd vaults/team && git add x`,
    `cd vaults/team; git rebase main`,
    `cd link-team && git merge x`,
    `git -C link-team add x`,
    `bash -c "git -C ${team} add x"`,
    `git -C ${team} log --output=out.txt`,
    `git -C ${team} frobnicate`,
    `git -C ${team} commit -m x > /dev/null`,
  ], MOUNT);
});

test('a git read of a mount, a git call in the installation itself and in a repository that is no mount pass', () => {
  assertAllowed([
    `git -C ${team} status`,
    `git -C ${team} log --oneline -5`,
    `git -C vaults/team diff HEAD~1`,
    `git -C ${team} show HEAD:NOTES.md`,
    `git -C ${team} ls-files`,
    `git -C ${team} rev-parse HEAD`,
    `git -C ${team} branch`,
    `git -C ${team} branch -a`,
    `git -C ${team} branch --list 'f*'`,
    `git -C ${team} tag -l`,
    `git -C ${team} remote -v`,
    `git -C ${team} config --get user.name`,
    `git -C ${team} config user.name`,
    `git -C ${team} stash list`,
    `git -C ${team} submodule status`,
    `git --git-dir=${team}/.git log`,
    `GIT_DIR=${team}/.git git status`,
    `cd ${team} && git log`,
    'git status',
    'git add notes/a.md',
    'git commit -m x',
    `git -C ${dir} add notes/a.md`,
    `git -C ${outside} commit -m x`,
    `git -C ${outside} clean -ff`,
    `GIT_DIR=${outside}/.git git add x`,
    `git init ${outside}-new`,
  ]);
});

test('a read carrying -c, --config-env or a configuration variable counts as a write into a mount (it can run code)', () => {
  assertDenied([
    `git -C ${team} -c core.fsmonitor=./hook status`,
    `git -C ${team} --config-env=core.fsmonitor=HOOK log`,
    `git -C ${team} --config-env core.fsmonitor=HOOK log`,
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=./hook git -C ${team} status`,
    `GIT_CONFIG_PARAMETERS="'core.fsmonitor=./hook'" git -C ${team} diff`,
  ], MOUNT);
  assertAllowed([`git -c color.ui=never status`, `git -C ${outside} -c core.pager=cat log`]);
});

test('submodule recursion and clean -ff run in the installation write into every inside mount, however they are spelled (F15)', () => {
  assertDenied([
    'git submodule update --init',
    "git submodule foreach 'git pull'",
    'git submodule foreach --recursive git status',
    'git pull --recurse-submodules',
    'git checkout --recurse-submodules main',
    'git fetch --recurse-submodules=on-demand',
    'git -C . reset --hard --recurse-submodules',
    'git clean -ffdx',
    'git clean -ff',
    'git clean -f -f',
    'git clean -fdff',
    'git clean --force --force',
    'git clean -fxdf',
    `git -C ${dir} clean -ffd`,
    `git --git-dir=${dir}/.git --work-tree=${dir} submodule update`,
    `GIT_DIR=${dir}/.git git clean -ff`,
    'git -C notes clean -ff',
    'cd notes && git submodule update',
    `git -C ${dir}/notes pull --recurse-submodules`,
    'git submodule sync && git submodule update',
  ], MOUNT);
  assertAllowed([
    'git clean -fd',
    'git clean -n',
    'git clean -nd',
    'git clean -f',
    'git submodule status',
    'git submodule summary',
    'git pull',
    'git checkout main',
    `git -C ${outside} submodule update`,
    `git -C ${outside} pull --recurse-submodules`,
  ]);
});

test('a search whose scope is above the installation is denied in the shell, whatever the program or the spelling (F10)', () => {
  assertDenied([
    `rg foo ${parent}`,
    `rg foo ${parent}/`,
    `grep -rn foo ${parent}`,
    `grep -R foo ${parent}`,
    `grep --recursive foo ${parent}`,
    `grep -d recurse foo ${parent}`,
    `egrep -r 'a|b' ${parent}`,
    `find ${parent} -name '*.md'`,
    `find -L ${parent} -type f`,
    `fd readme ${parent}`,
    `ag foo ${parent}`,
    `ls -R ${parent}`,
    `ls -lRa ${parent}`,
    `tree ${parent}`,
    'grep -r foo ..',
    'rg foo ../',
    'rg foo notes ..',
    'find / -name x',
    'find .. -name x',
    `rg -e foo ${parent}`,
    `rg -n --glob '*.md' foo ${parent}`,
    `rg foo ${dir}/..`,
    `rg foo ${dir}/notes/../..`,
    `rg foo ${parent}/*`,
    'cd .. && rg foo',
    'cd .. && grep -r foo',
    `cd ${parent} && find . -name x`,
    'cd .. && ls -R',
    `cp -r ${parent} /tmp/copy`,
    `tar cf /tmp/all.tar ${parent}`,
    `bash -c "rg foo ${parent}"`,
  ], SCOPE);
  assertDenied(['cd .. && rg foo'], SCOPE, dir);
  assertDenied(['rg foo', 'grep -r foo', 'find . -name x', 'ls -R', 'fd x'], SCOPE, parent);
});

test('a search inside the installation, in a mount or with a pattern that looks like a path passes', () => {
  assertAllowed([
    'rg foo',
    'rg foo .',
    'rg foo notes',
    'rg foo vaults/team',
    `rg foo ${team} ${own}`,
    `rg -e foo ${dir}`,
    'rg "/" notes',
    'rg ".." notes',
    'grep -rn foo .',
    'grep -r foo notes vaults',
    'grep -r "/" .',
    'grep foo ../outside-file',
    'grep -c foo notes/a.md',
    'find . -name x',
    'find notes -type f',
    `find ${dir} -name x`,
    `find ${own} -name x`,
    'fd a notes',
    'ls',
    'ls ..',
    `ls ${parent}`,
    'ls -la notes',
    'ls -R notes',
    'cd notes && rg foo',
    'cd notes && ls -R',
    'cd .. && cd notes && rg foo',
    'cd .. && ls',
    `cp -r notes ${tempDir('copy-')}`,
    'cat notes/a.md | rg a',
    "echo 'rg foo ..' > notes/note.txt",
  ]);
});

test('the search tools are denied a scope above the installation, by path, by default folder or by an absolute glob (F10)', () => {
  for (const [name, input] of [
    ['Grep', { pattern: 'foo', path: parent }],
    ['Grep', { pattern: 'foo', path: '..' }],
    ['Grep', { pattern: 'foo', path: `${dir}/notes/../..` }],
    ['Grep', { pattern: 'foo', path: '/' }],
    ['Glob', { pattern: '**/*.md', path: parent }],
    ['Glob', { pattern: `${parent}/**/oikos.yaml` }],
    ['Glob', { pattern: `${parent}/*/oikos.yaml`, path: dir }],
    ['grep_search', { pattern: 'foo', path: parent }],
    ['glob', { pattern: '**/*.md', path: parent }],
  ]) assert.match(search(name, input) ?? '(allowed)', SCOPE, `${name} ${JSON.stringify(input)}`);
  assert.match(search('Grep', { pattern: 'foo' }, parent) ?? '(allowed)', SCOPE, 'no path: the session folder is the scope');
  assert.match(search('Glob', { pattern: '**/*.md' }, parent) ?? '(allowed)', SCOPE);
  for (const [name, input] of [
    ['Grep', { pattern: 'foo' }],
    ['Grep', { pattern: 'foo', path: dir }],
    ['Grep', { pattern: 'foo', path: 'notes' }],
    ['Grep', { pattern: 'foo', path: team }],
    ['Grep', { pattern: 'foo', path: own }],
    ['Glob', { pattern: '**/*.md', path: dir }],
    ['Glob', { pattern: `${dir}/**/*.md` }],
    ['Glob', { pattern: '*.md', path: 'vaults/team' }],
    ['Read', { file_path: join(dir, 'notes', 'a.md') }],
    ['Grep', { pattern: 'foo', path: join(dir, 'notes', 'a.md') }],
  ]) assert.equal(search(name, input), null, `${name} ${JSON.stringify(input)}`);
});

test('any command that names a path of an unregistered installation is denied, whatever the program (F10)', () => {
  assertDenied([
    `cat ${stranger}/AGENTS.md`,
    `cat ${stranger}/oikos.yaml | head`,
    `cp ${stranger}/oikos.yaml notes/`,
    `cp notes/a.md ${stranger}/`,
    `mv notes/a.md ${stranger}/a.md`,
    `ln -s ${stranger} notes/link`,
    `ln ${stranger}/oikos.yaml notes/hard`,
    `tar tf ${stranger}/x.tar`,
    `ls ${stranger}`,
    `ls ${stranger}/.local`,
    `cd ${stranger}`,
    `cd ${stranger} && ls`,
    `rg foo ${stranger}`,
    `git -C ${stranger} status`,
    `git --git-dir=${stranger}/.git log`,
    `GIT_DIR=${stranger}/.git git log`,
    `echo x > ${stranger}/f`,
    `node ${stranger}/script.mjs`,
    `bash -c 'cat ${stranger}/x'`,
    `sed -n 1p --file=${stranger}/x.sed`,
    `curl -o ${stranger}/x https://example.com`,
    `FOO=${stranger}/x env`,
    `PATH=$PATH:${stranger}/bin env`,
    `python3 -c "open('${stranger}/x').read()"`,
    `cat ../${stranger.split('/').at(-1)}/oikos.yaml`,
    `cat ${parent}/${stranger.split('/').at(-1)}/oikos.yaml`,
    `cat ${stranger}/../${stranger.split('/').at(-1)}/oikos.yaml`,
    'cat link-stranger/oikos.yaml',
    'ls link-stranger',
    'cat notes/../link-stranger/oikos.yaml',
    `cat ${parent}/*/oikos.yaml`,
    `ls ${parent}/acme-*`,
    `cat ${stranger}/oik*.yaml`,
    `cat ${stranger}/$FILE`,
    `cat '${stranger}/AGENTS.md'`,
    `cat 'a b' ${stranger}/AGENTS.md`,
  ], OTHER);
});

test('a registered linked installation can be read, and still not written (D05, D02)', () => {
  assertAllowed([
    `cat ${friend}/AGENTS.md`,
    `ls ${friend}`,
    `rg foo ${friend}`,
    `cp ${friend}/oikos.yaml notes/`,
    `git -C ${friend} log --oneline`,
    `git -C ${friend} status`,
    `cd ${friend} && ls`,
  ]);
  assertDenied([
    `echo x > ${friend}/f`,
    `cp notes/a.md ${friend}/a.md`.replace('cp notes/a.md', 'echo x >'),
    `git -C ${friend} commit -m x`,
    `git -C ${friend} add x`,
  ], MOUNT);
});

test('the core, an ordinary folder and a path that does not exist are no other installation', () => {
  assertAllowed([
    'cat oikos/OIKOS.md',
    'cat oikos/examples/installation/oikos.yaml',
    'rg foo oikos/skills',
    `ls ${plain}`,
    `cat ${plain}/missing.txt`,
    `cat ${parent}/missing-installation/oikos.yaml`,
    'cat /etc/hostname',
    'ls /tmp',
    'cd ..',
    `ls ${parent}`,
    'cat notes/a.md',
    "echo 'the folder /nowhere/at/all is missing'",
    'node --version',
  ]);
});

test('an installation registered with use is not a linked one: its read is denied like a stranger\'s', () => {
  const { dir: used, team: usedTeam } = mounted({ local: `  ${stranger}:\n    use: [wiki]\n` });
  const answer = hook(used, 'git-guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: used, tool_input: { command: `cat ${stranger}/AGENTS.md` } }).hookSpecificOutput;
  assert.equal(answer?.permissionDecision, 'deny');
  assert.match(answer.permissionDecisionReason, OTHER);
  const ok = hook(used, 'git-guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: used, tool_input: { command: `cat ${usedTeam}/NOTES.md` } }).hookSpecificOutput;
  assert.equal(ok, undefined);
});

test('a long command stays fast (a document written by a heredoc is one)', () => {
  const words = Array.from({ length: 50000 }, (_, i) => (i % 7 === 0 ? `w/${i}` : `w${i}`)).join(' ');
  const started = Date.now();
  assert.equal(shell(`cat > notes/long.md <<'EOF'\n${words}\nEOF`), null);
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
});

// The audit round: wrappers, git pathspecs, leading globs, `~`/`$HOME`/`$PWD`/set variables, quoted
// substitutions, `git grep --no-index`, `@file` and comma-joined values, git's code-running variables.
const fromHome = (path) => relative(homedir(), path);

test('a wrapper does not hide git: timeout, nice, ionice, stdbuf, setsid, flock, taskset, chrt, command, exec, time, env -S, xargs, strace, ltrace, setarch, unshare, prlimit, nsenter, firejail and systemd-run are stripped with their options', () => {
  const git = 'git -C vaults/team commit -m x';
  assertDenied([
    `timeout 30 ${git}`,
    `timeout -s KILL -k 5 30 ${git}`,
    `timeout --signal=KILL 30s ${git}`,
    `nice ${git}`,
    `nice -n 5 ${git}`,
    `nice -10 ${git}`,
    `ionice -c 3 ${git}`,
    `stdbuf -oL ${git}`,
    `stdbuf -o L -e0 ${git}`,
    `setsid ${git}`,
    `flock -n /tmp/lock ${git}`,
    `taskset 1 ${git}`,
    `taskset -c 0-3 ${git}`,
    `chrt -f 10 ${git}`,
    `command ${git}`,
    `command -p ${git}`,
    `exec -a other ${git}`,
    `time -p ${git}`,
    `/usr/bin/time -f %e ${git}`,
    `env -S "${git}"`,
    `env -i -S '${git}'`,
    `env --split-string="${git}"`,
    `env -S 'GIT_TRACE=0 ${git}'`,
    `xargs ${git}`,
    `xargs -n 1 -I {} ${git}`,
    `timeout 5 nice -n 3 env X=1 ${git}`,
    `ls | xargs -0 ${git}`,
    `strace -f ${git}`,
    `strace -f -o /dev/null -e trace=file -s 100 ${git}`,
    `ltrace -f ${git}`,
    `setarch x86_64 ${git}`,
    `setarch x86_64 -R ${git}`,
    `unshare -r ${git}`,
    `unshare -m --propagation private ${git}`,
    `prlimit --nofile=100 ${git}`,
    `nsenter -t 1 -m ${git}`,
    `firejail --net=none ${git}`,
    `systemd-run --user -p MemoryMax=1G ${git}`,
    `strace -f setarch x86_64 unshare -r ${git}`,
  ], MOUNT);
  assertDenied(['timeout 5 bash -c "echo x > vaults/team/n.md"', 'nice sh -c "git -C vaults/team commit -m x"'], MOUNT);
});

test('a wrapped command that is no write, and a wrapper with nothing to run, pass', () => {
  assertAllowed([
    'timeout 5 npm test',
    'nice rg x',
    'nice -n 5 git status',
    'timeout 30 git -C vaults/team log',
    'xargs -n 1 echo',
    'command -v git',
    'timeout 5',
    'nice',
    'env -S "git status"',
    'strace -f git status',
    'strace -o /dev/null ls',
    'setarch x86_64 git status',
    'unshare -r git log',
    'prlimit --nofile=100 git -C vaults/team log',
    'git log --oneline -3',
    'git status',
    'echo "$(date)"',
  ]);
});

test('a git write that names a path in a mount is denied (git rm, mv, checkout, add), and so is rm or mv of a folder that holds one', () => {
  assertDenied([
    'git rm -r vaults/team',
    'git rm -r vaults/team/shared.md',
    'git mv vaults/team vaults/team2',
    'git mv notes/a.md vaults/team/a.md',
    'git checkout -- vaults/team/shared.md',
    'git restore vaults/team/shared.md',
    'git add vaults/team/shared.md',
    'git commit vaults/team/shared.md -m x',
    'git -C vaults rm -r team',
    'git -C vaults add team/shared.md',
    'git add ":(top)vaults/team/shared.md"',
    'git add :/vaults/team/shared.md',
    `git rm -r ${team}`,
    'git rm -r .',
    'git rm -r --force .',
    'git mv . moved',
    'git rm -r projects',
    'git submodule deinit -f vaults/team',
    'git submodule absorbgitdirs',
    'git submodule sync',
    'git submodule set-url vaults/team https://example.com/x.git',
    'cd vaults && git rm -r team',
  ], MOUNT);
});

test('a git write that names nothing in a mount, and a read of a mount, pass', () => {
  assertAllowed([
    'git rm notes/a.md',
    'git rm -r notes',
    'git rm -r --cached .',
    'git mv notes/a.md notes/c.md',
    'git add notes/a.md',
    'git restore notes/a.md',
    'git checkout -- notes/a.md',
    'git checkout main',
    'git commit -m "update vaults notes"',
    'git commit -m vaults',
    'git push origin team',
    'git branch team',
    'git status vaults/team',
    'git log -- vaults/team',
    'git diff vaults/team',
    'git -C vaults/team log',
    'git submodule status',
    'git rm -r new-*',
  ]);
});

test('a word that starts with a glob is judged by the folder it is read from', () => {
  assertDenied([`cd ${parent} && cat */oikos.yaml`, `cd ${parent} && cat ?*/AGENTS.md`, `cd ${parent} && cat {a,b}/x`, 'cd .. && cat */oikos.yaml'], OTHER);
  assertDenied([`cd ${parent} && rg foo *`], SCOPE);
  assertDenied(['cd vaults/team && echo x > *.md', 'cd vaults/team && echo x > {a,b}.md'], MOUNT);
  assertAllowed(['cat */a.md', 'ls *.md', 'rg foo *', 'echo x > *.log', `cd ${parent} && [ -f x ]`, `cd ${parent} && [[ -f x ]]`]);
});

test('~, $HOME, ${HOME}, $PWD and a variable the command sets are read in cd targets, redirections and git targets', () => {
  const homeToTeam = fromHome(team);
  assertDenied([
    `echo x > $HOME/${homeToTeam}/n.md`,
    `echo x > \${HOME}/${homeToTeam}/n.md`,
    `echo x > "$HOME/${homeToTeam}/n.md"`,
    `echo x > $PWD/vaults/team/n.md`,
    `cd $HOME/${fromHome(dir)} && echo x > vaults/team/n.md`,
    `cd $PWD/vaults/team && echo x > n.md`,
    `cd ~/${fromHome(dir)}/vaults/team && echo x > n.md`,
    `V=vaults/team; echo x > $V/n.md`,
    `V=vaults/team; echo x > \${V}/n.md`,
    `export V=vaults; echo x > $V/team/n.md`,
    `V=$HOME/${homeToTeam}; echo x > $V/n.md`,
    `V=${team}; W=$V/sub; echo x > $W/n.md`,
    `V=vaults/team; git -C $V commit -m x`,
    `V=vaults; git -C $V/team commit -m x`,
    `V=vaults/team; cd $V && echo x > n.md`,
    `git -C $HOME/${homeToTeam} commit -m x`,
    `git -C $PWD/vaults/team commit -m x`,
    `V=vaults/team; git add $V/shared.md`,
    `V=notes; V=vaults/team; echo x > $V/n.md`,
  ], MOUNT);
  assertDenied([`cd ~ && cat ${fromHome(stranger)}/oikos.yaml`, `cat $HOME/${fromHome(stranger)}/oikos.yaml`, `V=${stranger}; cat $V/oikos.yaml`], OTHER);
  assertAllowed([
    'V=notes; echo x > $V/b.md',
    'V=notes; git -C $V status',
    'echo x > $UNSET/x',
    'git -C $UNSET commit -m x',
    'cd $UNSET && echo x > y',
    'echo x > $HOME/.oikos-test-never-written',
    'echo x > $PWD/notes/b.md',
    'cd ~ && ls',
    `V=${team}; cat $V/shared.md`,
  ]);
});

test('a redirection, git call or path inside a substitution in double quotes is judged as a command of its own', () => {
  assertDenied([
    'echo "$(echo x > vaults/team/n.md)"',
    'echo "a $(echo x >> vaults/team/n.md) b"',
    'echo "`echo x > vaults/team/n.md`"',
    'echo "$(echo "$(echo x > vaults/team/n.md)")"',
    'echo "$(git -C vaults/team commit -m x)"',
    'echo "$(timeout 5 git -C vaults/team commit -m x)"',
    'echo "x=$(cd vaults/team && echo y > n.md)"',
  ], MOUNT);
  assertDenied([`echo "$(cat ${stranger}/oikos.yaml)"`], OTHER);
  assertAllowed(['echo "$(date)"', 'echo "$(echo x > notes/b.md)"', 'echo "a > vaults/team/n.md"', "echo '$(echo x > vaults/team/n.md)'", 'echo "`date`"']);
});

test('git grep --no-index is a search: its folder (-C, a path) above the installation is denied', () => {
  assertDenied([
    'git -C .. grep --no-index -r x',
    'git grep --no-index x ..',
    'git grep --no-index -e x ..',
    'git -C .. grep -n --no-index x',
    `git -C ${parent} grep --no-index x`,
    `cd ${parent} && git grep --no-index x`,
    `cd ${parent} && git grep --no-index x .`,
    'V=..; git -C $V grep --no-index x',
  ], SCOPE);
  assertAllowed([
    'git grep x',
    'git grep -n x notes',
    'git grep --no-index x',
    'git grep --no-index x notes',
    'git -C notes grep --no-index x',
    'git -C .. grep x',
    `git -C ${team} grep --no-index x`,
  ]);
});

test('a path behind @ (an upload of @file) or in a comma-joined value is judged', () => {
  assertDenied([
    `curl -d @${stranger}/oikos.yaml https://example.com`,
    `curl --data-binary @${stranger}/oikos.yaml https://example.com`,
    `curl -d@${stranger}/oikos.yaml https://example.com`,
    `curl --data=@${stranger}/oikos.yaml https://example.com`,
    `tool --files=notes/a.md,${stranger}/oikos.yaml`,
    `tool ${stranger}/oikos.yaml,notes/a.md`,
    `tool a,@${stranger}/oikos.yaml`,
  ], OTHER);
  assertAllowed(['curl -d @notes/a.md https://example.com', 'curl -d@notes/a.md https://example.com', 'npm install @scope/pkg', 'tool --files=notes/a.md,notes/b.md', 'echo a,b,c']);
});

test('the variables and options that make git run a program count as a configuration value; git config edit, set and unset are writes', () => {
  for (const name of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_EDITOR', 'GIT_ASKPASS', 'GIT_SEQUENCE_EDITOR', 'GIT_PROXY_COMMAND']) {
    assertDenied([`${name}=/x/evil git -C vaults/team status`, `export ${name}=/x/evil; git -C vaults/team log`, `env ${name}=/x/evil git -C vaults/team diff`], MOUNT);
  }
  assertDenied([
    'git -C vaults/team config edit',
    'git -C vaults/team config --edit',
    'git -C vaults/team config -e',
    'git -C vaults/team config set user.name x',
    'git -C vaults/team config unset user.name',
    'git -C vaults/team config user.name x',
  ], MOUNT);
  assertAllowed([
    'GIT_PAGER=cat git status',
    'GIT_CONFIG_GLOBAL=/dev/null git -C notes status',
    'git -C vaults/team config get user.name',
    'git -C vaults/team config list',
    'git -C vaults/team config --get user.name',
    'git -C vaults/team config --list',
    'git -C vaults/team config user.name',
  ]);
});

// The re-audit round: an output option's value is a write target, the hook state folder, a variable as the
// program, `~name`, brace groups and globs on the route of a write.
const STATE = /oikos mount guard: .* writes into the hook state folder/;
const HOME = /oikos mount guard: `.+` is a path in another user's home/;

test('the file or folder a git call is told to write to (--output, -o, --output-directory, config --file) is judged like a redirection target', () => {
  assertDenied([
    'git diff --output=vaults/team/n.md',
    'git log -1 --output=vaults/team/n.md',
    'git show --output vaults/team/n.md HEAD',
    'git format-patch --output-directory=vaults/team -1',
    'git format-patch --output-directory vaults/team -1',
    'git format-patch -ovaults/team -1',
    'git format-patch -o vaults/team -1',
    'git format-patch -o vaults -1',
    'git archive --output=vaults/team/x.tar HEAD',
    'git archive --output vaults/team/x.tar HEAD',
    'git archive -o vaults/team/x.tar HEAD',
    'git archive -ovaults/team/x.tar HEAD',
    'git -C notes diff --output=../vaults/team/n.md',
    'git diff --output=link-team/n.md',
    `git diff --output=${own}/n.md`,
    `git diff --output=$HOME/${fromHome(team)}/n.md`,
    'git config --file vaults/team/x.cfg user.name x',
    'git config -f vaults/team/x.cfg --add a.b c',
    'git checkout-index --prefix=vaults/team/ -a',
    'git init --separate-git-dir=vaults/team/g notes-new',
    'git diff --output=vau*/team/n.md',
    'V=vaults/team; git diff --output=$V/n.md',
    `git diff --output=${STATE_DIR}/writes-x.json`,
  ], new RegExp(`${MOUNT.source}|${STATE.source}`));
  assertAllowed([
    'git diff --output=out.md',
    'git log -1 --output=notes/out.md',
    'git format-patch -o patches -1',
    'git format-patch -o notes -1',
    'git archive --output=notes/x.tar HEAD',
    'git archive --prefix=vaults/team/ -o notes/x.tar HEAD',
    'git archive --prefix=vaults/team/ HEAD',
    'git config --file notes/x.cfg --get a.b',
    'git config --file notes/x.cfg a.b c',
    'git diff --output-indicator-new=+ HEAD',
    'git -C vaults/team diff HEAD',
    'git diff --output=*.log',
    'git commit -o notes/a.md -m x',
  ]);
});

test('a redirection or a git output into the hook state folder is denied, whatever way the folder is spelled (it would forge a dry run)', () => {
  mkdirSync(STATE_DIR, { recursive: true });
  symlinkSync(tmpdir(), join(dir, 'link-tmp'), 'dir');
  const state = join(STATE_DIR, 'writes-x.json');
  assertDenied([
    `echo '{}' > ${state}`,
    `echo '{}' >> ${state}`,
    `echo '{}' 2> ${state}`,
    `echo '{}' > $TMPDIR/oikos-hooks/writes-x.json`,
    `echo '{}' > "$TMPDIR/oikos-hooks/writes-x.json"`,
    `echo '{}' > \${TMPDIR}/oikos-hooks/writes-x.json`,
    `echo '{}' > ${tmpdir()}/../${tmpdir().split('/').pop()}/oikos-hooks/writes-x.json`,
    `echo '{}' > ${tmpdir()}/./oikos-hooks/../oikos-hooks/writes-x.json`,
    `echo '{}' > link-tmp/oikos-hooks/writes-x.json`,
    `echo '{}' > ${STATE_DIR}/writes-*.json`,
    `echo '{}' > ${tmpdir()}/oikos-h*/writes-x.json`,
    `echo '{}' > ${tmpdir()}/{x,oikos-hooks}/writes-x.json`,
    `cd ${STATE_DIR} && echo '{}' > writes-x.json`,
    `D=${STATE_DIR}; echo '{}' > $D/writes-x.json`,
    `bash -c "echo '{}' > ${state}"`,
    `git diff --output=$TMPDIR/oikos-hooks/writes-x.json`,
    `git format-patch -o link-tmp/oikos-hooks -1`,
  ], STATE);
  assertAllowed([
    `echo x > ${tmpdir()}/oikos-hooks-not/writes-x.json`,
    `echo x > $TMPDIR/other-file.json`,
    `echo x > ${tmpdir()}/oikos-test-never-read.json`,
    `cat ${state}`,
    `cat $TMPDIR/oikos-hooks/writes-x.json`,
    `TMPDIR=notes; echo x > $TMPDIR/oikos-hooks/writes-x.json`,
  ]);
});

test('a variable the command sets stands for the program too: `G=git; $G -C vaults/team commit`', () => {
  assertDenied([
    'G=git; $G -C vaults/team commit -m x',
    'G=git; ${G} -C vaults/team commit -m x',
    'G=git; export H=1; $G -C vaults/team commit -m x',
    "G='git -C vaults/team'; $G commit -m x",
    'G="timeout 5 git"; $G -C vaults/team commit -m x',
    'G=env; $G git -C vaults/team commit -m x',
    'G=git; timeout 5 $G -C vaults/team commit -m x',
    'G=ls; G=git; $G -C vaults/team commit -m x',
    'S=bash; $S -c "echo x > vaults/team/n.md"',
  ], MOUNT);
  assertDenied(['S=grep; $S -r foo ..', 'S=rg; $S foo ..'], SCOPE);
  assertAllowed(['G=git; $G status', 'G=git; $G -C vaults/team log', 'G=ls; $G -C vaults/team', '$G -C vaults/team commit -m x', 'G=echo; $G hi']);
});

test('a word that starts with `~name` is denied as unjudgeable, the file guard\'s rule: where a path stands for sure and as `~name/…` anywhere', () => {
  assertDenied([
    'cat ~root/x',
    'echo x > ~root/n.md',
    'echo x > ~root',
    'echo x >> ~someone/n.md',
    'cd ~root && ls',
    'cd ~someone',
    'git -C ~root commit -m x',
    'git --git-dir=~root/.git add x',
    'git --work-tree ~root add x',
    'cat {~root,x}/y',
    'cat {x,~root/y}',
    'V=~root/x; cat $V',
    'V=~root; cd $V',
    'tool --file=~root/x',
    'tool a,~root/x',
    'ls ~root/..',
    `echo x > ~${homedir().split('/').pop()}/n.md`,
  ], HOME);
  assertAllowed([
    'cat ~/x',
    'echo x > ~/.oikos-test-never-written',
    'cd ~ && ls',
    'cd ~/',
    'git commit -m "~fix the thing"',
    'echo ~',
    'echo ~root',
    'cat notes/~backup',
  ]);
});

test('a brace group is expanded before a word is judged: `{..,.}/other/f`, `{notes,vaults/team}/n.md`', () => {
  const ours = relative(dir, stranger);
  assertDenied([`cat {${ours},x}/oikos.yaml`, `cat {x,${ours}}/oikos.yaml`, `cat {a,{${ours},b}}/oikos.yaml`, `cat {${stranger},x}/oikos.yaml`, `cd ${parent} && cat {${relative(parent, stranger)},x}/oikos.yaml`], OTHER);
  assertDenied(['echo x > {notes,vaults/team}/n.md', 'echo x > {vaults,x}/team/n.md', 'echo x > vaults/{a,team}/n.md', 'git -C {notes,vaults/team} commit -m x', 'git rm -r {notes,vaults/team}', 'echo x > {x,}{vaults,y}/team/n.md'], MOUNT);
  assertAllowed(['echo x > notes/{a,b}.md', 'echo x > {notes,notes}/b.md', 'cat {a,b}.md', 'git -C {notes,notes} status', 'echo ${HOME}', 'echo {a}', 'echo {}']);
});

test('a glob on the route of a write is expanded against the file system: it is the mount it may name (L-e)', () => {
  assertDenied([
    'echo x > vau*/team/n.md',
    'echo x > v[a]ults/team/n.md',
    'echo x > v?ults/team/n.md',
    'echo x > v[!b]ults/team/n.md',
    'echo x > */team/n.md',
    'echo x > **/team/n.md',
    'echo x > vaults/t*/n.md',
    'echo x > vaults/*/n.md',
    'echo x > link-te*/n.md',
    'echo x > link-t?am/n.md',
    `echo x > ${join(dirname(own), 'own-v*')}/n.md`,
    'cd vaults && echo x > t*/n.md',
    'git -C vaults/te* commit -m x',
    'git -C v?ults/team commit -m x',
    "git -C 'proj*/dev-root' commit -m x",
    'git -C link-te* add x',
    'git --git-dir=v*/team/.git add x',
    'git --work-tree=v*/team add x',
    "git rm -r 'vau*/te*'",
    "git rm -r 'vault*'",
    'git rm -r vau*',
    'git rm -r v?ults/team',
    'git add vaul*/team/shared.md',
    'git add "vaults/t*"',
    'git checkout -- v*/team/shared.md',
    'V=vau*; echo x > $V/team/n.md',
    'echo x > VAU*/team/n.md',
  ], MOUNT);
  assertAllowed([
    'echo x > not-here-*/n.md',
    'echo x > *.log',
    'echo x > new-*',
    'echo x > notes/*.md',
    'echo x > no*/b.md',
    'echo x > vaults-*/n.md',
    'git add notes/*.md',
    'git rm -r new-*',
    "git rm -r 'no*'",
    'git add no*/a.md',
    'git -C no* status',
    'git -C no* add a.md',
    'git -C vaults/te* log',
    'git commit -m "vau* is a glob"',
    'ls vau*/t*',
  ]);
});

// Audit 5: braces the guard cannot expand fail closed, one budget per command, git's abbreviated options,
// wrappers with attached values, quoted text that is no expansion, and a glob over the installation's own files.
test('a brace the guard cannot expand in full is judged as every mount below its folder (sequences, past the cap)', () => {
  const commas = ','.repeat(70);
  assertDenied([
    'echo x > va{u..u}lts/team/n.md',
    'echo x > {a..z}aults/team/n.md',
    'echo x > {1..3}{a..z}{a..z}/team/n.md',
    'echo x > {v..v}aults/team/n.md',
    `echo x > ${'{a,b}'.repeat(8)}vaults/team/n.md`,
    `echo x > {${commas}vaults}/team/n.md`,
    `echo x > {${commas}vaults/team}/n.md`,
    'echo x > vaults/{1..100000}/n.md',
    'git -C {1..3}{a..z}{a..z}vaults/team commit -m x',
  ], MOUNT);
  assertAllowed(['echo x > notes/{1..3}.md', 'echo x > notes/{a..c}{1,2}.md', 'echo x > {01..03}.log', 'git -C notes status {1..3}']);
});

test('a command is judged within a budget of its own, not one per word: 1 MB of braces and globs is read in a couple of seconds', () => {
  const brace = `echo x > ${Array.from({ length: 40000 }, () => '{a,b}').join('/')}`;
  const unclosed = `echo x > ${'{'.repeat(1000000)}`;
  const globs = `echo ${Array.from({ length: 40000 }, (_, i) => `*/*/*/x${i}*`).join(' ')}`;
  const wide = `cat ${'{x,'.repeat(250000)}`;
  for (const [what, command] of Object.entries({ brace, unclosed, globs, wide })) {
    const started = Date.now();
    spawnSync(process.execPath, [join(dir, 'oikos', 'tools', 'hooks', 'host-hook.mjs'), 'git-guard'], {
      cwd: dir, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: dir, tool_input: { command } }), encoding: 'utf8', maxBuffer: 1 << 28, env: cleanEnv({ CLAUDE_PROJECT_DIR: dir }),
    });
    const spent = Date.now() - started;
    console.log(`# ${what}: ${command.length} chars judged in ${spent} ms (hook process included)`);
    assert.ok(spent < 5000, `${what}: ${spent} ms`);
  }
  assertDenied([`echo x > ${'a'.repeat(5000)}{b,c}/vaults/team/n.md`, `echo x > ${'a'.repeat(5000)}*/team/n.md`], MOUNT);
});

test('git takes an unambiguous prefix of the long options it parses itself: --fil, --sep, --pre are the options they stand for', () => {
  assertDenied([
    'git config --fil vaults/team/x.cfg core.hooksPath /tmp',
    'git config --file=vaults/team/x.cfg a.b c',
    'git config --fi=vaults/team/x.cfg a.b c',
    'git init --sep=vaults/team/g notes-new',
    'git init --separate vaults/team/g notes-new',
    'git clone --sep vaults/team/g notes notes-copy',
    'git checkout-index -a --pre=vaults/team/',
    'git checkout-index -a --pre vaults/team/',
    'git checkout-index -a --pr=vaults/',
    'git fast-export --export-marks=vaults/team/m HEAD',
    'git fast-export --export-marks vaults/team/m HEAD',
  ], MOUNT);
  assertAllowed([
    'git config --fil notes/x.cfg a.b c',
    'git init --sep=notes/g notes-new',
    'git checkout-index -a --pre=notes/',
    'git diff --out=vaults/team/n.md HEAD',
    'git format-patch --output-d=vaults/team -1',
    'git fast-export --export-m=vaults/team/m HEAD',
  ]);
});

test('a wrapper with a short option and its value attached is read: strace -fo, ltrace -o, eatmydata, fakeroot, faketime, valgrind', () => {
  const git = 'git -C vaults/team commit -m x';
  assertDenied([
    `strace -fo /dev/null ${git}`,
    `strace -ofile ${git}`,
    `ltrace -fo /dev/null ${git}`,
    `strace -qqfo /dev/null -e trace=file ${git}`,
    `eatmydata ${git}`,
    `fakeroot ${git}`,
    `fakeroot -- ${git}`,
    `faketime '2020-01-01 00:00:00' ${git}`,
    `faketime -f +1d ${git}`,
    `valgrind ${git}`,
    `valgrind -q --tool=none ${git}`,
  ], MOUNT);
  assertAllowed(['echo git -C vaults/team commit', 'echo eatmydata git -C vaults/team commit', 'strace -fo /dev/null ls', 'valgrind ls']);
});

test('~name and a brace group in quotes or in a heredoc body are text, not an expansion', () => {
  assertAllowed([
    'echo "about ~2/3 of cases" >> notes/n.md',
    'git commit -m "speed up ~2/3"',
    'git commit -m "see ~bob/notes"',
    "git commit -m 'see ~bob/notes'",
    'git commit -m "move {../other,x}"',
    "cat > notes/n.md <<'EOF'\nabout ~2/3 and ~bob/x and {../other,x}\nEOF",
    'cat > notes/n.md <<EOF\nabout ~2/3 and ~bob/x and {../other,x}\nEOF',
  ]);
  assertDenied(['echo ~bob/x', 'cat {~bob,x}/y', 'echo a=~bob/x', 'echo "x" ~bob/y'], HOME);
  assertDenied([`cat {${relative(dir, stranger)},x}/oikos.yaml`], OTHER);
});

test('the target of cd and pushd is expanded like any unquoted word: braces, sequences, globs; one the guard cannot expand fails closed', () => {
  const commas = ','.repeat(70);
  assertDenied([
    'cd vaults/te{a..a}m && git commit -m x',
    'cd vaults/t* && git commit -m x',
    'cd v*/team && git commit -m x',
    'pushd vaults/t* && git commit -m x',
    'cd vaults/{a,team} && git commit -m x',
    `cd vaults/{${commas}team}; git commit -m x`,
    'cd vaults/{1..3}{a..z}{a..z}; git commit -m x',
    'G=gi; ${G}t -C vaults/team commit -m x',
    'G=gi; ${G}t -C vaults/team commit -m x',
  ], MOUNT);
  assertAllowed([
    'cd notes && git commit -m x',
    'cd "{a,vaults/team}" ; git commit -m x',
    'cd n* && git commit -m x',
    'cd notes/{a,b} && git status',
    'G=gi; ${G}t -C notes commit -m x',
  ]);
});

test('a glob in git checkout, git restore or git rm --cached over the installation itself is no write into a mount; the mount as the repository is still one', () => {
  assertAllowed(['git checkout -- *', 'git restore *', 'git restore --staged *', 'git rm --cached *', 'git rm -r --cached *', 'git checkout -- t*'], join(dir, 'vaults'));
  assertAllowed(['git restore vau*', 'git checkout -- v*', 'git checkout -- no*', 'git rm --cached no*']);
  assertDenied([
    'git -C vaults/team checkout -- *',
    'git -C vaults/te* restore *',
    'git --work-tree=vaults/team checkout -- *',
    'git checkout -- vaults/team/shared.md',
    'git checkout -- v*/team/shared.md',
    'git rm -r *',
    'git rm -r vau*',
    'git mv * x',
    'git checkout -- */*',
  ], MOUNT);
  assertDenied(['git add t*', 'git rm -r t*', 'git mv t* x'], MOUNT, join(dir, 'vaults'));
});

test('CDPATH, an assigned HOME, `function name { … }` and a nested command reach a mount like the plain cd (audit 6, D-AUDIT6-CD)', () => {
  const vaults = join(dir, 'vaults');
  assertDenied([
    `CDPATH=${vaults}; cd team && git commit -m x`,
    `export CDPATH=${vaults}; cd team; git commit -m x`,
    `CDPATH=${vaults} cd team; git commit -m x`,
    `CDPATH=/nowhere:${vaults}; cd team; git commit -m x`,
    `CDPATH=${vaults}; cd te*; git commit -m x`,
    'CDPATH=$UNSET_DIR; cd team; git commit -m x',
    `HOME=${team}; cd; git commit -m x`,
    `HOME=${team}; cd ~; git commit -m x`,
    `HOME=${vaults}; cd ~/team; git commit -m x`,
    'function f { cd vaults/team; }; f; git commit -m x',
    'function f() { cd vaults/team; }; f; git commit -m x',
    'cd vaults/team; bash -c "git commit -m x"',
    'cd vaults/team; sh -c "git commit -m x"',
    'cd vaults/team; find . -maxdepth 0 -exec git commit -m x \\;',
    'cd vaults/team; find . -maxdepth 0 -execdir git commit -m x +',
    'cd vaults/team; echo x | xargs git commit -m',
  ], MOUNT);
  assertAllowed([
    `CDPATH=/tmp; cd ${plain}; git commit -m x`,
    `CDPATH=${vaults}; cd ./notes; git commit -m x`,
    `CDPATH=${vaults}; cd ${plain}; git commit -m x`,
    `CDPATH=${vaults}; cd nothing; git commit -m x`,
    `HOME=${plain}; cd; git commit -m x`,
    'cd vaults/team; bash -c "git status"',
    'cd vaults/team; find . -maxdepth 0 -exec git log \\;',
    'function f { cd notes; }; f; git commit -m x',
  ]);
});

// Audit 6b (D-AUDIT6B-SHELL-MODEL): the shell guard guards against mistakes and the obvious forms, not a boundary — a program read
// from a file (`sh script.sh`) is an accepted residual; the cheap forms below are closed.
const OUTSIDE = plain; // a folder with no mount: only what the command reaches decides
const VAULTS = join(dir, 'vaults');
const nested = (inner, levels) => (levels === 0 ? inner : nested(`bash -c ${JSON.stringify(inner)}`, levels - 1));

test('a shell with no -c: a here-string is its command; a pipe, -s, /dev/stdin or <(…) is a script nobody can see, so a git write or a redirect in that command is denied (H1)', () => {
  assertDenied([
    `bash <<< "cd ${team}; git commit -m x"`,
    `bash <<< "git -C ${team} commit -m x"`,
    `sh <<< 'echo x > ${team}/n.md'`,
    `cd ${team}; bash <<< "git commit -m x"`,
    'echo "cd vaults/team" | bash; git commit -m x',
    `echo "cd ${team}" | sh; git commit -m x`,
    'echo x | bash -s; git commit -m x',
    'echo x | bash /dev/stdin; git commit -m x',
    'bash <(echo x); git commit -m x',
    `cd ${team}; echo x | bash; git commit -m x`,
    'echo x | bash > out.md',
  ], MOUNT, OUTSIDE);
  assertAllowed([
    'bash <<< "echo hi"',
    `cd ${team}; bash <<< "git status"`,
    'echo x | bash',
    'echo x | bash -s',
    'echo "cd vaults/team; echo hi" | sh',
    'bash <(echo x)',
    'sh script.sh',
    'bash ./run.sh --flag',
    'bash < script.sh',
    'bash <<EOF\necho hi\nEOF',
    `echo x | bash > ${OUTSIDE}/out.md`,
  ], OUTSIDE);
});

test('`bash -c -- "…"`, `sh -c -- "…"`: the command is the first word after -c that is no `--` and no option (H2)', () => {
  assertDenied([
    `bash -c -- "git -C ${team} commit -m x"`,
    `sh -c -- 'git -C ${team} commit -m x'`,
    `bash -c -e "git -C ${team} commit -m x"`,
    `bash -lc -- "git -C ${team} commit -m x"`,
  ], MOUNT, OUTSIDE);
  assertAllowed(['bash -c -- "git status"', 'sh -c -- "echo hi"'], OUTSIDE);
});

test('a command nested deeper than the guard reads is denied when it holds a command inside (H3); three levels are read', () => {
  const git = `git -C ${team} commit -m x`;
  assertDenied([nested(git, 1), nested(git, 3)], MOUNT, OUTSIDE);
  assertDenied([nested('git status', 4), nested('echo hi', 5), `bash -c ${JSON.stringify(nested('echo hi', 3))}`], /more than 3 levels deep/, OUTSIDE);
  assertAllowed([nested('git status', 3), nested('echo hi', 2)], OUTSIDE);
});

test('the folder a cd leads to is a set: a glob, a brace group, CDPATH and each assigned HOME all stay, and a later relative cd is read from each (M1)', () => {
  assertDenied([
    `cd ${dir}/[n]otes; cd ../vaults/team; git commit -m x`,
    `cd ${dir}/{notes,projects}; cd ../vaults/team; git commit -m x`,
    `CDPATH=${dir}; cd notes; cd ../vaults/team; git commit -m x`,
    `export CDPATH=:${dir}; cd notes; cd ../vaults/team; git commit -m x`,
    `HOME=${dir}; cd; cd vaults/team; git commit -m x`,
    `export HOME=${dir}; cd; cd vaults/team; git commit -m x`,
    `HOME=${dir}; pushd ~; pushd vaults/team; git commit -m x`,
    `HOME=${dir}; cd ~/notes; cd ../vaults/team; git commit -m x`,
  ], MOUNT, OUTSIDE);
  assertAllowed([
    `cd ${dir}/[n]otes; cd ..; git commit -m x`,
    `CDPATH=${dir}; cd notes; git commit -m x`,
    `HOME=${OUTSIDE}; cd; git commit -m x`,
  ], OUTSIDE);
});

test('the command inside a shell gets the variables and the wide folders of the one around it (M2)', () => {
  assertDenied([
    `CDPATH=${VAULTS} bash -c "cd team; git commit -m x"`,
    `export CDPATH=${VAULTS}; bash -c "cd team; git commit -m x"`,
    `env CDPATH=${VAULTS} bash -c "cd team; git commit -m x"`,
    `HOME=${team} bash -c "cd; git commit -m x"`,
    `export HOME=${team}; sh -c "cd && git commit -m x"`,
    `shopt -s nullglob; cd ${dir}/{a..z}{a..z}?lt; bash -c "git commit -m x"`,
    `shopt -s nullglob; cd ${dir}/{a..z}{a..z}?lt; find . -maxdepth 0 -exec git commit -m x \\;`,
  ], MOUNT, OUTSIDE);
  assertAllowed([
    `CDPATH=${VAULTS} bash -c "cd ${OUTSIDE}; git commit -m x"`,
    `CDPATH=${OUTSIDE} bash -c "cd notes; git status"`,
  ], OUTSIDE);
});

test('find -execdir, and an -exec that is given the match ({} or $1), run below every path find starts from (M3)', () => {
  assertDenied([
    `find ${team} -maxdepth 1 -iname inbox -execdir git commit -m x \\;`,
    `find ${team} -maxdepth 0 -exec sh -c "cd {} && git commit -m x" \\;`,
    `find ${team} -maxdepth 0 -exec sh -c 'cd "$1" && git commit -m x' _ {} \\;`,
    `find ${team} -maxdepth 0 -exec sh -c 'cd "$@" && git commit -m x' _ {} +`,
    `find ${VAULTS} -name inbox -okdir git commit -m x \\;`,
  ], MOUNT, OUTSIDE);
  assertAllowed([
    "find . -name '*.md' -exec grep -l x {} +",
    `find ${team} -name '*.md' -exec grep -l x {} +`,
    `find ${team} -name '*.md' -execdir git log \\;`,
    `find ${OUTSIDE} -maxdepth 0 -exec sh -c 'cd "$1" && git commit -m x' _ {} \\;`,
    `cd ${team}; find . -maxdepth 0 -exec git log \\;`,
  ], OUTSIDE);
});

test('NAME+= makes a variable one the guard cannot tell; ~ in an assigned value is read with the assigned HOME (M4)', () => {
  assertDenied([
    `CDPATH=/nowhere; CDPATH+=:${VAULTS}; cd team; git commit -m x`,
    `CDPATH+=:${VAULTS}; cd team; git commit -m x`,
    `export CDPATH+=:${VAULTS}; cd team; git commit -m x`,
    `HOME=${dir}; CDPATH=~/vaults; cd team; git commit -m x`,
    `HOME=${dir}; export CDPATH=~/vaults; cd team; git commit -m x`,
    `HOME=${dir}; T=~/vaults/team; git -C $T commit -m x`,
  ], MOUNT, OUTSIDE);
  assertAllowed([`HOME=${OUTSIDE}; CDPATH=~; cd notes; git commit -m x`], OUTSIDE);
});

test('script -c, watch, busybox sh -c, fish -c run the command they are given (L1)', () => {
  assertDenied([
    'cd vaults/team; script -qc "git commit -m x" /dev/null',
    'cd vaults/team; script -c "git commit -m x" /dev/null',
    'cd vaults/team; script --command="git commit -m x" /dev/null',
    'cd vaults/team; watch -n1 git commit -m x',
    'cd vaults/team; watch git commit -m x',
    'cd vaults/team; busybox sh -c "git commit -m x"',
    'cd vaults/team; fish -c "git commit -m x"',
    'cd vaults/team; csh -c "git commit -m x"',
  ], MOUNT);
  assertAllowed(['cd vaults/team; watch -n1 git status', 'cd vaults/team; script -qc "git status" /dev/null', 'cd vaults/team; fish -c "git log"']);
});

test('a command of thousands of cd, globs and shells is decided in seconds, and what is past the budget is denied (L3)', () => {
  const started = Date.now();
  assertDenied([
    `${'cd vaults/*; '.repeat(3000)}git commit -m x`,
    `${`CDPATH=${dir}; cd note*; `.repeat(3000)}cd ../vaults/team; git commit -m x`,
    `${'cd {notes,vaults/team}; bash -c "git status"; '.repeat(1500)}git commit -m x`,
    Array.from({ length: 300 }, (_, i) => `bash -c "echo ${i}"`).join('; '),
  ], /mount|more commands inside other commands/);
  assert.ok(Date.now() - started < 20000, `decided in ${Date.now() - started} ms`);
  assertAllowed([`${'bash -c "echo hi"; '.repeat(100)}git status`], OUTSIDE);
});
