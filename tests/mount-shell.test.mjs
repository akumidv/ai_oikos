// The boundary of an installation in the shell and in the search tools (ADR 0007 D02 and D05, task S4):
// a redirection or a git write into a mount, git's target taken from `-C`, `--git-dir`, `--work-tree`,
// the variables and a `cd` (F15), submodule recursion, `clean -ff` and `-c` as writes, a search whose
// scope lies above the installation and a command that names a path of an installation that is not
// registered (F10). The hooks run as a host runs them (`host-hook.mjs <guard>`, tests/helpers/mounts.mjs)
// from temporary installations (ACME Corp) with real `git init` mounts; nothing here runs git or reaches
// the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { installation, tempDir } from './helpers/installation.mjs';
import { hook, mounted, repository, write } from './helpers/mounts.mjs';

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

test('a wrapper does not hide git: timeout, nice, ionice, stdbuf, setsid, flock, taskset, chrt, command, exec, time, env -S and xargs are stripped with their options', () => {
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
