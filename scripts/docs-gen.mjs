#!/usr/bin/env node
/**
 * Generate the reference pages of `docs/en/reference/` from the code that defines them.
 *
 *   node scripts/docs-gen.mjs            write the pages     (npm run docs:gen)
 *   node scripts/docs-gen.mjs --check    fail if they drifted (npm run docs:check)
 *
 * The point is not to save typing. A hand-written command table is a second copy of the truth, and this repo has
 * already shipped three of them, two of which are wrong. Here the flags, endpoints, config keys and error codes on
 * the page ARE the declarations in the source: change a flag without regenerating and `--check` turns red, with a
 * diff naming the line, instead of a developer finding out from a command that does not work.
 *
 * `--check` regenerates into memory and compares byte for byte, so it also catches an edit made to a generated page
 * by hand — which is the other half of the same problem.
 *
 * Two toolchain pieces, both already in the repo: `typescript` (for the sources that cannot be imported) and `tsx`
 * (for the ones that can). The script re-executes itself under tsx when it is run with a plain `node`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = dirname(dirname(SELF));

// `packages/node/src/openapi.ts` and `packages/core/src/config-schema.ts` are imported from TypeScript source, so
// the generator needs a TS loader. tsx is a devDependency of two workspaces and hoisted to the root.
if (process.env.DOCS_GEN_TSX !== '1') {
  const r = spawnSync(process.execPath, ['--import', 'tsx', SELF, ...process.argv.slice(2)],
    { cwd: REPO, stdio: 'inherit', env: { ...process.env, DOCS_GEN_TSX: '1' } });
  process.exit(r.status ?? 1);
}

const { page, frontmatter, banner, assertUniqueAnchors } = await import('./docs-gen/md.mjs');
const { readCliTree, renderCliPage } = await import('./docs-gen/cli-page.mjs');
const { renderHttpApiPage, renderSchemasPage } = await import('./docs-gen/openapi-page.mjs');
const { renderConfigPage } = await import('./docs-gen/config-page.mjs');
const { renderErrorsPage } = await import('./docs-gen/errors-page.mjs');

const { buildOpenApi } = await import('../packages/node/src/openapi.ts');
const schema = await import('../packages/core/src/config-schema.ts');
const config = await import('../packages/core/src/config.ts');

/** The node's own default port and version, so the page never carries the address of whoever generated it. */
const BASE_URL = 'http://localhost:3402';
const NODE_VERSION = JSON.parse(readFileSync(join(REPO, 'packages/node/package.json'), 'utf8')).version;

function build() {
  const spec = buildOpenApi(BASE_URL, NODE_VERSION);
  const cli = renderCliPage(readCliTree(REPO));
  const http = renderHttpApiPage(spec);
  const schemas = renderSchemasPage(spec);
  const cfg = renderConfigPage(REPO, { schema, config });
  const errors = renderErrorsPage(REPO);

  return [
    {
      path: 'docs/en/reference/cli.md',
      title: 'CLI reference',
      summary: `Every ${'`ainize`'} command, argument and option, generated from the CLI's own declarations`,
      sources: ['packages/cli/src/bin.ts'],
      lead: `Every command the ${'`ainize`'} CLI accepts — ${cli.counts.top} top-level commands, ${cli.counts.leaves} of them runnable — with the arguments, options, defaults and examples each one declares. The binary is also installed as ${'`ngram`'}; the two names run the same program.`,
      blocks: cli.blocks,
      counts: cli.counts,
    },
    {
      path: 'docs/en/reference/http-api.md',
      title: 'HTTP API reference',
      summary: 'Every endpoint an Ainize node serves, with parameters, bodies and responses',
      sources: ['packages/node/src/openapi.ts'],
      lead: `${http.counts.operations} operations on ${http.counts.paths} paths, grouped into the ${http.counts.tags} areas a node serves. Body shapes shared between endpoints are on the [Schemas](./schemas.md) page; the codes an error can carry are on [Error codes](./errors.md).`,
      blocks: http.blocks,
      counts: http.counts,
    },
    {
      path: 'docs/en/reference/schemas.md',
      title: 'Schemas',
      summary: 'The reusable request and response shapes of the node HTTP API',
      sources: ['packages/node/src/openapi.ts'],
      lead: `The ${schemas.counts.schemas} named shapes the [HTTP API](./http-api.md) refers to.`,
      blocks: schemas.blocks,
      counts: schemas.counts,
    },
    {
      path: 'docs/en/reference/config.md',
      title: 'Configuration reference',
      summary: 'Every key of a node config.json, its type, its default and the rules it is checked against',
      sources: ['packages/core/src/config-schema.ts', 'packages/core/src/config.ts', 'packages/core/src/types.ts'],
      lead: `All ${cfg.counts.keys} keys a node config accepts, the environment variables that override them, and the file ${'`ainize init`'} writes.`,
      blocks: cfg.blocks,
      counts: cfg.counts,
    },
    {
      path: 'docs/en/reference/errors.md',
      title: 'Error codes',
      summary: 'The error envelope, and every machine-readable code a node can answer with',
      sources: ['packages/node/src'],
      lead: `What an error body looks like, how a thrown error becomes an HTTP status, and the ${errors.counts.codes} codes a client can match on.`,
      blocks: errors.blocks,
      counts: errors.counts,
    },
  ].map((p) => {
    const text = page([
      frontmatter({ title: p.title, summary: p.summary }),
      `# ${p.title}`,
      banner(p.sources),
      p.lead,
      ...p.blocks,
    ]);
    assertUniqueAnchors(text, p.path);
    return { ...p, text };
  });
}

