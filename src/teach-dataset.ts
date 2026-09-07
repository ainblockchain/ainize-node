/**
 * Teach mode v2 — the dataset parser and validator (design `docs/teachable-dataset-design.md` §8).
 *
 * PURE functions over a `Buffer`: no filesystem, no database, no network, no clock. Everything the node promises the
 * visitor about their file — what was read, what was tidied up, what was refused and why, at which line — is decided
 * here, once, server-side (§D2: the browser may render a local preview, but this output replaces it).
 *
 * Rules that are easy to get wrong and are therefore load-bearing:
 *  - NOTHING is silently dropped. Every source row that does not become a trained question gets a report entry with a
 *    status, a reason and its 1-based LOGICAL source line (a quoted CSV newline is one row, not two).
 *  - The canonical form (`rows.jsonl`) is byte-stable: the same logical data arriving as jsonl / json / csv / tsv / txt
 *    hashes to the same sha256, so a chat basket and an uploaded file are the same artifact by the time training sees them.
 *  - Contradictions block, duplicates drop the later copy, over-length blocks, and `shared_ending` only warns (§8.5).
 */
import { createHash } from 'node:crypto';
import type { TeachDatasetFormat, TeachDatasetLang, TeachDatasetRow, TeachDatasetSummary, TeachPiiKind, TeachRowStatus } from '@ainize/core';

// ------------------------------------------------------------------ shape

/**
 * One accepted question, canonical field order. This is what a line of `rows.jsonl` decodes to.
 *
 * `from` / `replaces` are the PROVENANCE of an inherited row (lineage design §5.2): `from = '<parent_patch_id>#<row
 * index in the parent set>'` on a row copied unchanged from the knowledge this set was forked from, `replaces` the
 * same pointer on a row whose answer the new owner changed. Both live INSIDE the hashed bytes, so "these 2,761
 * questions came from krx-all-2761, and I changed three of them" is part of the set's identity and can be checked
 * against the parent's own bytes (§6.3) rather than believed.
 */
export interface CanonicalRow { prompt: string; answer: string; alt_prompt?: string; note?: string; from?: string; replaces?: string }

/** `<patch id>#<row index>` — the only shape a provenance pointer may have; anything else is dropped, never trusted. */
const ROW_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}#(0|[1-9][0-9]{0,8})$/;
export const isRowRef = (s: unknown): s is string => typeof s === 'string' && ROW_REF.test(s);
/** The patch id a `from` / `replaces` pointer names (null when the pointer is malformed). */
export function rowRefPatch(ref: string | undefined): string | null { return isRowRef(ref) ? ref!.slice(0, ref!.lastIndexOf('#')) : null; }
export function rowRefIndex(ref: string | undefined): number | null { return isRowRef(ref) ? Number(ref!.slice(ref!.lastIndexOf('#') + 1)) : null; }

export type TxtLayout = 'tsv' | 'qa' | 'blocks' | 'prompts';

export interface ParseOptions {
  /** Explicit format wins over the extension, which wins over sniffing. */
  format?: TeachDatasetFormat;
  /** Used only to guess the format when `format` is absent. */
  filename?: string;
  /** Force a text encoding ('utf-8' | 'utf-16le' | 'utf-16be' | 'euc-kr' | 'latin1'); otherwise it is detected. */
  encoding?: string;
  delimiter?: string;
  hasHeader?: boolean;
  layout?: TxtLayout;
  /** Column mapping by header name or 0-based index, e.g. `{prompt: 'question', answer: 2}`. */
  columns?: Record<string, string | number>;
  maxSourceLines?: number;
  maxRows?: number;
  promptMax?: number;
  answerMax?: number;
  noteMax?: number;
  /** Operator's `blockedTopics` regular expression source. */
  blockedTopics?: string;
}

export interface ParseResult {
  format: TeachDatasetFormat;
  encoding: string;
  layout?: TxtLayout;
  delimiter?: string;
  has_header?: boolean;
  columns?: Record<string, string | number>;
  source_rows: number;
  /** true when the file was longer than `maxSourceLines` and the tail was not read. */
  truncated: boolean;
  /** Accepted questions, in source order — exactly what `rows.jsonl` contains. */
  rows: CanonicalRow[];
  /** One entry per non-blank source row. */
  report: TeachDatasetRow[];
  summary: TeachDatasetSummary;
  /** Machine-readable informational notes: 'extra_columns', 'blank_rows:<n>', 'mixed_scripts', 'replacement_chars', 'truncated', 'system_messages:<n>', 'not_text'. */
  notes: string[];
  /** The printable-text check (§8.1). `ok: false` = the caller must refuse the file, not walk the visitor to Train. */
  text_quality: TextQuality;
}

export const DEFAULTS = { maxSourceLines: 50_000, maxRows: 2_000, promptMax: 400, answerMax: 200, noteMax: 500 };

/**
 * Control / bidi / zero-width characters stripped from every dataset field — the SAME class `NAME_BLOCKLIST` uses for
 * display names (`teach.ts`). Dataset text has five public exits (trained answer, recipe.json, the on-chain
 * benchmark samples, RUN-LOCALLY.md, the live-test chat), so an RTL override in question 400 would render corrupted
 * text on an immutable public page.
 */
const CONTROLS = new RegExp('[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]', 'g');

