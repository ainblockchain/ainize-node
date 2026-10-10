/** Durable work owned by a hosted agent in its existing /state mount.
 * Lease recovery permits another attempt, not an exactly-once external side effect.
 * GitHub/Ainmem writes must also use the stable job id and reconcile before retry.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, openSync } from 'node:fs';

const states = new Set(['queued', 'waiting', 'completed', 'failed']);
const json = (value) => {
  const text = JSON.stringify(value);
  if (!text || Buffer.byteLength(text) > 64 * 1024) throw new Error('job data must be JSON under 64 KiB');
  return text;
};
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};

export class Jobs {
  constructor(file, { now = Date.now, limit = 2000 } = {}) {
    this.now = now;
    this.limit = limit;
    closeSync(openSync(file, 'a', 0o600));
    chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS review_polls(job_id TEXT PRIMARY KEY,last_attempt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_polls(job_id TEXT PRIMARY KEY,last_attempt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS revalidation_history(job_id TEXT NOT NULL,sequence INTEGER NOT NULL,source_digest TEXT NOT NULL,input TEXT NOT NULL,checkpoint TEXT NOT NULL,observed_base TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(job_id,sequence),UNIQUE(job_id,source_digest));
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, input TEXT NOT NULL,
        state TEXT NOT NULL, checkpoint TEXT NOT NULL, lease TEXT, expires INTEGER,
        created INTEGER NOT NULL, updated INTEGER NOT NULL
      );`);
  }
  close() { this.db.close(); }
  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  enqueue(key, input) {
    return this.transaction(() => this.insert(key, input));
  }
  /** Match canonical Teams identity across historical base-dependent keys without rewriting jobs.
   * Re-delivery never rebases a candidate or carries an approval to a newly generated commit.
   */
  enqueueTeamsRequest(input) {
    const identity = value => [value.service, value.teams?.workspaceId, value.teams?.channelId,
      value.teams?.parentId, value.teams?.messageId];
    const parts = identity(input);
    if (!parts.every(v => typeof v === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(v))) {
      throw new Error('invalid Teams request identity');
    }
    const key = JSON.stringify(parts);
    return this.transaction(() => {
      const matches = this.db.prepare('SELECT * FROM jobs').all().filter(row =>
        JSON.stringify(identity(JSON.parse(row.input))) === key);
      // Do not choose arbitrarily between historical duplicates with different candidates/approvals.
      if (matches.length > 1) throw new Error('multiple historical jobs for Teams request; reconciliation required');
      if (matches.length) {
        const prior = this.decode(matches[0]);
        if (prior.input.text !== input.text || prior.input.repository !== input.repository) {
          throw new Error('canonical Teams request changed; reconciliation required');
        }
        return prior;
      }
      return this.insert('teams:' + createHash('sha256').update(key).digest('hex'), input);
    });
  }
  insert(key, input) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9._:-]{1,200}$/.test(key)) throw new Error('invalid request key');
    const body = json(canonical(JSON.parse(json(input))));
    const prior = this.db.prepare('SELECT * FROM jobs WHERE request_key=?').get(key);
    if (prior) {
      if (prior.input !== body) throw new Error('request key reused with different input');
      return this.decode(prior);
    }
    if (this.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n >= this.limit) throw new Error('job capacity reached');
    const id = randomUUID(), now = this.now();
    this.db.prepare("INSERT INTO jobs VALUES(?,?,?,'queued','{}',NULL,NULL,?,?)").run(id, key, body, now, now);
    return this.get(id);
  }
  get(id) { return this.decode(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id)); }
  decode(row) {
    if (!row) return null;
    return { id: row.id, requestKey: row.request_key, input: JSON.parse(row.input), state: row.state,
      checkpoint: JSON.parse(row.checkpoint), created: row.created, updated: row.updated };
  }
  claim(ttl = 60_000) {
    if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 300_000) throw new Error('invalid lease duration');
    return this.transaction(() => {
      const now = this.now();
      // A host operation can return running for many ticks. Give each other eligible job
      // a turn before polling it again, including across process restarts.
      const row = this.db.prepare("SELECT j.* FROM jobs j LEFT JOIN work_polls p ON p.job_id=j.id WHERE (j.state='queued' OR (j.state='running' AND j.expires<=?)) AND coalesce(json_extract(j.checkpoint,'$.stage'),'') NOT IN ('awaiting_approval','awaiting_deployment','needs_revalidation') ORDER BY coalesce(p.last_attempt,0),j.created,j.id LIMIT 1").get(now);
      if (!row) return null;
      const lease = randomUUID();
      this.db.prepare("UPDATE jobs SET state='running',lease=?,expires=?,updated=? WHERE id=?").run(lease, now + ttl, now, row.id);
      const sequence = Number(this.db.prepare('SELECT coalesce(max(last_attempt),0)+1 AS n FROM work_polls').get().n);
      this.db.prepare('INSERT INTO work_polls VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET last_attempt=excluded.last_attempt').run(row.id, sequence);
      return { job: this.get(row.id), lease };
    });
  }
  claimReview(ttl=60000) {
    if(!Number.isSafeInteger(ttl)||ttl<1000||ttl>300000)throw new Error('invalid lease duration');
    return this.transaction(()=>{
      const now=this.now();
      const row=this.db.prepare("SELECT j.* FROM jobs j LEFT JOIN review_polls p ON p.job_id=j.id WHERE (j.state IN ('waiting','queued') OR (j.state='running' AND j.expires<=?)) AND json_extract(j.checkpoint,'$.stage') IN ('awaiting_approval','awaiting_deployment') AND json_extract(j.checkpoint,'$.holdReason') IS NULL ORDER BY coalesce(p.last_attempt,0),j.created,j.id LIMIT 1").get(now);
      if(!row)return null;
      const lease=randomUUID();
      this.db.prepare("UPDATE jobs SET state='running',lease=?,expires=?,updated=? WHERE id=?").run(lease,now+ttl,now,row.id);
      const sequence=Number(this.db.prepare('SELECT coalesce(max(last_attempt),0)+1 AS n FROM review_polls').get().n);
      this.db.prepare('INSERT INTO review_polls VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET last_attempt=excluded.last_attempt').run(row.id,sequence);
      return {job:this.get(row.id),lease};
    });
  }
  renew(id, lease, ttl = 60_000) {
    if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 300_000) throw new Error('invalid lease duration');
    const now = this.now();
    if (this.db.prepare("UPDATE jobs SET expires=?,updated=? WHERE id=? AND state='running' AND lease=? AND expires>?")
      .run(now + ttl, now, id, lease, now).changes !== 1) throw new Error('job lease lost');
  }
  finish(id, lease, state, checkpoint) {
    if (!states.has(state)) throw new Error('invalid job transition');
    const body = json(checkpoint), now = this.now();
    if (this.db.prepare('UPDATE jobs SET state=?,checkpoint=?,lease=NULL,expires=NULL,updated=? WHERE id=? AND state=\'running\' AND lease=? AND expires>?')
      .run(state, body, now, id, lease, now).changes !== 1) throw new Error('job lease lost');
    return this.get(id);
  }
  /** Preserve the exact prior attempt before changing its visible state. No new base or approval is bound here. */
  parkForRevalidation(id, lease, observedBase, evidence, candidateDigest) {
    if (typeof observedBase !== 'string' || !/^[a-f0-9]{40}$/.test(observedBase)) throw new Error('Invalid changed base');
    if(candidateDigest!==undefined&&(typeof candidateDigest!=='string'||!/^[a-f0-9]{64}$/.test(candidateDigest)))throw new Error('Invalid revalidation candidate');
    return this.transaction(() => {
      const job = this.get(id), published = job?.checkpoint.published;
      const reviewing=job?.checkpoint.stage==='awaiting_approval'&&published?.repository===job.input.repository&&published.base===job.input.base&&/^[a-f0-9]{40}$/.test(published.sha??'');
      const publishing=job?.checkpoint.stage==='needs_publication'&&job.checkpoint.coding?.jobId===id&&job.checkpoint.validation?.jobId===id&&evidence?.jobId===id&&/^[a-f0-9]{64}$/.test(evidence.checksum??'');
      if (!job || (!reviewing&&!publishing) || observedBase === job.input.base) throw new Error('Revalidation candidate binding changed');
      const priorCheckpoint={...job.checkpoint,...(publishing?{revalidationEvidence:evidence,...(candidateDigest?{revalidationCandidateDigest:candidateDigest}:{})}:{})};
      const input = json(job.input), checkpoint = json(priorCheckpoint);
      const sourceDigest = createHash('sha256').update(JSON.stringify([input, checkpoint])).digest('hex');
      const prior = this.db.prepare('SELECT sequence,observed_base FROM revalidation_history WHERE job_id=? AND source_digest=?').get(id, sourceDigest);
      const sequence = prior?.sequence ?? Number(this.db.prepare('SELECT coalesce(max(sequence),0)+1 AS n FROM revalidation_history WHERE job_id=?').get(id).n);
      if (sequence > 20) throw new Error('Revalidation attempt limit reached');
      if (prior && prior.observed_base !== observedBase) throw new Error('Archived base observation changed');
      // Lease validation and archival share a transaction: an expired writer leaves neither behind.
      const { approval: _approval, release: _release, deployment: _deployment, servingCommit: _servingCommit, ...preserved } = priorCheckpoint;
      const result = this.finish(id, lease, 'waiting', { ...preserved, stage: 'needs_revalidation',
        holdReason: 'base_changed', observedBase, priorAttempt: { sequence, sourceDigest } });
      if (!prior) this.db.prepare('INSERT INTO revalidation_history VALUES(?,?,?,?,?,?,?)')
        .run(id, sequence, sourceDigest, input, checkpoint, observedBase, this.now());
      return result;
    });
  }
  revalidationHistory(id) {
    return this.db.prepare('SELECT * FROM revalidation_history WHERE job_id=? ORDER BY sequence').all(id).map(row => ({
      sequence: Number(row.sequence), sourceDigest: row.source_digest, input: JSON.parse(row.input),
      checkpoint: JSON.parse(row.checkpoint), observedBase: row.observed_base, created: Number(row.created),
    }));
  }
  /** Separate, opt-in claim: ordinary scheduling must not wake a base-invalidated candidate. */
  claimRevalidation(ttl = 60000) {
    if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 300000) throw new Error('invalid lease duration');
    return this.transaction(() => {
      const now = this.now();
      const row = this.db.prepare("SELECT * FROM jobs WHERE (state='waiting' OR (state='running' AND expires<=?)) AND json_extract(checkpoint,'$.stage')='needs_revalidation' AND json_extract(checkpoint,'$.holdReason')='base_changed' AND json_extract(checkpoint,'$.hostIntake')=1 AND json_extract(checkpoint,'$.hostBase')=1 ORDER BY updated,id LIMIT 1").get(now);
      if (!row) return null;
      const lease = randomUUID();
      this.db.prepare("UPDATE jobs SET state='running',lease=?,expires=?,updated=? WHERE id=?").run(lease, now + ttl, now, row.id);
      return { job: this.get(row.id), lease };
    });
  }
  /** Apply a host-prepared new attempt, never an observed SHA alone. The caller must obtain this
   * receipt from the host's revalidation capability, after invalidating the prior review there.
   * The entire old candidate remains in history; coding starts afresh from the original request.
   */
  bindRevalidation(id, lease, receipt) {
    return this.transaction(() => {
      const job = this.get(id), prior = job?.checkpoint.priorAttempt;
      const archived = prior && this.revalidationHistory(id).find(row => row.sequence === prior.sequence);
      if (!job || job.state !== 'running' || job.checkpoint.stage !== 'needs_revalidation'
        || job.checkpoint.holdReason !== 'base_changed' || job.checkpoint.hostIntake !== true
        || job.checkpoint.hostBase !== true || !archived || archived.sourceDigest !== prior.sourceDigest
        || archived.input.base !== job.input.base || archived.observedBase !== job.checkpoint.observedBase
        || json(archived.input) !== json(job.input)) throw new Error('Revalidation archive binding changed');
      if (!receipt || receipt.jobId !== id || receipt.repository !== job.input.repository
        || receipt.previousBase !== job.input.base || receipt.candidateDigest !== job.checkpoint.revalidationCandidateDigest || receipt.sequence !== prior.sequence
        || receipt.sourceDigest !== prior.sourceDigest || typeof receipt.base !== 'string' || !/^[a-f0-9]{40}$/.test(receipt.base)
        || receipt.base === job.input.base) throw new Error('Revalidation preparation binding changed');
      const now = this.now();
      // No coding, validation, publication or release field survives into the new active attempt.
      const checkpoint = { hostIntake: true, hostBase: true,
        revalidationAttempt: { sequence: prior.sequence, sourceDigest: prior.sourceDigest, previousBase: job.input.base } };
      if (this.db.prepare("UPDATE jobs SET input=?,checkpoint=?,state='queued',lease=NULL,expires=NULL,updated=? WHERE id=? AND state='running' AND lease=? AND expires>?")
        .run(json({ ...job.input, base: receipt.base }), json(checkpoint), now, id, lease, now).changes !== 1) throw new Error('job lease lost');
      return this.get(id);
    });
  }
  /** Only first-time base preparation may update input. Candidates and approvals are never rebased here. */
  bindBase(id,lease,base) {
    if(typeof base!=='string'||!/^[a-f0-9]{40}$/.test(base))throw new Error('Invalid prepared base');
    return this.transaction(()=>{
      const job=this.get(id);
      if(!job||job.checkpoint.hostIntake!==true||Object.keys(job.checkpoint).some(k=>!['hostIntake','stepFailures'].includes(k)))throw new Error('Existing candidate requires explicit reconciliation');
      const now=this.now();
      if(this.db.prepare("UPDATE jobs SET input=?,checkpoint=?,state='queued',lease=NULL,expires=NULL,updated=? WHERE id=? AND state='running' AND lease=? AND expires>?")
        .run(json({...job.input,base}),json({...job.checkpoint,hostBase:true}),now,id,lease,now).changes!==1)throw new Error('job lease lost');
      return this.get(id);
    });
  }
  /** Scheduling only; this does not grant release permission. The executor must recheck approval and SHA. */
  wake(id) {
    return this.db.prepare("UPDATE jobs SET state='queued',updated=? WHERE id=? AND state='waiting' AND coalesce(json_extract(checkpoint,'$.holdReason'),'')<>'base_changed'").run(this.now(), id).changes === 1;
  }
}
