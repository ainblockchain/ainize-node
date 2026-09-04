/**
 * Teach mode v2 — the dataset service: everything that touches disk, the store and the quotas around a dataset
 * (design `docs/teachable-dataset-design.md` §6, §7.1–§7.2, §11, §12).
 *
 * The parser (`teach-dataset.ts`) is pure; this is the layer that persists what it decided:
 *
 *   <dataDir>/teach/datasets/<id>/
 *       source.<ext>    the original uploaded bytes (kept while status=staged, and while retention='keep')
 *       rows.jsonl      canonical, the sha256 subject
 *       report.json     one entry per SOURCE row, including everything that was rejected
 *
 * Two rules that are easy to get wrong and are load-bearing here:
 *  - the per-row report is read PAGINATED from disk, never inlined into `teach_datasets.summary` (a 2000-row report in
 *    the summary column would be read on every "My datasets" call);
 *  - `revision` changes while `id` stays, so anything keyed on the bytes keys on `(id, revision)` or on the sha256.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAcceptedRowStatus, type TeachConfig, type TeachDataset, type TeachDatasetRow, type TeachDatasetSource, type TeachDatasetSummary } from '@ngram/core';
import { TeachError } from './teach-error.js';
import { buildReportJson, canonicalBytes, canonicalJsonl, parseDataset, readCanonicalJsonl, type CanonicalRow, type ParseOptions, type ParseResult } from './teach-dataset.js';
import { TEACH_SAMPLES, sampleOf } from './teach-samples.js';
import type { Store, TeachDatasetRecord } from './store.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const dayKey = (now: number) => new Date(now).toISOString().slice(0, 10);
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** What the dataset service needs from the worker — a small surface, so neither module imports the other. */
export interface DatasetHost {
  store: Store;
  dataDir: string;
  cfg(): TeachConfig & { pausedReason?: string; blockedTopics?: string };
  log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void;
  /** Statuses that mean "a job is using this dataset right now". */
  activeJobStatuses: string[];
}

export interface DatasetView extends TeachDataset { }

export interface CreateInput {
  owner: string;
  ip?: string;
  name?: string;
  retention?: 'keep' | 'delete_after_training';
  source: TeachDatasetSource | 'inline';
  /** Uploaded bytes (the file door). */
  bytes?: Buffer;
  filename?: string;
  /** Already-canonical questions (the chat door, the CLI, a fork, a v1 materialisation). */
  rows?: CanonicalRow[];
  parse?: ParseOptions;
  /** `x-ngram-dataset-sha256` — the value the v2 signature covered; re-hashed here (design §D14). */
  declaredSha256?: string;
  parentDataset?: string;
  /** Lineage (§5.3, Story B): the published KNOWLEDGE these rows were copied out of, and how many of them are its. */
  parentPatch?: string;
  parentDatasetSha?: string;
  inheritedRows?: number;
}

export interface CreateResult { dataset: DatasetView; report: { summary: TeachDatasetSummary; rows: TeachDatasetRow[] }; created: boolean }

export class TeachDatasets {
  /** In-memory per-IP create limiter, like the policy limiter — cheap, resets with the process. */
  private ipHits = new Map<string, { count: number; window: number }>();

  constructor(private readonly host: DatasetHost) {}

  private get store() { return this.host.store; }
  private get cfg() { return this.host.cfg(); }
  get root(): string { return join(this.host.dataDir, 'teach', 'datasets'); }
  dir(id: string): string { return join(this.root, id); }
  /** Where multer writes an upload before the node has decided anything about it. */
  get incoming(): string { return join(this.host.dataDir, 'teach', 'incoming'); }

  // ------------------------------------------------------------ views

