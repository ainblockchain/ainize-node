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
  /**
   * The AIN SSO organization this key was made for, or absent/null for a personal key (docs/ain-sso.md).
   *
   * Only a session made through AIN SSO can make an organization key, and only for an organization its ID token
   * named. Suspension in that organization disables the key, offboarding deletes it; personal keys are never
   * touched by either. Absent on every key written before this field existed — they are personal, as they were.
   */
  orgId?: string | null;
  /**
   * Set while the key is switched off (organization suspension); `reason` says who and why. Such a record is also
   * stored under `disabled:<hash>` rather than `<hash>`, so a build from before this field — which would ignore
   * it — cannot find the key at all: rolling the node back never switches a suspended key back on.
   */
  disabled?: { at: number; reason: string } | null;
  /**
   * The AIN SSO account whose session made this key (docs/ain-sso.md), absent for a key made any other way. It is
   * what tells, when a legacy mapping is rolled back at AIN SSO, the keys a person made on the legacy principal
   * THROUGH the link (revoked with it) from the ones the legacy principal made itself (kept).
   */
  via?: { iss: string; sub: string } | null;
}

/** The map key a switched-off record is stored under (see `disabled`). */
const DISABLED = 'disabled:';
const realHash = (mapKey: string) => (mapKey.startsWith(DISABLED) ? mapKey.slice(DISABLED.length) : mapKey);

/** What `listFor` shows: enough to tell two keys apart and revoke one, never enough to use it. */
export interface OpenaiApiKeySummary {
  /** First bytes of the key's HASH — not of the key. Naming a key must not leak part of it. */
  prefix: string;
  issuedAt: number;
  label: string | null;
  /** the organization the key belongs to; null = personal */
  org_id: string | null;
  /** switched off by an organization suspension */
  disabled: boolean;
}

const OPENAI_API_KEY_PREFIX = 'ainize-sk-';

