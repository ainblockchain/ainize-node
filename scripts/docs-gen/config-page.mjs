/**
 * `docs/en/reference/config.md` — generated from the zod schema in `packages/core/src/config-schema.ts` and the
 * defaults in `packages/core/src/config.ts`.
 *
 * Four things are read, each from the place that decides it:
 *   • the key list and each key's type — `configKeys()` / `configField()` / `configFieldType()`;
 *   • each key's rules — by asking the schema itself: a wrong-but-right-typed value is parsed and the schema's own
 *     sentence is recorded, so the page shows exactly what `ainize config set` prints when you get it wrong;
 *   • each key's default — `defaultConfig()`, called with a sentinel home so the page never carries this machine's
 *     paths, and asserted key by key for the few defaults that are not constants;
 *   • each key's description — the JSDoc on `NodeConfig` / `TeachConfig` in `packages/core/src/types.ts`.
 */
import { join } from 'node:path';
import { ts, parseFile, literal, Unresolved, walk } from './ts.mjs';
import { code, cell, table, fence } from './md.mjs';

const HOME = '<AINIZE_HOME>';
/** A fixed key so the generated page is byte-identical on every machine; it is never printed. */
const FIXED_KEY = `0x${'11'.repeat(32)}`;

/** The rules the schema enforces, in the schema's own words: probe it and keep the sentences it answers with. */
function rulesOf(field) {
  const probes = { number: [-1, 0.5, 1e12], string: ['', '@@ not a url @@'], bigint: [], boolean: [], array: [], object: [], record: [], enum: [], union: [] };
  const out = new Set();
  for (const probe of probes[field.def.type] ?? []) {
    const res = field.safeParse(probe);
    if (res.success) continue;
    for (const issue of res.error.issues) if (/^must /.test(issue.message)) out.add(issue.message);
  }
  return [...out];
}

/** `{a: {b: 1}}` → the value at `a.b`, and whether the path exists at all. */
function at(obj, path) {
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || !(seg in cur)) return { has: false, value: undefined };
    cur = cur[seg];
  }
  return { has: true, value: cur };
}

/**
 * Every doc-commented field of an interface, as dotted paths. Nested type literals are walked; a property whose
 * type names another interface in the same file is followed into it (`teach?: TeachConfig`).
 */
export function interfaceDocs(file, rootName) {
  const src = parseFile(file);
  const interfaces = new Map();
  walk(src, (n) => { if (ts.isInterfaceDeclaration(n)) interfaces.set(n.name.text, n); });
  const out = new Map();
  const seen = new Set();
  const visitMembers = (members, prefix) => {
    for (const m of members) {
      if (!ts.isPropertySignature(m) || !m.name || !(ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) continue;
      const path = prefix ? `${prefix}.${m.name.text}` : m.name.text;
      const doc = (m.jsDoc ?? []).map((d) => (typeof d.comment === 'string' ? d.comment : (d.comment ?? []).map((c) => c.text).join('')))
        .concat((m.jsDoc ?? []).flatMap((d) => (d.tags ?? []).map((t) => (t.tagName.text === 'deprecated' ? `**Deprecated.** ${typeof t.comment === 'string' ? t.comment : ''}` : ''))))
        .filter(Boolean).join(' ').replace(/\s*\n\s*/g, ' ').trim();
      if (doc) out.set(path, doc);
      const type = m.type;
      if (!type) continue;
      if (ts.isTypeLiteralNode(type)) visitMembers(type.members, path);
      else if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && interfaces.has(type.typeName.text) && !seen.has(`${path}:${type.typeName.text}`)) {
        seen.add(`${path}:${type.typeName.text}`);
        visitMembers(interfaces.get(type.typeName.text).members, path);
      }
    }
  };
  visitMembers(interfaces.get(rootName).members, '');
  return out;
}

/**
 * The environment variables that overwrite config keys, read out of `applyEnv()` — the one function that does it.
 * Each `if (env.X) cfg.a.b = …` becomes a row; an assignment that rebuilds a block (`cfg.teach = {…, backend: …}`)
 * contributes the keys the object literal actually names.
 */