/** Column aliases (§8.2), casefolded and whitespace/underscore-insensitive. */
export const FIELD_ALIASES: Record<keyof CanonicalRow, string[]> = {
  prompt: ['prompt', 'question', 'q', 'input', 'instruction', 'query', '질문', '문제', '입력'],
  answer: ['answer', 'a', 'output', 'response', 'completion', 'target', '답', '답변', '정답', '출력'],
  alt_prompt: ['altprompt', 'alt', 'altquestion', 'paraphrase', 'anotherway', '다른질문', '유사질문', '다른표현'],
  note: ['note', 'memo', 'source', 'comment', '설명', '비고'],
  // provenance, not content: exact names only, so a spreadsheet column called "출처" never becomes a lineage claim
  from: ['from'],
  replaces: ['replaces'],
};
const FIELD_ORDER: (keyof CanonicalRow)[] = ['prompt', 'answer', 'alt_prompt', 'note'];
/** Read from a JSON object, never mapped onto a spreadsheet column: a 5th CSV column is content, not a lineage claim. */
const PROVENANCE_FIELDS: (keyof CanonicalRow)[] = ['from', 'replaces'];
const aliasKey = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');
const ALIAS_TO_FIELD = new Map<string, keyof CanonicalRow>();
for (const f of [...FIELD_ORDER, ...PROVENANCE_FIELDS]) for (const a of FIELD_ALIASES[f]) ALIAS_TO_FIELD.set(aliasKey(a), f);

// ------------------------------------------------------------------ decoding (§8.1)

export interface DecodeResult { text: string; encoding: string; bom: boolean }

/**
 * BOM first, then the caller's hint, then strict UTF-8, then CP949/EUC-KR, then latin1. The chosen encoding is
 * reported and shown in the preview: a short CP949 file can decode as valid UTF-8 and produce mojibake that passes
 * every other check, so this is the most likely silent corruption in the whole pipeline.
 */
export function decodeBuffer(buf: Buffer, hint?: string): DecodeResult {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: decodeWith(buf.subarray(3), 'utf-8') ?? buf.subarray(3).toString('utf8'), encoding: 'utf-8', bom: true };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le', bom: true };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be', bom: true };
  if (hint) {
    const t = decodeWith(buf, hint);
    if (t !== null) return { text: t, encoding: hint.toLowerCase(), bom: false };
    return { text: new TextDecoder(safeEncoding(hint)).decode(buf), encoding: hint.toLowerCase(), bom: false };
  }
  const utf8 = decodeWith(buf, 'utf-8');
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8', bom: false };
  for (const enc of ['euc-kr', 'shift_jis']) {
    const t = decodeWith(buf, enc);
    if (t !== null) return { text: t, encoding: enc, bom: false };
  }
  return { text: buf.toString('latin1'), encoding: 'latin1', bom: false };
}
function safeEncoding(enc: string): string { try { new TextDecoder(enc); return enc; } catch { return 'utf-8'; } }
function decodeWith(buf: Buffer, enc: string): string | null {
  try { return new TextDecoder(enc, { fatal: true }).decode(buf); } catch { return null; }
}

/** What the printable-text check measured, so the refusal can show its working rather than just saying "no". */
export interface TextQuality {
  /** a NUL in the DECODED text — no text this node accepts contains one (UTF-16 source BYTES are full of them) */
  nul: boolean;
  /** C0/C1 control characters other than tab / CR / LF, as a fraction of the sampled characters */
  controls: number;
  /** U+FFFD replacement characters (what a wrong decoder leaves behind), as a fraction */
  replacement: number;
  /** private-use codepoints, as a fraction */
  private_use: number;
  /** characters looked at (the head of the file, capped) */
  sampled: number;
  /** false = this is not text this node can read as questions */
  ok: boolean;
}

/**
 * Does this look like TEXT at all? (§8.1)
 *
 * The extension cannot answer that: 4 KB of `/dev/urandom` renamed to `.csv` decodes under latin1, splits into
 * "rows" on whatever byte happens to be a comma and passes every other check in this file, because every other check
 * is about the SHAPE of a row and not about whether the bytes are language. So the parse measures what came out of
 * the decoder — a NUL, C0/C1 controls, U+FFFD, private-use codepoints — and the caller refuses the upload when the
 * mixture is not plausibly text. Deliberately generous (5 % of the sampled characters, and a NUL is decisive on its
 * own): a legitimate file with a stray control character must not be turned away.
 *
 * The NUL is counted in the DECODED text, not in the source bytes. UTF-16 is a text encoding this node reads and
 * names (`encoding: utf-16le`), and every UTF-16 file has a zero byte between its ASCII characters: measuring the
 * bytes refused every Korean spreadsheet exported as "Unicode text" with "this does not read as text". Decoded, a
 * blob is caught exactly as before — its zero bytes come back as U+0000 under utf-8 or latin1 alike.
 */
export function textQuality(buf: Buffer, text: string): TextQuality {
  const sample = text.slice(0, 65_536);
  let controls = 0; let replacement = 0; let priv = 0; let n = 0;
  for (const ch of sample) {
    const cp = ch.codePointAt(0)!;
    n++;
    if (cp === 0xfffd) { replacement++; continue; }
    if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f)) { controls++; continue; }
    if ((cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd) || (cp >= 0x100000 && cp <= 0x10fffd)) priv++;
  }
  const nul = sample.includes('\u0000');
  const denom = Math.max(1, n);
  const q = { nul, controls: controls / denom, replacement: replacement / denom, private_use: priv / denom, sampled: n, ok: false };
  q.ok = !nul && q.controls + q.replacement + q.private_use <= 0.05;
  return q;
}

// ------------------------------------------------------------------ delimited parsing (§8.2)

