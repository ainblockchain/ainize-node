/**
 * `docs/en/reference/http-api.md` and `docs/en/reference/schemas.md` — generated from `buildOpenApi()` in
 * `packages/node/src/openapi.ts`.
 *
 * The module is imported from TypeScript source, never from `dist/`: a node running a stale build serves a stale
 * spec, and a reference generated from that build would be stale in exactly the same silent way (docs/README.md §8,
 * H7). Reading the source is what makes `--check` mean "the docs match the code", not "the docs match a build".
 *
 * Nested object schemas are flattened to dotted paths (`benchmark.samples[].prompt`) instead of being indented into
 * a table. Indentation stops being legible at the second level, and these schemas are four deep.
 */
import { code, cell, inline, table, slug } from './md.mjs';

const REF = '#/components/schemas/';

const refName = (ref) => ref.slice(REF.length);

/** A link to a component schema — same page on schemas.md, across the pair from http-api.md. */
const schemaLink = (name, samePage) => `[${code(name)}](${samePage ? '' : './schemas.md'}#${slug(name)})`;

/** The type of a schema, as one short phrase. */
export function typeName(schema, samePage = false) {
  if (!schema || typeof schema !== 'object') return '`object`';
  if (schema.$ref) return schemaLink(refName(schema.$ref), samePage);
  if (schema.allOf) return schema.allOf.map((s) => typeName(s, samePage)).join(' & ');
  if (schema.oneOf) return schema.oneOf.map((s) => typeName(s, samePage)).join(' | ');
  let t;
  if (schema.enum) t = schema.enum.filter((v) => v !== null).map((v) => code(JSON.stringify(v))).join(' \\| ');
  else if (schema.type === 'array') t = `${typeName(schema.items ?? {}, samePage)}[]`;
  else if (schema.type) t = code(schema.format ? `${schema.type} (${schema.format})` : schema.type);
  else t = '`object`';
  const nullable = schema.nullable || (Array.isArray(schema.enum) && schema.enum.includes(null));
  return nullable ? `${t} \\| \`null\`` : t;
}

/** The constraints a reader needs that the type alone does not carry. */
function constraints(schema) {
  const bound = (min, max, unit) => {
    if (min !== undefined && max !== undefined) return `${min}–${max} ${unit}`;
    if (max !== undefined) return `at most ${max} ${unit}`;
    if (min !== undefined) return `at least ${min} ${unit}`;
    return null;
  };
  const out = [];
  if (schema.default !== undefined) out.push(`default \`${JSON.stringify(schema.default)}\``);
  const num = bound(schema.minimum, schema.maximum, '');
  if (num) out.push(num.trim());
  const len = bound(schema.minLength, schema.maxLength, 'characters');
  if (len) out.push(len);
  const items = bound(schema.minItems, schema.maxItems, 'items');
  if (items) out.push(items);
  if (schema.example !== undefined) out.push(`e.g. \`${JSON.stringify(schema.example)}\``);
  return out;
}

/**
 * One row per field, however deep: `dataset`, `dataset.parents[]`, `dataset.parents[].patch_id`. A `$ref` is a link
 * and stops the walk — that is what keeps `Anchor` readable instead of inlining four schemas into it.
 */
export function flattenFields(schema, { prefix = '', rows = [], samePage = false, required = [] } = {}) {
  if (!schema || typeof schema !== 'object') return rows;
  const props = schema.properties ?? {};
  for (const [name, prop] of Object.entries(props)) {
    const path = prefix ? `${prefix}.${name}` : name;
    const bits = constraints(prop);
    rows.push({
      path,
      type: typeName(prop, samePage),
      required: required.includes(name),
      description: [prop.deprecated ? '**Deprecated.**' : '', prop.description ? cell(prop.description) : '', bits.length ? `(${bits.join('; ')})` : ''].filter(Boolean).join(' '),
    });
    if (prop.$ref) continue;
    if (prop.type === 'object' && prop.properties) flattenFields(prop, { prefix: path, rows, samePage, required: prop.required ?? [] });
    else if (prop.type === 'array' && prop.items && !prop.items.$ref && prop.items.properties) flattenFields(prop.items, { prefix: `${path}[]`, rows, samePage, required: prop.items.required ?? [] });
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    rows.push({ path: `${prefix ? `${prefix}.` : ''}<any key>`, type: typeName(schema.additionalProperties, samePage), required: false, description: 'any key' });
  }
  return rows;
}