  view(d: TeachDatasetRecord): DatasetView {
    const jobs = this.store.listTeachJobs({ dataset_id: d.id, limit: 200 });
    return {
      id: d.id, owner_address: d.owner, name: d.name, status: d.status, source: d.source,
      sha256: d.sha256, revision: d.revision, rows: d.rows, invalid_rows: d.invalid_rows, size_bytes: d.size_bytes,
      ...(d.source_bytes !== null ? { source_bytes: d.source_bytes } : {}),
      ...(d.source_name ? { source_name: d.source_name } : {}),
      ...(d.format ? { format: d.format as TeachDataset['format'] } : {}),
      ...(d.encoding ? { encoding: d.encoding } : {}),
      ...(d.layout ? { layout: d.layout } : {}),
      ...(d.delimiter ? { delimiter: d.delimiter } : {}),
      ...(d.has_header !== null ? { has_header: d.has_header } : {}),
      ...(d.columns ? { columns: d.columns } : {}),
      summary: d.summary ?? emptySummary(),
      ...(d.parent_dataset ? { parent_dataset: d.parent_dataset } : {}),
      ...(d.parent_patch ? { parent_patch: d.parent_patch } : {}),
      ...(d.parent_dataset_sha ? { parent_dataset_sha: d.parent_dataset_sha } : {}),
      ...(d.inherited_rows !== null ? { inherited_rows: d.inherited_rows } : {}),
      retention: d.retention,
      job_ids: jobs.map((j) => j.id),
      created_at: d.created_at, updated_at: d.updated_at,
      ...(d.expires_at !== null ? { expires_at: d.expires_at } : {}),
      ...(d.deleted_at !== null ? { deleted_at: d.deleted_at } : {}),
    };
  }

  get(id: string): TeachDatasetRecord | null { return this.store.getTeachDataset(id); }
  /** Never confirm a stranger's dataset exists: the caller gets the same 404 either way. */
  owned(id: string, address: string | null, operator = false): TeachDatasetRecord {
    const d = this.store.getTeachDataset(id);
    if (!d) throw new TeachError(404, 'dataset_not_found: no such dataset on this node');
    if (operator) return d;
    if (!address || d.owner.toLowerCase() !== address.toLowerCase()) throw new TeachError(404, 'dataset_not_found: no such dataset on this node');
    return d;
  }
  listMine(address: string): DatasetView[] {
    return this.store.listTeachDatasets({ owner: address, includeDeleted: true }).map((d) => this.view(d));
  }
  listAll(limit = 200): (DatasetView & { ip: string | null; owner: string })[] {
    return this.store.listTeachDatasets({ includeDeleted: true, limit }).map((d) => ({ ...this.view(d), ip: d.ip, owner: d.owner }));
  }

  // ------------------------------------------------------------ quotas and the pre-multer gate (§7.1 ordering rule)

  quota(address: string, ip: string | undefined, now = Date.now()) {
    const c = this.cfg.dataset; const day = dayKey(now);
    const key = address.toLowerCase();
    return {
      datasets_remaining: Math.max(0, c.perKeyPerDay - this.store.teachQuotaCount(`ds:addr:${key}`, day)),
      kept_remaining: Math.max(0, c.keptPerKey - this.store.countTeachDatasets(address)),
      bytes_remaining: Math.max(0, c.bytesPerKeyPerDay - this.store.teachQuotaCount(`bytes:addr:${key}`, day)),
      rows_remaining: Math.max(0, c.rowsPerKeyPerDay - this.store.teachQuotaCount(`rows:addr:${key}`, day)),
      rows_ip_remaining: ip ? Math.max(0, c.rowsPerIpPerDay - this.store.teachQuotaCount(`rows:ip:${ip}`, day)) : c.rowsPerIpPerDay,
    };
  }

  /**
   * Runs BEFORE multer touches the disk: size, per-IP-per-minute limiter, dataset count and the byte quota. Registering
   * the upload middleware first (the pattern `/api/patches` uses) would let a banned key write 4 MB per request.
   * The bytes are charged here, before parsing — they are the scarce resource, not the parse.
   */
  gate(address: string, ip: string | undefined, bytes: number, now = Date.now()) {
    const c = this.cfg.dataset;
    if (bytes > c.maxBytes) throw new TeachError(413, `dataset_too_large: this node accepts files up to ${Math.round(c.maxBytes / 1e6)} MB`, { bytes, max_bytes: c.maxBytes });
    if (ip) {
      if (this.ipHits.size > 5000) for (const [k, v] of this.ipHits) if (now - v.window > 60_000) this.ipHits.delete(k);
      const u = this.ipHits.get(ip);
      const cur = u && now - u.window < 60_000 ? u : { count: 0, window: now };
      cur.count++; this.ipHits.set(ip, cur);
      if (cur.count > c.createsPerIpPerMin) throw new TeachError(429, 'rate_limited: too many datasets from this address in the last minute', { per_min: c.createsPerIpPerMin });
    }
    const q = this.quota(address, ip, now);
    if (q.kept_remaining <= 0) throw new TeachError(429, `quota_dataset: this node keeps ${c.keptPerKey} datasets for one teaching key — delete one first`, { kept: c.keptPerKey });
    if (q.datasets_remaining <= 0) throw new TeachError(429, `quota_dataset: ${c.perKeyPerDay} new datasets per day for one teaching key`, { per_day: c.perKeyPerDay, remaining: 0 });
    if (bytes > q.bytes_remaining) throw new TeachError(429, 'quota_bytes: you have uploaded as much as this node accepts from one teaching key today', { bytes, remaining: q.bytes_remaining });
    if (bytes > 0) this.store.teachQuotaBump(`bytes:addr:${address.toLowerCase()}`, dayKey(now), bytes);
  }

