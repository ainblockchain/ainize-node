/**
 * Where the sources are, now that there is no `packages/`.
 *
 * This generator was written inside a monorepo and every path in it is `packages/<name>/…`. The repositories are
 * separate now and checked out side by side, so those paths name nothing. Rather than rewrite forty string
 * literals into `../ainize-<name>/…` — which would bury what each one MEANS under how it is currently arranged —
 * the literals stay as logical names and are resolved here. One place decides how the tree is laid out, and the
 * call sites keep saying "the node's source" rather than "two directories up and across".
 *
 * The docs themselves live in `ainize-web`, because that is what serves them.
 *
 * A missing sibling is a hard error, never a skipped section: a reference page generated with one of its four
 * sources absent is not a smaller page, it is a page that says a command or an error code does not exist.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The directory the repositories sit in — `ainize-node`'s parent, wherever it has been checked out. */
export function workspaceRoot(repo) { return dirname(repo); }

/** `packages/node/src/x.ts` → `<root>/ainize-node/src/x.ts`. Anything else is taken as docs-relative. */
export function at(repo, logical) {
  const root = workspaceRoot(repo);
  const m = /^packages\/([a-z]+)(\/.*)?$/.exec(logical);
  if (m) return join(root, `ainize-${m[1]}`, m[2] ? m[2].slice(1) : '');
  return join(root, 'ainize-web', logical);
}

/** What the generated banner should call a source, so a reader can actually open it. */
export function label(logical) {
  const m = /^packages\/([a-z]+)(\/.*)?$/.exec(logical);
  return m ? `ainize-${m[1]}${m[2] ?? ''}` : logical;
}

/** Checked once, up front: every repository this generator reads from has to be here. */
export function requireSiblings(repo, names = ['core', 'node', 'cli', 'web']) {
  const missing = names.filter((n) => !existsSync(join(workspaceRoot(repo), `ainize-${n}`)));
  if (missing.length) {
    throw new Error(
      `docs-gen needs the sibling repositories checked out beside this one: ${missing.map((n) => `ainize-${n}`).join(', ')} `
      + `not found in ${workspaceRoot(repo)}. The reference pages are generated from all four, and one missing source does not `
      + `make a shorter page — it makes a page that says a command does not exist.`);
  }
}
