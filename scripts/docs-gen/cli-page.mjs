/**
 * `docs/en/reference/cli.md` — generated from the yargs declarations in `packages/cli/src/bin.ts`.
 *
 * bin.ts ends in a top-level `await cli.parseAsync()`, so the yargs instance cannot be imported and asked what it
 * knows; the command tree is read from the syntax tree instead. Every name, description, type, default, choice list
 * and example on the page is the object literal the CLI itself is built from — there is no second copy to drift.
 */
import { join } from 'node:path';
import { ts, parseFile, literal, Unresolved, resolveConst, tsFiles } from './ts.mjs';
import { PROG, code, value, inline, cell, table, fence, slug } from './md.mjs';

const BIN = 'packages/cli/src/bin.ts';

/** A command, positional or option that the AST could not read is a bug in this generator, not a page to publish. */
const must = (v, what, node) => {
  if (v instanceof Unresolved || v === undefined) throw new Error(`docs-gen(cli): could not read ${what} from ${JSON.stringify(node.getText().slice(0, 120))}`);
  return v;
};

function newNode(name, path, describe) {
  return { name, path, describe, aliases: [], defaultForm: null, positionals: [], options: [], examples: [], demand: null, children: [] };
}

/** Split `'fund <address> [amount]'` into its command word and its positional tokens. */
function parseCommandString(s) {
  const [name, ...tokens] = s.trim().split(/\s+/);
  return { name, tokens };
}

function tokenToPositional(tok) {
  const required = tok.startsWith('<');
  const variadic = tok.includes('..');
  const name = tok.replace(/^[<[]|[\]>]$/g, '').replace(/\.\.$/, '');
  return { name, required, variadic, type: null, describe: null, default: undefined };
}

