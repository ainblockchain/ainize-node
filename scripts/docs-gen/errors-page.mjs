/**
 * `docs/en/reference/errors.md` — generated from the error classes, the `new …Error(status, 'code: sentence')`
 * literals and the API error middleware in `packages/node/src`.
 *
 * There is no error table in this code base to copy; the codes are the message literals themselves, and the status
 * each one comes back as is decided in two places — the class (`super(404, …)`) and the middleware that maps a
 * thrown error onto a response. Both are read here, which is why the page can state the envelope truthfully.
 *
 * Files are read with `readFileSync`: `packages/node/src/teach-dataset.ts` carries a raw NUL byte and grep skips it.
 */
import { relative, join } from 'node:path';
import { ts, parseFile, tsFiles, literal, walk, resolveConst } from './ts.mjs';
import { code, cell, table } from './md.mjs';

/** `'quota_rows: this node trains up to 300 questions'` -> the code and the sentence, or null when there is none. */
export function splitCoded(message) {
  const m = /^([a-z][a-z0-9_]{2,}):\s+(\S[\s\S]*)$/.exec(message);
  return m ? { code: m[1], sentence: m[2].trim() } : null;
}

/**
 * The message a throw site produces. A template literal keeps its fixed text and writes each substitution as the
 * expression that fills it when that is short enough to read (`invalid: <msg>`), and as an ellipsis when it is not.
 * A bare identifier is resolved to the constant it names, so `new RuntimeUnavailableError(MODEL_UNAVAILABLE)` shows
 * the sentence a caller actually receives.
 */
function messageOf(node, files) {
  if (!node || node.kind === undefined) return null;
  const v = literal(node);
  if (typeof v === 'string') return v;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => {
      const text = s.expression.getText().trim();
      const short = /^[A-Za-z_$][\w$.]{0,22}$/.test(text) ? `<${text}>` : '…';
      return short + s.literal.text;
    }).join('');
  }
  if (ts.isIdentifier(node)) {
    try {
      const c = resolveConst(node.text, files);
      if (typeof c === 'string') return c;
    } catch { /* not a literal constant — the message is built at run time */ }
  }
  return null;
}

/**
 * Every error class in the tree and how it decides its HTTP status:
 *   `constructor(public status: number, …)`  -> the caller passes it
 *   `super(404, message)`                     -> fixed by the class
 *   `readonly status = 499`                   -> fixed by the class
 */
export function errorClasses(files) {
  const classes = new Map();
  for (const file of files) {
    const src = parseFile(file);
    walk(src, (n) => {
      if (!ts.isClassDeclaration(n) || !n.name) return;
      const ext = n.heritageClauses?.flatMap((h) => h.types.map((t) => t.expression.getText()))[0] ?? null;
      if (!ext || !/Error$/.test(n.name.text)) return;
      const info = { name: n.name.text, extends: ext, file, statusFrom: null, status: null, messageIndex: 0 };
      for (const m of n.members) {
        if (ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === 'status' && m.initializer) {
          const v = literal(m.initializer);
          if (typeof v === 'number') { info.statusFrom = 'class'; info.status = v; }
        }
        if (!ts.isConstructorDeclaration(m)) continue;
        const params = m.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
        if (params[0] === 'status') { info.statusFrom = 'argument'; info.messageIndex = 1; }
        walk(m, (c) => {
          if (ts.isCallExpression(c) && c.expression.kind === ts.SyntaxKind.SuperKeyword) {
            const first = literal(c.arguments[0]);
            if (typeof first === 'number') { info.statusFrom = 'class'; info.status = first; info.messageIndex = 1; }
            // `super(MODEL_UNAVAILABLE)` / `super('live test cancelled …')` — the class always says the same thing,
            // whatever the caller passes, so the message is the class's and not the call site's.
            const msg = c.arguments[info.statusFrom === 'class' && typeof first === 'number' ? 1 : 0];
            if (msg && !params.includes(msg.getText())) info.fixedMessage = msg;
          }
        });
      }
      classes.set(info.name, info);
    });
  }
  // a subclass with no status of its own inherits the way its parent decides one
  for (const info of classes.values()) {
    let cur = info;
    const seen = new Set();
    while (cur && !cur.statusFrom && !seen.has(cur.name)) { seen.add(cur.name); cur = classes.get(cur.extends); }
    if (cur && cur !== info && cur.statusFrom) { info.statusFrom = cur.statusFrom; info.status = cur.status; info.messageIndex = cur.messageIndex; }
  }
  return classes;
}

