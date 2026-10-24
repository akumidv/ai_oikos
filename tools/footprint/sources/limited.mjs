// A few requests at a time: the per-item reads of a source (an issue's changelog, a page's versions,
// a merge request's diff) run side by side, at most `limit` at once, so a long list is not read one
// request after another nor all at once.

/**
 * Run `task` for every item of `items`, at most `limit` at a time; the first failure rejects (the
 * tasks already started still finish, none is started after it).
 *
 * @template T
 * @param {T[]} items what to run over
 * @param {number} limit how many run at once
 * @param {(item: T) => Promise<void>} task what to run for one item
 * @returns {Promise<void>}
 */
export async function eachLimited(items, limit, task) {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next];
      next += 1;
      try {
        await task(item);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