export function readCliTree(repo) {
  const file = join(repo, BIN);
  const src = parseFile(file);
  const nodeSources = [...tsFiles(join(repo, 'packages/node/src')), ...tsFiles(join(repo, 'packages/core/src'))];

  // Builder helpers — `const keyOpts = (y) => y.option('key', …).option('key-file', …)` — add their options to
  // every command whose builder calls them. Collected first, and skipped by the main pass so they do not land on
  // the global chain.
  const macroDecls = new Map();
  for (const stmt of src.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) macroDecls.set(d.name.text, { stmt, decl: d });
    }
  }
  const macros = new Map();
  for (const [name, { decl }] of macroDecls) {
    const ctx = newNode(name, [], null);
    collect(decl.initializer.body, ctx);
    macros.set(name, ctx);
  }

  const root = newNode(null, [], null);
  root.help = false;
  root.version = false;
  root.helpAliases = [];
  for (const stmt of src.statements) {
    if (macroDecls.size && [...macroDecls.values()].some((m) => m.stmt === stmt)) continue;
    collect(stmt, root);
  }
  return root;

  function collect(node, ctx) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const fn = node.expression.name.text;
      collect(node.expression.expression, ctx);            // the chain to the left keeps this context
      if (fn === 'command') {
        const child = makeCommand(node, ctx);
        for (const a of node.arguments) collect(a, child); // …the arguments belong to the new command
        return;
      }
      chainCall(fn, node, ctx);
      for (const a of node.arguments) collect(a, ctx);
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && macros.has(node.expression.text)) {
      const m = macros.get(node.expression.text);
      ctx.options.push(...m.options);
      ctx.positionals.push(...m.positionals);
      for (const a of node.arguments) collect(a, ctx);
      return;
    }
    ts.forEachChild(node, (c) => collect(c, ctx));
  }

  function makeCommand(node, ctx) {
    const names = must(literal(node.arguments[0]), 'a command name', node);
    const describe = must(literal(node.arguments[1]), 'a command description', node);
    const list = (Array.isArray(names) ? names : [names]).map(String);
    const primary = parseCommandString(list[0]);
    if (primary.name === '$0') throw new Error(`docs-gen(cli): the first form of a command must not be '$0' (${list.join(' | ')})`);
    const cmd = newNode(primary.name, [...ctx.path, primary.name], typeof describe === 'string' ? describe : null);
    cmd.positionals = primary.tokens.map(tokenToPositional);
    for (const alt of list.slice(1)) {
      const p = parseCommandString(alt);
      if (p.name === '$0') cmd.defaultForm = p.tokens;      // `['upload <file>', '$0 <file>']` — usable without the word
      else cmd.aliases.push(p.name);
    }
    ctx.children.push(cmd);
    return cmd;
  }

  function chainCall(fn, node, ctx) {
    if (fn === 'option') {
      const name = must(literal(node.arguments[0]), 'an option name', node);
      const spec = node.arguments[1] ? must(literal(node.arguments[1]), 'an option spec', node) : {};
      ctx.options.push(readOption(String(name), spec, node));
    } else if (fn === 'positional') {
      const name = String(must(literal(node.arguments[0]), 'a positional name', node));
      const spec = node.arguments[1] ? must(literal(node.arguments[1]), 'a positional spec', node) : {};
      const found = ctx.positionals.find((p) => p.name === name);
      const merged = { ...(found ?? { name, required: !!spec.demandOption, variadic: !!spec.array }), ...readPositional(spec, node) };
      if (found) Object.assign(found, merged);
      else ctx.positionals.push(merged);
    } else if (fn === 'example') {
      const cmd = must(literal(node.arguments[0]), 'an example command', node);
      const desc = node.arguments[1] ? literal(node.arguments[1]) : '';
      ctx.examples.push({ cmd: String(cmd), desc: typeof desc === 'string' ? desc : '' });
    } else if (fn === 'demandCommand') {
      const msg = node.arguments[1] ? literal(node.arguments[1]) : null;
      ctx.demand = typeof msg === 'string' ? msg : true;
    } else if (fn === 'help') {
      ctx.help = true;
    } else if (fn === 'version') {
      ctx.version = true;
    } else if (fn === 'alias') {
      const from = literal(node.arguments[0]);
      const to = literal(node.arguments[1]);
      if (to === 'help' && typeof from === 'string') ctx.helpAliases = [...(ctx.helpAliases ?? []), from];
    }
  }

  function choicesOf(node, spec) {
    if (spec.choices === undefined) return null;
    if (!(spec.choices instanceof Unresolved)) return spec.choices.map(String);
    // `choices: EVENT_KINDS` — the list lives in another package; read it from its declaration rather than guess.
    const name = spec.choices.text.trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`docs-gen(cli): unreadable choices ${name}`);
    return resolveConst(name, nodeSources).map(String);
  }

  function readOption(name, spec, node) {
    return {
      name,
      alias: spec.alias ? [].concat(spec.alias).map(String) : [],
      type: spec.type ?? null,
      array: !!spec.array,
      choices: choicesOf(node, spec),
      default: spec.default,
      required: !!spec.demandOption,
      global: !!spec.global,
      describe: typeof spec.describe === 'string' ? spec.describe : null,
    };
  }

  function readPositional(spec, node) {
    return {
      type: spec.type ?? null,
      choices: choicesOf(node, spec),
      default: spec.default,
      describe: typeof spec.describe === 'string' ? spec.describe : null,
      ...(spec.demandOption ? { required: true } : {}),
      ...(spec.array ? { variadic: true } : {}),
    };
  }
}

// ------------------------------------------------------------------ rendering

const flat = (node, out = []) => {
  for (const c of node.children) { out.push(c); flat(c, out); }
  return out;
};

const typeOf = (p) => {
  if (p.choices) return p.choices.map((c) => JSON.stringify(c)).join(' | ');
  const base = p.type ?? 'string';
  return p.array || p.variadic ? `${base}[]` : base;
};

/** `(`string`, required, default `false`)` — the facts a reader needs before the sentence. */
function facts(p) {
  const bits = [code(typeOf(p))];
  if (p.required) bits.push('required');
  if (p.default !== undefined && !(p.default instanceof Unresolved)) bits.push(`default ${value(p.default)}`);
  return `(${bits.join(', ')})`;
}

function optionLine(o) {
  const names = [`\`--${o.name}\``, ...o.alias.map((a) => `\`-${a}\``)].join(', ');
  const tail = o.describe ? ` — ${inline(o.describe)}` : '';
  return `- **${names}** ${facts(o)}${tail}`;
}

function positionalLine(p) {
  const token = p.required ? `<${p.name}${p.variadic ? '…' : ''}>` : `[${p.name}${p.variadic ? '…' : ''}]`;
  const tail = p.describe ? ` — ${inline(p.describe)}` : '';
  return `- **${code(token)}** ${facts(p)}${tail}`;
}

