// Pins the shell-parsing layer of tools/hooks/shell.mjs as it is now: how a command is segmented,
// which folders its `cd`s reach, where its redirections point, and what its syntax adds. Works only
// in a temporary folder.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellSegments } from '../tools/hooks/common.mjs';
import { plainCommand, plainText, real, shellSyntax, workingDirs, withoutRedirections } from '../tools/hooks/shell.mjs';

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
