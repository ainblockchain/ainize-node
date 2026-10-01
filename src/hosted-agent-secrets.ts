/**
 * Secret values for hosted agents — API keys an agent's code uses for the writes it performs.
 *
 * Encrypted at rest (AES-256-GCM) with a key in its own 0600 file beside the data. That protects a copied data
 * file or a backup that left the machine without the key; it does not protect against someone who can read both
 * files, and nothing on one machine could. Values are write-only over HTTP: an owner may set or clear one, never
 * read it back, so a stolen session cannot exfiltrate them.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type SealedSecret = { iv: string; tag: string; data: string };

export const HOSTED_AGENT_SECRET_MAX_BYTES = 8192;

/**
 * Stored values this node could not read at start: the key file was missing (a restore that brought the data
 * back without `hosted-agent-secrets.key`) or is not the one they were sealed with (key and data from different
 * backups). The node still starts — each agent's PoP key is re-issued (hosted-agent-pop.ts) and owners set their
 * secrets again — but nothing is lost silently: the sealed file is copied aside (`keptAt`) before the store drops
 * the values it cannot open, so restoring the right key together with that copy brings them back, and server.ts
 * logs this as an error.
 */
export interface HostedAgentSecretsUnreadable {
  reason: 'key-missing' | 'key-mismatch';
  agents: number;
  values: number;
  keptAt: string;
}

export class HostedAgentSecretStore {
  private readonly key: Buffer;
  private readonly sealed = new Map<string, Record<string, SealedSecret>>();
  /** Set when the stored values could not be read with this key (see above); null otherwise. */
  readonly unreadable: HostedAgentSecretsUnreadable | null = null;

  constructor(private readonly file: string, keyFile: string) {
    mkdirSync(dirname(keyFile), { recursive: true });
    const hadKey = existsSync(keyFile);
    if (!hadKey) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    this.key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
    if (this.key.length !== 32) throw new Error(`${keyFile} does not hold a 32-byte key`);
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, SealedSecret>>;
      for (const [agent, values] of Object.entries(parsed)) this.sealed.set(agent, values);
    }
    const values = [...this.sealed.entries()].flatMap(([agent, v]) => Object.entries(v).map(([name, s]) => ({ agent, name, s })));
    // One value that opens is enough: every value was sealed with the same key.
    if (values.length && !values.some(({ agent, name, s }) => this.opens(agent, name, s))) {
      const keptAt = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '')}`;
      copyFileSync(file, keptAt);
      try { chmodSync(keptAt, 0o600); } catch { /* best effort */ }
      this.unreadable = { reason: hadKey ? 'key-mismatch' : 'key-missing', agents: new Set(values.map((v) => v.agent)).size, values: values.length, keptAt };
      this.sealed.clear();
      this.save();
    }
  }

  private opens(agentId: string, name: string, s: SealedSecret): boolean {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(s.iv, 'base64'));
      decipher.setAAD(Buffer.from(`${agentId}/${name}`));
      decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
      Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()]);
      return true;
    } catch {
      return false;
    }
  }

  set(agentId: string, name: string, value: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${agentId}/${name}`));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const values = { ...(this.sealed.get(agentId) ?? {}), [name]: { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') } };
    this.sealed.set(agentId, values);
    this.save();
  }

  clear(agentId: string, name: string): void {
    const values = { ...(this.sealed.get(agentId) ?? {}) };
    delete values[name];
    this.sealed.set(agentId, values);
    this.save();
  }

  dropAgent(agentId: string): void {
    if (this.sealed.delete(agentId)) this.save();
  }

  names(agentId: string): string[] {
    return Object.keys(this.sealed.get(agentId) ?? {});
  }

  /** Every value for one agent, restricted to the names its spec declares — a removed name stops being delivered. */
  reveal(agentId: string, declared: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    const values = this.sealed.get(agentId) ?? {};
    for (const name of declared) {
      const s = values[name];
      if (!s) continue;
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(s.iv, 'base64'));
      decipher.setAAD(Buffer.from(`${agentId}/${name}`));
      decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
      out[name] = Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()]).toString('utf8');
    }
    return out;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.sealed)), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