const placeholder = (o) => (o.choices ? `<${o.choices.join('|')}>` : o.type === 'number' ? '<n>' : o.type === 'boolean' ? '' : '<value>');

function synopsis(cmd) {
  const parts = [PROG, ...cmd.path];
  for (const p of cmd.positionals) parts.push(p.required ? `<${p.name}${p.variadic ? '…' : ''}>` : `[${p.name}${p.variadic ? '…' : ''}]`);
  for (const o of cmd.options.filter((x) => x.required)) parts.push(`--${o.name}${placeholder(o) ? ` ${placeholder(o)}` : ''}`);
  if (cmd.options.some((o) => !o.required)) parts.push('[options]');
  if (cmd.children.length) parts.push('<subcommand>');
  return parts.filter(Boolean).join(' ');
}

function renderCommand(cmd, depth) {
  const heading = '#'.repeat(Math.min(4, depth + 1));
  const out = [`${heading} ${code([PROG, ...cmd.path].join(' '))}`, '', ...fence('bash', synopsis(cmd))];
  if (cmd.describe) out.push('', inline(cmd.describe));
  if (cmd.aliases.length) out.push('', `Also spelled ${cmd.aliases.map((a) => code([PROG, ...cmd.path.slice(0, -1), a].join(' '))).join(', ')}.`);
  if (cmd.defaultForm) out.push('', `This is the default subcommand: ${code([PROG, ...cmd.path.slice(0, -1), ...cmd.defaultForm].join(' '))} runs it without naming ${code(cmd.name)}.`);
  if (cmd.positionals.length) out.push('', '**Arguments**', '', ...cmd.positionals.map(positionalLine));
  const opts = cmd.options.filter((o) => !o.global);
  if (opts.length) out.push('', '**Options**', '', ...opts.map(optionLine));
  if (cmd.children.length) out.push('', cmd.demand ? '**Subcommands** — one of them is required' : '**Subcommands**', '', ...cmd.children.map((c) => `- ${code([PROG, ...c.path].join(' '))}${c.describe ? ` — ${inline(c.describe)}` : ''}`));
  if (cmd.examples.length) {
    out.push('', '**Examples**', '');
    out.push(...fence('bash', cmd.examples.flatMap((e) => (e.desc ? [`# ${e.desc.replace(/\$0/g, PROG)}`] : []).concat([e.cmd.replace(/\$0/g, PROG)]))));
  }
  return out;
}

export function renderCliPage(root) {
  const commands = flat(root);
  const leaves = commands.filter((c) => c.children.length === 0);
  const globals = root.options.filter((o) => o.global);

  const blocks = [];
  blocks.push('## How to read this page');
  blocks.push([
    `Each command shows the shape of the line first: required arguments in ${code('<angle brackets>')}, optional ones in ${code('[square brackets]')}, a trailing ${code('…')} where several values may follow, and every required option spelled out. ${code('[options]')} stands for the rest of the list below it.`,
    '',
    `An option with a type takes a value (${code('--limit 20')}); a ${code('boolean')} option is a flag, and ${code('--no-')} in front of its name turns it off — ${code(`${PROG} init --no-force`)}.`,
    '',
    'The global options come first because they work everywhere; everything after that is one command per heading, nested exactly as its subcommands are.',
  ].join('\n'));
  blocks.push('## Global options');
  blocks.push('These are accepted by every command.');
  const builtins = [];
  if (root.help) builtins.push(`- **\`--help\`${(root.helpAliases ?? []).map((a) => `, \`-${a}\``).join('')}** (\`boolean\`) — print the help for a command and exit`);
  if (root.version) builtins.push('- **`--version`** (`boolean`) — print the CLI version and exit');
  blocks.push([...globals.map(optionLine), ...builtins]);

  blocks.push('## Commands');
  blocks.push(table(['Command', 'What it does'], root.children.map((c) => [`[${code(`${PROG} ${c.name}`)}](#${slug(`${PROG} ${c.path.join(' ')}`)})`, cell(c.describe ?? '')])));

  for (const c of root.children) {
    const stack = [[c, 1]];
    while (stack.length) {
      const [cmd, depth] = stack.shift();
      blocks.push(renderCommand(cmd, depth));
      stack.unshift(...cmd.children.map((ch) => [ch, depth + 1]));
    }
  }
  return { blocks, counts: { top: root.children.length, all: commands.length, leaves: leaves.length, options: commands.reduce((n, c) => n + c.options.length, 0) } };
}