/**
 * RFC 4180 state machine: `""` escape, embedded delimiters and newlines inside quotes, `\r\n` / `\r` / `\n` all
 * accepted (a lone `\r` inside a quoted field is preserved). Rows are LOGICAL: `rows[i]` is source line `i + 1`.
 * Blank logical rows are kept as `[]` so the numbering still points at the right place in the file.
 */
export function parseDelimited(text: string, delim: string, maxRows: number): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let field = ''; let row: string[] = []; let inQ = false; let quoted = false; let i = 0;
  const endRow = () => {
    row.push(field); field = '';
    rows.push(row.length === 1 && row[0] === '' && !quoted ? [] : row);
    row = []; quoted = false;
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQ = true; quoted = true; i++; continue; }
    if (ch === delim) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      endRow();
      if (rows.length >= maxRows) return { rows, truncated: i < text.length };
      continue;
    }
    field += ch; i++;
  }
  if (field !== '' || row.length || quoted) endRow();
  return { rows, truncated: false };
}

const DELIM_CANDIDATES = [',', '\t', ';', '|'];

/** Most consistent modal field count ≥ 2 over the first 40 non-blank logical rows; tie → comma (§8.2). */
export function sniffDelimiter(text: string): { delimiter: string; consistency: number } | null {
  let best: { delimiter: string; consistency: number; mode: number } | null = null;
  for (const d of DELIM_CANDIDATES) {
    const { rows } = parseDelimited(text, d, 40);
    const counts = rows.filter((r) => r.length).map((r) => r.length);
    if (counts.length < 1) continue;
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    let mode = 0; let modeN = 0;
    for (const [c, n] of freq) if (n > modeN || (n === modeN && c > mode)) { mode = c; modeN = n; }
    if (mode < 2) continue;
    const consistency = modeN / counts.length;
    if (!best || consistency > best.consistency + 1e-9) best = { delimiter: d, consistency, mode };
  }
  return best ? { delimiter: best.delimiter, consistency: best.consistency } : null;
}

/** A header row: every cell non-numeric, ≤ 64 chars, unique after casefolding, and at least one is a known alias. */
export function looksLikeHeader(cells: string[]): boolean {
  if (cells.length < 2) return false;
  const seen = new Set<string>();
  let hit = false;
  for (const raw of cells) {
    const c = raw.trim();
    if (!c || c.length > 64) return false;
    if (/^[-+]?[\d.,]+$/.test(c)) return false;
    const k = aliasKey(c);
    if (seen.has(k)) return false;
    seen.add(k);
    if (ALIAS_TO_FIELD.has(k)) hit = true;
  }
  return hit;
}

// ------------------------------------------------------------------ format detection (§8.1)

export function detectFormat(text: string, opts: ParseOptions): TeachDatasetFormat {
  if (opts.format) return opts.format;
  const ext = (opts.filename ?? '').toLowerCase().match(/\.(jsonl|ndjson|json|csv|tsv|tab|txt|text)$/)?.[1];
  if (ext) return ext === 'ndjson' ? 'jsonl' : ext === 'tab' ? 'tsv' : ext === 'text' ? 'txt' : (ext as TeachDatasetFormat);
  const head = text.replace(/^\s+/, '');
  if (head.startsWith('[')) return 'json';
  if (head.startsWith('{')) return 'jsonl';
  const d = sniffDelimiter(text);
  if (d && d.consistency >= 0.8) return d.delimiter === '\t' ? 'tsv' : 'csv';
  return 'txt';
}

// ------------------------------------------------------------------ raw record extraction

interface RawRecord {
  line: number;
  draft: Partial<CanonicalRow>;
  /** set when the source row could not be read at all */
  error?: string;
  raw?: string;
}

function fieldsFromObject(o: Record<string, unknown>, notes: Set<string>): Partial<CanonicalRow> | null {
  // ChatML: last user message → prompt, last assistant message → answer; a leading system message is ignored and counted.
  const msgs = o.messages;
  if (Array.isArray(msgs)) {
    let prompt: string | undefined; let answer: string | undefined; let system = 0;
    for (const m of msgs as { role?: unknown; content?: unknown }[]) {
      if (!m || typeof m !== 'object') continue;
      const role = String(m.role ?? ''); const content = typeof m.content === 'string' ? m.content : '';
      if (role === 'user') prompt = content;
      else if (role === 'assistant') answer = content;
      else if (role === 'system') system++;
    }
    if (system) notes.add('system_messages');
    if (prompt === undefined && answer === undefined) return null;
    return { prompt, answer };
  }
  const out: Partial<CanonicalRow> = {};
  for (const [k, v] of Object.entries(o)) {
    const f = ALIAS_TO_FIELD.get(aliasKey(k));
    if (!f) continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    if (out[f] === undefined) out[f] = String(v);
  }
  // Alpaca: {instruction, input?, output} — `input` is appended to the instruction, never used as the answer.
  const instruction = typeof o.instruction === 'string' ? o.instruction : undefined;
  const input = typeof o.input === 'string' ? o.input.trim() : '';
  if (instruction !== undefined && input) out.prompt = `${instruction}\n${input}`;
  return Object.keys(out).length ? out : null;
}

