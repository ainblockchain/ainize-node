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
      const row = this.db.prepare("SELECT * FROM jobs WHERE state='queued' OR (state='running' AND expires<=?) ORDER BY created,id LIMIT 1").get(now);
      if (!row) return null;
      const lease = randomUUID();
      this.db.prepare("UPDATE jobs SET state='running',lease=?,expires=?,updated=? WHERE id=?").run(lease, now + ttl, now, row.id);
      return { job: this.get(row.id), lease };
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
  /** Scheduling only; this does not grant release permission. The executor must recheck approval and SHA. */
  wake(id) {
    return this.db.prepare("UPDATE jobs SET state='queued',updated=? WHERE id=? AND state='waiting'").run(this.now(), id).changes === 1;
  }
}
