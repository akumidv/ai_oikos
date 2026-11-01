// The one spelling of a plain lowercase name (tools/common/slug.mjs): a catalog id, a handoff slug,
// a mount's skill prefix. Nothing here touches the disk or the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLUG, slugify } from '../tools/common/slug.mjs';

test('SLUG: lowercase latin letters, digits and -, starting with a letter or digit', () => {
  for (const ok of ['a', '0', 'acme-corp', 'dev-2', 'a--b']) assert.ok(SLUG.test(ok), ok);
  for (const bad of ['', '-dev', 'Dev', 'dev_x', 'dev x', '../x', 'dev.x', 'é']) assert.ok(!SLUG.test(bad), bad);
});

test('slugify: lowercased, every run of other characters one -, none at the ends, empty when nothing is left', () => {
  assert.equal(slugify('Ops_Kit'), 'ops-kit');
  assert.equal(slugify('My.Kit_2'), 'my-kit-2');
  assert.equal(slugify('..My  Kit__2.'), 'my-kit-2');
  assert.equal(slugify('dev-root'), 'dev-root');
  assert.equal(slugify('___'), '');
  assert.equal(slugify('日本'), '');
  for (const text of ['Ops_Kit', 'a b', 'x.y.z']) assert.ok(SLUG.test(slugify(text)), text);
});
