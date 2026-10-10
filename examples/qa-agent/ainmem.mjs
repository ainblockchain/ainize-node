/** Durable Ainmem reporting. Model output and transport errors are never used as authority or logs. */
import { createHash } from 'node:crypto';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const statuses = ['queued', 'coding', 'validating', 'waiting', 'completed', 'failed'];
export function parseAinmemConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Ainmem configuration required');
  const origin = new URL(raw.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Invalid Ainmem origin');
  for (const field of ['databaseId', 'titlePropertyId', 'statusPropertyId']) if (!uuid(raw[field])) throw new Error('Invalid Ainmem board binding');
  const statusOptions = Object.fromEntries(statuses.map(status => {
    const option = raw.statusOptions?.[status];
    if (typeof option !== 'string' || !option || option.length > 100) throw new Error('Missing Ainmem status option');
    return [status, option];
  }));
  return { origin: origin.origin, databaseId: raw.databaseId, titlePropertyId: raw.titlePropertyId, statusPropertyId: raw.statusPropertyId, statusOptions };
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function card(job, config) {
  const stage = job.checkpoint.stage;
  const state = job.state === 'failed' || stage === 'validation_failed' ? 'failed' : job.state === 'completed' ? 'completed'
    : job.checkpoint.holdReason || job.state === 'waiting' ? 'waiting'
    : stage === 'needs_validation' ? 'validating' : stage === 'coding' ? 'coding' : 'queued';
  const repairs=Array.isArray(job.checkpoint.validationAttempts)?job.checkpoint.validationAttempts.length:0;
  const repair=stage==='validation_failed'?'제품 검증에 실패했습니다. 수정 후보와 실패 기록을 보존했습니다. 배포하지 않았습니다.\n'
    :repairs>0&&['coding','needs_validation'].includes(stage)?`검증 실패를 반영해 자동 재수정 중입니다 (${repairs}/2).\n`:'';
  const published=job.checkpoint.published;
  const review=stage==='awaiting_approval' && job.state==='waiting' && !job.checkpoint.holdReason && published?.repository===job.input.repository
    && /^[a-f0-9]{40}$/.test(published.sha??'') && Number.isSafeInteger(published.number) && published.number>0
    && published.url===`https://github.com/${job.input.repository}/pull/${published.number}`
    ? `\n검토 PR: ${published.url}\n검토 커밋: ${published.sha}\n관리자 배포 승인이 필요합니다.\n` : '';
  const deployment=stage==='awaiting_deployment'?'\n코드가 반영되었습니다. 실제 서비스 배포를 확인하고 있습니다.\n'
    :stage==='deployed'&&/^[a-f0-9]{40}$/.test(job.checkpoint.servingCommit??'')?`\n배포 확인 완료\n실행 커밋: ${job.checkpoint.servingCommit}\n`:'';
  return { databaseId: config.databaseId, titlePropertyId: config.titlePropertyId, statusPropertyId: config.statusPropertyId,
    approvalPending: !!review && job.state === 'waiting' && !job.checkpoint.holdReason,
    statusOptionId: config.statusOptions[state], title: job.input.text.trim().slice(0, 200) || 'QA 수정 요청',
    body: `작업 ${job.id}\n서비스: ${job.input.service}\n상태: ${job.state} / ${stage ?? 'queued'}\n${job.checkpoint.holdReason === 'base_changed' ? 'main이 변경되어 최신 코드 기준으로 수정·검증이 필요합니다. 기존 승인은 재사용하지 않습니다.\n' : job.checkpoint.holdReason ? '작업을 보존하고 실행 문제 확인을 기다리고 있습니다.\n' : ''}\n${job.input.text.slice(0, 12000)}\n${repair}${review}${deployment}\n이 상태 표시는 배포 승인이 아닙니다.` };
}
export class AinmemReports {
  constructor(jobs, config) {
    this.jobs = jobs; this.config = parseAinmemConfig(config); this.binding = digest(this.config);
    jobs.db.exec(`CREATE TABLE IF NOT EXISTS ainmem_reports (
      job_id TEXT PRIMARY KEY, binding TEXT NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL,
      revision INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT -1, url TEXT, last_attempt INTEGER NOT NULL DEFAULT 0
    )`);
    jobs.transaction(() => {
      if (!jobs.db.prepare('PRAGMA table_info(ainmem_reports)').all().some(column => column.name === 'last_attempt')) {
        jobs.db.exec('ALTER TABLE ainmem_reports ADD COLUMN last_attempt INTEGER NOT NULL DEFAULT 0');
      }
    });
  }
  refresh(jobId) {
    return this.jobs.transaction(() => {
      // Re-read under the transaction: a late reporter must not publish an older job snapshot.
      const job = this.jobs.get(jobId);
      if (!job) throw new Error('Unknown report job');
      const payload = card(job, this.config), hash = digest(payload);
      const prior = this.jobs.db.prepare('SELECT * FROM ainmem_reports WHERE job_id=?').get(jobId);
      if (prior && prior.binding !== this.binding) throw new Error('Ainmem board binding changed; reconcile existing page first');
      if (!prior) this.jobs.db.prepare('INSERT INTO ainmem_reports(job_id,binding,digest,payload,revision) VALUES(?,?,?,?,0)').run(jobId,this.binding,hash,JSON.stringify(payload));
      else if (prior.digest !== hash) this.jobs.db.prepare('UPDATE ainmem_reports SET digest=?,payload=?,revision=revision+1 WHERE job_id=?').run(hash,JSON.stringify(payload),jobId);
      return this.jobs.db.prepare('SELECT url FROM ainmem_reports WHERE job_id=?').get(jobId)?.url;
    });
  }
  async flush(ctx) {
    const token = ctx.secret('AINMEM_TOKEN');
    if (!token) throw new Error('Ainmem credential unavailable');
    const pending = this.jobs.db.prepare('SELECT * FROM ainmem_reports WHERE delivered<revision ORDER BY last_attempt,job_id LIMIT 5').all();
    let firstError;
    for (const row of pending) {
      this.jobs.db.prepare('UPDATE ainmem_reports SET last_attempt=(SELECT COALESCE(MAX(last_attempt),0)+1 FROM ainmem_reports) WHERE job_id=?').run(row.job_id);
      try {
        if (row.binding !== this.binding) throw new Error('Ainmem board binding changed');
        let response;
        try { response = await ctx.fetch(`${this.config.origin}/api/qa/tasks/${encodeURIComponent(row.job_id)}`, {
          method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(10_000), maxBytes: 4096,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...JSON.parse(row.payload), revision: row.revision }),
        }); } catch { throw new Error('Ainmem connection failed; report retained'); }
        if (!response.ok) throw new Error('Ainmem update refused; report retained');
        let result;
        try { const text = await response.text(); if (Buffer.byteLength(text) > 4096) throw new Error(); result = JSON.parse(text); }
        catch { throw new Error('Invalid Ainmem response'); }
        if (!uuid(result.pageId) || !uuid(result.rowId) || result.path !== `/p/${result.pageId}` || result.revision !== row.revision) throw new Error('Invalid Ainmem receipt');
        const url = `${this.config.origin}${result.path}`;
        this.jobs.db.prepare('UPDATE ainmem_reports SET delivered=?,url=? WHERE job_id=? AND revision=? AND binding=?')
          .run(row.revision,url,row.job_id,row.revision,this.binding);
      } catch (error) { firstError ??= error; }
    }
    if (firstError) throw firstError;
  }
}
