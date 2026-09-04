/**
 * Markdown helpers shared by every generated reference page.
 *
 * Two rules everything else follows from:
 *   1. The output is read three ways — on disk, on GitHub, and by the /docs renderer — so it stays inside the
 *      markdown subset `docs/README.md` §2.2 lists. No raw HTML, no images, no reference links.
 *   2. Descriptions are copied out of source code that was written for a terminal, not for markdown. They contain
 *      `<placeholders>`, pipes and backticks, so every one of them goes through `inline()` (prose) or `cell()`
 *      (table cell) before it reaches a page.
 */

/** The binary name yargs substitutes for `$0` (packages/cli/src/context.ts: PROG defaults to `ainize`). */
export const PROG = 'ainize';

/**
 * GitHub's heading-anchor rule, which the /docs renderer must match: lower-case, drop everything that is not a
 * letter, digit, space, hyphen or underscore, then spaces to hyphens. `### GET /api/catalog` → `#get-apicatalog`.
 */
export function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replace(/ +/g, '-');
}

/**
 * A source-code string made safe as markdown prose. Backtick spans are left exactly as they are (they are already
 * code); outside them `<` is escaped, because `<node url>` in a describe is swallowed as an HTML tag by GitHub and
 * refused as raw HTML by the docs renderer.
 */
export function inline(s) {
  return String(s ?? '')
    .split(/(`[^`]*`)/)
    .map((seg, i) => (i % 2 === 1 ? seg.replace(/\$0/g, PROG) : seg.replace(/\$0/g, PROG).replace(/</g, '\\<')))
    .join('');
}

/** Same, folded onto one line and with the cell separator escaped. */
export function cell(s) {
  return inline(s).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
}

/** `code` — for identifiers that must never be interpreted, whatever they contain. */
export function code(s) {
  const t = String(s);
  const fence = '`'.repeat(Math.max(1, ...[...t.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return t.includes('`') ? `${fence} ${t} ${fence}` : `\`${t}\``;
}

/** A JSON literal in backticks — how every default value in these pages is written. */
export function value(v) {
  return code(JSON.stringify(v));
}

/** Flat `key: value` frontmatter, the only form the renderer parses. */
export function frontmatter(fields) {
  const lines = Object.entries(fields).map(([k, v]) => {
    if (/[:#]/.test(String(v))) throw new Error(`frontmatter value for '${k}' must not contain ':' or '#': ${v}`);
    return `${k}: ${v}`;
  });
  return ['---', ...lines, '---'];
}

/**
 * The visible "do not hand-edit" line every generated page carries, naming the file it came from and the command
 * that rewrites it. It is a blockquote alert so it renders as one on GitHub and in the docs renderer alike.
 */
export function banner(sources) {
  const from = sources.map((s) => code(s)).join(' and ');
  return [
    '> [!NOTE]',
    `> **This page is generated — do not edit it by hand.** It is written by \`scripts/docs-gen.mjs\` from ${from}.`,
    '> Regenerate with `npm run docs:gen`; `npm run docs:check` fails when this page and the source disagree.',
  ];
}

/**
 * A GFM pipe table. Cells are finished markdown — a caller that puts raw source text in one runs it through
 * `cell()` first, exactly once. A column that is empty in every row is dropped rather than printed blank.
 */
export function table(headers, rows) {
  const keep = headers.map((_, i) => rows.some((r) => String(r[i] ?? '').trim() !== ''));
  const head = headers.filter((_, i) => keep[i]);
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.filter((_, i) => keep[i]).map((c) => String(c ?? '').replace(/\s*\n\s*/g, ' ').trim() || ' ').join(' | ')} |`),
  ];
}

/** A fenced block. The info string is what the renderer's copy button and highlighter read. */
export function fence(lang, body) {
  return ['```' + lang, ...(Array.isArray(body) ? body : [body]), '```'];
}

/** Join blocks (each an array of lines or a string) into a page, with exactly one blank line between them. */
export function page(blocks) {
  const lines = [];
  for (const b of blocks) {
    if (b === null || b === undefined) continue;
    const part = Array.isArray(b) ? b : [b];
    if (part.length === 0) continue;
    if (lines.length) lines.push('');
    lines.push(...part);
  }
  return lines.join('\n') + '\n';
}

/**
 * Refuse to emit a page whose headings would collide: two `##`/`###` with the same slug make one of the two
 * unreachable by `#anchor`, and every cross-link in these pages is built from a slug.
 */
export function assertUniqueAnchors(pageText, file) {
  const seen = new Map();
  for (const line of pageText.split('\n')) {
    const m = /^(#{1,4}) +(.+?) *$/.exec(line);
    if (!m) continue;
    const s = slug(m[2]);
    if (seen.has(s)) throw new Error(`${file}: two headings share the anchor #${s} — ${JSON.stringify(seen.get(s))} and ${JSON.stringify(m[2])}`);
    seen.set(s, m[2]);
  }
  return seen;
}