/**
 * The API error middleware in `api.ts`: which thrown error becomes which HTTP status, and what it adds to the body.
 * This is the only description of the envelope that cannot go stale, because it *is* the envelope.
 */
export function envelope(apiFile) {
  const src = parseFile(apiFile);
  let body = null;
  walk(src, (n) => {
    if (body) return;
    if (!ts.isCallExpression(n) || n.expression.getText() !== 'router.use') return;
    const fn = n.arguments[0];
    if (fn && ts.isArrowFunction(fn) && fn.parameters.length === 4) body = fn.body;
  });
  if (!body) throw new Error('docs-gen(errors): the API error middleware was not found in api.ts');
  const rows = [];
  let fallback = null;
  for (const stmt of body.statements) {
    if (!ts.isIfStatement(stmt)) continue;
    const kinds = [];
    let messageTest = null;
    walk(stmt.expression, (n) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) kinds.push(n.right.getText());
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'test' && ts.isRegularExpressionLiteral(n.expression.expression)) {
        messageTest = n.expression.expression.getText();
      }
    });
    let status = null;
    const extra = [];
    let header = null;
    walk(stmt.thenStatement, (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'status') {
        const v = literal(n.arguments[0]);
        const text = n.arguments[0]?.getText() ?? '';
        status = typeof v === 'number' ? String(v) : (text === 'err.status' ? "the error's own status" : text);
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'set') {
        const k = literal(n.arguments[0]);
        const v = literal(n.arguments[1]);
        if (typeof k === 'string' && typeof v === 'string') header = `${k}: ${v}`;
      }
      if (ts.isObjectLiteralExpression(n)) {
        for (const p of n.properties) {
          if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text !== 'error') extra.push(p.name.text);
          if (ts.isSpreadAssignment(p)) extra.push(p.expression.getText().replace(/\s+/g, ' '));
        }
      }
    });
    if (!status || (!kinds.length && !messageTest)) continue;
    rows.push({ kinds, messageTest, status, extra: [...new Set(extra)], header });
  }
  for (const stmt of body.statements) {
    walk(stmt, (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'status' && literal(n.arguments[0]) === 500) fallback = true;
    });
  }
  return { rows, fallback };
}

/** Every `new SomeError(…)` in the tree whose message carries a machine code. */
export function codedErrors(files, classes, repo) {
  const found = new Map();
  const uncoded = [];
  for (const file of files) {
    const src = parseFile(file);
    walk(src, (n) => {
      if (!ts.isNewExpression(n) || !ts.isIdentifier(n.expression)) return;
      const info = classes.get(n.expression.text);
      if (!info) return;
      const args = n.arguments ?? [];
      const message = messageOf(info.fixedMessage ?? args[info.messageIndex], files);
      let status = info.status;
      if (info.statusFrom === 'argument') {
        const v = literal(args[0]);
        status = typeof v === 'number' ? v : null;
      }
      const rel = relative(repo, file);
      if (message === null || status === null) { uncoded.push({ file: rel, klass: info.name, message, status }); return; }
      const split = splitCoded(message);
      if (!split) { uncoded.push({ file: rel, klass: info.name, message, status }); return; }
      const key = `${split.code} ${status} ${split.sentence}`;
      const row = found.get(key) ?? { ...split, status, files: new Set(), klass: info.name };
      row.files.add(rel);
      found.set(key, row);
    });
  }
  const rows = [...found.values()].sort((a, b) => a.code.localeCompare(b.code) || a.status - b.status || a.sentence.localeCompare(b.sentence));
  return { rows, uncoded };
}

