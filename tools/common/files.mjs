// Paths the user gives by hand: when one does not exist, find what was probably meant. The
// deepest folder of the path that exists is searched for names close to the first missing part
// (edit distance over a language-agnostic fold of case and diacritics); a close folder is
// followed by the rest of the path.
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

// Language-agnostic fold for matching: case, combining diacritics (é→e, ü→u, …) and the Russian
// ё, which has no NFKD decomposition. The single place letters are canonicalised before a match.
export const fold = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ё/g, 'е');

const norm = fold;
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const exists = (p) => { try { statSync(p); return true; } catch { return false; } };

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** Edits between the names (another extension on a file counts as two more) and that share of the length. */
function score(want, name, file) {
  const a = norm(want);
  const b = norm(name);
  const d = distance(a, b) + (file && extname(a) !== extname(b) ? 2 : 0);
  return { d, s: d / Math.max(a.length, b.length, 1) };
}

/**
 * For a path that does not exist: { dir, missing, candidates: [{ path, name, kind, exact }] },
 * the closest first: within one edit of the best, at most `limit`, share of changed characters ≤
 * `threshold`. `exact`: the candidate with the rest of the path exists — when some are, only they
 * are returned. Null when the path exists or only the filesystem root of it does.
 */
export function similarPaths(path, { limit = 5, threshold = 0.5 } = {}) {
  const full = resolve(path);
  if (exists(full)) return null;
  const rest = [];
  let dir = full;
  do { rest.unshift(basename(dir)); dir = dirname(dir); } while (!isDir(dir) && dirname(dir) !== dir);
  if (!isDir(dir) || dirname(dir) === dir) return null;
  const [missing, ...tail] = rest;
  const leaf = tail.length === 0;
  let items;
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const hidden = (name) => name.startsWith('.') || name.startsWith('~$'); // ~$… are Office lock files
  const scored = items
    .filter((it) => !hidden(it.name) && (leaf || it.isDirectory()))
    .map((it) => ({ name: it.name, kind: it.isDirectory() ? 'folder' : 'file', ...score(missing, it.name, leaf && !it.isDirectory()) }))
    .filter((c) => c.s <= threshold)
    .sort((a, b) => a.d - b.d || a.name.localeCompare(b.name));
  const best = scored[0]?.d ?? 0;
  let candidates = scored.filter((c) => c.d <= best + 1).map((c) => {
    const candidate = join(dir, c.name, ...tail);
    const found = exists(candidate);
    return { path: candidate, name: c.name, kind: leaf ? c.kind : found && isDir(candidate) ? 'folder' : 'file', exact: found };
  });
  if (!leaf && candidates.some((c) => c.exact)) candidates = candidates.filter((c) => c.exact);
  return { dir, missing, candidates: candidates.slice(0, limit) };
}

/** "no such file: …" with what was probably meant, for an error message. */
export function missingMessage(path, what = 'file') {
  const lines = [`no such ${what}: ${path}`];
  const found = similarPaths(path);
  if (!found) return lines[0];
  if (!found.candidates.length) {
    lines.push(`  nothing similar to "${found.missing}" in ${found.dir}`);
    return lines.join('\n');
  }
  const deeper = found.candidates.some((c) => c.path !== join(found.dir, c.name));
  lines.push(`  similar to "${found.missing}" in ${found.dir}:`);
  for (const c of found.candidates) {
    const shown = deeper ? c.path : c.name;
    lines.push(`    ${shown}${c.kind === 'folder' && c.exact ? '/' : ''}${deeper && !c.exact ? '  (the rest of the path is not there either)' : ''}`);
  }
  lines.push(found.candidates.length > 1
    ? '  ask the user which one was meant — do not pick between them'
    : '  confirm with the user that this is the one meant');
  return lines.join('\n');
}
