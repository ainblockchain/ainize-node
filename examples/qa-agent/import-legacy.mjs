/** Operator-only offline migration. Imported history is preserved, never interpreted as release authority. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const repo = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);

export function importLegacyJobs({ sourcePath, jobs, checkpoints, config }) {
  if (!id(config?.service) || !id(config?.workspaceId) || !id(config?.channelId) || !repo(config?.repository)) throw new Error('Invalid legacy service binding');
  const targetPath = jobs.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!targetPath || realpathSync(sourcePath) === realpathSync(targetPath)) throw new Error('Legacy source and destination must differ');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let rows, reports;
  try {
    source.exec('BEGIN');
    rows = source.prepare('SELECT * FROM jobs ORDER BY created,id').all();
    reports = source.prepare('SELECT * FROM reports ORDER BY id').all();
    source.exec('COMMIT');
  } finally { source.close(); }
  if (rows.length > jobs.limit) throw new Error('Legacy snapshot exceeds job capacity');
  if (reports.some(report => !rows.some(row => row.id === report.job_id))) throw new Error('Legacy snapshot contains orphan reports');
  const identities = new Set();
  const planned = rows.map(row => {
    const payload = JSON.parse(row.payload), details = JSON.parse(row.details);
    if (!uuid(row.id) || !id(row.message_id) || row.message_id !== payload.message_id || !id(payload.parent_id)
      || !id(payload.sender_id) || typeof payload.text !== 'string' || !payload.text.trim()
      || !Number.isFinite(row.created) || !Number.isFinite(row.updated)) throw new Error('Invalid legacy job');
    if (!['working','queued','completed','failed','blocked','interrupted','awaiting_approval'].includes(row.status)) throw new Error('Unknown legacy job state');
    if (row.status === 'working' || row.status === 'queued') throw new Error('Legacy writer has unfinished work; reconcile before import');
    if (details.repository && details.repository !== config.repository) throw new Error('Legacy repository does not match service binding');
    const base = details.base_sha ?? null;
    if (base !== null && !/^[a-f0-9]{40}$/.test(base)) throw new Error('Invalid legacy base SHA');
    const identity = JSON.stringify([payload.parent_id, row.message_id]);
    if (identities.has(identity)) throw new Error('Duplicate canonical legacy request');
    identities.add(identity);
    const archive = { kind: 'legacy-job-v1', service: config.service, repository: config.repository,
      workspaceId: config.workspaceId, channelId: config.channelId,
      job: { ...row, payload, details }, reports: reports.filter(report => report.job_id === row.id) };
    const fingerprint = createHash('sha256').update(JSON.stringify(archive)).digest('hex');
    const input = { service: config.service, repository: config.repository, base, text: payload.text,
      teams: { workspaceId: config.workspaceId, channelId: config.channelId, messageId: row.message_id, parentId: payload.parent_id },
      legacySenderId: payload.sender_id, legacyCreatedAt: payload.created_at ?? null };
    if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) throw new Error('Legacy input exceeds native job limit');
    return { row, input, archive, fingerprint };
  });
  return jobs.transaction(() => {
    const existing = jobs.db.prepare('SELECT * FROM jobs').all();
    let imported = 0, unchanged = 0;
    for (const item of planned) {
      const prior = existing.find(row => row.id === item.row.id);
      if (prior) {
        const checkpoint = JSON.parse(prior.checkpoint);
        if (checkpoint.legacyFingerprint !== item.fingerprint || prior.input !== JSON.stringify(item.input)) throw new Error('Existing job differs from legacy snapshot');
        // Check referenced immutable history too; a missing/corrupt archive is not a successful migration.
        if (JSON.stringify(checkpoints.load(checkpoint.legacy)) !== JSON.stringify(item.archive)) throw new Error('Legacy archive mismatch');
        unchanged++; continue;
      }
      if (existing.length + imported >= jobs.limit) throw new Error('Native job capacity reached');
      for (const row of existing) {
        const other = JSON.parse(row.input);
        if (other.service === item.input.service && ['workspaceId','channelId','parentId','messageId'].every(key => other.teams?.[key] === item.input.teams[key])) throw new Error('Canonical request already exists under another job ID');
      }
      const legacy = checkpoints.save(item.row.id, item.archive);
      const checkpoint = { stage: 'legacy_reconciliation', holdReason: 'legacy_import', legacyStatus: item.row.status, legacyStage: item.row.stage, legacy, legacyFingerprint: item.fingerprint };
      const state = item.row.status === 'completed' ? 'completed' : item.row.status === 'failed' ? 'failed' : 'waiting';
      jobs.db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,NULL,NULL,?,?)").run(item.row.id,
        `legacy:${config.service}:${item.row.id}`, JSON.stringify(item.input), state, JSON.stringify(checkpoint),
        Math.trunc(item.row.created * 1000), Math.trunc(item.row.updated * 1000));
      imported++;
    }
    return { imported, unchanged, total: planned.length };
  });
}