function recordsFromJsonl(text: string, max: number, notes: Set<string>): { records: RawRecord[]; truncated: boolean; logical: number } {
  const lines = text.split(/\r\n|\r|\n/);
  const records: RawRecord[] = [];
  let truncated = false; let logical = 0;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    if (!s.trim()) { logical++; continue; }
    logical++;
    if (records.length >= max) { truncated = true; break; }
    try {
      const v = JSON.parse(s) as unknown;
      if (!v || typeof v !== 'object' || Array.isArray(v)) { records.push({ line: logical, draft: {}, error: 'line is not a JSON object', raw: s }); continue; }
      const d = fieldsFromObject(v as Record<string, unknown>, notes);
      if (!d) { records.push({ line: logical, draft: {}, error: 'no question/answer keys in this object', raw: s }); continue; }
      records.push({ line: logical, draft: d });
    } catch {
      records.push({ line: logical, draft: {}, error: 'line is not valid JSON', raw: s });
    }
  }
  return { records, truncated, logical };
}

function recordsFromJsonArray(text: string, max: number, notes: Set<string>): { records: RawRecord[]; truncated: boolean; logical: number } | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  const arr = Array.isArray(v) ? v : Array.isArray((v as { rows?: unknown[] })?.rows) ? (v as { rows: unknown[] }).rows : Array.isArray((v as { data?: unknown[] })?.data) ? (v as { data: unknown[] }).data : null;
  if (!arr) return null;
  const records: RawRecord[] = [];
  let truncated = false;
  for (const [i, item] of arr.entries()) {
    if (records.length >= max) { truncated = true; break; }
    if (!item || typeof item !== 'object' || Array.isArray(item)) { records.push({ line: i + 1, draft: {}, error: 'array entry is not an object', raw: JSON.stringify(item).slice(0, 200) }); continue; }
    const d = fieldsFromObject(item as Record<string, unknown>, notes);
    if (!d) { records.push({ line: i + 1, draft: {}, error: 'no question/answer keys in this object', raw: JSON.stringify(item).slice(0, 200) }); continue; }
    records.push({ line: i + 1, draft: d });
  }
  return { records, truncated, logical: arr.length };
}

interface DelimitedPlan { delimiter: string; hasHeader: boolean; columns: Record<string, number>; extra: boolean }

function planDelimited(rows: string[][], opts: ParseOptions, delimiter: string): DelimitedPlan {
  const first = rows.find((r) => r.length) ?? [];
  const hasHeader = opts.hasHeader ?? looksLikeHeader(first);
  const columns: Record<string, number> = {};
  if (opts.columns) {
    for (const [f, v] of Object.entries(opts.columns)) {
      if (!FIELD_ORDER.includes(f as keyof CanonicalRow)) continue;
      if (typeof v === 'number') { if (v >= 0) columns[f] = v; continue; }
      const idx = first.findIndex((c) => aliasKey(c) === aliasKey(v));
      if (idx >= 0) columns[f] = idx;
    }
  }
  if (!Object.keys(columns).length) {
    if (hasHeader) {
      for (const [i, cell] of first.entries()) {
        const f = ALIAS_TO_FIELD.get(aliasKey(cell));
        if (f && columns[f] === undefined) columns[f] = i;
      }
    }
    if (columns.prompt === undefined) columns.prompt = 0;
    if (columns.answer === undefined) columns.answer = columns.prompt === 0 ? 1 : 0;
    if (!hasHeader) { if (columns.alt_prompt === undefined) columns.alt_prompt = 2; if (columns.note === undefined) columns.note = 3; }
  }
  const used = new Set(Object.values(columns));
  const width = Math.max(...rows.filter((r) => r.length).map((r) => r.length), 0);
  return { delimiter, hasHeader, columns, extra: width > used.size };
}

function recordsFromDelimited(rows: string[][], plan: DelimitedPlan): RawRecord[] {
  const records: RawRecord[] = [];
  const need = Math.max(plan.columns.prompt ?? 0, plan.columns.answer ?? 0);
  for (const [i, cells] of rows.entries()) {
    const line = i + 1;
    if (!cells.length) continue;                                  // blank logical row
    if (plan.hasHeader && records.length === 0 && i === rows.findIndex((r) => r.length)) continue;
    if (cells.length <= need && cells.length < 2) { records.push({ line, draft: {}, error: `this line has ${cells.length} column(s); a question and an answer are needed`, raw: cells.join(plan.delimiter === '\t' ? '\t' : plan.delimiter).slice(0, 200) }); continue; }
    const at = (f: keyof CanonicalRow) => { const idx = plan.columns[f]; return idx === undefined ? undefined : cells[idx]; };
    records.push({ line, draft: { prompt: at('prompt'), answer: at('answer'), alt_prompt: at('alt_prompt'), note: at('note') } });
  }
  return records;
}

const Q_RE = /^\s*(?:Q|질문|문제)\s*[:.]\s*/i;
const A_RE = /^\s*(?:A|답변|정답|답)\s*[:.]\s*/i;

/** Which TXT sub-layout the file is, decided by the first sniffer that matches over the first 200 lines (§8.4). */
export function sniffTxtLayout(text: string): TxtLayout {
  const lines = text.split(/\r\n|\r|\n/).slice(0, 200).filter((l) => l.trim());
  if (!lines.length) return 'prompts';
  const tabbed = lines.filter((l) => l.includes('\t')).length;
  if (tabbed >= Math.max(1, Math.ceil(lines.length * 0.6))) return 'tsv';
  const qs = lines.filter((l) => Q_RE.test(l)).length;
  const as = lines.filter((l) => A_RE.test(l)).length;
  if (qs >= 1 && as >= 1) return 'qa';
  const blocks = text.split(/(?:\r?\n|\r)[ \t]*(?:\r?\n|\r)/).map((b) => b.split(/\r\n|\r|\n/).filter((l) => l.trim()));
  // a blank-line separator must actually be there: a file that is just a list of lines is a list of questions, not one block
  if (blocks.length >= 2 && blocks.some((b) => b.length >= 2)) return 'blocks';
  return 'prompts';
}

