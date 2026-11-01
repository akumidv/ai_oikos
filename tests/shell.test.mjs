// Pins the shell-parsing layer of tools/hooks/shell.mjs as it is now: how a command is segmented,
// which folders its `cd`s reach, where its redirections point, and what its syntax adds. Works only
// in a temporary folder.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellSegments } from '../tools/hooks/common.mjs';
import { realOf } from '../tools/common/paths.mjs';
import { assignedVars, dirsAlong, gitCalls, gitPlaces, gitPlacesAll, plainCommand, plainText, quotedSubstitutions, real, redirectionTargets, shellSyntax, workingDirs, withoutRedirections, withVariables } from '../tools/hooks/shell.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'shell-test-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
mkdirSync(join(ROOT, 'a', 'b'), { recursive: true });

/** The command with its redirections removed and its whitespace collapsed. */
const bare = (command) => withoutRedirections(command).replace(/\s+/g, ' ').trim();

test('shellSegments: quotes keep `&&` and spaces inside a word; `&&` splits the commands', () => {
  assert.deepEqual(shellSegments('echo "a && b" && git push').map((s) => s.tokens), [['echo', 'a && b'], ['git', 'push']]);
  assert.deepEqual(shellSegments("echo 'x;y' && cd 'a b'").map((s) => s.tokens), [['echo', 'x;y'], ['cd', 'a b']]);
});

test('workingDirs: each literal cd is taken from the one before; an expanding, missing or empty target is unknown', () => {
  const chained = workingDirs(shellSegments('cd a && cd b'), ROOT);
  assert.equal(chained.unknown, false);
  assert.ok(chained.dirs.includes(ROOT));
  assert.ok(chained.dirs.includes(join(ROOT, 'a')));
  assert.ok(chained.dirs.includes(join(ROOT, 'a', 'b')));
  assert.equal(workingDirs(shellSegments('cd $DIR'), ROOT).unknown, true);
  assert.equal(workingDirs(shellSegments('cd missing'), ROOT).unknown, true);
  assert.equal(workingDirs(shellSegments('cd'), ROOT).unknown, true);
});

test('withoutRedirections: `>` and `>>` take their target off; `2>&1` is no file; quoted `>` is text', () => {
  assert.equal(bare('node x.mjs > out.txt'), 'node x.mjs');
  assert.equal(bare('node x.mjs >> log.txt'), 'node x.mjs');
  assert.equal(bare('node x.mjs 2>&1'), 'node x.mjs');
  assert.equal(bare('echo "a > b" 2>&1'), 'echo "a > b"');
  assert.equal(bare("echo 'a >> b'"), "echo 'a >> b'");
  assert.equal(bare('cat > $OUT'), 'cat $OUT');
});

test('shellSyntax and plainCommand: one plain command has no syntax; operators, substitutions, globs and comments add some', () => {
  assert.equal(plainCommand('node tools/x/cli.mjs list --all'), true);
  assert.equal(plainCommand("node x.mjs --text 'a; b | c $(d) *'"), true);
  assert.equal(plainCommand('echo "x" \\$HOME'), true);
  assert.equal(plainCommand('a#b'), true);
  assert.ok(shellSyntax('a; b').has('chaining'));
  assert.ok(shellSyntax('a > f').has('file redirection'));
  assert.ok(shellSyntax('a 2>&1').has('redirection'));
  assert.ok(!shellSyntax('a 2>&1').has('file redirection'));
  assert.deepEqual([...shellSyntax('a > /dev/null')], ['redirection']);
  assert.ok(shellSyntax('echo $(date)').has('command substitution'));
  assert.ok(shellSyntax('echo $HOME').has('substitution'));
  assert.ok(!shellSyntax('echo $HOME').has('command substitution'));
  assert.ok(shellSyntax('ls *.md').has('expansion'));
  assert.ok(shellSyntax('ls # note').has('comment'));
  assert.ok(shellSyntax('echo "a').has('unclosed quote'));
  assert.equal(plainCommand('a; b'), false);
  assert.equal(plainCommand('a > f'), false);
});

test('plainText: backslash-newlines, backslashes and quotes are removed as the shell joins them', () => {
  assert.equal(plainText('node "tools/x/cli.mjs" \'a\''), 'node tools/x/cli.mjs a');
  assert.equal(plainText('a\\\nb'), 'ab');
  assert.equal(plainText('echo \\"x\\"'), 'echo x');
});

