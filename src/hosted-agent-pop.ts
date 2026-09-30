/**
 * The node's side of a hosted agent's proof-of-possession key (hosted-agent-runtime/hostedAgentPop.ts explains
 * the key; docs/agent-delegated-reads.md the flow).
 *
 * One ES256 keypair per agent, made when the agent is created (hosted-agent-routes.ts) or, for an agent stored
 * before keys existed, when the node boots (server.ts). The private half is a secret like any other the store
 * holds — encrypted at rest, revealed only to the runtime that needs it — under a name no owner can declare:
 * `secretNames` are UPPER_SNAKE_CASE starting with a letter, so `__POP_KEY__` is never settable, clearable or
 * listed over HTTP. The public half is written into the spec (it is public) so the card and the registry can show
 * it without the secret store.
 */
import { generateHostedAgentPopKey, hostedAgentPopSigner, type HostedAgentPopJwk } from './hosted-agent-runtime/hostedAgentPop.js';
import type { HostedAgentSecretStore } from './hosted-agent-secrets.js';
import type { HostedAgentStore } from './hosted-agent-store.js';
import type { HostedAgentSpec } from './hosted-agent-types.js';
import { audienceOf, type SharedAgentEvents } from './shared-agents.js';

/** Reserved: outside the pattern owners may name, so no route reads, sets or clears it. */
export const HOSTED_AGENT_POP_SECRET_NAME = '__POP_KEY__';

/** A fresh keypair for `spec`: the private half sealed, the public half on the spec. Returns the spec as stored. */
export function issueHostedAgentPopKey(store: HostedAgentStore, secrets: HostedAgentSecretStore, spec: HostedAgentSpec): HostedAgentSpec {
  const { publicJwk, privateJwk } = generateHostedAgentPopKey();
  secrets.set(spec.id, HOSTED_AGENT_POP_SECRET_NAME, JSON.stringify(privateJwk));
  return store.setPopJwk(spec.id, publicJwk) ?? spec;
}

/** Where a boot-time rotation is announced: the registry's event feed, under the address the refs are minted under. */
export interface HostedAgentPopKeyAnnouncer {
  events: Pick<SharedAgentEvents, 'append'>;
  registryIssuer: string;
}

/**
 * Every stored agent holds a usable key after this: one is issued to an agent that has none, to one whose public
 * half is on the spec but whose private half is gone (a secret store restored without its key), and to one whose
 * private half does not match the advertised `kid` (a spec file and a secret store restored from different
 * backups — the card would promise a key the runtime cannot sign with, and every read would fail at the origin as
 * "not valid here"). A rotation is a new release (the store bumps the version), so a product holding the old JWK
 * re-reads the card; with `announce` it is also an `agent.updated` event on the feed, as a rotation over HTTP
 * would be.
 */
export function ensureHostedAgentPopKeys(store: HostedAgentStore, secrets: HostedAgentSecretStore, announce?: HostedAgentPopKeyAnnouncer): HostedAgentSpec[] {
  for (const spec of store.list()) {
    // A secret store that cannot reveal this agent's key (a key file restored from another backup, a corrupt row)
    // must not keep the whole node from starting: the agent gets a fresh key and a new release, announced below.
    let stored: string | undefined;
    try { stored = hostedAgentPopPrivateKeyOf(secrets, spec.id); } catch { stored = undefined; }
    const held = hostedAgentPopSigner(stored);
    if (spec.popJwk && held && held.publicJwk.kid === spec.popJwk.kid) continue;
    const before = spec.version;
    const after = issueHostedAgentPopKey(store, secrets, spec);
    if (after.version !== before) {
      announce?.events.append({ type: 'agent.updated', registryIssuer: announce.registryIssuer, agentId: after.id, version: after.version, releaseId: `v${after.version}`, audience: audienceOf(after) });
    }
  }
  return store.list();
}

/** The private JWK (JSON) for one agent, or undefined when none was issued. Only the host asks. */
export const hostedAgentPopPrivateKeyOf = (secrets: HostedAgentSecretStore, agentId: string): string | undefined =>
  secrets.reveal(agentId, [HOSTED_AGENT_POP_SECRET_NAME])[HOSTED_AGENT_POP_SECRET_NAME];

export type { HostedAgentPopJwk };