function recordsFromTxt(text: string, layout: TxtLayout, max: number): { records: RawRecord[]; truncated: boolean; logical: number } {
  const rawLines = text.split(/\r\n|\r|\n/);
  const records: RawRecord[] = [];
  let truncated = false;
  if (layout === 'qa') {
    let pending: { line: number; prompt: string } | null = null;
    for (let i = 0; i < rawLines.length; i++) {
      const l = rawLines[i];
      if (!l.trim()) continue;
      if (records.length >= max) { truncated = true; break; }
      if (Q_RE.test(l)) {
        if (pending) records.push({ line: pending.line, draft: { prompt: pending.prompt }, });
        pending = { line: i + 1, prompt: l.replace(Q_RE, '') };
        continue;
      }
      if (A_RE.test(l)) {
        if (!pending) { records.push({ line: i + 1, draft: {}, error: 'an answer line with no question before it', raw: l.slice(0, 200) }); continue; }
        records.push({ line: pending.line, draft: { prompt: pending.prompt, answer: l.replace(A_RE, '') } });
        pending = null;
        continue;
      }
      records.push({ line: i + 1, draft: {}, error: 'not a "Q:" or "A:" line', raw: l.slice(0, 200) });
    }
    if (pending) records.push({ line: pending.line, draft: { prompt: pending.prompt } });
    return { records, truncated, logical: rawLines.length };
  }
  if (layout === 'blocks') {
    let line = 0;
    let block: { line: number; lines: string[] } | null = null;
    const flush = () => {
      if (!block) return;
      const [head, ...rest] = block.lines;
      records.push({ line: block.line, draft: { prompt: head, answer: rest.join(' ') } });
      block = null;
    };
    for (const l of rawLines) {
      line++;
      if (!l.trim()) { flush(); continue; }
      if (records.length >= max) { truncated = true; break; }
      if (!block) block = { line, lines: [] };
      block.lines.push(l);
    }
    flush();
    return { records, truncated, logical: rawLines.length };
  }
  // 'prompts': every line is a question with no answer — the visitor is told the file has no answers, never given invented ones.
  for (let i = 0; i < rawLines.length; i++) {
    if (!rawLines[i].trim()) continue;
    if (records.length >= max) { truncated = true; break; }
    records.push({ line: i + 1, draft: { prompt: rawLines[i] } });
  }
  return { records, truncated, logical: rawLines.length };
}

// ------------------------------------------------------------------ normalisation (§8.5)

interface NormalizedRow { prompt: string; answer: string; alt_prompt?: string; note?: string; from?: string; replaces?: string; fixes: string[] }

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

export function normalizeRow(d: Partial<CanonicalRow>, noteMax = DEFAULTS.noteMax): NormalizedRow {
  const fixes = new Set<string>();
  const nfc = (s: string | undefined) => (s === undefined ? undefined : String(s).normalize('NFC'));
  let prompt = nfc(d.prompt) ?? '';
  let answer = nfc(d.answer) ?? '';
  let alt = nfc(d.alt_prompt);
  let note = nfc(d.note);

  // invisibles first: U+FEFF and friends are matched by \s in JavaScript, so collapsing before stripping would turn a
  // zero-width character into a real space instead of removing it
  const strip = (s: string | undefined) => {
    if (s === undefined) return undefined;
    const out = s.replace(CONTROLS, '');
    if (out !== s) fixes.add('controls_stripped');
    return out;
  };
  prompt = strip(prompt)!; answer = strip(answer)!; alt = strip(alt); note = strip(note);

  const c1 = collapse(prompt); if (c1 !== prompt) fixes.add('whitespace_collapsed'); prompt = c1;
  if (alt !== undefined) { const c2 = collapse(alt); if (c2 !== alt) fixes.add('whitespace_collapsed'); alt = c2; }
  // v1's one-line answer rule is enforced by normalisation, not refusal
  const flat = collapse(answer.replace(/[\r\n\t]+/g, ' '));
  if (/[\r\n\t]/.test(answer)) fixes.add('answer_flattened');
  else if (flat !== answer) fixes.add('whitespace_collapsed');
  answer = flat;
  // a prompt that is already a benchmark rendering ("Q: …\nA:") is unwrapped rather than trained as literal text
  const qa = prompt.match(/^Q\s*:\s*(.*?)\s*(?:A\s*:\s*)?$/i);
  if (qa && qa[1] && /^Q\s*:/i.test(prompt)) { prompt = qa[1]; fixes.add('qa_prefix_stripped'); }
  if (note !== undefined) { const c3 = collapse(note); if (c3 !== note) fixes.add('whitespace_collapsed'); note = c3; }

  if (note !== undefined && note.length > noteMax) { note = note.slice(0, noteMax); fixes.add('note_truncated'); }
  if (alt !== undefined && !alt) alt = undefined;
  if (note !== undefined && !note) note = undefined;
  // provenance is carried through untouched when it is well-formed and silently dropped when it is not: a malformed
  // pointer must not become part of the sha, and must never be shown as "from someone"
  const from = isRowRef(d.from) ? d.from : undefined;
  const replaces = isRowRef(d.replaces) ? d.replaces : undefined;
  return { prompt, answer, ...(alt ? { alt_prompt: alt } : {}), ...(note ? { note } : {}), ...(from ? { from } : {}), ...(replaces ? { replaces } : {}), fixes: [...fixes].sort() };
}