  /** Questions trained today — charged when a lesson is created, which is when the GPU-seconds are actually spent. */
  chargeRows(address: string, ip: string | undefined, rows: number, now = Date.now()) {
    const day = dayKey(now);
    this.store.teachQuotaBump(`rows:addr:${address.toLowerCase()}`, day, rows);
    if (ip) this.store.teachQuotaBump(`rows:ip:${ip}`, day, rows);
  }

  // ------------------------------------------------------------ create (§7.1)

  create(input: CreateInput, now = Date.now()): CreateResult {
    const c = this.cfg;
    const limits = c.dataset;
    let parsed: ParseResult;
    let sourceBytes: Buffer | null = null;
    if (input.bytes) {
      sourceBytes = input.bytes;
      if (input.declaredSha256 && input.declaredSha256.toLowerCase() !== sha256(sourceBytes)) {
        throw new TeachError(400, 'dataset_hash: the file changed while it was being uploaded — try again');
      }
      if (sourceBytes.length > limits.maxBytes) throw new TeachError(413, `dataset_too_large: this node accepts files up to ${Math.round(limits.maxBytes / 1e6)} MB`, { bytes: sourceBytes.length, max_bytes: limits.maxBytes });
      parsed = parseDataset(sourceBytes, {
        ...input.parse, filename: input.filename ?? input.parse?.filename,
        maxSourceLines: limits.maxSourceLines, maxRows: limits.maxRows, blockedTopics: c.blockedTopics,
      });
    } else {
      const rows = input.rows ?? [];
      if (!rows.length) throw new TeachError(400, 'dataset_empty: a dataset needs at least one question and answer');
      parsed = parseDataset(canonicalBytes(rows), { format: 'jsonl', maxSourceLines: limits.maxSourceLines, maxRows: limits.maxRows, blockedTopics: c.blockedTopics });
    }
    if (!parsed.rows.length) {
      throw new TeachError(400, parsed.report.length ? 'dataset_empty: that file has no usable questions — every line needs a question and a right answer' : 'dataset_format: this node could not read that file as a dataset',
        { report: { summary: parsed.summary, rows: parsed.report.slice(0, 50) } });
    }

    const bytes = canonicalBytes(parsed.rows);
    const sha = sha256(bytes);
    const existing = this.store.findTeachDatasetBySha(input.owner, sha);
    if (existing) {
      // idempotent re-upload: the same bytes from the same key are the same dataset; no dataset quota is charged
      return { dataset: this.view(existing), report: this.reportPage(existing, { limit: 50 }), created: false };
    }

    const id = randomUUID();
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    writeFileSync(join(dir, 'rows.jsonl'), bytes, { mode: FILE_MODE });
    writeFileSync(join(dir, 'report.json'), JSON.stringify(buildReportJson(parsed)), { mode: FILE_MODE });
    if (sourceBytes) writeFileSync(join(dir, `source.${parsed.format}`), sourceBytes, { mode: FILE_MODE });

    const source: TeachDatasetSource = input.source === 'inline' ? 'chat' : input.source;
    const name = (input.name?.trim() || defaultName(source, input.filename, now)).slice(0, 80);
    const rec: TeachDatasetRecord = {
      id, owner: input.owner, ip: input.ip ?? null, name,
      status: sourceBytes ? 'staged' : 'ready', source,
      format: parsed.format, encoding: parsed.encoding, layout: parsed.layout ?? null, delimiter: parsed.delimiter ?? null,
      has_header: parsed.has_header ?? null, columns: (parsed.columns as Record<string, string | number>) ?? null,
      sha256: sha, revision: 1, rows: parsed.rows.length, invalid_rows: parsed.summary.rejected, size_bytes: bytes.length,
      source_bytes: sourceBytes ? sourceBytes.length : null, source_name: input.filename ?? null, source_sha256: sourceBytes ? sha256(sourceBytes) : null,
      dir, summary: parsed.summary, parent_dataset: input.parentDataset ?? null,
      parent_patch: input.parentPatch ?? null, parent_dataset_sha: input.parentDatasetSha ?? null,
      // counted from the bytes that were actually accepted, never from what the caller claimed
      inherited_rows: input.parentPatch ? parsed.rows.filter((r) => r.from ?? r.replaces).length : null,
      retention: input.retention ?? 'keep',
      created_at: now, updated_at: now, expires_at: now + limits.ttlDays * 86_400_000, deleted_at: null,
    };
    this.store.insertTeachDataset(rec);
    this.store.teachQuotaBump(`ds:addr:${input.owner.toLowerCase()}`, dayKey(now));
    // the questions themselves never appear in a log line — /api/events is public
    this.host.log('info', `dataset ${id} created (${source}, ${parsed.rows.length} question(s), ${parsed.summary.rejected} not used, ${parsed.format}/${parsed.encoding})`, { dataset_id: id, rows: parsed.rows.length });
    return { dataset: this.view(rec), report: { summary: parsed.summary, rows: parsed.report.slice(0, 50) }, created: true };
  }

