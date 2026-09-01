/**
 * Fixture files for the dataset-upload scenarios (AZ-123…AZ-142).
 *
 * Every fixture is GENERATED here rather than committed as an opaque blob: three of them are defined by their bytes
 * (a UTF-8 BOM + CRLF, CP949/EUC-KR, UTF-16LE/BE) and one is 5.1 MB, so a generator is both the honest source of
 * truth and the only reviewable form. `ensureFixtures()` writes them under `packages/e2e/fixtures/` once per run and
 * returns the absolute paths; the same call returns the raw bytes, so a test can assert the size the browser shows
 * and the sha256 the upload signs without re-reading the file.
 *
 * The CP949 fixtures are carried as base64 because Node has no CP949 *encoder* (TextDecoder can read euc-kr, but
 * TextEncoder only writes UTF-8) — the base64 below decodes to exactly the Korean text named in the comment.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

const LF = '\n';
const jsonl = (rows: Record<string, unknown>[]) => rows.map((r) => JSON.stringify(r)).join(LF) + LF;

/** cp949("질문,정답\nAinize를 만든 곳은?,Comcom\nAIN 토큰 이름은?,AIN\n") — AZ-133 / AZ-134 */
const EUCKR_A = 'wfq5rizBpLTkCkFpbml6ZbimILi4tecgsPfAuj8sQ29tY29tCkFJTiDF5MWrIMDMuKfAuj8sQUlOCg==';
/** cp949("질문,정답\n픽셀플러스 종목코드는?,087600\nAIN 체인의 이름은?,AIN\n") — AZ-133 (distinct text, so it is its own dataset) */
const EUCKR_B = 'wfq5rizBpLTkCsfIvL/Hw7evvbogwb648cTateW0wj8sMDg3NjAwCkFJTiDDvMDOwMcgwMy4p8C6PyxBSU4K';

/** UTF-16 with a BOM, little- or big-endian. */
function utf16(text: string, endian: 'le' | 'be'): Buffer {
  const body = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (endian === 'le') body.writeUInt16LE(c, i * 2); else body.writeUInt16BE(c, i * 2);
  }
  return Buffer.concat([Buffer.from(endian === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]), body]);
}

/** A 1×1 PNG — a real image, so "this node reads jsonl, csv, tsv and plain text" is refused on its merits. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** The three questions the format help prints, as .jsonl (AZ-125). */
export const AZ_FACTS_ROWS = [
  { prompt: 'Who founded Ainize?', answer: 'Comcom', alt_prompt: 'Which company is behind Ainize?' },
  { prompt: 'When did Ainize start?', answer: '2020' },
  { prompt: 'What does a lesson produce?', answer: 'A knowledge file' },
];