export function renderErrorsPage(repo) {
  const nodeSrc = join(repo, 'packages/node/src');
  const files = [...tsFiles(nodeSrc), ...tsFiles(join(repo, 'packages/core/src'))];
  const classes = errorClasses(files);
  const env = envelope(join(nodeSrc, 'api.ts'));

  // A class that carries no status of its own (`ValidationError`) gets one from the middleware, which is where its
  // status is actually decided.
  for (const r of env.rows) {
    if (r.kinds.length !== 1 || !/^\d+$/.test(r.status)) continue;
    const info = classes.get(r.kinds[0]);
    if (info && !info.statusFrom) { info.statusFrom = 'middleware'; info.status = Number(r.status); }
  }

  const { rows, uncoded } = codedErrors(files, classes, repo);

  const byCode = new Map();
  for (const r of rows) byCode.set(r.code, [...(byCode.get(r.code) ?? []), r]);

  // Plain sentences, deduplicated. The ones whose message is assembled at run time cannot be listed, only counted.
  const plain = new Map();
  let runtimeBuilt = 0;
  for (const u of uncoded) {
    if (u.message === null) { runtimeBuilt++; continue; }
    const key = `${u.status} ${u.message}`;
    const row = plain.get(key) ?? { status: u.status, message: u.message, files: new Set() };
    row.files.add(u.file);
    plain.set(key, row);
  }
  const plainRows = [...plain.values()].sort((a, b) => (a.status ?? 0) - (b.status ?? 0) || a.message.localeCompare(b.message));

  const blocks = [];
  blocks.push('## The error envelope');
  blocks.push([
    `Every failed request answers with ${code('{"error": "<message>"}')} and one of the statuses below. Some errors add fields to that object; the endpoint that raises them says so in the [HTTP API reference](./http-api.md).`,
    '',
    `Where the message begins with a lower-case word and a colon — ${code('dataset_not_found: no such dataset on this node')} — **that prefix is the machine-readable code**. There is no separate ${code('code')} field: match on the prefix, show the sentence.`,
  ].join('\n'));

  blocks.push('### How a thrown error becomes a status');
  blocks.push(table(['Error', 'HTTP status', 'Also in the body'], env.rows.map((r) => [
    [r.kinds.map((k) => code(k)).join(', '), r.messageTest ? `whose message matches ${code(r.messageTest)}` : ''].filter(Boolean).join(' ') || `any error matching ${code(r.messageTest)}`,
    [/^\d+$/.test(r.status) ? code(r.status) : r.status, r.header ? `and the header ${code(r.header)}` : ''].filter(Boolean).join(' '),
    r.extra.map((e) => code(e)).join(', '),
  ])));
  if (env.fallback) blocks.push(`Anything else is a fault in the node and comes back as ${code('500')} with the raw message.`);

  blocks.push('## Codes');
  blocks.push(`${byCode.size} codes are raised by name, in ${rows.length} distinct messages: a code that can come back with more than one status, or with more than one sentence, has a row for each. An ellipsis or a ${code('<name>')} in a sentence is a value filled in at the time — the code before the colon is the part to match on.`);
  blocks.push(table(['Code', 'HTTP', 'What it means', 'Raised in'], rows.map((r) => [
    code(r.code), code(String(r.status)), cell(r.sentence), [...r.files].sort().map((f) => code(f)).join(', '),
  ])));

  blocks.push('## Messages without a code');
  blocks.push([
    `Not every error carries a code. ${plainRows.length} raise a plain sentence and are told apart by their status — these are written for a person reading them, so match on the status, never on the words.`,
    '',
    `A further ${runtimeBuilt} throw sites build their message at the time (a validator's own wording, a peer's answer); they answer with the statuses above.`,
  ].join('\n'));
  blocks.push(table(['HTTP', 'Message', 'Raised in'], plainRows.map((r) => [
    code(String(r.status)), cell(r.message), [...r.files].sort().map((f) => code(f)).join(', '),
  ])));

  return { blocks, counts: { codes: byCode.size, rows: rows.length, plain: plainRows.length, runtimeBuilt, classes: classes.size } };
}
