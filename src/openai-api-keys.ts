/**
 * Bearer keys for the `/v1` surface, each standing for one EVM address.
 *
 * The surface exists so that a client which already knows OpenAI needs to learn nothing, and OpenAI's clients put
 * a bearer string in a header. That settles the mechanism: a per-request signature would break every stock client
 * and would put an ecrecover and a nonce store on the inference path. Proving the address happens once, at
 * sign-in; after that a call costs one hash and one map lookup.
 *
 * Only the hash of a key is kept. The key is returned once, at issue, and cannot be recovered — losing it means
 * issuing another, which is the bargain every API key makes. An operator reading this file learns which addresses
 * hold keys and when they were issued, never what to send.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface OpenaiApiKeyRecord {
  address: string;
  issuedAt: number;
  label: string | null;
}

/** What `listFor` shows: enough to tell two keys apart and revoke one, never enough to use it. */
export interface OpenaiApiKeySummary {
  /** First bytes of the key's HASH — not of the key. Naming a key must not leak part of it. */
  prefix: string;
  issuedAt: number;
  label: string | null;
}

const OPENAI_API_KEY_PREFIX = 'ainize-sk-';

export function hashOpenaiApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export class OpenaiApiKeyStore {
  private records = new Map<string, OpenaiApiKeyRecord>();

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, OpenaiApiKeyRecord>;
      this.records = new Map(Object.entries(parsed));
    } catch {
      // A store we cannot read is an empty store. Refusing to boot would lock an operator out of the node over a
      // file whose only content is revocable; the keys in it stop working, which is the safe direction to fail.
      console.error(`[openai-keys] ${file} is unreadable — starting with no issued keys`);
      this.records = new Map();
    }
  }

  issue(address: string, label: string | null = null): string {
    const key = `${OPENAI_API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
    this.records.set(hashOpenaiApiKey(key), { address: address.toLowerCase(), issuedAt: Date.now(), label });
    this.persist();
    return key;
  }

  /** The address this key speaks for, or null. Checked shape-first so a foreign key costs no hash. */
  addressForKey(key: string): string | null {
    if (!key.startsWith(OPENAI_API_KEY_PREFIX)) return null;
    return this.records.get(hashOpenaiApiKey(key))?.address ?? null;
  }

  revoke(key: string): boolean {
    const removed = this.records.delete(hashOpenaiApiKey(key));
    if (removed) this.persist();
    return removed;
  }

  listFor(address: string): OpenaiApiKeySummary[] {
    const wanted = address.toLowerCase();
    return [...this.records.entries()]
      .filter(([, record]) => record.address === wanted)
      .map(([hash, record]) => ({ prefix: hash.slice(0, 8), issuedAt: record.issuedAt, label: record.label }));
  }

  /** Written to a temp file and renamed, so a crash mid-write cannot leave a half-parsed store behind. */
  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.records)), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* the temp file may never have been created */ }
      throw error;
    }
  }
}