const fieldTable = (rows) => table(['Field', 'Type', 'Required', 'Description'], rows.map((r) => [code(r.path), r.type, r.required ? 'yes' : '', r.description]));

/** How a caller proves it may make this request, read from the operation rather than from prose. */
export function authOf(op) {
  const out = [];
  if (op.security) out.push('operator');
  const teach = (op.parameters ?? []).find((p) => p.in === 'header' && p.name.toLowerCase() === 'x-ngram-auth');
  if (teach) out.push(teach.required ? 'teaching key' : 'teaching key (optional)');
  if (op.responses?.['402']) out.push('payment (x402)');
  return out.length ? out.join(' + ') : 'none';
}

function bodyBlock(op, samePage) {
  if (!op.requestBody) return [];
  const out = [];
  const entries = Object.entries(op.requestBody.content ?? {});
  for (const [contentType, media] of entries) {
    out.push('', `**Request body** — ${code(contentType)}${op.requestBody.required ? ', required' : ', optional'}`);
    const sc = media.schema ?? {};
    if (sc.$ref) out.push('', `${typeName(sc, samePage)}`);
    else {
      if (sc.description) out.push('', inline(sc.description));
      const rows = flattenFields(sc, { samePage, required: sc.required ?? [] });
      if (rows.length) out.push('', ...fieldTable(rows));
      else out.push('', code(JSON.stringify(sc)));
    }
  }
  return out;
}

function responseBlock(op, samePage) {
  const rows = [];
  for (const [statusCode, res] of Object.entries(op.responses ?? {})) {
    const media = Object.values(res.content ?? {})[0];
    const sc = media?.schema;
    rows.push([code(statusCode), cell(res.description ?? ''), sc ? (sc.$ref ? typeName(sc, samePage) : (sc.type === 'array' ? typeName(sc, samePage) : '`object`')) : '']);
  }
  const out = ['', '**Responses**', '', ...table(['Code', 'Description', 'Body'], rows)];
  // an inline response schema is worth spelling out; a $ref already links to its own section
  for (const [statusCode, res] of Object.entries(op.responses ?? {})) {
    const sc = Object.values(res.content ?? {})[0]?.schema;
    if (!sc || sc.$ref) continue;
    const fields = flattenFields(sc, { samePage, required: sc.required ?? [] });
    if (!fields.length) continue;
    out.push('', `**${code(statusCode)} response body**`, '', ...fieldTable(fields));
  }
  return out;
}

function parameterBlock(op) {
  const params = op.parameters ?? [];
  if (!params.length) return [];
  const rows = params.map((p) => [
    code(p.name),
    code(p.in),
    typeName(p.schema ?? {}),
    p.required ? 'yes' : '',
    p.schema?.default !== undefined ? code(JSON.stringify(p.schema.default)) : '',
    p.description ? cell(p.description) : '',
  ]);
  return ['', '**Parameters**', '', ...table(['Name', 'In', 'Type', 'Required', 'Default', 'Description'], rows)];
}

