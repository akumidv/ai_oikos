// How a guard judges a target path (ADR 0007 D02, the re-audit's F4): resolved component by component
// with each link followed before the next `..` (realOf), contained by the identity of the folders above
// it (inside) and not by the spelling, a file with a second name refused, a case variant of a closed
// file the same file (sameFile). Works only in temporary folders.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idOf, realOf, sameFile } from '../tools/common/paths.mjs';
import { hardLinked, inside } from '../tools/hooks/boundary.mjs';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'real-path-')));
after(() => rmSync(ROOT, { recursive: true, force: true }));
mkdirSync(join(ROOT, 'a', 'deep'), { recursive: true });
mkdirSync(join(ROOT, 'b'));
writeFileSync(join(ROOT, 'a', 'file.txt'), 'x');
symlinkSync(join(ROOT, 'a', 'deep'), join(ROOT, 'link-deep'), 'dir');
symlinkSync('a/deep', join(ROOT, 'rel-deep'), 'dir');
symlinkSync(join(ROOT, 'a', 'file.txt'), join(ROOT, 'link-file'));
symlinkSync(join(ROOT, 'a', 'nothing-yet.txt'), join(ROOT, 'dangling'));
symlinkSync('loop-b', join(ROOT, 'loop-a'));
symlinkSync('loop-a', join(ROOT, 'loop-b'));

test('realOf follows each link before the next `..`: `link/..` is the parent of what the link leads to', () => {
  assert.equal(realOf(`${ROOT}/link-deep/..`), join(ROOT, 'a'));
  assert.equal(realOf(`${ROOT}/link-deep/../file.txt`), join(ROOT, 'a', 'file.txt'));
  assert.equal(realOf(`${ROOT}/rel-deep/../../b`), join(ROOT, 'b'), 'a relative link is read from the folder that holds it');
  assert.equal(realOf(`${ROOT}/link-deep/../../b/../a`), join(ROOT, 'a'));
  assert.equal(realOf(`${ROOT}/a/./deep/`), join(ROOT, 'a', 'deep'));
});

test('realOf follows the last component too, a link to a file and a dangling one (the file it would create)', () => {
  assert.equal(realOf(join(ROOT, 'link-file')), join(ROOT, 'a', 'file.txt'));
  assert.equal(realOf(join(ROOT, 'dangling')), join(ROOT, 'a', 'nothing-yet.txt'));
  assert.equal(realOf(join(ROOT, 'link-deep')), join(ROOT, 'a', 'deep'));
});

test('realOf puts what does not exist yet on the nearest folder that does, `.` and `..` applied to it as written', () => {
  assert.equal(realOf(`${ROOT}/link-deep/new/file.md`), join(ROOT, 'a', 'deep', 'new', 'file.md'));
  assert.equal(realOf(`${ROOT}/link-deep/new/../other.md`), join(ROOT, 'a', 'deep', 'other.md'));
  assert.equal(realOf(`${ROOT}/a/file.txt/under`), join(ROOT, 'a', 'file.txt', 'under'), 'below a file');
  assert.equal(realOf('/'), '/');
});

test('realOf takes a relative path from `from` (the working folder by default), a link loop as it stands', () => {
  assert.equal(realOf('link-deep/..', ROOT), join(ROOT, 'a'));
  assert.equal(realOf('.', join(ROOT, 'rel-deep')), join(ROOT, 'a', 'deep'));
  assert.equal(realOf('a'), join(realpathSync(process.cwd()), 'a'));
  assert.equal(typeof realOf(join(ROOT, 'loop-a')), 'string', 'a loop does not hang or throw');
  assert.equal(realOf(`${ROOT}/a\0b`).startsWith(ROOT), true, 'a NUL in a name does not throw');
});

test('idOf is one string for one file however it is reached, null for what is not there', () => {
  assert.equal(idOf(join(ROOT, 'link-deep')), idOf(join(ROOT, 'a', 'deep')));
  assert.notEqual(idOf(join(ROOT, 'a')), idOf(join(ROOT, 'b')));
  assert.equal(idOf(join(ROOT, 'missing')), null);
});

test('inside judges by the identity of the folders above a path, so another spelling of a folder is the folder', () => {
  const boundary = { ids: new Map() };
  const deep = join(ROOT, 'a', 'deep');
  assert.equal(inside(join(deep, 'x', 'y'), deep, idOf(deep), boundary), true, 'by the string');
  assert.equal(inside(join(ROOT, 'link-deep', 'x'), deep, idOf(deep), boundary), true, 'by the identity: the link is the folder');
  assert.equal(inside(join(ROOT, 'link-deep'), deep, idOf(deep), boundary), true);
  assert.equal(inside(join(ROOT, 'a', 'file.txt'), deep, idOf(deep), boundary), false);
  assert.equal(inside(join(ROOT, 'b', 'x'), deep, idOf(deep), boundary), false);
  assert.equal(inside(join(ROOT, 'link-deep', 'x'), deep, null, boundary), false, 'a root with no identity is judged by the string alone');
});

test('sameFile: one real path, or one folder and one name up to case; not a name in another folder', () => {
  const file = join(ROOT, 'a', 'file.txt');
  assert.equal(sameFile(file, file), true);
  assert.equal(sameFile(file, join(ROOT, 'a', 'File.TXT')), true, 'a case variant, as on a file system that folds case');
  assert.equal(sameFile(file, join(ROOT, 'b', 'file.txt')), false);
  assert.equal(sameFile(file, join(ROOT, 'a', 'other.txt')), false);
});

test('hardLinked: a file with a second name, not a file with one, a folder, a link or a missing path', () => {
  writeFileSync(join(ROOT, 'one.txt'), 'x');
  linkSync(join(ROOT, 'one.txt'), join(ROOT, 'two.txt'));
  assert.equal(hardLinked(join(ROOT, 'one.txt')), true);
  assert.equal(hardLinked(join(ROOT, 'two.txt')), true);
  assert.equal(hardLinked(join(ROOT, 'a', 'file.txt')), false);
  assert.equal(hardLinked(join(ROOT, 'a')), false);
  assert.equal(hardLinked(join(ROOT, 'missing')), false);
});
