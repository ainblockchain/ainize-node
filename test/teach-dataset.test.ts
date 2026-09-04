/**
 * Teach mode v2 — the dataset parser (design §8). Pure functions over a Buffer: no node, no database, no model.
 *
 * The assertions that matter most, and why:
 *  - the SAME logical data as jsonl / json / csv / tsv / txt produces byte-identical canonical output and one sha256
 *    (that is what makes "the chat door is the file door's front half" true rather than a slogan);
 *  - a quoted CSV newline is ONE logical row, so the line numbers in the preview point at the right place in the file;
 *  - a contradiction excludes ALL copies and cross-links them; a duplicate keeps the first;
 *  - nothing is silently dropped: every rejection has a status, a reason and a line number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalJsonl, decodeBuffer, detectFormat, detectPii, endingKey, guessLang, looksLikeHeader, normalizeRow, parseDataset,
  parseDelimited, readCanonicalJsonl, sha256Rows, sniffDelimiter, sniffTxtLayout, type CanonicalRow, type ParseOptions,
} from '../src/teach-dataset.js';

const B = (s: string) => Buffer.from(s, 'utf8');
const P = (s: string | Buffer, o: ParseOptions = {}) => parseDataset(typeof s === 'string' ? B(s) : s, o);
const statuses = (s: string | Buffer, o: ParseOptions = {}) => P(s, o).report.map((r) => r.status);

// ---------------------------------------------------------------- the same three questions in five formats
const THREE: CanonicalRow[] = [
  { prompt: 'Who founded Ainize?', answer: 'Comcom', alt_prompt: 'Which company is behind Ainize?' },
  { prompt: '픽셀플러스 종목코드는?', answer: '087600' },
  { prompt: 'What is 17 + 25?', answer: '42' },
];

test('one dataset, five formats, one fingerprint — the canonical bytes do not depend on how the file was written', () => {
  const jsonl = THREE.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const json = JSON.stringify(THREE, null, 2);
  const csv = 'question,answer,another_way\n"Who founded Ainize?",Comcom,"Which company is behind Ainize?"\n픽셀플러스 종목코드는?,087600,\n"What is 17 + 25?",42,\n';
  const tsv = 'prompt\tanswer\talt_prompt\nWho founded Ainize?\tComcom\tWhich company is behind Ainize?\n픽셀플러스 종목코드는?\t087600\t\nWhat is 17 + 25?\t42\t\n';
  const txt = 'Q: Who founded Ainize?\nA: Comcom\n\nQ: 픽셀플러스 종목코드는?\nA: 087600\n\nQ: What is 17 + 25?\nA: 42\n';

  const jl = P(jsonl, { filename: 'a.jsonl' });
  const js = P(json, { filename: 'a.json' });
  const cs = P(csv, { filename: 'a.csv' });
  const ts = P(tsv, { filename: 'a.tsv' });
  const tx = P(txt, { filename: 'a.txt' });

  assert.equal(jl.format, 'jsonl'); assert.equal(js.format, 'json'); assert.equal(cs.format, 'csv'); assert.equal(ts.format, 'tsv'); assert.equal(tx.format, 'txt');
  assert.equal(cs.delimiter, ','); assert.equal(cs.has_header, true);
  assert.deepEqual(cs.columns, { prompt: 0, answer: 1, alt_prompt: 2 });
  assert.equal(tx.layout, 'qa');
  // the alt_prompt only exists in the four table formats; txt Q:/A: has no third column, so compare the two questions
  const sha = sha256Rows(jl.rows);
  for (const r of [js, cs, ts]) assert.equal(sha256Rows(r.rows), sha, 'same questions, same fingerprint');
  assert.deepEqual(jl.rows, THREE);
  assert.deepEqual(tx.rows, THREE.map(({ prompt, answer }) => ({ prompt, answer })));

  // canonical form: key order, LF endings, exactly one trailing newline, no BOM
  const bytes = canonicalJsonl(jl.rows);
  assert.equal(bytes, '{"prompt":"Who founded Ainize?","answer":"Comcom","alt_prompt":"Which company is behind Ainize?"}\n{"prompt":"픽셀플러스 종목코드는?","answer":"087600"}\n{"prompt":"What is 17 + 25?","answer":"42"}\n');
  assert.ok(!bytes.includes('\r'));
  assert.ok(bytes.endsWith('\n') && !bytes.endsWith('\n\n'));
  // round trip: parse → rows.jsonl → parse again → identical rows and sha
  const again = P(bytes, { filename: 'r.jsonl' });
  assert.deepEqual(again.rows, jl.rows);
  assert.equal(sha256Rows(again.rows), sha);
  assert.deepEqual(readCanonicalJsonl(bytes), jl.rows);
});

// ---------------------------------------------------------------- encoding
test('encoding: BOM, UTF-16, CP949 and a mojibake warning — the parser says what it read the file as', () => {
  assert.equal(decodeBuffer(Buffer.from([0xef, 0xbb, 0xbf, 0x61])).encoding, 'utf-8');
  assert.equal(decodeBuffer(Buffer.from([0xef, 0xbb, 0xbf, 0x61])).text, 'a', 'the BOM is stripped, not trained');
  const bom = P(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), B('{"prompt":"q1","answer":"a1"}\n')]));
  assert.deepEqual(bom.rows, [{ prompt: 'q1', answer: 'a1' }]);

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"prompt":"q1","answer":"a1"}\n', 'utf16le')]);
  const u = P(utf16, { filename: 'a.jsonl' });
  assert.equal(u.encoding, 'utf-16le');
  assert.deepEqual(u.rows, [{ prompt: 'q1', answer: 'a1' }]);

  // CP949 bytes are not valid UTF-8; the parser must not fall through to latin1 mojibake
  const cp949 = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);                    // "한글"
  const dec = decodeBuffer(cp949);
  assert.equal(dec.encoding, 'euc-kr');
  assert.equal(dec.text, '한글');
  const kr = P(Buffer.concat([Buffer.from('prompt\tanswer\n', 'latin1'), cp949, Buffer.from('\t', 'latin1'), cp949]), { filename: 'a.tsv' });
  assert.equal(kr.encoding, 'euc-kr');
  assert.deepEqual(kr.rows, [{ prompt: '한글', answer: '한글' }]);

  // a file full of U+FFFD is flagged rather than trained as-is
  const broken = P('\ufffd\ufffd\ufffd\ufffd\ufffda\t\ufffd\ufffd\ufffd\ufffd\ufffdb\n', { filename: 'x.tsv' });
  assert.ok(broken.notes.includes('replacement_chars'), broken.notes.join(','));

  // an explicit encoding wins over detection
  assert.equal(P(cp949, { format: 'txt', encoding: 'latin1' }).encoding, 'latin1');
});

// ---------------------------------------------------------------- line endings and blank rows
test('CRLF, CR and mixed line endings all parse, and blank lines keep the numbering honest', () => {
  for (const nl of ['\n', '\r\n', '\r']) {
    const r = P(`prompt${nl === '\r\n' ? '' : ''}\tanswer${nl}q1\ta1${nl}q2\ta2${nl}`, { filename: 'a.tsv' });
    assert.deepEqual(r.rows, [{ prompt: 'q1', answer: 'a1' }, { prompt: 'q2', answer: 'a2' }], `newline ${JSON.stringify(nl)}`);
  }
  // a blank line is not a question: it is skipped, counted in the notes, and the following row keeps its real line number
  const r = P('q1\ta1\n\n\nq2\ta2\n', { filename: 'a.tsv' });
  assert.deepEqual(r.report.map((x) => x.line), [1, 4]);
  assert.ok(r.notes.some((n) => n.startsWith('blank_rows:')), r.notes.join(','));
  assert.equal(r.summary.source_rows, 2, 'blank lines are not counted as questions that failed');
});

// ---------------------------------------------------------------- RFC 4180
test('CSV: quoted commas, quoted newlines, "" escapes — and a two-physical-line field is ONE logical row', () => {
  const csv = 'question,answer\n"Ainize, the platform — who made it?","Comcom, Inc."\n"A question\nspanning two lines",yes\n"He said ""hi""",ok\n';
  const r = P(csv, { filename: 'a.csv' });
  assert.equal(r.delimiter, ',');
  assert.deepEqual(r.rows.map((x) => x.prompt), ['Ainize, the platform — who made it?', 'A question spanning two lines', 'He said "hi"']);
  assert.deepEqual(r.rows.map((x) => x.answer), ['Comcom, Inc.', 'yes', 'ok']);
  // the third data row is logical line 4 even though the file has five physical lines
  assert.deepEqual(r.report.map((x) => x.line), [2, 3, 4]);
  // a lone \r inside a quoted field survives the state machine (it is collapsed by normalisation, not by the parser)
  const raw = parseDelimited('a,"b\rc"\n', ',', 100);
  assert.deepEqual(raw.rows, [['a', 'b\rc']]);
});

test('CSV: delimiter and header sniffing, positional columns, ragged rows are a per-row reject', () => {
  assert.equal(sniffDelimiter('a;b;c\nd;e;f\n')?.delimiter, ';');
  assert.equal(sniffDelimiter('a|b\nc|d\n')?.delimiter, '|');
  assert.equal(sniffDelimiter('a\tb\nc\td\n')?.delimiter, '\t');
  assert.equal(sniffDelimiter('just one column\nand another\n'), null, 'a one-column file is not a table');
  assert.equal(looksLikeHeader(['question', 'answer']), true);
  assert.equal(looksLikeHeader(['질문', '정답', '다른표현']), true);
  assert.equal(looksLikeHeader(['q1', '1']), false, 'a numeric cell means it is data');
  assert.equal(looksLikeHeader(['Who founded Ainize?', 'Comcom']), false, 'no cell matches a known column name');

  const semi = P('질문;정답\n서울의 인구는?;약 940만 명\n', { filename: 'a.csv' });
  assert.equal(semi.delimiter, ';'); assert.equal(semi.has_header, true);
  assert.deepEqual(semi.columns, { prompt: 0, answer: 1 });
  assert.deepEqual(semi.rows, [{ prompt: '서울의 인구는?', answer: '약 940만 명' }]);

  // headerless two-column: positional 0=prompt, 1=answer
  const headerless = P('q1,a1\nq2,a2\n', { filename: 'a.csv' });
  assert.equal(headerless.has_header, false);
  assert.deepEqual(headerless.rows, [{ prompt: 'q1', answer: 'a1' }, { prompt: 'q2', answer: 'a2' }]);

  // extra columns are ignored with ONE summary note, not a per-row complaint
  const extra = P('question,answer,source,updated\nq1,a1,book,2020\n', { filename: 'a.csv' });
  assert.ok(extra.notes.includes('extra_columns'));
  assert.equal(extra.rows.length, 1);

  // a ragged row is a per-row reject, never a whole-file failure
  const ragged = P('question,answer\nq1,a1\nbroken\nq2,a2\n', { filename: 'a.csv' });
  assert.deepEqual(ragged.report.map((x) => x.status), ['ok', 'not_parsed', 'ok']);
  assert.equal(ragged.report[1].line, 3);
  assert.match(ragged.report[1].detail!, /column/);
  assert.equal(ragged.report[1].raw, 'broken');
  assert.equal(ragged.rows.length, 2, 'the good rows are still trained');

  // the caller can override the plan (this is what "read it again" sends)
  const forced = P('q1|a1|alt1\n', { format: 'csv', delimiter: '|', hasHeader: false });
  assert.deepEqual(forced.rows, [{ prompt: 'q1', answer: 'a1', alt_prompt: 'alt1' }]);
  const mapped = P('a,b,c\nx,y,z\n', { format: 'csv', hasHeader: true, columns: { prompt: 2, answer: 0 } });
  assert.deepEqual(mapped.rows, [{ prompt: 'z', answer: 'x' }]);
});

// ---------------------------------------------------------------- JSON shapes
test('JSONL / JSON: aliases (incl. Korean), Alpaca, ChatML, and a non-object line is `not_parsed`', () => {
  const aliased = P('{"q":"q1","completion":"a1","paraphrase":"p1","memo":"m1"}\n');
  assert.deepEqual(aliased.rows, [{ prompt: 'q1', answer: 'a1', alt_prompt: 'p1', note: 'm1' }]);
  const korean = P('{"질문":"수도는?","정답":"서울","다른표현":"어디가 수도?","비고":"출처"}\n');
  assert.deepEqual(korean.rows, [{ prompt: '수도는?', answer: '서울', alt_prompt: '어디가 수도?', note: '출처' }]);

  const alpaca = P('{"instruction":"Translate to Korean","input":"good morning","output":"좋은 아침"}\n');
  assert.deepEqual(alpaca.rows, [{ prompt: 'Translate to Korean good morning', answer: '좋은 아침' }], 'input is appended to the instruction, never used as the answer');
  const alpacaNoInput = P('{"instruction":"Who founded Ainize?","input":"","output":"Comcom"}\n');
  assert.deepEqual(alpacaNoInput.rows, [{ prompt: 'Who founded Ainize?', answer: 'Comcom' }]);

  const chatml = P('{"messages":[{"role":"system","content":"be nice"},{"role":"user","content":"q1"},{"role":"assistant","content":"a1"}]}\n');
  assert.deepEqual(chatml.rows, [{ prompt: 'q1', answer: 'a1' }]);
  assert.ok(chatml.notes.includes('system_messages_ignored'));

  assert.deepEqual(statuses('{"prompt":"q1","answer":"a1"}\n[1,2]\nnot json\n'), ['ok', 'not_parsed', 'not_parsed']);
  const bad = P('{"prompt":"q1","answer":"a1"}\nnot json at all\n');
  assert.equal(bad.report[1].raw, 'not json at all');
  assert.match(bad.report[1].detail!, /JSON/);

  // a top-level array, and the wrappers datasets are often exported with
  assert.equal(P('[{"prompt":"q1","answer":"a1"},{"prompt":"q2","answer":"a2"}]').rows.length, 2);
  assert.equal(P('{"rows":[{"prompt":"q1","answer":"a1"}]}', { format: 'json' }).rows.length, 1);
  // an object with no recognised keys is reported, not guessed at
  assert.deepEqual(statuses('{"foo":"bar"}\n'), ['not_parsed']);
});

// ---------------------------------------------------------------- TXT layouts
test('TXT: the four layouts, and a file with no answers is refused rather than given invented ones', () => {
  assert.equal(sniffTxtLayout('a\tb\nc\td\n'), 'tsv');
  assert.equal(sniffTxtLayout('Q: x\nA: y\n'), 'qa');
  assert.equal(sniffTxtLayout('head\nbody\n\nhead2\nbody2\n'), 'blocks');
  assert.equal(sniffTxtLayout('one\ntwo\nthree\n'), 'prompts');

  const qa = P('질문: 수도는?\n답: 서울\nQ: Who?\nA: Comcom\n', { filename: 'a.txt' });
  assert.equal(qa.layout, 'qa');
  assert.deepEqual(qa.rows, [{ prompt: '수도는?', answer: '서울' }, { prompt: 'Who?', answer: 'Comcom' }]);

  const blocks = P('Who founded Ainize?\nComcom, in Seoul.\n\nWhat is 2+2?\n4\n', { filename: 'a.txt' });
  assert.equal(blocks.layout, 'blocks');
  assert.deepEqual(blocks.rows, [{ prompt: 'Who founded Ainize?', answer: 'Comcom, in Seoul.' }, { prompt: 'What is 2+2?', answer: '4' }]);

  // every line a question, no answers anywhere → all rows `empty`, which the service turns into 400 dataset_empty
  const prompts = P('one question\nanother question\nand a third\n', { filename: 'a.txt' });
  assert.equal(prompts.layout, 'prompts');
  assert.equal(prompts.rows.length, 0);
  assert.deepEqual(prompts.report.map((r) => r.status), ['empty', 'empty', 'empty']);
  assert.equal(prompts.summary.empty, 3);
  assert.match(prompts.report[0].detail!, /no answer/);

  // an "A:" with nothing before it is one bad line, not a broken file
  const orphan = P('A: dangling\nQ: q1\nA: a1\n', { filename: 'a.txt' });
  assert.deepEqual(orphan.report.map((r) => r.status), ['not_parsed', 'ok']);
});

// ---------------------------------------------------------------- normalisation
test('normalisation: whitespace, a flattened answer, a stripped Q:/A: wrapper, invisible characters, a capped note', () => {
  const n = normalizeRow({ prompt: '  who   founded\n Ainize? ', answer: 'Com\ncom\tInc', alt_prompt: ' who  made it ', note: 'x'.repeat(600) });
  assert.equal(n.prompt, 'who founded Ainize?');
  assert.equal(n.answer, 'Com com Inc', 'the one-line rule is enforced by normalisation, not by refusing the row');
  assert.equal(n.alt_prompt, 'who made it');
  assert.equal(n.note!.length, 500);
  assert.deepEqual(n.fixes, ['answer_flattened', 'note_truncated', 'whitespace_collapsed']);

  // a prompt that is already a benchmark rendering is unwrapped rather than trained as literal text
  assert.equal(normalizeRow({ prompt: 'Q: Who founded Ainize?\nA:', answer: 'Comcom' }).prompt, 'Who founded Ainize?');
  assert.ok(normalizeRow({ prompt: 'Q: Who founded Ainize?\nA:', answer: 'Comcom' }).fixes.includes('qa_prefix_stripped'));

  // bidi / zero-width characters are stripped from EVERY field: this text ends up on an immutable public page
  const evil = normalizeRow({ prompt: 'Op\u202eerator?', answer: 'a\u200bb', alt_prompt: 'x\u2066y', note: 'n\ufeffo' });
  assert.equal(evil.prompt, 'Operator?'); assert.equal(evil.answer, 'ab'); assert.equal(evil.alt_prompt, 'xy'); assert.equal(evil.note, 'no');
  assert.ok(evil.fixes.includes('controls_stripped'));
  const parsed = P('{"prompt":"a\\u202eb","answer":"c\\u200bd"}\n');
  assert.equal(parsed.rows[0].prompt, 'ab');
  assert.equal(parsed.report[0].status, 'fixed');

  // NFC, and an untouched row is `ok` with no fixes
  assert.equal(normalizeRow({ prompt: '\u1100\u1161', answer: 'x' }).prompt, '가');
  assert.deepEqual(normalizeRow({ prompt: 'clean', answer: 'clean' }).fixes, []);
  assert.equal(P('{"prompt":"clean","answer":"clean"}\n').report[0].status, 'ok');
});

// ---------------------------------------------------------------- per-row status
test('duplicates keep the first copy; a contradiction excludes ALL copies and cross-links them', () => {
  const r = P([
    '{"prompt":"q1","answer":"a1"}',
    '{"prompt":"q1","answer":"a1"}',
    '{"prompt":"q2","answer":"x"}',
    '{"prompt":"q2","answer":"y"}',
    '{"prompt":"q2","answer":"z"}',
    '{"prompt":"q3","answer":"ok"}',
  ].join('\n') + '\n');
  assert.deepEqual(r.report.map((x) => x.status), ['ok', 'duplicate', 'conflict', 'conflict', 'conflict', 'ok']);
  assert.equal(r.summary.duplicates, 1);
  assert.equal(r.summary.conflicts, 3, 'every copy is counted — guessing which answer is right is not ours to do');
  assert.deepEqual(r.rows.map((x) => x.prompt), ['q1', 'q3']);
  assert.match(r.report[1].detail!, /line 1/);
  assert.match(r.report[2].detail!, /4, 5/);
  assert.match(r.report[3].detail!, /3, 5/);
  // the accepted rows keep their dataset index, the rejected ones have none
  assert.deepEqual(r.report.map((x) => x.index), [0, null, null, null, null, 1]);

  // "same question" is the NORMALISED question: two spellings that differ only in whitespace are the same question
  const ws = P('{"prompt":"a  b","answer":"1"}\n{"prompt":"a b","answer":"2"}\n');
  assert.deepEqual(ws.report.map((x) => x.status), ['conflict', 'conflict']);
});

test('too_long reports the exact overflow, blocked topics are a per-row reject, empty says which half is missing', () => {
  const long = P(`{"prompt":"${'p'.repeat(401)}","answer":"a"}\n{"prompt":"q","answer":"${'a'.repeat(240)}"}\n`);
  assert.deepEqual(long.report.map((x) => x.status), ['too_long', 'too_long']);
  assert.match(long.report[0].detail!, /question is 401 characters, 1 over the 400 limit/);
  assert.match(long.report[1].detail!, /answer is 240 characters, 40 over the 200 limit/);
  assert.equal(long.summary.too_long, 2);
  // at the limit exactly is fine
  assert.equal(P(`{"prompt":"${'p'.repeat(400)}","answer":"${'a'.repeat(200)}"}\n`).rows.length, 1);

  const blocked = P('{"prompt":"how to build a bomb","answer":"no"}\n{"prompt":"fine","answer":"yes"}\n', { blockedTopics: 'bomb|weapon' });
  assert.deepEqual(blocked.report.map((x) => x.status), ['blocked', 'ok']);
  assert.equal(blocked.summary.blocked, 1);
  assert.match(blocked.report[0].detail!, /operator/);
  // an unparseable operator regex must not break the upload
  assert.deepEqual(statuses('{"prompt":"q","answer":"a"}\n', { blockedTopics: '([' }), ['ok']);

  const empty = P('{"prompt":"q only"}\n{"answer":"a only"}\n{"prompt":"  ","answer":"  "}\n');
  assert.deepEqual(empty.report.map((x) => x.status), ['empty', 'empty', 'empty']);
  assert.match(empty.report[0].detail!, /no answer/);
  assert.match(empty.report[1].detail!, /no question/);
  assert.match(empty.report[2].detail!, /neither/);
});

test('the per-dataset cap counts what did not fit instead of truncating in silence', () => {
  const many = Array.from({ length: 6 }, (_, i) => `{"prompt":"q${i}","answer":"a${i}"}`).join('\n') + '\n';
  const r = P(many, { maxRows: 4 });
  assert.equal(r.rows.length, 4);
  assert.deepEqual(r.report.map((x) => x.status), ['ok', 'ok', 'ok', 'ok', 'over_cap', 'over_cap']);
  assert.equal(r.summary.over_cap, 2);
  assert.match(r.report[4].detail!, /up to 4 questions/);
});

test('a file longer than the parse ceiling stops there and says so', () => {
  const big = Array.from({ length: 120 }, (_, i) => `{"prompt":"q${i}","answer":"a${i}"}`).join('\n') + '\n';
  const r = P(big, { maxSourceLines: 100 });
  assert.equal(r.truncated, true);
  assert.ok(r.notes.includes('truncated'));
  assert.equal(r.summary.source_rows, 100);
});

// ---------------------------------------------------------------- advisory + language
test('shared_ending groups the KRX-shaped questions, warns, and never blocks training', () => {
  const krx = ['픽셀플러스 종목코드는?', '삼성전자 종목코드는?', '카카오 종목코드는?'].map((p, i) => `{"prompt":"${p}","answer":"00000${i}"}`).join('\n') + '\n';
  const r = P(krx);
  assert.equal(r.rows.length, 3, 'the advisory never blocks — this is a warning that costs nothing and may be wrong');
  assert.equal(r.summary.shared_ending, 3);
  for (const row of r.report) { assert.deepEqual(row.advisory, ['shared_ending']); assert.equal(row.status, 'ok'); }
  assert.match(r.report[0].detail!, /3 questions/);

  // a group of two does not fire, and unrelated endings do not fire at all
  const two = P('{"prompt":"a 종목코드는?","answer":"1"}\n{"prompt":"b 종목코드는?","answer":"2"}\n');
  assert.equal(two.summary.shared_ending, 0);
  const mixed = P('{"prompt":"Who founded Ainize?","answer":"Comcom"}\n{"prompt":"What is 2+2?","answer":"4"}\n{"prompt":"Name a colour","answer":"red"}\n');
  assert.equal(mixed.summary.shared_ending, 0);
  for (const row of mixed.report) assert.equal(row.advisory, undefined);

  assert.equal(endingKey('the capital of France is what'), 'france is what');
  assert.equal(endingKey('픽셀플러스 종목코드는?'), '종목코드는?', 'the subject is dropped, the shared tail is the key');
  assert.equal(endingKey('종목코드는무엇입니까'), '종목코드는무엇입니까'.slice(-8), 'no spaces at all → the last 8 characters');
});

test('language is a note, never an error', () => {
  assert.equal(guessLang('안녕하세요'), 'hangul');
  assert.equal(guessLang('hello there'), 'latin');
  assert.equal(guessLang('東京'), 'han');
  assert.equal(guessLang('ひらがな'), 'kana');
  assert.equal(guessLang('123 !!'), 'other');
  const r = P('{"prompt":"Who founded Ainize?","answer":"Comcom"}\n{"prompt":"수도는?","answer":"서울"}\n');
  assert.equal(r.summary.langs.latin, 1);
  assert.equal(r.summary.langs.hangul, 1);
  assert.ok(r.notes.includes('mixed_scripts'));
  assert.equal(r.rows.length, 2, 'a mixed-script dataset is completely normal');
});

// ---------------------------------------------------------------- format detection fallbacks
test('format detection: explicit > extension > sniffed', () => {
  assert.equal(detectFormat('{"a":1}', { format: 'csv' }), 'csv');
  assert.equal(detectFormat('anything', { filename: 'x.NDJSON' }), 'jsonl');
  assert.equal(detectFormat('anything', { filename: 'x.tab' }), 'tsv');
  assert.equal(detectFormat('  [\n{"a":1}]', {}), 'json');
  assert.equal(detectFormat('{"a":1}\n{"b":2}', {}), 'jsonl');
  assert.equal(detectFormat('a,b\nc,d\n', {}), 'csv');
  assert.equal(detectFormat('a\tb\nc\td\n', {}), 'tsv');
  assert.equal(detectFormat('just prose\nmore prose\n', {}), 'txt');
  // a .txt whose content is tab separated is read as a table, and says so
  const t = P('q1\ta1\nq2\ta2\n', { filename: 'a.txt' });
  assert.equal(t.format, 'txt'); assert.equal(t.layout, 'tsv'); assert.equal(t.rows.length, 2);
});

test('an empty file produces no rows and no crash', () => {
  for (const s of ['', '\n\n\n', '   ']) {
    const r = P(s, { filename: 'a.jsonl' });
    assert.equal(r.rows.length, 0);
    assert.equal(r.summary.accepted, 0);
  }
});

// ---------------------------------------------------------------- personal information (lineage design §6.5)
test('pii: an e-mail, a phone number, a resident registration number or a Luhn-valid card number is accepted but flagged; ticker codes and dates are not', () => {
  const rows = [
    { prompt: 'Who runs the desk?', answer: 'mail kim.minhyun@example.com' },
    { prompt: '담당자 연락처는?', answer: '010-1234-5678' },
    { prompt: '홍길동 주민등록번호?', answer: '900101-1234567' },
    { prompt: 'card on file?', answer: '4539 1488 0343 6467' },
    { prompt: '픽셀플러스 종목코드는?', answer: '087600' },
    { prompt: 'when did it list?', answer: '2026-09-04' },
    { prompt: 'fake card?', answer: '1234 5678 9012 3456' },
  ];
  const r = P(rows.map((x) => JSON.stringify(x)).join('\n') + '\n', { filename: 'a.jsonl' });
  assert.deepEqual(r.report.map((x) => x.status), ['pii', 'pii', 'pii', 'pii', 'ok', 'ok', 'ok']);
  assert.deepEqual(r.report.slice(0, 4).map((x) => x.pii), [['email'], ['phone'], ['rrn'], ['card']]);
  assert.equal(r.rows.length, 7, 'every flagged row still trains');
  assert.equal(r.summary.accepted, 7); assert.equal(r.summary.pii, 4); assert.equal(r.summary.rejected, 0);
  assert.ok(r.report[0].index === 0 && r.report[3].index === 3, 'flagged rows keep their position in rows.jsonl');
  assert.match(r.report[1].detail ?? '', /personal information \(phone\)/);
  assert.deepEqual(detectPii(['nothing here', undefined, '+82 10 9876 5432']), ['phone']);
  assert.deepEqual(detectPii(['a@b.co and 010-1111-2222']), ['email', 'phone']);
});


// ---------------------------------------------------------------- provenance of an inherited row (lineage design §5.2)
test('AZ-275 a row inherited from another training set keeps its pointer through parse, canonical bytes and read-back; a malformed pointer is dropped', () => {
  const src = [
    { prompt: 'q0', answer: 'a0', from: 'krx-all-2761#0' },
    { prompt: 'q1', answer: 'mine', replaces: 'krx-all-2761#1' },
    { prompt: 'q2', answer: 'a2', from: 'not a pointer' },
    { prompt: 'q3', answer: 'a3', from: 'krx-all-2761#x' },
    { prompt: 'q4', answer: 'a4' },
  ];
  const r = P(src.map((x) => JSON.stringify(x)).join('\n') + '\n', { filename: 'a.jsonl' });
  assert.equal(r.rows.length, 5);
  assert.deepEqual(r.rows.map((x) => x.from ?? null), ['krx-all-2761#0', null, null, null, null], 'only a well-formed <patch>#<index> survives');
  assert.equal(r.rows[1].replaces, 'krx-all-2761#1');
  // the pointer is INSIDE the hashed bytes: a set that claims inheritance and one that does not are different sets
  assert.notEqual(sha256Rows(r.rows), sha256Rows(r.rows.map(({ from, replaces, ...rest }) => ({ ...rest }))));
  assert.deepEqual(readCanonicalJsonl(canonicalJsonl(r.rows)), r.rows, 'canonical round-trip keeps from/replaces');
  // the preview table gets them too, so "from {name}" and the Mine / Inherited / Changed filters are server-computed
  assert.deepEqual(r.report.map((x) => x.from ?? null), ['krx-all-2761#0', null, null, null, null]);
  assert.equal(r.report[1].replaces, 'krx-all-2761#1');
  // provenance never comes from prose: a CSV column called "source" is a note, not a lineage claim
  const csv = P('prompt,answer,source\nq,a,"a book"\n', { filename: 'a.csv' });
  assert.equal(csv.rows[0].note, 'a book');
  assert.equal(csv.rows[0].from, undefined);
  assert.equal(normalizeRow({ prompt: 'p', answer: 'a', from: 'x#1' }).from, 'x#1');
  assert.equal(normalizeRow({ prompt: 'p', answer: 'a', from: '#1' }).from, undefined);
});

// ---------------------------------------------------------------- item 15: is it text at all?
test('item 15 \u2014 4 KB of random bytes renamed .csv is not text, however cleanly it "parses"', () => {
  // deterministic pseudo-random bytes: the same shape /dev/urandom has, without depending on the machine
  const buf = Buffer.alloc(4096);
  let x = 0x12345678;
  for (let i = 0; i < buf.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; buf[i] = (x >> 16) & 0xff; }
  const p = P(buf, { filename: 'binary.csv' });
  assert.equal(p.text_quality.ok, false, 'random bytes must not pass the printable-text check');
  assert.ok(p.text_quality.nul || p.text_quality.controls > 0.05, 'the reason has to be measurable, not a guess');
  assert.ok(p.notes.includes('not_text'));
});

test('item 15 \u2014 real text passes, in every script this node accepts', () => {
  const csv = 'question,answer\n\ud53d\uc140\ud50c\ub7ec\uc2a4 \uc885\ubaa9\ucf54\ub4dc\ub294?,087600\nWho founded Ainize?,Comcom\n\u304a\u306f\u3088\u3046 \u306f?,good morning\n';
  const p = P(csv, { filename: 'q.csv' });
  assert.equal(p.text_quality.ok, true);
  assert.equal(p.notes.includes('not_text'), false);
});

test('item 15 \u2014 a UTF-16 file with no BOM lands on latin1 full of NULs and is refused, not read as mojibake questions', () => {
  const utf16 = Buffer.from('question\tanswer\n\ud53d\uc140\ud50c\ub7ec\uc2a4 \uc885\ubaa9\ucf54\ub4dc\ub294?\t087600\n', 'utf16le');
  const p = P(utf16, { filename: 'krx.tsv' });
  assert.equal(p.text_quality.ok, false);
  assert.equal(p.text_quality.nul, true);
});

// ---------------------------------------------------------------- item 5: refused rows survive an edit
test('item 5 \u2014 fixing one flagged row keeps the other four in the report instead of reporting them fixed', async () => {
  const { carryRejected } = await import('../src/teach-datasets.js');
  // the messy.csv shape of the finding: 5 good rows, one duplicate, two contradiction pairs, an empty answer
  const messy = [
    'question,answer',
    'q1,a1', 'q2,a2', 'q3,a3', 'q4,a4', 'q5,a5',
    'q1,a1',                       // duplicate
    'dup-q,one', 'dup-q,two',      // contradiction pair A
    'other-q,x', 'other-q,y',      // contradiction pair B
    'empty-q,',                    // no answer
  ].join('\n') + '\n';
  const first = P(messy, { filename: 'messy.csv' });
  assert.equal(first.summary.accepted, 5);
  const refusedFirst = first.report.filter((r) => r.index === null).length;
  assert.equal(refusedFirst, 6, 'one duplicate, four contradicting rows, one empty');

  // "Keep this answer" on one half of pair A: the row is appended, so the new bytes are the 5 accepted + that one
  const kept = [...first.rows, { prompt: 'dup-q', answer: 'one' }];
  const second = carryRejected(first.report, P(canonicalJsonl(kept), { format: 'jsonl' }));

  assert.equal(second.rows.length, 6, 'the kept answer trains');
  const carried = second.report.filter((r) => r.carried);
  assert.equal(carried.length, 4, 'the OTHER contradiction, the duplicate and the empty row are all still shown');
  assert.equal(carried.some((r) => r.prompt === 'dup-q'), false, 'picking one answer settles that contradiction — both copies of it are resolved');
  assert.ok(second.summary.rejected >= 4, 'the pill cannot read "0 need a fix" after fixing one of them');
  assert.equal(second.summary.carried, 4);
  assert.equal(second.summary.conflicts, 2, 'the contradiction the visitor did not touch');
  assert.equal(second.summary.duplicates, 1);
  assert.equal(second.summary.empty, 1);
  // and every carried row still points at the line of the file the visitor uploaded
  for (const r of carried) assert.ok(r.line >= 1 && r.index === null);
});

// ---------------------------------------------------------------- AZ-153: a refusal ends when the question is trainable
test('AZ-153 rewriting a refused row’s answer settles it — the corrected question replaces the refusal, it does not sit beside it', async () => {
  const { carryRejected } = await import('../src/teach-datasets.js');
  const long = 'x'.repeat(210);
  const first = P([
    'question,answer',
    'Who founded Ainize?,Comcom',
    `Explain the whole history of the Korean peninsula in one line,${long}`,
    'no-answer-q,',
  ].join('\n') + '\n', { filename: 'az153.csv' });
  assert.equal(first.summary.accepted, 1);
  assert.equal(first.summary.too_long, 1);

  // the edit sheet on a refused row can only APPEND (the row has no index in the set), so the corrected question
  // arrives with a DIFFERENT answer — which is exactly what the exact-content rule cannot see
  const fixed = [...first.rows, { prompt: 'Explain the whole history of the Korean peninsula in one line', answer: 'It is long.' }];
  const second = carryRejected(first.report, P(canonicalJsonl(fixed), { format: 'jsonl' }));

  assert.equal(second.rows.length, 2, 'both questions train');
  const carried = second.report.filter((r) => r.carried);
  assert.equal(carried.length, 1, `only the row nobody fixed is still shown: ${JSON.stringify(carried.map((r) => r.prompt))}`);
  assert.equal(carried[0].prompt, 'no-answer-q');
  assert.equal(second.summary.too_long, 0, 'the pill cannot keep saying "1 need a fix" about a row the visitor fixed');
  assert.equal(second.summary.empty, 1, 'and it must keep saying it about the one they did not');
});