  /** Sample dataset → a real dataset owned by the caller, so the rest of the pipeline has nothing special to know. */
  createFromSample(kind: string, input: Omit<CreateInput, 'source' | 'rows' | 'bytes'>, now = Date.now()): CreateResult {
    const s = sampleOf(kind);
    if (!s) throw new TeachError(404, `dataset_not_found: no sample dataset called "${kind}"`);
    return this.create({ ...input, source: 'sample', name: input.name ?? s.name, rows: s.rows }, now);
  }

  // ------------------------------------------------------------ read

  rows(d: TeachDatasetRecord): CanonicalRow[] {
    const p = join(d.dir, 'rows.jsonl');
    if (!existsSync(p)) return [];
    return readCanonicalJsonl(readFileSync(p, 'utf8'));
  }
  /**
   * The rows, or a refusal — for every caller that would otherwise build a NEW dataset out of nothing. A dataset whose
   * file was removed (retention, or a tombstone) still reports `rows > 0`, so an edit or a fork of it would silently
   * produce a dataset holding only the appended rows (design §11).
   */
  rowsOrThrow(d: TeachDatasetRecord): CanonicalRow[] {
    const rows = this.rows(d);
    if (!rows.length && d.rows > 0) throw new TeachError(404, 'dataset_not_found: the questions of this dataset are no longer on this node');
    return rows;
  }
  canonicalBytesOf(d: TeachDatasetRecord): Buffer {
    const p = join(d.dir, 'rows.jsonl');
    if (!existsSync(p)) throw new TeachError(404, 'dataset_not_found: the questions of this dataset are no longer on this node');
    return readFileSync(p);
  }
  /** Indexes (in rows.jsonl) of the accepted rows flagged as personal information — the publish gate reads this (§6.5). */
  piiRows(d: TeachDatasetRecord): { index: number; kinds: string[] }[] {
    const rep = this.reportJson(d);
    return (((rep?.rows as TeachDatasetRow[]) ?? []).filter((r) => r.status === 'pii' && r.index !== null)).map((r) => ({ index: r.index!, kinds: r.pii ?? [] }));
  }
  reportJson(d: TeachDatasetRecord): Record<string, unknown> | null {
    const p = join(d.dir, 'report.json');
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return null; }
  }
  /** Paginated report (§6.7): the per-row report is never inlined into the dataset row. */
  reportPage(d: TeachDatasetRecord, opts: { offset?: number; limit?: number; status?: string } = {}): { summary: TeachDatasetSummary; rows: TeachDatasetRow[]; total: number; source_rows: number; offset: number; limit: number } {
    const rep = this.reportJson(d);
    const all = ((rep?.rows as TeachDatasetRow[]) ?? []);
    const filter = opts.status && opts.status !== 'all'
      ? opts.status === 'ok' ? (r: TeachDatasetRow) => isAcceptedRowStatus(r.status)
        : opts.status === 'rejected' ? (r: TeachDatasetRow) => !isAcceptedRowStatus(r.status)
          : (r: TeachDatasetRow) => r.status === opts.status
      : () => true;
    const rows = all.filter(filter);
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    return {
      summary: (rep?.summary as TeachDatasetSummary) ?? d.summary ?? emptySummary(),
      rows: rows.slice(offset, offset + limit), total: rows.length,
      source_rows: (rep?.source_rows as number) ?? d.rows + d.invalid_rows, offset, limit,
    };
  }
  /** `format=csv` renders the same questions as RFC 4180 so a spreadsheet round-trips; `jsonl` is the sha256 subject. */
  download(d: TeachDatasetRecord, format: 'jsonl' | 'csv' = 'jsonl'): { body: Buffer; filename: string; contentType: string; sha256: string } {
    const bytes = this.canonicalBytesOf(d);
    if (format === 'jsonl') return { body: bytes, filename: `dataset-${d.id}-r${d.revision}.jsonl`, contentType: 'application/x-ndjson; charset=utf-8', sha256: d.sha256 };
    const rows = readCanonicalJsonl(bytes.toString('utf8'));
    const q = (s: string | undefined) => (s === undefined ? '' : /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const csv = ['prompt,answer,alt_prompt,note', ...rows.map((r) => [q(r.prompt), q(r.answer), q(r.alt_prompt), q(r.note)].join(','))].join('\n') + '\n';
    return { body: Buffer.from(csv, 'utf8'), filename: `dataset-${d.id}-r${d.revision}.csv`, contentType: 'text/csv; charset=utf-8', sha256: d.sha256 };
  }

  samples() {
    return TEACH_SAMPLES.map((s) => ({
      kind: s.kind, name: s.name, description: s.description, rows: s.rows.length,
      sha256: sha256(canonicalBytes(s.rows)),
      preview: s.rows.slice(0, 5).map((r, i): TeachDatasetRow => ({ index: i, line: i + 1, status: 'ok', prompt: r.prompt, answer: r.answer, ...(r.alt_prompt ? { alt_prompt: r.alt_prompt } : {}) })),
      download_url: `/api/teach/samples/${s.kind}`,
    }));
  }
  sampleBytes(kind: string): Buffer {
    const s = sampleOf(kind);
    if (!s) throw new TeachError(404, `dataset_not_found: no sample dataset called "${kind}"`);
    return canonicalBytes(s.rows);
  }

  // ------------------------------------------------------------ edit (§7.2, §11)

  /** A dataset a running lesson is reading must not change under it — the client forks instead. */
  private assertIdle(d: TeachDatasetRecord) {
    const busy = this.store.listTeachJobs({ dataset_id: d.id }).filter((j) => this.host.activeJobStatuses.includes(j.status));
    if (busy.length) throw new TeachError(409, 'dataset_in_use: this dataset is being trained right now — make a copy to edit it', { job_ids: busy.map((j) => j.id) });
  }

  /** Re-read the ORIGINAL upload with different parser settings. Nothing is re-uploaded; `staged` datasets only. */
  reparse(d: TeachDatasetRecord, opts: ParseOptions, now = Date.now()): CreateResult {
    this.assertIdle(d);
    if (d.status !== 'staged') throw new TeachError(409, 'dataset_in_use: only a dataset that has never been trained can be re-read — make a copy instead');
    const src = d.format ? join(d.dir, `source.${d.format}`) : null;
    const found = src && existsSync(src) ? src : ['jsonl', 'json', 'csv', 'tsv', 'txt'].map((e) => join(d.dir, `source.${e}`)).find((p) => existsSync(p));
    if (!found) throw new TeachError(409, 'dataset_format: the original file is no longer on this node — upload it again');
    const bytes = readFileSync(found);
    const limits = this.cfg.dataset;
    const parsed = parseDataset(bytes, { ...opts, filename: d.source_name ?? undefined, maxSourceLines: limits.maxSourceLines, maxRows: limits.maxRows, blockedTopics: this.cfg.blockedTopics });
    if (!parsed.rows.length) throw new TeachError(400, 'dataset_empty: read that way, the file has no usable questions', { report: { summary: parsed.summary, rows: parsed.report.slice(0, 50) } });
    return this.rewrite(d, parsed, now, found !== join(d.dir, `source.${parsed.format}`) ? found : null);
  }

  /** `{name?, retention?, rows_op?}` — the touched rows are revalidated against the whole set, so a new duplicate or contradiction is caught. */
  patch(d: TeachDatasetRecord, body: { name?: string; retention?: 'keep' | 'delete_after_training'; rows_op?: RowsOp }, now = Date.now()): CreateResult {
    if (body.rows_op) this.assertIdle(d);
    const patchRec: Partial<TeachDatasetRecord> = {};
    if (body.name !== undefined) patchRec.name = body.name.trim().slice(0, 80) || d.name;
    if (body.retention !== undefined) patchRec.retention = body.retention;
    if (Object.keys(patchRec).length) this.store.updateTeachDataset(d.id, patchRec);
    if (!body.rows_op) {
      const fresh = this.store.getTeachDataset(d.id)!;
      return { dataset: this.view(fresh), report: this.reportPage(fresh, { limit: 50 }), created: false };
    }
    const next = applyRowsOp(this.rowsOrThrow(d), body.rows_op);
    if (!next.length) throw new TeachError(400, 'dataset_empty: a dataset needs at least one question');
    const limits = this.cfg.dataset;
    const parsed = parseDataset(canonicalBytes(next), { format: 'jsonl', maxSourceLines: limits.maxSourceLines, maxRows: limits.maxRows, blockedTopics: this.cfg.blockedTopics });
    if (!parsed.rows.length) throw new TeachError(400, 'dataset_empty: after that change the dataset has no usable questions', { report: { summary: parsed.summary, rows: parsed.report.slice(0, 50) } });
    return this.rewrite(this.store.getTeachDataset(d.id)!, parsed, now, null);
  }

  /** A copy with `parent_dataset` set and `revision = 1` — how a dataset is edited while a lesson is training. */
  fork(d: TeachDatasetRecord, input: { owner: string; ip?: string; name?: string; rows_op?: RowsOp }, now = Date.now()): CreateResult {
    const rows = input.rows_op ? applyRowsOp(this.rowsOrThrow(d), input.rows_op) : this.rowsOrThrow(d);
    if (!rows.length) throw new TeachError(400, 'dataset_empty: a dataset needs at least one question');
    return this.create({
      owner: input.owner, ip: input.ip, name: input.name ?? `${d.name} (copy)`, source: d.source === 'upload' ? 'derived' : d.source,
      rows, retention: d.retention, parentDataset: d.id,
      // a copy of a copy is still built on the same knowledge — the rows still carry its `from` pointers
      ...(d.parent_patch ? { parentPatch: d.parent_patch, ...(d.parent_dataset_sha ? { parentDatasetSha: d.parent_dataset_sha } : {}) } : {}),
    }, now);
  }

  /**
   * Story B — *Copy and continue*: a published knowledge's training set becomes a dataset in MY *My datasets*, every
   * row pointing back at the row it came from (`from: '<patch>#<i>'`). Re-forking the same bytes returns the same
   * dataset (the owner-scoped sha dedup in `create`), so the button is idempotent.
   *
   * `rows` are the parent's published bytes — the caller (the worker, which owns the access rules and the p2p fetch)
   * has already decided this key may have them.
   */
  forkFromPatch(input: { owner: string; ip?: string; name?: string; patchId: string; datasetSha: string; rows: CanonicalRow[] }, now = Date.now()): CreateResult {
    if (!input.rows.length) throw new TeachError(404, `dataset_unavailable: the training set of ${input.patchId} has no questions on this node`, { id: input.patchId });
    // provenance is rewritten to point at the DIRECT parent: what a verifier checks is that my row's (prompt, answer)
    // is byte-equal to that row of THIS knowledge's set (§6.3), not what the grandparent called it.
    const rows: CanonicalRow[] = input.rows.map((r, i) => ({ prompt: r.prompt, answer: r.answer, ...(r.alt_prompt ? { alt_prompt: r.alt_prompt } : {}), ...(r.note ? { note: r.note } : {}), from: `${input.patchId}#${i}` }));
    return this.create({
      owner: input.owner, ip: input.ip, name: input.name, source: 'derived', rows,
      parentPatch: input.patchId, parentDatasetSha: input.datasetSha,
    }, now);
  }

  /** New bytes for the same id: revision++, sha256 changes, report rewritten. */
  private rewrite(d: TeachDatasetRecord, parsed: ParseResult, now: number, oldSource: string | null): CreateResult {
    const bytes = canonicalBytes(parsed.rows);
    const sha = sha256(bytes);
    const clash = this.store.findTeachDatasetBySha(d.owner, sha);
    if (clash && clash.id !== d.id) return { dataset: this.view(clash), report: this.reportPage(clash, { limit: 50 }), created: false };
    mkdirSync(d.dir, { recursive: true, mode: DIR_MODE });
    writeFileSync(join(d.dir, 'rows.jsonl'), bytes, { mode: FILE_MODE });
    writeFileSync(join(d.dir, 'report.json'), JSON.stringify(buildReportJson(parsed)), { mode: FILE_MODE });
    if (oldSource) { const dest = join(d.dir, `source.${parsed.format}`); try { renameSync(oldSource, dest); } catch { /* keep the old name */ } }
    this.store.updateTeachDataset(d.id, {
      sha256: sha, revision: d.revision + 1, rows: parsed.rows.length, invalid_rows: parsed.summary.rejected, size_bytes: bytes.length,
      summary: parsed.summary, format: parsed.format, encoding: parsed.encoding, layout: parsed.layout ?? null,
      delimiter: parsed.delimiter ?? null, has_header: parsed.has_header ?? null, columns: (parsed.columns as Record<string, string | number>) ?? null,
      expires_at: now + this.cfg.dataset.ttlDays * 86_400_000,
    });
    const fresh = this.store.getTeachDataset(d.id)!;
    this.host.log('info', `dataset ${d.id} is now revision ${fresh.revision} (${parsed.rows.length} question(s))`, { dataset_id: d.id, rows: parsed.rows.length });
    return { dataset: this.view(fresh), report: { summary: parsed.summary, rows: parsed.report.slice(0, 50) }, created: false };
  }

  /**
   * Files removed, row kept as a tombstone so a lesson trained from it reads "the dataset for this lesson was deleted
   * by its owner" instead of pointing at a dangling id.
   */
  remove(d: TeachDatasetRecord, by: 'owner' | 'operator', now = Date.now()): { ok: true; status: 'deleted' } {
    this.assertIdle(d);
    this.removeFiles(d);
    this.store.deleteTeachDataset(d.id, now);
    this.host.log('info', `dataset ${d.id} deleted by ${by} — files removed, the lessons trained from it are kept`, { dataset_id: d.id });
    return { ok: true, status: 'deleted' };
  }
  private removeFiles(d: TeachDatasetRecord, keepReport = false) {
    if (!d.dir || !existsSync(d.dir)) return;
    if (!keepReport) { try { rmSync(d.dir, { recursive: true, force: true }); } catch { /* ignore */ } return; }
    for (const f of ['rows.jsonl', 'source.jsonl', 'source.json', 'source.csv', 'source.tsv', 'source.txt']) {
      const p = join(d.dir, f);
      if (existsSync(p)) { try { rmSync(p, { force: true }); } catch { /* ignore */ } }
    }
  }

  /** `retention: 'delete_after_training'` — the file goes as soon as the lesson is finished; report.json and the sha256 stay. */
  afterTraining(datasetId: string | null) {
    if (!datasetId) return;
    const d = this.store.getTeachDataset(datasetId);
    if (!d || d.retention !== 'delete_after_training' || d.status === 'deleted') return;
    const busy = this.store.listTeachJobs({ dataset_id: d.id }).filter((j) => this.host.activeJobStatuses.includes(j.status));
    if (busy.length) return;
    this.removeFiles(d, true);
    this.store.updateTeachDataset(d.id, { size_bytes: 0 });
    this.host.log('info', `dataset ${d.id} removed as its owner asked (delete as soon as training finishes)`, { dataset_id: d.id });
  }

  markStatus(datasetId: string | null, status: 'ready' | 'in_use') {
    if (!datasetId) return;
    const d = this.store.getTeachDataset(datasetId);
    if (!d || d.status === 'deleted') return;
    if (d.status !== status) this.store.updateTeachDataset(d.id, { status });
  }

  /**
   * Three sweep passes (§11): `staged` datasets never used by a job, `ready` datasets whose last job finished more than
   * `ttlDays` ago, and the leftover files of tombstoned rows.
   */
  sweep(now = Date.now()) {
    const c = this.cfg.dataset;
    for (const d of this.store.listTeachDatasets({ includeDeleted: true, limit: 2000 })) {
      if (d.status === 'deleted') { if (existsSync(d.dir)) this.removeFiles(d); continue; }
      const jobs = this.store.listTeachJobs({ dataset_id: d.id, limit: 200 });
      if (jobs.some((j) => this.host.activeJobStatuses.includes(j.status))) continue;
      if (d.status === 'staged' && !jobs.length) {
        if (d.created_at + c.stagedTtlHours * 3600_000 > now) continue;
        this.removeFiles(d); this.store.deleteTeachDataset(d.id, now);
        this.host.log('info', `dataset ${d.id} removed — uploaded ${c.stagedTtlHours} h ago and never trained`, { dataset_id: d.id });
        continue;
      }
      const last = jobs.length ? Math.max(...jobs.map((j) => j.finished_at ?? j.updated_at)) : d.updated_at;
      if (last + c.ttlDays * 86_400_000 > now) continue;
      this.removeFiles(d); this.store.deleteTeachDataset(d.id, now);
      this.host.log('info', `dataset ${d.id} removed after ${c.ttlDays} days`, { dataset_id: d.id });
    }
  }
}

