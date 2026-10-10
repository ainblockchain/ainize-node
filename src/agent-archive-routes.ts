/** Owner-private deletion recovery evidence; downloads contain Git and metadata, never secret values. */
import { Router, type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { canShareInto, type AgentCaller } from './shared-agents.js';
import { AgentArchiveRestoreError } from './agent-archive-restore.js';
import { HostedAgentIdTakenError, HostedAgentLimitError } from './hosted-agent-store.js';
import type { AgentArchive, AgentArchives } from './agent-archives.js';
import { serializedWrites, type RepositorySerialize } from './agent-repository-queue.js';

export interface AgentArchiveRoutesDeps {
  archives: AgentArchives;
  caller: (req: Request) => AgentCaller | null;
  serialize: RepositorySerialize;
  restore: (archive: AgentArchive) => Promise<unknown>;
}
const refuse = (res: Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } });

export function agentArchiveRoutes(deps: AgentArchiveRoutesDeps): Router {
  const router = Router();
  const writes = serializedWrites(router, deps.serialize, (req) => deps.archives.get(String(req.params.id), deps.caller(req)?.subject ?? '')?.agent ?? String(req.params.id));
  const owner = (req: Request, res: Response) => {
    res.set({ 'cache-control': 'private, no-store', vary: 'Authorization, Cookie' });
    const who = deps.caller(req);
    if (!who) { refuse(res, 401, 'not_signed_in', 'sign in to read your deleted agents'); return null; }
    return who.subject;
  };
  router.get('/api/agent-archives', (req, res) => {
    const who = owner(req, res); if (!who) return;
    const limit = Number(req.query.limit ?? 10), offset = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0) return refuse(res, 400, 'invalid_request', 'limit is 1–50 and offset is a nonnegative integer');
    const all = deps.archives.list(who);
    res.json({ archives: all.slice(offset, offset + limit).map((record) => ({ id: record.id, agent: record.agent, name: record.spec.name,
      createdAt: record.createdAt, bytes: record.bytes, repositoryFormat: record.repositoryFormat ?? 'bundle', repository: record.repository !== false, exportedAt: record.exportedAt ?? null,
      restoredAt: record.restoredAt ?? null, source: record.runtime?.source ?? null, secretNames: record.spec.secretNames })), total: all.length, limit, offset });
  });
  router.get('/api/agent-archives/:id', (req, res) => {
    const who = owner(req, res); if (!who) return;
    const record = deps.archives.get(String(req.params.id), who);
    if (!record) return refuse(res, 404, 'not_found', 'no archive');
    res.json({ archive: record });
  });
  writes.post('/api/agent-archives/:id/export', async (req, res) => {
    const who = owner(req, res); if (!who) return;
    const id = String(req.params.id), record = deps.archives.get(id, who);
    if (!record) return refuse(res, 404, 'not_found', 'no archive');
    const directory = await mkdtemp(join(tmpdir(), 'ainize-agent-export-'));
    try {
      await writeFile(join(directory, 'metadata.json'), JSON.stringify({ format: 'ainize.agent-archive', version: 1, archive: record }, null, 2), { mode: 0o600 });
      const repository = deps.archives.repositoryFile(id, who);
      const filename = repository?.format === 'bare-tar' ? 'repository.tar.gz' : 'repository.bundle';
      if (repository) await copyFile(repository.path, join(directory, filename));
      const child = spawn('tar', ['-czf', '-', '-C', directory, 'metadata.json', ...(repository ? [filename] : [])]);
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2048); });
      const completed = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `archive export exited ${code}`)));
      });
      res.attachment(`${record.agent}-${record.id}.tar.gz`).type('application/gzip');
      try {
        await Promise.all([pipeline(child.stdout, res), completed]);
        deps.archives.markExported(id, who);
      } catch (error) { child.kill('SIGTERM'); throw error; }
    } catch (error) {
      if (!res.headersSent) refuse(res, 502, 'export_failed', (error as Error).message);
      else res.destroy(error as Error);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  writes.post('/api/agent-archives/:id/restore', async (req, res) => {
    const who = owner(req, res); if (!who) return;
    const id = String(req.params.id), record = deps.archives.get(id, who);
    if (!record) return refuse(res, 404, 'not_found', 'no archive');
    if (req.body && Object.keys(req.body).length) return refuse(res, 400, 'invalid_request', 'restore uses the archived active version and accepts no overrides');
    if (record.spec.visibility === 'org' && !canShareInto(deps.caller(req), record.spec.orgId!)) return refuse(res, 403, 'not_allowed', 'restoring organization sharing requires the current contributor role');
    try { res.status(201).json(await deps.restore(record)); }
    catch (error) {
      if (error instanceof AgentArchiveRestoreError) return refuse(res, error.status, error.code, error.message);
      if (error instanceof HostedAgentIdTakenError) return refuse(res, 409, 'id_taken', error.message);
      if (error instanceof HostedAgentLimitError) return refuse(res, 429, 'limit_reached', error.message);
      return refuse(res, 502, 'restore_failed', (error as Error).message);
    }
  });
  writes.delete('/api/agent-archives/:id', (req, res) => {
    const who = owner(req, res); if (!who) return;
    const result = deps.archives.remove(String(req.params.id), who);
    if (result === 'missing') return refuse(res, 404, 'not_found', 'no archive');
    if (result === 'not_exported') return refuse(res, 409, 'export_required', 'download the complete archive before removing it permanently');
    res.json({ deleted: String(req.params.id) });
  });
  return router;
}