test('real: the real path of an existing file or folder, symlinks resolved; null when it does not exist', () => {
  const folder = join(ROOT, 'a');
  const link = join(ROOT, 'link-to-a');
  symlinkSync(folder, link);
  assert.equal(real(folder), realpathSync(folder));
  assert.equal(real(link), realpathSync(folder));
  assert.equal(real(join(ROOT, 'missing')), null);
});

test('dirsAlong: each segment gets the folders before its own cd, and `now` the folder every earlier cd led to', () => {
  const segments = shellSegments('rg x && cd a && rg y && cd b && rg z');
  const { along, now, dirs } = dirsAlong(segments, ROOT);
  assert.deepEqual(along[0], [ROOT]);
  assert.deepEqual(along[2], [ROOT, join(ROOT, 'a')]);
  assert.deepEqual(now, [ROOT, ROOT, join(ROOT, 'a'), join(ROOT, 'a'), join(ROOT, 'a', 'b')]);
  assert.deepEqual(dirs, along[4].slice(0, dirs.length));
  assert.ok(dirs.includes(join(ROOT, 'a', 'b')));
});

test('redirectionTargets: the files a command writes — `>`, `>>`, `>|`, `&>`, `<>`, `>&file`; reads, descriptors and quoted `>` are none', () => {
  const targets = (command) => redirectionTargets(command).map((r) => r.target);
  assert.deepEqual(targets('a > f1 >> f2 2> f3 &> f4 >| f5 <> f6'), ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
  assert.deepEqual(targets('a >&2 2>&1 >&- <in <<EOF <<<"x"'), []);
  assert.deepEqual(targets('a >&out.txt'), ['out.txt']);
  assert.deepEqual(targets('echo "a > b" \'c > d\''), []);
  assert.deepEqual(targets('a > "x y/z" > \'q\''), ['x y/z', 'q']);
  assert.deepEqual(targets('a > $OUT > dir/$NAME > dir/*.md'), ['$OUT', 'dir/$NAME', 'dir/*.md']);
  assert.deepEqual(targets('a >(b)'), []);
  assert.deepEqual(targets('a > /dev/null'), ['/dev/null']);
});

/** The git calls of a command, in order. */
const gitOf = (command) => [...gitCalls(shellSegments(command)).values()];

test('gitCall: the subcommand past git\'s own options, and the folder, git directory, work tree and configuration it is given', () => {
  assert.deepEqual(gitOf('git -C a -C b --git-dir=g --work-tree w -c x=y --no-pager commit -m msg')[0],
    { sub: 'commit', rest: ['-m', 'msg'], chdirs: ['a', 'b'], gitDir: 'g', workTree: 'w', configured: true });
  assert.deepEqual(gitOf('git status')[0], { sub: 'status', rest: [], chdirs: [], gitDir: null, workTree: null, configured: false });
  assert.equal(gitOf('git --config-env=a=B log')[0].configured, true);
  assert.equal(gitOf('git --config-env a=B log')[0].sub, 'log');
  assert.equal(gitOf('git log -C -c')[0].configured, false, 'after the subcommand -c and -C are its own');
  assert.equal(gitOf('git')[0].sub, undefined);
});

test('gitCalls: GIT_DIR and GIT_WORK_TREE come from the command, from env and from an earlier export or assignment', () => {
  assert.equal(gitOf('GIT_DIR=a git log')[0].gitDir, 'a');
  assert.equal(gitOf('env GIT_WORK_TREE=w git log')[0].workTree, 'w');
  assert.equal(gitOf('env -C d git log')[0].chdirs[0], 'd');
  assert.equal(gitOf('export GIT_DIR=a && git log')[0].gitDir, 'a');
  assert.equal(gitOf('GIT_DIR=a; git log')[0].gitDir, 'a');
  assert.equal(gitOf('git log; GIT_DIR=a')[0].gitDir, null, 'a variable set after the call is not its');
  assert.equal(gitOf('GIT_CONFIG_COUNT=1 git log')[0].configured, true);
  assert.equal(gitOf('echo a | git log').length, 1);
});

test('gitPlaces: the work tree and git directory a call works in from a folder, `-C` taken one after the other; null when a word cannot be told', () => {
  const here = realpathSync(ROOT);
  const places = (command, dir = ROOT) => gitPlaces(gitOf(command)[0], dir);
  assert.deepEqual(places('git status'), { workTree: here, gitDir: null });
  assert.deepEqual(places('git -C a -C b status'), { workTree: join(here, 'a', 'b'), gitDir: null });
  assert.deepEqual(places('git -C /x --git-dir=.git --work-tree=w status'), { workTree: '/x/w', gitDir: '/x/.git' });
  assert.deepEqual(places('git --git-dir /g/.git status', '/start'), { workTree: '/start', gitDir: '/g/.git' });
  assert.equal(places('git -C $DIR status'), null);
  assert.equal(places('git -C ~other status'), null);
  assert.equal(places('git --work-tree=`pwd` status'), null);
  assert.equal(places('git -C ~/x status').workTree, realOf(join(homedir(), 'x')));
});

test('gitPlaces: a `-C` follows a link before the next `..` (ADR 0007 D02)', () => {
  const here = realpathSync(ROOT);
  symlinkSync(join(ROOT, 'a', 'b'), join(ROOT, 'link-to-b'), 'dir');
  assert.deepEqual(gitPlaces(gitOf('git -C link-to-b/.. status')[0], ROOT), { workTree: join(here, 'a'), gitDir: null });
  assert.deepEqual(gitPlaces(gitOf('git -C link-to-b -C .. status')[0], ROOT), { workTree: join(here, 'a'), gitDir: null });
});

test('shellSegments: a wrapper and its options are stripped, so `exe` is the program it runs', () => {
  const exeOf = (command) => shellSegments(command)[0].exe;
  const argsOf = (command) => shellSegments(command)[0].args;
  for (const command of [
    'timeout 30 git push', 'timeout -s KILL -k 5 30 git push', 'timeout --signal KILL --foreground 30 git push', 'nice git push', 'nice -n 5 git push', 'nice -5 git push',
    'ionice -c 2 -n 7 git push', 'stdbuf -oL -e0 git push', 'stdbuf -o L git push', 'setsid -w git push', 'flock -n /tmp/x git push', 'flock -w 5 /tmp/x git push',
    'taskset 0x3 git push', 'taskset -c 0,1 git push', 'chrt -f 10 git push', 'command git push', 'command -p git push', 'exec -a x git push', 'time -p git push',
    'time -f %e git push', '/usr/bin/timeout 5 /usr/bin/git push', 'nohup git push', 'builtin command git push', 'xargs git push', 'xargs -0 -n 1 git push',
    'xargs -I {} -P 4 git push', 'timeout 5 nice -n 3 env X=1 GIT_DIR=y git push', 'X=1 timeout 5 git push', 'env -- git push', 'env -S "git push"',
    "env -S 'git push'", 'env -i -S "X=1 git push"', 'env --split-string="git push"', 'env -Sgit\\ push', 'env -S "env -S \\"git push\\""',
  ]) {
    assert.equal(exeOf(command), 'git', command);
    assert.deepEqual(argsOf(command), ['push'], command);
  }
  assert.equal(shellSegments('env -S "git push"')[0].viaEnv, true);
  assert.deepEqual(shellSegments('env -S "git -C a push"')[0].tokens, ['env', 'git', '-C', 'a', 'push'], 'the words of -S replace it in the tokens');
  assert.equal(shellSegments('timeout 30 git -C a push')[0].tokens.length, 6, 'the tokens stay as written otherwise');
});

test('shellSegments: a wrapper with nothing after it runs nothing, and `command -v` runs nothing', () => {
  assert.equal(shellSegments('timeout 5')[0].exe, null);
  assert.equal(shellSegments('nice')[0].exe, null);
  assert.equal(shellSegments('nice -n 5')[0].exe, null);
  assert.equal(shellSegments('command -v git')[0].exe, 'command');
  assert.equal(shellSegments('xargs')[0].exe, null);
  assert.equal(shellSegments('timeout 5 npm test')[0].exe, 'npm');
  assert.equal(shellSegments('nice rg x')[0].exe, 'rg');
  assert.equal(shellSegments('timeoutx 5 git status')[0].exe, 'timeoutx');
});

test('assignedVars and withVariables: HOME, PWD and the variables a command sets, every value, read again for a value that names a variable', () => {
  const vars = assignedVars(shellSegments('V=a; export W=~/w X=$V/x; V=b; Y=1 git log; declare Z=z; echo U=no'));
  assert.deepEqual(vars.get('V'), ['a', 'b']);
  assert.deepEqual(vars.get('W'), [join(homedir(), 'w')]);
  assert.deepEqual(vars.get('X'), ['$V/x']);
  assert.equal(vars.get('Y'), undefined, 'a variable given to one program is not set for the rest');
  assert.deepEqual(vars.get('Z'), ['z']);
  assert.equal(vars.get('U'), undefined);
  assert.deepEqual(withVariables('$X/y', vars, '/p'), ['a/x/y', 'b/x/y']);
  assert.deepEqual(withVariables('${V}/x', vars, '/p'), ['a/x', 'b/x']);
  assert.deepEqual(withVariables('$HOME/x:${PWD}/y', vars, '/p'), [`${homedir()}/x:/p/y`]);
  assert.deepEqual(withVariables('$NOPE/x', vars, '/p'), ['$NOPE/x'], 'a variable with no value stays as written');
  assert.deepEqual(withVariables('${HOME:-x}', vars, '/p'), ['${HOME:-x}']);
  assert.deepEqual(withVariables('plain', vars, '/p'), ['plain']);
  assert.ok(withVariables('$A', assignedVars(shellSegments('A=$A/x')), '/p').length >= 1, 'a value that names itself ends');
});

test('dirsAlong: a cd to ~, $HOME, $PWD or a variable the command sets is followed; a target with an unset variable or a glob is unknown', () => {
  const { dirs } = dirsAlong(shellSegments('cd a && cd $PWD/b && cd ~ && cd ${HOME}/x'), ROOT);
  assert.ok(dirs.includes(join(ROOT, 'a', 'b')), '$PWD is the folder the earlier cd led to');
  assert.ok(dirs.includes(homedir()));
  assert.ok(dirs.includes(join(homedir(), 'x')));
  const set = dirsAlong(shellSegments('D=a/b; cd $D'), ROOT);
  assert.equal(set.unknown, false);
  assert.ok(set.dirs.includes(join(ROOT, 'a', 'b')));
  assert.equal(dirsAlong(shellSegments('cd $UNSET'), ROOT).unknown, true);
  assert.equal(dirsAlong(shellSegments('cd a*'), ROOT).unknown, true);
  assert.equal(dirsAlong(shellSegments('cd ~someone'), ROOT).unknown, true);
});

test('gitPlacesAll: one place for each value of a variable in -C, --git-dir and --work-tree, with the folder the pathspecs are read from', () => {
  const here = realpathSync(ROOT);
  const segments = shellSegments('D=a; D=a/b; git -C $D --git-dir=g status');
  const call = [...gitCalls(segments).values()][0];
  assert.deepEqual(gitPlacesAll(call, ROOT, assignedVars(segments)), [
    { workTree: join(here, 'a'), gitDir: join(here, 'a', 'g'), base: join(here, 'a') },
    { workTree: join(here, 'a', 'b'), gitDir: join(here, 'a', 'b', 'g'), base: join(here, 'a', 'b') },
  ]);
  assert.deepEqual(gitPlaces(call, ROOT, assignedVars(segments)), { workTree: join(here, 'a'), gitDir: join(here, 'a', 'g') });
  assert.deepEqual(gitPlacesAll(gitOf('git -C $UNSET status')[0], ROOT), []);
  assert.equal(gitPlaces(gitOf('git -C $UNSET status')[0], ROOT), null);
});

test('gitCall: the variables that name a configuration file or a program for git count as a configuration value', () => {
  for (const name of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_ASKPASS', 'GIT_PROXY_COMMAND']) {
    assert.equal(gitOf(`${name}=x git log`)[0].configured, true, name);
    assert.equal(gitOf(`export ${name}=x; git log`)[0].configured, true, name);
  }
  assert.equal(gitOf('GIT_DIR=x GIT_TRACE=1 git log')[0].configured, false);
});

test('quotedSubstitutions: the commands inside $(…) and backticks in double quotes, nested ones too; none outside quotes or in single quotes', () => {
  assert.deepEqual(quotedSubstitutions('echo "$(echo x > f)"'), ['echo x > f']);
  assert.deepEqual(quotedSubstitutions('echo "a $(b) c `d` e"'), ['b', 'd']);
  assert.deepEqual(quotedSubstitutions('echo "$(echo "$(inner)" (x))"'), ['echo "$(inner)" (x)']);
  assert.deepEqual(quotedSubstitutions('echo $(a) `b`'), []);
  assert.deepEqual(quotedSubstitutions("echo '$(a)' \"\\$(b)\""), []);
  assert.deepEqual(quotedSubstitutions('echo "$(unclosed'), ['unclosed']);
  assert.deepEqual(quotedSubstitutions('echo plain'), []);
  assert.deepEqual(redirectionTargets('echo "$(echo x > f1)" > f2').map((r) => r.target), ['f2', 'f1']);
  assert.ok(redirectionTargets('echo "$(echo "`echo x > f1`")"').some((r) => r.target === 'f1'), 'a backtick inside a substitution inside quotes');
});
