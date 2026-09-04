/**
 * TypeScript-AST helpers for the generators that cannot import their source of truth.
 *
 * `packages/cli/src/bin.ts` ends in a top-level `await cli.parseAsync()`, so importing it runs the CLI instead of
 * handing over the yargs instance: the command tree can only be read from the syntax tree. The error codes are in
 * the same position — they are `throw new TeachError(404, 'dataset_not_found: …')` expressions, not a table.
 *
 * Files are read with `readFileSync`, never with `grep`: `packages/node/src/teach-dataset.ts` holds a raw NUL byte,
 * so grep classifies it as binary and matches nothing in its 716 lines without saying so.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export { ts };

const cache = new Map();
export function parseFile(file) {
  let src = cache.get(file);
  if (!src) { src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true); cache.set(file, src); }
  return src;
}

/** Every `.ts` under a directory, sorted, so a generated page has the same order on every machine. */
export function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Marker for an expression whose value is not in this file (an identifier, a call, a spread). */
export class Unresolved {
  constructor(text) { this.text = text; }
}

const unwrapExpr = (n) => {
  let cur = n;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression?.(cur)) cur = cur.expression;
    else if (ts.isNonNullExpression(cur)) cur = cur.expression;
    else return cur;
  }
};

/** The JS value of a literal expression, or an `Unresolved` carrying its source text. */
export function literal(node) {
  const n = unwrapExpr(node);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isNumericLiteral(n)) return Number(n.text.replace(/_/g, ''));
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (n.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(n) && n.text === 'undefined') return undefined;
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken) {
    const inner = literal(n.operand);
    return typeof inner === 'number' ? -inner : new Unresolved(n.getText());
  }
  if (ts.isArrayLiteralExpression(n)) return n.elements.map((e) => literal(e));
  if (ts.isObjectLiteralExpression(n)) {
    const out = {};
    for (const p of n.properties) {
      if (!ts.isPropertyAssignment(p)) return new Unresolved(n.getText());
      const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
      if (key === null) return new Unresolved(n.getText());
      out[key] = literal(p.initializer);
    }
    return out;
  }
  return new Unresolved(n.getText());
}

/** The name a call expression invokes: `a.b.method(x)` → `method`, `fn(x)` → `fn`. */
export function calleeName(node) {
  if (!ts.isCallExpression(node)) return null;
  const e = node.expression;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isIdentifier(e)) return e.text;
  return null;
}

/** Depth-first walk. */
export function walk(node, fn) {
  fn(node);
  ts.forEachChild(node, (c) => walk(c, fn));
}

/**
 * The value of an exported `const NAME = [...] as const` in a set of files — how `choices: EVENT_KINDS` in the CLI
 * is turned back into the list it stands for. Throws when the constant cannot be found, so an unresolved choice
 * list stops the generator instead of quietly producing an option with no choices.
 */
export function resolveConst(name, files) {
  for (const file of files) {
    const src = parseFile(file);
    let found;
    walk(src, (n) => {
      if (found !== undefined) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
        const v = literal(n.initializer);
        if (!(v instanceof Unresolved)) found = v;
      }
    });
    if (found !== undefined) return found;
  }
  throw new Error(`docs-gen: cannot resolve the constant '${name}' — it is used as a choice list but its declaration was not found`);
}