/** Per-row script guess by codepoint majority — never an error, only an aggregate note (§8.6). */
export function guessLang(s: string): TeachDatasetLang {
  const n: Record<TeachDatasetLang, number> = { hangul: 0, latin: 0, han: 0, kana: 0, other: 0 };
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) n.hangul++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) n.latin++;
    else if (c >= 0x4e00 && c <= 0x9fff) n.han++;
    else if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff)) n.kana++;
    else if (/\S/.test(ch) && !/[\p{P}\p{S}\p{N}]/u.test(ch)) n.other++;
  }
  let best: TeachDatasetLang = 'other'; let bn = 0;
  for (const k of ['hangul', 'latin', 'han', 'kana', 'other'] as TeachDatasetLang[]) if (n[k] > bn) { best = k; bn = n[k]; }
  return bn ? best : 'other';
}

/**
 * What two questions "end the same way" means (§8.5 advisory). Up to the last three whitespace tokens, but never the
 * whole question: the FIRST token is the subject, and it is exactly the part the measurement found the model cannot
 * see at the answer position. `{name} 종목코드는?` is two tokens, so the key is `종목코드는?` and all 2804 KRX
 * listings land in one group — which is the finding this advisory exists to report. A prompt with no spaces at all
 * (a script without word breaks) falls back to its last 8 characters.
 */
export function endingKey(prompt: string): string {
  const toks = prompt.split(/\s+/).filter(Boolean);
  if (toks.length >= 2) return toks.slice(-Math.min(3, toks.length - 1)).join(' ').toLowerCase();
  return prompt.replace(/\s+/g, '').slice(-8).toLowerCase();
}

// ------------------------------------------------------------------ personal information (lineage design §6.5)

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
/** Korean mobile / landline numbers (010-1234-5678, 01012345678, 02-123-4567, +82 10 …) and international-looking runs. */
const PHONE_RE = /(?:\+82[\s-]?0?|\b0)(?:1[016789]|2|3[1-3]|4[1-4]|5[1-5]|6[1-4]|70|80)[\s-]?\d{3,4}[\s-]?\d{4}\b|\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/;
/** 주민등록번호: YYMMDD-GNNNNNN with a plausible month/day and a gender digit 1-4 (5-8 for foreigners). */
const RRN_RE = /\b\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[\s-]?[1-8]\d{6}\b/;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
function luhnOk(digits: string): boolean {
  let sum = 0; let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}
/**
 * What in a row looks like personal information: an e-mail address, a phone number (incl. `010-`), a resident
 * registration number, or a 13–19 digit run that passes Luhn (a card number). Advisory for training — the row is
 * accepted — and a hard block on publishing the training set above `private`. Precision over recall: a ticker code
 * or a 6-digit date must never be flagged, so every pattern needs its own shape, and the Luhn check needs ≥ 13 digits.
 */
export function detectPii(fields: (string | undefined)[]): TeachPiiKind[] {
  const kinds = new Set<TeachPiiKind>();
  for (const f of fields) {
    if (!f) continue;
    if (EMAIL_RE.test(f)) kinds.add('email');
    if (RRN_RE.test(f)) kinds.add('rrn');
    else if (PHONE_RE.test(f)) kinds.add('phone');
    for (const m of f.match(CARD_RE) ?? []) {
      const digits = m.replace(/\D/g, '');
      if (digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhnOk(digits)) { kinds.add('card'); break; }
    }
  }
  return [...kinds].sort();
}

// ------------------------------------------------------------------ the canonical file (§6.1)

/**
 * `rows.jsonl` — one JSON object per line, keys always `prompt, answer, alt_prompt, note` (absent when empty), LF
 * endings, UTF-8 without BOM, exactly one trailing LF. The sha256 is taken over THESE bytes, so the same logical
 * dataset hashes the same whatever format it arrived in.
 */
/**
 * The identity of a QUESTION (F13, design §16 R1): NFC, control/bidi/zero-width stripped, whitespace collapsed,
 * case-sensitive, punctuation untouched — the same rule that already decides duplicates and conflicts inside a file.
 * Everything that has to say "these two are the same question" (open questions, `covered_by`, merge) uses this and
 * nothing else, so a question never means one thing in the parser and another in the market.
 */
export function questionKey(prompt: string): string {
  return collapse(String(prompt ?? '').normalize('NFC').replace(CONTROLS, ''));
}

export function canonicalJsonl(rows: CanonicalRow[]): string {
  return rows.map((r) => JSON.stringify({ prompt: r.prompt, answer: r.answer, ...(r.alt_prompt ? { alt_prompt: r.alt_prompt } : {}), ...(r.note ? { note: r.note } : {}), ...(isRowRef(r.from) ? { from: r.from } : {}), ...(isRowRef(r.replaces) ? { replaces: r.replaces } : {}) })).join('\n') + (rows.length ? '\n' : '');
}
export function canonicalBytes(rows: CanonicalRow[]): Buffer { return Buffer.from(canonicalJsonl(rows), 'utf8'); }
export function sha256Rows(rows: CanonicalRow[]): string { return createHash('sha256').update(canonicalBytes(rows)).digest('hex'); }

/** Fast reader for a `rows.jsonl` this node wrote (no validation — the file is ours). */
export function readCanonicalJsonl(text: string): CanonicalRow[] {
  const out: CanonicalRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as CanonicalRow;
      if (typeof o?.prompt === 'string' && typeof o?.answer === 'string') out.push({ prompt: o.prompt, answer: o.answer, ...(o.alt_prompt ? { alt_prompt: o.alt_prompt } : {}), ...(o.note ? { note: o.note } : {}), ...(isRowRef(o.from) ? { from: o.from } : {}), ...(isRowRef(o.replaces) ? { replaces: o.replaces } : {}) });
    } catch { /* our own file — a bad line is skipped rather than failing the whole read */ }
  }
  return out;
}