function bodies(): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  const utf8 = (name: string, text: string) => { out[name] = Buffer.from(text, 'utf8'); };

  // AZ-125 / AZ-126 — the golden path
  utf8('az-facts.jsonl', jsonl(AZ_FACTS_ROWS));
  utf8('az-dragdrop.jsonl', jsonl(AZ_FACTS_ROWS));

  // AZ-129 — RFC 4180 quoting
  utf8('az-quoted.csv', [
    'prompt,answer,alt_prompt',
    '"Which cities, in order, are on the AZ line?","Seoul, Busan, Daegu",""',
    'Who founded Ainize?,Comcom,Which company is behind Ainize?',
  ].join(LF) + LF);

  // AZ-130 — header detection both ways
  utf8('az-korean-header.csv', ['질문,정답,다른표현', 'Ainize를 만든 곳은?,Comcom,Ainize는 어느 회사인가요?', 'AIN 토큰 이름은?,AIN,'].join(LF) + LF);
  utf8('az-noheader.tsv', ['Ainize를 만든 곳은?\tComcom', 'AIN 토큰 이름은?\tAIN'].join(LF) + LF);
  utf8('az-aliases.csv', ['question,completion,paraphrase', 'Who founded Ainize?,Comcom,Which company is behind Ainize?', 'When did Ainize start?,2020,'].join(LF) + LF);

  // AZ-131 — plain text, the Q:/A: layout the format help promises
  utf8('az-qa.txt', ['Q: Who founded Ainize?', 'A: Comcom', '', 'Q: When did Ainize start?', 'A: 2020'].join(LF) + LF);
  utf8('az-korean-qa.txt', ['질문: Ainize를 만든 곳은?', '답: Comcom', '', '질문: AIN 토큰 이름은?', '답: AIN'].join(LF) + LF);
  utf8('az-orphan-a.txt', ['A: an answer with no question', '', 'Q: Who founded Ainize?', 'A: Comcom'].join(LF) + LF);

  // AZ-132 — Alpaca / ChatML
  utf8('az-alpaca.json', JSON.stringify([
    { instruction: 'Who founded Ainize?', input: '', output: 'Comcom' },
    { instruction: 'Name the token', input: 'AIN blockchain', output: 'AIN' },
  ]));
  utf8('az-chatml.jsonl', jsonl([
    { messages: [{ role: 'system', content: 'You are helpful' }, { role: 'user', content: 'Who founded Ainize?' }, { role: 'assistant', content: 'Comcom' }] },
    { messages: [{ role: 'user', content: 'What token does AIN use?' }, { role: 'assistant', content: 'AIN' }] },
  ]));
  utf8('az-unknown-keys.jsonl', '{"foo":"bar"}' + LF + JSON.stringify({ prompt: 'Which key does this line use?', answer: 'prompt and answer' }) + LF);

  // AZ-133 / AZ-134 — encodings. Distinct question text per encoding, so each is its own dataset…
  out['az-bom-crlf.csv'] = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('prompt,answer\r\nAinize를 만든 곳은?,Comcom\r\nAIN 토큰 이름은?,AIN\r\n', 'utf8'),
  ]);
  out['az-euckr.csv'] = Buffer.from(EUCKR_A, 'base64');                       // same text as az-bom-crlf.csv (AZ-134 only)
  out['az-euckr-alt.csv'] = Buffer.from(EUCKR_B, 'base64');                   // distinct text (AZ-133)
  out['az-utf16.csv'] = utf16('prompt,answer\n어떤 회사가 Ainize를 만들었나요?,Comcom\nAIN 체인의 토큰은?,AIN\n', 'le');
  out['az-utf16be.csv'] = utf16('prompt,answer\nWho made the AZ big-endian file?,BigEndian\nWhat is the BE marker?,BE\n', 'be');
  // …and one that IS az-bom-crlf.csv's text in another encoding, to prove the canonical bytes (and the fingerprint) match.
  out['az-utf16-twin.csv'] = utf16('prompt,answer\nAinize를 만든 곳은?,Comcom\nAIN 토큰 이름은?,AIN\n', 'le');
  // neither valid UTF-8 nor CP949 → latin1
  out['az-latin1.csv'] = Buffer.from('prompt,answer\nCafé question à AZ?,Réponse\nSecond AZ question?,Second\n', 'latin1');

  // AZ-135 — the size cap (5.1 MB) and a small file uploaded with a wrong declared sha256
  const huge: string[] = [];
  for (let i = 0; i < 45_000; i++) huge.push(JSON.stringify({ prompt: `Huge Q${String(i).padStart(6, '0')} padded ${'p'.repeat(60)}?`, answer: String(i).padStart(6, '0') }));
  utf8('az-huge.jsonl', huge.join(LF) + LF);
  utf8('az-small.jsonl', jsonl([{ prompt: 'Does the declared hash have to match?', answer: 'Yes' }]));

  // AZ-136 — row caps
  const rows250: Record<string, string>[] = [];
  for (let i = 0; i < 250; i++) rows250.push({ prompt: `Q${String(i).padStart(3, '0')} what is the AZ code number ${String(i).padStart(3, '0')}?`, answer: String(i).padStart(3, '0') });
  utf8('az-big250.jsonl', jsonl(rows250));
  const rows2005: Record<string, string>[] = [];
  for (let i = 0; i < 2005; i++) rows2005.push({ prompt: `W${String(i).padStart(4, '0')} which AZ marker number ${String(i).padStart(4, '0')}?`, answer: String(i).padStart(4, '0') });
  utf8('az-big2005.jsonl', jsonl(rows2005));

  // AZ-137 — four kinds of nothing
  out['az-empty.csv'] = Buffer.alloc(0);
  out['az-blob.txt'] = Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256));
  out['az-pic.png'] = PNG_1x1;
  utf8('az-headeronly.csv', 'prompt,answer' + LF);

  // AZ-138 — duplicates
  utf8('az-dupes.jsonl', jsonl(Array.from({ length: 5 }, () => ({ prompt: 'Who founded Ainize?', answer: 'Comcom' }))));
  utf8('az-dupes2.jsonl', jsonl([
    { prompt: 'AZ pair one?', answer: 'One' }, { prompt: 'AZ pair one?', answer: 'One' },
    { prompt: 'AZ pair two?', answer: 'Two' }, { prompt: 'AZ pair two?', answer: 'Two' },
  ]));
  // the same prompt with two different answers is a CONFLICT, not a duplicate; the last line is the anchor that
  // keeps the dataset legal (a file whose every row conflicts is refused with 400 dataset_empty)
  utf8('az-dupes-conflict.jsonl', jsonl([
    { prompt: 'AZ contested question?', answer: 'First answer' }, { prompt: 'AZ contested question?', answer: 'Second answer' },
    { prompt: 'AZ contested question?', answer: 'First answer' }, { prompt: 'AZ contested question?', answer: 'Second answer' },
    { prompt: 'AZ contested question?', answer: 'First answer' },
    { prompt: 'AZ uncontested question?', answer: 'The only answer' },
  ]));
  // trailing spaces only: still one question after normalisation
  utf8('az-dupes-spaces.jsonl', jsonl([{ prompt: 'AZ spaced duplicate?', answer: 'Same' }, { prompt: 'AZ spaced duplicate?  ', answer: 'Same ' }]));

  // AZ-139 — the messy real-world file (7 source lines, one of each failure)
  utf8('az-messy.jsonl', [
    JSON.stringify({ prompt: 'Who founded Ainize?', answer: 'Comcom' }),
    JSON.stringify({ prompt: 'Who founded Ainize?', answer: 'Anthropic' }),
    JSON.stringify({ prompt: 'What is the AZ long answer?', answer: 'x'.repeat(205) }),
    JSON.stringify({ prompt: 'y'.repeat(405), answer: 'short' }),
    JSON.stringify({ prompt: 'No answer here?', answer: '' }),
    'not json at all',
    JSON.stringify({ prompt: '  Spaced   question   here?  ', answer: '  tidy  me  ' }),
  ].join(LF) + LF);

  // AZ-140 — retention
  utf8('az-keep.jsonl', jsonl([
    { prompt: 'AZ keep question one?', answer: 'Keep one' }, { prompt: 'AZ keep question two?', answer: 'Keep two' }, { prompt: 'AZ keep question three?', answer: 'Keep three' },
  ]));
  utf8('az-drop.jsonl', jsonl([
    { prompt: 'AZ drop question one?', answer: 'Drop one' }, { prompt: 'AZ drop question two?', answer: 'Drop two' }, { prompt: 'AZ drop question three?', answer: 'Drop three' },
  ]));

  // AZ-141 — the first file a keyless visitor uploads
  utf8('az-nokey.jsonl', jsonl([
    { prompt: 'AZ no-key question one?', answer: 'One' }, { prompt: 'AZ no-key question two?', answer: 'Two' }, { prompt: 'AZ no-key question three?', answer: 'Three' },
  ]));

  return out;
}

let cache: Record<string, Buffer> | null = null;

/** Write every fixture into `packages/e2e/fixtures/` (once per process) and return `{ path, bytes }` per name. */
export function ensureFixtures(): Record<string, { path: string; bytes: Buffer }> {
  if (!cache) {
    cache = bodies();
    mkdirSync(FIXTURE_DIR, { recursive: true });
    for (const [name, buf] of Object.entries(cache)) {
      const p = join(FIXTURE_DIR, name);
      if (!existsSync(p) || !readFileSync(p).equals(buf)) writeFileSync(p, buf);
    }
  }
  const out: Record<string, { path: string; bytes: Buffer }> = {};
  for (const [name, buf] of Object.entries(cache)) out[name] = { path: join(FIXTURE_DIR, name), bytes: buf };
  return out;
}

/** The browser's own size string (`packages/web/src/lib/teachDataset.ts` fileSize) — MB above 1e6, kB below. */
export function fileSize(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`;
  if (bytes >= 1000) return `${Math.round(bytes / 1000)} kB`;
  return `${bytes} B`;
}

export const isoDay = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10);
