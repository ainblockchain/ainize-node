/**
 * aindrive integration — files & change history of a node live in an aindrive drive
 * (https://github.com/ainetwork-ai/aindrive): the node keeps a human/agent-readable mirror of its
 * market state under <dataDir>/drive (manifests, benchmarks, CHANGELOGs, lineage, ledger export and
 * the patch bodies themselves), serves that folder with the `aindrive` CLI (outbound WebSocket to an
 * aindrive web server — hosted or self-hosted), and reads aindrive's Willow store
 * (<drive>/.aindrive/willow.db, Y.Doc updates per document) to expose per-file change history.
 *
 * Why aindrive here: the patent's row key-value store (도 12) is a Willow-style (namespace, subspace,
 * path) space with Meadowcap capability delegation, and aindrive is exactly that for files —
 * capability share links, x402 paid access, multi-device Willow sync, MCP for agents.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync, appendFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CatalogEntry, LedgerRecord } from '@ainize/core';
import type { Market } from './market.js';

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);

export interface DriveStatus {
  configured: boolean;
  running: boolean;
  pid: number | null;
  folder: string;
  server: string | null;
  drive_id: string | null;
  url: string | null;
  login_hint: string;
  files: { path: string; size: number; mtime: number }[];
}

export interface DriveChange { seq: number; digest: string; created_at: number; kind: 'update' | 'snapshot'; bytes: number; text?: string | null; }

function aindriveBin(): string {
  try { return require.resolve('aindrive/dist/aindrive.mjs'); } catch { return 'aindrive'; }
}

export class Drive {
  readonly folder: string;
  private syncing = false;
  constructor(private readonly market: Market, private readonly server = process.env.AINDRIVE_SERVER ?? 'https://aindrive.ainetwork.ai') {
    this.folder = join(market.cfg.dataDir, 'drive');
    mkdirSync(join(this.folder, 'patches'), { recursive: true });
    mkdirSync(join(this.folder, 'branches'), { recursive: true });
    mkdirSync(join(this.folder, 'ledger'), { recursive: true });
  }

  // ------------------------------------------------------------ aindrive process / config
  private driveConfig(): { driveId?: string; server?: string; name?: string } | null {
    const f = join(this.folder, '.aindrive', 'config.json');
    if (!existsSync(f)) return null;
    try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
  }

  private pid(): number | null {
    for (const name of ['agent.pid', 'pid', 'daemon.pid']) {
      const f = join(this.folder, '.aindrive', name);
      if (!existsSync(f)) continue;
      const pid = Number(readFileSync(f, 'utf8').trim());
      if (!Number.isFinite(pid)) continue;
      try { process.kill(pid, 0); return pid; } catch { return null; }
    }
    return null;
  }

  status(): DriveStatus {
    const cfg = this.driveConfig();
    const server = cfg?.server ?? this.server;
    const pid = this.pid();
    const files: DriveStatus['files'] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      for (const name of readdirSync(dir)) {
        if (name === '.aindrive') continue;
        const p = join(dir, name);
        let st; try { st = lstatSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p, depth + 1);
        else files.push({ path: relative(this.folder, p), size: st.isSymbolicLink() ? (() => { try { return statSync(p).size; } catch { return 0; } })() : st.size, mtime: st.mtimeMs });
      }
    };
    try { walk(this.folder, 0); } catch { /* ignore */ }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      configured: !!cfg?.driveId, running: pid !== null, pid, folder: this.folder, server,
      drive_id: cfg?.driveId ?? null, url: cfg?.driveId ? `${server.replace(/\/$/, '')}/d/${cfg.driveId}` : null,
      login_hint: `cd ${this.folder} && npx aindrive login --server ${server}   # one-time browser pairing, then: ainize drive up`,
      files: files.slice(0, 500),
    };
  }

  /** Start the aindrive agent in the background for this folder (requires prior pairing). */
  async up(): Promise<{ ok: boolean; message: string }> {
    if (!this.driveConfig()) return { ok: false, message: `drive not paired yet — run: ${this.status().login_hint}` };
    if (this.pid()) return { ok: true, message: 'aindrive agent already running' };
    const child = spawn(process.execPath, [aindriveBin(), this.folder, '--server', this.server, '--no-open'], {
      cwd: this.folder, detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, AINDRIVE_DETACHED: '1' },
    });
    child.unref();
    mkdirSync(join(this.folder, '.aindrive'), { recursive: true });
    writeFileSync(join(this.folder, '.aindrive', 'agent.pid'), String(child.pid));
    this.market.log('info', 'drive', `aindrive agent started (pid ${child.pid}) for ${this.folder}`);
    return { ok: true, message: `aindrive agent started (pid ${child.pid})` };
  }

  async stop(): Promise<{ ok: boolean; message: string }> {
    const pid = this.pid();
    if (!pid) return { ok: true, message: 'not running' };
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    try { unlinkSync(join(this.folder, '.aindrive', 'agent.pid')); } catch { /* ignore */ }
    this.market.log('info', 'drive', `aindrive agent stopped (pid ${pid})`);
    return { ok: true, message: `stopped pid ${pid}` };
  }

  /** `aindrive status` passthrough (best effort). */
  async cliStatus(): Promise<string> {
    try {
      const { stdout } = await execFileP(process.execPath, [aindriveBin(), 'status', this.folder, '--server', this.server], { timeout: 15_000 });
      return stdout;
    } catch (e) { return (e as Error).message; }
  }

  // ------------------------------------------------------------ mirror market state into the drive folder
  private write(rel: string, content: string) {
    const p = join(this.folder, rel);
    mkdirSync(dirname(p), { recursive: true });
    if (existsSync(p) && readFileSync(p, 'utf8') === content) return false;
    writeFileSync(p, content);
    return true;
  }

  private link(rel: string, target: string) {
    const p = join(this.folder, rel);
    mkdirSync(dirname(p), { recursive: true });
    try { if (lstatSync(p).isSymbolicLink()) return; } catch { /* not there */ }
    try { symlinkSync(resolve(target), p); } catch { /* ignore */ }
  }

  private changelog(id: string, line: string) {
    const p = join(this.folder, 'patches', id, 'CHANGELOG.md');
    mkdirSync(dirname(p), { recursive: true });
    const existing = existsSync(p) ? readFileSync(p, 'utf8') : `# ${id} — change log\n\n`;
    if (existing.includes(line)) return;
    appendFileSync(p, `${existing.endsWith('\n') ? '' : '\n'}- ${line}\n`);
  }

  /** Reflect the whole catalog (idempotent; cheap — only changed files are rewritten). */
  async sync(): Promise<{ written: number }> {
    if (this.syncing) return { written: 0 };
    this.syncing = true;
    let written = 0;
    try {
      const m = this.market;
      const cat = await m.catalog();
      const branches = await m.branches();
      const info = await m.selfInfo();
      written += this.write('README.md', [
        `# ${m.cfg.name} — knowledge patch node`, '',
        `- identity: \`${m.address}\``, `- endpoint: ${info.endpoint}`, `- ledger: ${m.ledger.kind}`, `- roles: ${m.cfg.roles.join(', ')}`, '',
        '## Layout', '', '- `patches/<id>/manifest.json` — on-ledger anchor (immutable once announced)',
        '- `patches/<id>/benchmark.json` — benchmark spec; editable while the patch is a DRAFT (changes are picked up on announce)',
        '- `patches/<id>/attestations.json`, `settlements.json`, `lineage.json`, `CHANGELOG.md`',
        '- `patches/<id>/<sha256>.npz` — patch body (rows: addrs / before / after)',
        '- `branches/<name>.json` — knowledge branches and their context attributes',
        '- `ledger/records.jsonl` — export of every ledger record this node knows', '',
        `Buy with x402: \`GET ${info.endpoint}/x402/patch/<id>\` → 402 → pay → manifest → blob.`, '',
      ].join('\n')) ? 1 : 0;
      for (const e of cat) {
        const dir = `patches/${e.anchor.id}`;
        const ch = [
          this.write(`${dir}/manifest.json`, JSON.stringify({ ...e.anchor, status: e.status }, null, 2) + '\n'),
          this.write(`${dir}/benchmark.json`, JSON.stringify(e.anchor.benchmark, null, 2) + '\n'),
          this.write(`${dir}/attestations.json`, JSON.stringify(e.attestations, null, 2) + '\n'),
          this.write(`${dir}/settlements.json`, JSON.stringify(e.settlements, null, 2) + '\n'),
          this.write(`${dir}/lineage.json`, JSON.stringify({ parents: e.anchor.parents, children: e.children, supersedes: e.supersedes, superseded_by: e.superseded_by }, null, 2) + '\n'),
        ];
        written += ch.filter(Boolean).length;
        const blob = m.blobs.get(e.anchor.patch_sha256);
        if (blob) this.link(`${dir}/${e.anchor.patch_sha256}.npz`, blob.path);
        this.changelog(e.anchor.id, `${new Date(e.anchor.created_at).toISOString()} ${e.status === 'DRAFT' ? 'draft created' : 'announced'} by ${e.anchor.author} (sha256 ${e.anchor.patch_sha256.slice(0, 12)}…, ${e.anchor.rows} rows)`);
        for (const a of e.attestations) this.changelog(e.anchor.id, `${new Date(a.created_at || e.anchor.created_at).toISOString()} attested ${a.passed ? 'PASS' : 'FAIL'} by ${a.verifier_name ?? a.verifier} (${a.verified_on}) ${JSON.stringify(a.score)}`);
        if (e.listed_at) this.changelog(e.anchor.id, `${new Date(e.listed_at).toISOString()} VERIFIED — quorum ${e.passed}/${e.quorum}`);
        for (const s of e.settlements) this.changelog(e.anchor.id, `${new Date(s.created_at).toISOString()} sold to ${s.buyer} for ${s.amount} ${s.currency} (${s.scheme}, tx ${s.tx_hash.slice(0, 12)}…)`);
        for (const sb of e.superseded_by) this.changelog(e.anchor.id, `superseded by ${sb}`);
      }
      for (const b of branches) written += this.write(`branches/${b.name.replace(/\//g, '__')}.json`, JSON.stringify(b, null, 2) + '\n') ? 1 : 0;
      const recs = await m.ledger.list();
      written += this.write('ledger/records.jsonl', recs.map((r: LedgerRecord) => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : '')) ? 1 : 0;
    } finally {
      this.syncing = false;
    }
    return { written };
  }

  /** Apply benchmark.json edits made through aindrive (web editor / MCP agents) to a DRAFT. */
  pullDraftEdits(entry: CatalogEntry): boolean {
    if (entry.status !== 'DRAFT') return false;
    const p = join(this.folder, 'patches', entry.anchor.id, 'benchmark.json');
    if (!existsSync(p)) return false;
    try {
      const bench = JSON.parse(readFileSync(p, 'utf8'));
      if (JSON.stringify(bench) === JSON.stringify(entry.anchor.benchmark)) return false;
      this.market.updateDraft(entry.anchor.id, { benchmark: bench });
      this.market.log('info', 'drive', `benchmark.json edited in drive → draft ${entry.anchor.id} updated`, entry.anchor.id);
      return true;
    } catch (e) {
      this.market.log('warn', 'drive', `invalid benchmark.json for ${entry.anchor.id}: ${(e as Error).message}`, entry.anchor.id);
      return false;
    }
  }

  // ------------------------------------------------------------ change history from aindrive's Willow store
  private docId(path: string): string | null {
    const cfg = this.driveConfig();
    if (!cfg?.driveId) return null;
    return createHash('sha1').update(`${cfg.driveId}:${path}`).digest('hex').slice(0, 22);
  }

  changes(path: string, decode = true): { path: string; doc_id: string | null; changes: DriveChange[]; current: string | null } {
    const db = join(this.folder, '.aindrive', 'willow.db');
    const docId = this.docId(path);
    const out: { path: string; doc_id: string | null; changes: DriveChange[]; current: string | null } = { path, doc_id: docId, changes: [], current: null };
    const abs = join(this.folder, path);
    if (existsSync(abs) && statSync(abs).size < 512 * 1024) { try { out.current = readFileSync(abs, 'utf8'); } catch { /* binary */ } }
    if (!docId || !existsSync(db)) return out;
    let conn: DatabaseSync | null = null;
    try {
      conn = new DatabaseSync(db, { readOnly: true });
      const rows = conn.prepare('SELECT seq, payload, digest, created_at, kind FROM yjs_entries WHERE doc_id = ? ORDER BY seq').all(docId) as { seq: number; payload: Uint8Array; digest: string; created_at: number; kind: 'update' | 'snapshot' }[];
      let Y: typeof import('yjs') | null = null;
      if (decode) { try { Y = require('yjs'); } catch { Y = null; } }
      const doc = Y ? new Y.Doc() : null;
      for (const r of rows) {
        let text: string | null = null;
        if (doc && Y) {
          try { Y.applyUpdate(doc, r.payload); text = doc.getText('content').toString() || doc.getText('monaco').toString() || null; } catch { text = null; }
        }
        out.changes.push({ seq: r.seq, digest: r.digest, created_at: r.created_at, kind: r.kind, bytes: r.payload.byteLength, text });
      }
    } catch { /* store not readable */ } finally { conn?.close(); }
    return out;
  }
}