export function envOverrides(file) {
  const src = parseFile(file);
  let fn = null;
  walk(src, (n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === 'applyEnv') fn = n; });
  if (!fn) throw new Error('docs-gen(config): applyEnv() not found in packages/core/src/config.ts');
  const rows = [];
  for (const stmt of fn.body.statements) {
    if (!ts.isIfStatement(stmt)) continue;
    const vars = new Set();
    const accepted = new Set();
    walk(stmt.expression, (n) => {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'env') vars.add(n.name.text);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
        const v = literal(n.right);
        if (typeof v === 'string') accepted.add(v);
      }
    });
    const keys = new Set();
    walk(stmt.thenStatement, (n) => {
      if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
      const target = n.left.getText().replace(/!/g, '');
      if (!target.startsWith('cfg.')) return;
      const base = target.slice(4);
      const rhs = n.right;
      if (ts.isObjectLiteralExpression(rhs)) {
        const named = rhs.properties.filter((p) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)));
        if (named.length) { for (const p of named) keys.add(`${base}.${p.name.text}`); return; }
      }
      keys.add(base);
    });
    if (!vars.size || !keys.size) continue;
    rows.push({ vars: [...vars], keys: [...keys], accepted: [...accepted] });
  }
  return rows;
}

/** `DEFAULT_HOME = process.env.AINIZE_HOME ?? join(homedir(), '.ainize')` — asserted, then written as a row. */
function homeVar(file) {
  const src = parseFile(file);
  let text = null;
  walk(src, (n) => { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'DEFAULT_HOME') text = n.initializer.getText(); });
  if (!text || !/process\.env\.AINIZE_HOME/.test(text) || !/'\.ainize'/.test(text)) {
    throw new Error(`docs-gen(config): DEFAULT_HOME is no longer 'process.env.AINIZE_HOME ?? join(homedir(), ".ainize")' — it is now ${text}`);
  }
  return { name: 'AINIZE_HOME', describe: 'the directory holding `config.json`, the node key and the data directory', dflt: '~/.ainize' };
}

/** The one default that depends on the machine `ainize init` runs on, read from the source rather than guessed. */
function runtimeRepoProbe(file) {
  const src = parseFile(file);
  let found = null;
  walk(src, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'defaultConfig') {
      walk(n, (m) => {
        if (ts.isCallExpression(m) && ts.isIdentifier(m.expression) && m.expression.text === 'existsSync') {
          const v = literal(m.arguments[0]);
          if (typeof v === 'string') found = v;
        }
      });
    }
  });
  if (!found) throw new Error('docs-gen(config): defaultConfig() no longer probes a path for runtime.repo');
  return found;
}