export function renderHttpApiPage(spec) {
  const byTag = new Map(spec.tags.map((t) => [t.name, { ...t, ops: [] }]));
  let operations = 0;
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      operations++;
      const tag = op.tags?.[0];
      if (!byTag.has(tag)) throw new Error(`docs-gen(http-api): ${method.toUpperCase()} ${path} carries the tag ${JSON.stringify(tag)}, which is not declared in the spec's tag list`);
      byTag.get(tag).ops.push({ path, method: method.toUpperCase(), op });
    }
  }

  const title = (o) => `${o.method} ${o.path}`;
  const blocks = [];

  blocks.push('## How to read this page');
  blocks.push([
    `The base URL is the node itself — ${code('http://localhost:3402')} for a node started on the default port — and every request and response body is ${code('application/json')} unless the endpoint says otherwise.`,
    '',
    `A node serves this same description as OpenAPI 3.1 at ${code('GET /api/openapi.json')}, so a client can be generated from it.`,
  ].join('\n'));

  blocks.push('### Authentication');
  const schemes = Object.entries(spec.components.securitySchemes ?? {}).map(([name, s]) =>
    `- **${code(name)}** — ${s.type === 'apiKey' ? `${s.in} ${code(s.name)}` : `${s.type} ${code(s.scheme ?? '')}`}`);
  blocks.push([
    'The **Auth** column of each index below says what a request must carry.',
    '',
    ...schemes,
    `- **teaching key** — the ${code('x-ngram-auth')} header. There is no account: the key is the identity. Endpoints that accept it describe its exact form in their parameter table.`,
    `- **payment (x402)** — the endpoint answers ${code('402')} with an ${code('x-payment-required')} header; repeat the request with ${code('X-PAYMENT')}.`,
    '- **none** — public.',
  ].join('\n'));

  blocks.push('### Errors');
  blocks.push([
    `Every error body is ${code('{"error": "<message>"}')}, sometimes with extra fields the endpoint documents. Where the message begins with a machine-readable code (${code('dataset_not_found: no such dataset on this node')}), that prefix is the code — there is no separate field for it.`,
    '',
    'See [Error codes](./errors.md) for the full list.',
  ].join('\n'));

  blocks.push('## Endpoint index');
  for (const t of byTag.values()) {
    if (!t.ops.length) continue;
    blocks.push(`**${t.name}**${t.description ? ` — ${inline(t.description)}` : ''}`);
    blocks.push(table(['Method', 'Path', 'Auth', 'What it does'], t.ops.map((o) => [
      code(o.method), `[${code(o.path)}](#${slug(title(o))})`, authOf(o.op), cell(o.op.summary ?? ''),
    ])));
  }

  for (const t of byTag.values()) {
    if (!t.ops.length) continue;
    blocks.push(`## ${t.name}`);
    if (t.description) blocks.push(inline(t.description));
    for (const o of t.ops) {
      const out = [`### ${code(title(o))}`];
      if (o.op.summary) out.push('', inline(o.op.summary));
      if (o.op.description) out.push('', inline(o.op.description));
      out.push('', `**Auth** — ${authOf(o.op)}`);
      out.push(...parameterBlock(o.op));
      out.push(...bodyBlock(o.op, false));
      out.push(...responseBlock(o.op, false));
      blocks.push(out);
    }
  }
  return { blocks, counts: { paths: Object.keys(spec.paths).length, operations, tags: [...byTag.values()].filter((t) => t.ops.length).length } };
}

export function renderSchemasPage(spec) {
  const schemas = Object.entries(spec.components.schemas ?? {});
  const blocks = [];
  blocks.push('## How to read this page');
  blocks.push([
    'Fields are listed with their full path, so a nested field appears as its own row',
    `(${code('dataset.parents[].patch_id')}) instead of being indented out of legibility. A field whose type is another schema links to it rather than inlining it.`,
  ].join('\n'));
  blocks.push(table(['Schema', 'What it is'], schemas.map(([name, s]) => [`[${code(name)}](#${slug(name)})`, cell(s.description ?? '')])));
  for (const [name, s] of schemas) {
    const out = [`## ${code(name)}`];
    if (s.description) out.push('', inline(s.description));
    const rows = flattenFields(s, { samePage: true, required: s.required ?? [] });
    if (rows.length) out.push('', ...fieldTable(rows));
    blocks.push(out);
  }
  return { blocks, counts: { schemas: schemas.length } };
}
