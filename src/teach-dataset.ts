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
import type { TeachDatasetFormat, TeachDatasetLang, TeachDatasetRow, TeachDatasetSummary, TeachRowStatus } from '@ngram/core';

// ------------------------------------------------------------------ shape

/** One accepted question, canonical field order. This is what a line of `rows.jsonl` decodes to. */
export interface CanonicalRow { prompt: string; answer: string; alt_prompt?: string; note?: string }

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
  /** Machine-readable informational notes: 'extra_columns', 'blank_rows:<n>', 'mixed_scripts', 'replacement_chars', 'truncated', 'system_messages:<n>'. */
  notes: string[];
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
};
const FIELD_ORDER: (keyof CanonicalRow)[] = ['prompt', 'answer', 'alt_prompt', 'note'];
const aliasKey = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');
const ALIAS_TO_FIELD = new Map<string, keyof CanonicalRow>();
for (const f of FIELD_ORDER) for (const a of FIELD_ALIASES[f]) ALIAS_TO_FIELD.set(aliasKey(a), f);

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

interface NormalizedRow { prompt: string; answer: string; alt_prompt?: string; note?: string; fixes: string[] }

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
  return { prompt, answer, ...(alt ? { alt_prompt: alt } : {}), ...(note ? { note } : {}), fixes: [...fixes].sort() };
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

// ------------------------------------------------------------------ the canonical file (§6.1)

/**
 * `rows.jsonl` — one JSON object per line, keys always `prompt, answer, alt_prompt, note` (absent when empty), LF
 * endings, UTF-8 without BOM, exactly one trailing LF. The sha256 is taken over THESE bytes, so the same logical
 * dataset hashes the same whatever format it arrived in.
 */
export function canonicalJsonl(rows: CanonicalRow[]): string {
  return rows.map((r) => JSON.stringify({ prompt: r.prompt, answer: r.answer, ...(r.alt_prompt ? { alt_prompt: r.alt_prompt } : {}), ...(r.note ? { note: r.note } : {}) })).join('\n') + (rows.length ? '\n' : '');
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
      if (typeof o?.prompt === 'string' && typeof o?.answer === 'string') out.push({ prompt: o.prompt, answer: o.answer, ...(o.alt_prompt ? { alt_prompt: o.alt_prompt } : {}), ...(o.note ? { note: o.note } : {}) });
    } catch { /* our own file — a bad line is skipped rather than failing the whole read */ }
  }
  return out;
}

// ------------------------------------------------------------------ the parse

const emptySummary = (): TeachDatasetSummary => ({
  source_rows: 0, accepted: 0, fixed: 0, rejected: 0, duplicates: 0, conflicts: 0, blocked: 0, too_long: 0,
  empty: 0, not_parsed: 0, over_cap: 0, shared_ending: 0,
  langs: { hangul: 0, latin: 0, han: 0, kana: 0, other: 0 },
});

export function parseDataset(buf: Buffer, opts: ParseOptions = {}): ParseResult {
  const maxSourceLines = opts.maxSourceLines ?? DEFAULTS.maxSourceLines;
  const maxRows = opts.maxRows ?? DEFAULTS.maxRows;
  const promptMax = opts.promptMax ?? DEFAULTS.promptMax;
  const answerMax = opts.answerMax ?? DEFAULTS.answerMax;
  const notes = new Set<string>();
  const { text, encoding } = decodeBuffer(buf, opts.encoding);
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
    const base = { prompt: n.prompt || undefined, answer: n.answer || undefined, ...(n.alt_prompt ? { alt_prompt: n.alt_prompt } : {}), ...(n.note ? { note: n.note } : {}), lang: guessLang(`${n.prompt} ${n.answer}`) } as const;
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
    const row: CanonicalRow = { prompt: n.prompt, answer: n.answer, ...(n.alt_prompt ? { alt_prompt: n.alt_prompt } : {}), ...(n.note ? { note: n.note } : {}) };
    rows.push(row);
    summary.accepted++;
    if (n.fixes.length) summary.fixed++;
    summary.langs[base.lang]++;
    acceptedIdx.push(report.length);
    push({ index: rows.length - 1, line, status: n.fixes.length ? 'fixed' : 'ok', ...base, ...(n.fixes.length ? { fixes: n.fixes } : {}) });
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
  };
}

/** `report.json` as written to disk (§8.7) — capped, read paginated, never inlined into the dataset summary. */
export function buildReportJson(p: ParseResult): Record<string, unknown> {
  return {
    version: 1, format: p.format, encoding: p.encoding, layout: p.layout ?? null, delimiter: p.delimiter ?? null,
    has_header: p.has_header ?? null, columns: p.columns ?? null, source_rows: p.source_rows, truncated: p.truncated,
    notes: p.notes, summary: p.summary, rows: p.report,
  };
}
