import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from '@ainize/core';

interface Batch {
  version: 1;
  model_id: string;
  request_count: number;
  started_at: number;
  finished_at: number;
  receipt_root: string;
}

interface Receipt { id: string; model_id: string; completed_at: number }
interface Entry {
  id: string;
  batch: Batch;
  state: 'pending' | 'submitting' | 'submitted' | 'unconfirmed';
  path?: string;
  tx_hash?: string;
}
interface Journal { started_at: number; receipts: Receipt[]; entries: Entry[] }
interface Storage { get(key: string): string | null; set(key: string, value: string): void }
export interface InferenceLedger {
  noteInferenceBatch?(batch: Batch): Promise<{ path: string; tx_hash: string } | null>;
}

export class InferenceRecords {
  private journal: Journal;
  private running: Promise<void> | null = null;
  constructor(private store: Storage, private ledger: InferenceLedger, private report: (message: string) => void,
    private now: () => number = Date.now) {
    if (!ledger.noteInferenceBatch) throw new Error('Inference recording requires a core build with noteInferenceBatch');
    const saved = store.get('inference.journal.v1');
    this.journal = saved ? JSON.parse(saved) : { started_at: now(), receipts: [], entries: [] };
    if (!Array.isArray(this.journal.receipts) || !Array.isArray(this.journal.entries)
      || this.journal.receipts.length > 5000 || this.journal.entries.length > 1000
      || !Number.isSafeInteger(this.journal.started_at) || this.journal.started_at <= 0) {
      throw new Error('Invalid inference journal; preserve it for operator reconciliation');
    }
    if (this.journal.entries.some(entry => entry.state !== 'submitted')) {
      report('Inference journal contains unresolved submissions; inspect before any manual retry');
    }
  }

  private save() { this.store.set('inference.journal.v1', JSON.stringify(this.journal)); }

  completed(model: string) {
    const completedAt = this.now();
    if (!model.trim() || model.length > 512 || completedAt < this.journal.started_at
      || this.journal.receipts.length >= 5000 || this.journal.entries.length >= 1000) {
      this.report('Inference receipt not recorded: invalid model/clock or journal capacity reached; coverage is incomplete');
      return;
    }
    this.journal.receipts.push({ id: randomUUID(), model_id: model, completed_at: completedAt });
    this.save();
  }

  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.submit().finally(() => { this.running = null; });
    return this.running;
  }

  private async submit() {
    const finishedAt = this.now();
    if (!this.journal.receipts.length || finishedAt <= this.journal.started_at
      || this.journal.receipts.some(receipt => receipt.completed_at > finishedAt)) return;
    const groups = new Map<string, Receipt[]>();
    for (const receipt of this.journal.receipts) {
      const group = groups.get(receipt.model_id) ?? [];
      group.push(receipt);
      groups.set(receipt.model_id, group);
    }
    if (this.journal.entries.length + groups.size > 1000) {
      this.report('Inference journal capacity reached; export and reconcile records before continuing');
      return;
    }
    const entries: Entry[] = [];
    for (const [model, receipts] of groups) {
      const entry: Entry = { id: randomUUID(), state: 'pending', batch: {
        version: 1, model_id: model, request_count: receipts.length,
        started_at: this.journal.started_at, finished_at: finishedAt,
        receipt_root: sha256Hex(canonicalJson(receipts)),
      } };
      this.store.set(`inference.receipts.${entry.id}`, canonicalJson(receipts));
      entries.push(entry);
    }
    this.journal.entries.push(...entries);
    this.journal.receipts = [];
    this.journal.started_at = finishedAt;
    this.save();
    for (const entry of entries) {
      entry.state = 'submitting';
      this.save();
      let result: { path: string; tx_hash: string } | null = null;
      try { result = await this.ledger.noteInferenceBatch!(entry.batch); } catch {}
      entry.state = result ? 'submitted' : 'unconfirmed';
      if (result) { entry.path = result.path; entry.tx_hash = result.tx_hash; }
      this.save();
      this.report(result ? `Inference batch submitted: ${result.path} transaction ${result.tx_hash}; inclusion not yet verified`
        : `Inference batch ${entry.id} submission unconfirmed; no automatic retry`);
    }
  }
}