export function hashOpenaiApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export class OpenaiApiKeyStore {
  private records = new Map<string, OpenaiApiKeyRecord>();
  /**
   * Asked at USE time for an organization key: may `owner` still act for `orgId`? Set by the node when AIN SSO
   * state exists (sso.ts), so a key whose organization access ended stops working even if disabling it failed.
   */
  orgGate: ((owner: string, orgId: string) => boolean) | null = null;

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

  issue(address: string, label: string | null = null, orgId: string | null = null, via: { iss: string; sub: string } | null = null): string {
    const key = `${OPENAI_API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
    // `orgId` and `via` are written only when there is one, so a key made outside AIN SSO stays byte-for-byte what
    // it always was.
    this.records.set(hashOpenaiApiKey(key), {
      address: address.toLowerCase(), issuedAt: Date.now(), label, ...(orgId ? { orgId } : {}), ...(via ? { via: { iss: via.iss, sub: via.sub } } : {}),
    });
    this.persist();
    return key;
  }

  /** The address this key speaks for, or null. Checked shape-first so a foreign key costs no hash. */
  addressForKey(key: string): string | null {
    if (!key.startsWith(OPENAI_API_KEY_PREFIX)) return null;
    // A switched-off key lives under `disabled:<hash>`, so this lookup never finds it.
    const record = this.records.get(hashOpenaiApiKey(key));
    if (!record || record.disabled) return null;
    if (record.orgId && this.orgGate && !this.orgGate(record.address, record.orgId)) return null;
    return record.address;
  }

  /**
   * Switch off, switch back on, or delete every key `owner` holds for one organization — what AIN SSO suspension,
   * reactivation and offboarding do (sso.ts). Personal keys (no `orgId`) are never matched. `enable` only clears a
   * `disabled` this same mechanism set; a deleted key stays deleted. Written once, and before the caller answers.
   */
  setOrgKeys(owner: string, orgId: string, action: 'disable' | 'enable' | 'revoke', reason: string): number {
    const wanted = owner.toLowerCase();
    const next = new Map(this.records);
    let changed = 0;
    for (const [mapKey, record] of this.records) {
      if (record.address !== wanted || !record.orgId || record.orgId !== orgId) continue;
      const hash = realHash(mapKey);
      if (action === 'revoke') { next.delete(mapKey); changed++; continue; }
      if (action === 'disable' && !mapKey.startsWith(DISABLED)) {
        next.delete(mapKey);
        next.set(`${DISABLED}${hash}`, { ...record, disabled: { at: Date.now(), reason } });
        changed++;
      }
      if (action === 'enable' && mapKey.startsWith(DISABLED)) {
        const { disabled: _off, ...rest } = record;
        next.delete(mapKey);
        next.set(hash, rest);
        changed++;
      }
    }
    // Written first and swapped in after: if the disk refuses, nothing changed — not "disabled until restart".
    if (changed) this.commit(next);
    return changed;
  }

  /** Delete every organization key `owner` holds, whichever organization — for a principal that stops being this person's. */
  revokeAllOrgKeys(owner: string): number {
    return this.revokeWhere(owner, (record) => !!record.orgId);
  }

  /**
   * Delete what an AIN account obtained on `owner` while it was linked to it — for a legacy principal that stops
   * being this person's (a mapping rolled back at AIN SSO): every organization key (only an SSO session makes one),
   * and every key an SSO session of THAT account made (`via`). Keys the principal made itself stay.
   */
  revokeObtainedThrough(owner: string, via: { iss: string; sub: string }): number {
    return this.revokeWhere(owner, (record) => !!record.orgId || (record.via?.iss === via.iss && record.via?.sub === via.sub));
  }

  private revokeWhere(owner: string, match: (record: OpenaiApiKeyRecord) => boolean): number {
    const wanted = owner.toLowerCase();
    const next = new Map(this.records);
    let changed = 0;
    for (const [mapKey, record] of this.records) if (record.address === wanted && match(record)) { next.delete(mapKey); changed++; }
    if (changed) this.commit(next);
    return changed;
  }

  /** How many keys an owner holds at all (usable or not). */
  countFor(owner: string): number {
    const wanted = owner.toLowerCase();
    let n = 0;
    for (const record of this.records.values()) if (record.address === wanted) n++;
    return n;
  }

  revoke(key: string): boolean {
    const removed = this.records.delete(hashOpenaiApiKey(key));
    if (removed) this.persist();
    return removed;
  }

  /**
   * Revoke one of THIS address's keys, by the prefix its listing shows.
   *
   * Scoped to the owner on purpose. A prefix appears in a list and is therefore not a secret, so treating it as
   * a capability would let anybody who had seen one revoke somebody else's key. Returns false when this address
   * has no such key, which is the same answer as "no such key" — and deliberately so: telling the two apart
   * would confirm that somebody else's key exists.
   */
  revokeByPrefixFor(address: string, prefix: string): boolean {
    const wanted = address.toLowerCase();
    for (const [mapKey, record] of this.records) {
      if (record.address !== wanted) continue;
      if (realHash(mapKey).slice(0, 8) !== prefix) continue;
      this.records.delete(mapKey);
      this.persist();
      return true;
    }
    return false;
  }

  listFor(address: string): OpenaiApiKeySummary[] {
    const wanted = address.toLowerCase();
    return [...this.records.entries()]
      .filter(([, record]) => record.address === wanted)
      .map(([mapKey, record]) => ({
        prefix: realHash(mapKey).slice(0, 8), issuedAt: record.issuedAt, label: record.label, org_id: record.orgId ?? null, disabled: mapKey.startsWith(DISABLED),
      }));
  }

  /** Persist `next`, then make it the live set. */
  private commit(next: Map<string, OpenaiApiKeyRecord>): void {
    this.persist(next);
    this.records = next;
  }

  /** Written to a temp file and renamed, so a crash mid-write cannot leave a half-parsed store behind. */
  private persist(records: Map<string, OpenaiApiKeyRecord> = this.records): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(records)), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* the temp file may never have been created */ }
      throw error;
    }
  }
}