// ------------------------------------------------------------------ the parse

const emptySummary = (): TeachDatasetSummary => ({
  source_rows: 0, accepted: 0, fixed: 0, rejected: 0, duplicates: 0, conflicts: 0, blocked: 0, too_long: 0,
  empty: 0, not_parsed: 0, over_cap: 0, shared_ending: 0, pii: 0,
  langs: { hangul: 0, latin: 0, han: 0, kana: 0, other: 0 },
});

export function parseDataset(buf: Buffer, opts: ParseOptions = {}): ParseResult {
  const maxSourceLines = opts.maxSourceLines ?? DEFAULTS.maxSourceLines;
  const maxRows = opts.maxRows ?? DEFAULTS.maxRows;
  const promptMax = opts.promptMax ?? DEFAULTS.promptMax;
  const answerMax = opts.answerMax ?? DEFAULTS.answerMax;
  const notes = new Set<string>();
  const { text, encoding } = decodeBuffer(buf, opts.encoding);
  const quality = textQuality(buf, text);
  if (!quality.ok) notes.add('not_text');
  const format = detectFormat(text, opts);

  let records: RawRecord[] = [];
  let truncated = false;
  let sourceRows = 0;
  let layout: TxtLayout | undefined;
  let delimiter: string | undefined;
  let hasHeader: boolean | undefined;
  let columns: Record<string, string | number> | undefined;

  if (format === 'json') {
    const r = recordsFromJsonArray(text, maxSourceLines, notes);
    if (r) { records = r.records; truncated = r.truncated; sourceRows = r.logical; }
    else { const j = recordsFromJsonl(text, maxSourceLines, notes); records = j.records; truncated = j.truncated; sourceRows = j.logical; }
  } else if (format === 'jsonl') {
    const j = recordsFromJsonl(text, maxSourceLines, notes);
    records = j.records; truncated = j.truncated; sourceRows = j.logical;
  } else if (format === 'csv' || format === 'tsv') {
    delimiter = opts.delimiter ?? (format === 'tsv' ? '\t' : sniffDelimiter(text)?.delimiter ?? ',');
    const p = parseDelimited(text, delimiter, maxSourceLines);
    truncated = p.truncated; sourceRows = p.rows.length;
    const plan = planDelimited(p.rows, opts, delimiter);
    hasHeader = plan.hasHeader;
    columns = Object.fromEntries(Object.entries(plan.columns));
    if (plan.extra) notes.add('extra_columns');
    records = recordsFromDelimited(p.rows, plan);
  } else {
    layout = opts.layout ?? sniffTxtLayout(text);
    if (layout === 'tsv') {
      delimiter = opts.delimiter ?? '\t';
      const p = parseDelimited(text, delimiter, maxSourceLines);
      truncated = p.truncated; sourceRows = p.rows.length;
      const plan = planDelimited(p.rows, opts, delimiter);
      hasHeader = plan.hasHeader;
      columns = Object.fromEntries(Object.entries(plan.columns));
      if (plan.extra) notes.add('extra_columns');
      records = recordsFromDelimited(p.rows, plan);
    } else {
      const t = recordsFromTxt(text, layout, maxSourceLines);
      records = t.records; truncated = t.truncated; sourceRows = t.logical;
    }
  }
  if (truncated) notes.add('truncated');

  // ---- normalise, then classify. Conflicts and duplicates need the whole file, so this is two passes.
  const norm = records.map((r) => (r.error ? null : normalizeRow(r.draft, opts.noteMax)));
  const byPrompt = new Map<string, number[]>();
  for (const [i, n] of norm.entries()) {
    if (!n || !n.prompt || !n.answer) continue;
    const key = n.prompt;
    const list = byPrompt.get(key); if (list) list.push(i); else byPrompt.set(key, [i]);
  }
  const conflictOf = new Map<number, number[]>();
  for (const idxs of byPrompt.values()) {
    if (idxs.length < 2) continue;
    const answers = new Set(idxs.map((i) => norm[i]!.answer));
    if (answers.size < 2) continue;
    for (const i of idxs) conflictOf.set(i, idxs.filter((x) => x !== i).map((x) => records[x].line));
  }

  let blockedRe: RegExp | null = null;
  if (opts.blockedTopics) { try { blockedRe = new RegExp(opts.blockedTopics, 'i'); } catch { blockedRe = null; } }

  const report: TeachDatasetRow[] = [];
  const rows: CanonicalRow[] = [];
  const summary = emptySummary();
  const seen = new Map<string, number>();          // prompt answer → source line of the first copy
  const acceptedIdx: number[] = [];                // indices into `report` of accepted rows, for the advisory pass

  for (const [i, rec] of records.entries()) {
    summary.source_rows++;
    const line = rec.line;
    const n = norm[i];
    const push = (row: TeachDatasetRow) => { report.push(row); return row; };
    if (rec.error || !n) {
      summary.not_parsed++; summary.rejected++;
      push({ index: null, line, status: 'not_parsed', detail: rec.error ?? 'could not read this line', ...(rec.raw ? { raw: rec.raw.slice(0, 200) } : {}) });
      continue;
    }
    const base = { prompt: n.prompt || undefined, answer: n.answer || undefined, ...(n.alt_prompt ? { alt_prompt: n.alt_prompt } : {}), ...(n.note ? { note: n.note } : {}), ...(n.from ? { from: n.from } : {}), ...(n.replaces ? { replaces: n.replaces } : {}), lang: guessLang(`${n.prompt} ${n.answer}`) } as const;
    const reject = (status: TeachRowStatus, detail: string) => push({ index: null, line, status, ...base, ...(n.fixes.length ? { fixes: n.fixes } : {}), detail });
    if (!n.prompt || !n.answer) {
      summary.empty++; summary.rejected++;
      reject('empty', !n.prompt && !n.answer ? 'this line has neither a question nor an answer' : !n.answer ? 'this question has no answer' : 'this answer has no question');
      continue;
    }
    if (n.prompt.length > promptMax || n.answer.length > answerMax) {
      summary.too_long++; summary.rejected++;
      const over = n.prompt.length > promptMax
        ? `the question is ${n.prompt.length} characters, ${n.prompt.length - promptMax} over the ${promptMax} limit`
        : `the answer is ${n.answer.length} characters, ${n.answer.length - answerMax} over the ${answerMax} limit`;
      reject('too_long', over);
      continue;
    }
    if (blockedRe && [n.prompt, n.answer, n.alt_prompt ?? '', n.note ?? ''].some((v) => v && blockedRe!.test(v))) {
      summary.blocked++; summary.rejected++;
      reject('blocked', 'the node operator does not accept this topic');
      continue;
    }
    const conflicts = conflictOf.get(i);
    if (conflicts) {
      summary.conflicts++; summary.rejected++;
      reject('conflict', `line${conflicts.length > 1 ? 's' : ''} ${conflicts.join(', ')} ask${conflicts.length > 1 ? '' : 's'} the same question with a different answer`);
      continue;
    }
    const dupKey = `${n.prompt} ${n.answer}`;
    const first = seen.get(dupKey);
    if (first !== undefined) {
      summary.duplicates++; summary.rejected++;
      reject('duplicate', `the same question and answer as line ${first}`);
      continue;
    }
    seen.set(dupKey, line);
    if (rows.length >= maxRows) {
      summary.over_cap++; summary.rejected++;
      reject('over_cap', `this node keeps up to ${maxRows} questions in one dataset`);
      continue;
    }
    const row: CanonicalRow = { prompt: n.prompt, answer: n.answer, ...(n.alt_prompt ? { alt_prompt: n.alt_prompt } : {}), ...(n.note ? { note: n.note } : {}), ...(n.from ? { from: n.from } : {}), ...(n.replaces ? { replaces: n.replaces } : {}) };
    rows.push(row);
    summary.accepted++;
    if (n.fixes.length) summary.fixed++;
    summary.langs[base.lang]++;
    acceptedIdx.push(report.length);
    // accepted, but flagged: it trains, and it keeps the training set from being published above `private` (§6.5)
    const pii = detectPii([n.prompt, n.answer, n.alt_prompt, n.note]);
    if (pii.length) summary.pii = (summary.pii ?? 0) + 1;
    push({ index: rows.length - 1, line, status: pii.length ? 'pii' : n.fixes.length ? 'fixed' : 'ok', ...base, ...(n.fixes.length ? { fixes: n.fixes } : {}),
      ...(pii.length ? { pii, detail: `looks like personal information (${pii.join(', ')}) — it trains, but the training set cannot be published above "private" until it is removed` } : {}) });
  }

  // ---- advisory: questions whose last three tokens are identical are very likely to be learned as one (§8.5)
  const groups = new Map<string, number[]>();
  for (const ri of acceptedIdx) {
    const k = endingKey(report[ri].prompt ?? '');
    const g = groups.get(k); if (g) g.push(ri); else groups.set(k, [ri]);
  }
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    for (const ri of g) { report[ri].advisory = ['shared_ending']; report[ri].detail = report[ri].detail ?? `${g.length} questions in this dataset end the same way`; summary.shared_ending++; }
  }

  // ---- informational notes
  const scripts = (Object.entries(summary.langs) as [TeachDatasetLang, number][]).filter(([, n]) => n > 0);
  if (scripts.length > 1) notes.add('mixed_scripts');
  const fffd = rows.filter((r) => r.prompt.includes('�') || r.answer.includes('�')).length;
  if (rows.length && fffd / rows.length > 0.2) notes.add('replacement_chars');
  const blanks = sourceRows - records.length;
  if (blanks > 0) notes.add(`blank_rows:${blanks}`);
  if (notes.has('system_messages')) { notes.delete('system_messages'); notes.add('system_messages_ignored'); }

  return {
    format, encoding, ...(layout ? { layout } : {}), ...(delimiter ? { delimiter } : {}), ...(hasHeader !== undefined ? { has_header: hasHeader } : {}),
    ...(columns ? { columns } : {}), source_rows: summary.source_rows, truncated, rows, report, summary, notes: [...notes].sort(),
    text_quality: quality,
  };
}

/** `report.json` as written to disk (§8.7) — capped, read paginated, never inlined into the dataset summary. */
export function buildReportJson(p: ParseResult): Record<string, unknown> {
  return {
    version: 1, format: p.format, encoding: p.encoding, layout: p.layout ?? null, delimiter: p.delimiter ?? null,
    has_header: p.has_header ?? null, columns: p.columns ?? null, source_rows: p.source_rows, truncated: p.truncated,
    notes: p.notes, summary: p.summary, text_quality: p.text_quality, rows: p.report,
  };
}