/**
 * No generated page may link to a page or an anchor that does not exist. The pages cross-link heavily (an endpoint
 * to its schema, a schema back to the endpoint page, a reference to the guide that explains it), and a link that
 * silently goes nowhere is exactly the failure a generated reference is supposed to make impossible. A link to a
 * hand-written page is checked against the tree on disk, so adding one before the page exists fails here.
 */
function assertLinksResolve(pages) {
  const anchors = new Map(pages.map((p) => [p.path, new Set(assertUniqueAnchors(p.text, p.path).keys())]));
  for (const p of pages) {
    for (const m of p.text.matchAll(/\]\(([^)\s#]*)(#[^)\s]*)?\)/g)) {
      const [, target, rawHash] = m;
      const hash = rawHash?.slice(1);
      if (/^[a-z]+:/.test(target)) continue;                       // an external URL is not ours to verify
      const file = target ? join(dirname(p.path), target).replace(/\\/g, '/') : p.path;
      const known = anchors.get(file);
      if (!known) {
        if (!existsSync(join(REPO, file))) throw new Error(`${p.path}: link to ${target} — no such file in the docs tree`);
        continue;                                                   // a hand-written page: docs-check.mjs owns its anchors
      }
      if (hash && !known.has(hash)) throw new Error(`${p.path}: link to ${target}#${hash} — no such heading on that page`);
    }
  }
}

/**
 * The one hunk where the two files disagree: everything they share at the top and at the bottom is trimmed away, so
 * a one-line drift prints as one line rather than as the rest of the file.
 */
function firstDivergence(expected, actual, path) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const CAP = 8;
  const out = [`--- ${path} (on disk)`, `+++ ${path} (what the source says it should be)`, `@@ line ${start + 1} @@`];
  for (let k = Math.max(0, start - 2); k < start; k++) out.push(`  ${b[k]}`);
  for (let k = start; k < Math.min(endB, start + CAP); k++) out.push(`- ${b[k]}`);
  if (endB - start > CAP) out.push(`- … ${endB - start - CAP} more line(s)`);
  for (let k = start; k < Math.min(endA, start + CAP); k++) out.push(`+ ${a[k]}`);
  if (endA - start > CAP) out.push(`+ … ${endA - start - CAP} more line(s)`);
  return out.join('\n');
}

const check = process.argv.includes('--check');
const pages = build();
assertLinksResolve(pages);
let failed = 0;

for (const p of pages) {
  const abs = join(REPO, p.path);
  const onDisk = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  const same = onDisk === p.text;
  if (check) {
    if (same) { process.stdout.write(`ok    ${p.path}\n`); continue; }
    failed++;
    process.stdout.write(`DRIFT ${p.path}${onDisk === null ? ' — the page does not exist' : ''}\n`);
    if (onDisk !== null) process.stdout.write(`${firstDivergence(p.text, onDisk, p.path)}\n`);
  } else {
    if (same) { process.stdout.write(`same  ${p.path}\n`); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, p.text);
    process.stdout.write(`write ${p.path}  (${p.text.split('\n').length} lines, ${JSON.stringify(p.counts)})\n`);
  }
}

if (check && failed) {
  process.stdout.write(`\n${failed} generated page(s) no longer match their source. Run \`npm run docs:gen\` and commit the result.\n`);
  process.exit(1);
}
if (check) process.stdout.write(`\nAll ${pages.length} generated pages match their source.\n`);