export function renderConfigPage(repo, mods) {
  const { configKeys, configField, configFieldType, PROTECTED_CONFIG_KEYS } = mods.schema;
  const { defaultConfig } = mods.config;
  const configFile = join(repo, 'packages/core/src/config.ts');
  const docs = interfaceDocs(join(repo, 'packages/core/src/types.ts'), 'NodeConfig');
  const defaults = defaultConfig({ home: HOME, privateKey: FIXED_KEY });
  const probePath = runtimeRepoProbe(configFile);
  const protectedKeys = new Set(PROTECTED_CONFIG_KEYS);
  // Each protected key is written by a different command; a new one must be given its sentence rather than
  // inheriting a wrong one silently.
  const protectedDefault = (key) => {
    if (key === 'identity' || key.startsWith('identity.')) return 'minted by `ainize init`';
    if (key === 'operatorPasswordHash') return 'set by `ainize login`';
    throw new Error(`docs-gen(config): ${key} is protected but this generator does not know what writes it`);
  };

  // The handful of defaults that are not constants. Each is asserted against what defaultConfig() actually
  // produced, so a change in the code stops the generator instead of leaving a wrong sentence on the page.
  const special = {
    name: (v) => { if (!/^node-[0-9a-f]{6}$/.test(v)) throw new Error(`docs-gen(config): expected name 'node-<6 hex>', got ${JSON.stringify(v)}`); return '`node-` + the first 6 hex of the node address'; },
    dataDir: (v) => { if (v !== `${HOME}/data`) throw new Error(`docs-gen(config): expected dataDir '<AINIZE_HOME>/data', got ${JSON.stringify(v)}`); return code(`${HOME}/data`); },
    'runtime.repo': (v) => {
      if (v !== undefined && v !== probePath) throw new Error(`docs-gen(config): expected runtime.repo to be unset or ${probePath}, got ${JSON.stringify(v)}`);
      return `unset — \`ainize init\` fills it with ${code(probePath)} when that directory exists on the machine it runs on`;
    },
    'market.currency': (v) => { if (v !== 'CREDIT') throw new Error(`docs-gen(config): expected market.currency 'CREDIT', got ${JSON.stringify(v)}`); return '`"CREDIT"`, or `"AIN"` with `ainize init --ledger ain`'; },
  };

  const rows = [];
  for (const key of configKeys()) {
    const field = configField(key);
    const isProtected = protectedKeys.has(key) || key.split('.')[0] === 'identity' && protectedKeys.has('identity');
    const rules = rulesOf(field).sort();
    const type = rules.length ? `${configFieldType(field)} — ${rules.join('; ')}` : configFieldType(field);
    const { has, value } = at(defaults, key);
    let dflt;
    if (isProtected) dflt = protectedDefault(key);
    else if (special[key]) dflt = special[key](value);
    else if (!has || value === undefined) dflt = 'unset';
    else if (field.def.type === 'object') dflt = '';
    else {
      const json = JSON.stringify(value);
      dflt = json.length > 44 ? `${Array.isArray(value) ? `${value.length} items` : 'see below'} — [the default \`config.json\`](#the-default-configjson)` : code(json);
    }
    rows.push([code(key), cell(type), dflt, [isProtected ? '**Protected.**' : '', docs.get(key) ? cell(docs.get(key)) : ''].filter(Boolean).join(' ')]);
  }

  const env = envOverrides(configFile);
  const home = homeVar(configFile);

  const printable = JSON.parse(JSON.stringify(defaults));
  printable.identity = { privateKey: '…', address: '0x…', publicKey: '0x…' };

  const blocks = [];
  blocks.push('## How to read this page');
  blocks.push([
    `A node keeps its settings in ${code('config.json')} inside its home directory (${code(home.dflt)} unless ${code('AINIZE_HOME')} says otherwise). Read and change them with`,
    `${code('ainize config show')}, ${code('ainize config get <key>')}, ${code('ainize config set <key> <value>')} and ${code('ainize config unset <key>')} — see the [CLI reference](./cli.md#ainize-config).`,
    '',
    'Keys are dotted paths. The **Type** column is the schema\'s own description of what a key holds, followed by the rules it enforces — the same sentence `ainize config set` prints when a value is refused.',
    '',
    'Money is a decimal string everywhere in this product, never a JSON number: `"0.1"`, not `0.1`.',
  ].join('\n'));

  blocks.push('## Keys');
  blocks.push(table(['Key', 'Type', 'Default', 'Notes'], rows));

  blocks.push('## Protected keys');
  blocks.push([
    `${code('ainize config set')} refuses these: the identity is the node's only key pair, and the password hash is written by ${code('ainize login')}.`,
    '',
    ...PROTECTED_CONFIG_KEYS.map((k) => `- ${code(k)}`),
  ].join('\n'));

  blocks.push('## Environment variables');
  blocks.push('These are read at start-up and overwrite what is in `config.json` for that run; the file is not changed.');
  blocks.push(table(['Variable', 'Sets', 'Accepted values'], [
    [code(home.name), home.describe, ''],
    ...env.map((e) => [e.vars.map((v) => code(v)).join(', '), e.keys.map((k) => code(k)).join(', '), e.accepted.map((a) => code(JSON.stringify(a))).join(', ')]),
  ]));

  blocks.push('## The default `config.json`');
  blocks.push(`What ${code('ainize init')} writes, with the identity removed — it is minted per node.`);
  blocks.push(fence('json', JSON.stringify(printable, null, 2).split('\n')));

  return { blocks, counts: { keys: rows.length, env: env.length + 1 } };
}