// ------------------------------------------------------------------ helpers

export type RowsOp =
  | { op: 'remove'; indexes: number[] }
  | { op: 'append'; rows: CanonicalRow[] }
  | { op: 'replace'; index: number; row: CanonicalRow };

export function applyRowsOp(rows: CanonicalRow[], op: RowsOp): CanonicalRow[] {
  if (op.op === 'remove') { const drop = new Set(op.indexes); return rows.filter((_, i) => !drop.has(i)); }
  // a new question is MINE, whatever the client sent: provenance is written by the node, never accepted from a form
  if (op.op === 'append') return [...rows, ...op.rows.map((r) => ({ prompt: r.prompt, answer: r.answer, ...(r.alt_prompt ? { alt_prompt: r.alt_prompt } : {}), ...(r.note ? { note: r.note } : {}) }))];
  const out = [...rows];
  if (op.index < 0 || op.index >= out.length) throw new TeachError(400, `invalid: there is no question #${op.index} in this dataset`);
  const prev = out[op.index];
  const ref = prev.replaces ?? prev.from;
  const untouched = prev.prompt === op.row.prompt && prev.answer === op.row.answer;
  const row: CanonicalRow = { prompt: op.row.prompt, answer: op.row.answer, ...(op.row.alt_prompt ? { alt_prompt: op.row.alt_prompt } : {}), ...(op.row.note ? { note: op.row.note } : {}) };
  // Editing an inherited answer keeps the pointer and turns it into `replaces` (design §6.7): the row still says which
  // question of the base it stands in for, which is what makes "changes k of {name}'s answers" a counted fact and
  // keeps the trainer from being asked to hold both answers at once.
  out[op.index] = ref && !untouched ? { ...row, replaces: ref } : ref ? { ...row, ...(prev.from ? { from: prev.from } : {}), ...(prev.replaces ? { replaces: prev.replaces } : {}) } : row;
  return out;
}

function defaultName(source: TeachDatasetSource, filename: string | undefined, now: number): string {
  if (filename) return filename.replace(/\.[^.]+$/, '').slice(0, 80) || 'dataset';
  const day = new Date(now).toISOString().slice(0, 10);
  return source === 'chat' ? `your-dataset-${day}` : source === 'derived' ? `lesson-dataset-${day}` : `dataset-${day}`;
}

export const emptySummary = (): TeachDatasetSummary => ({
  source_rows: 0, accepted: 0, fixed: 0, rejected: 0, duplicates: 0, conflicts: 0, blocked: 0, too_long: 0,
  empty: 0, not_parsed: 0, over_cap: 0, shared_ending: 0, pii: 0, langs: { hangul: 0, latin: 0, han: 0, kana: 0, other: 0 },
});

/** The canonical filename a frozen chat basket is presented under ("your 3 corrections were saved as …"). */
export const basketFilename = (now = Date.now()) => `your-dataset-${new Date(now).toISOString().slice(0, 10)}.jsonl`;

export { canonicalJsonl };
