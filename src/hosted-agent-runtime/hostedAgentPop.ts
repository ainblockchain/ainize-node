/**
 * A hosted agent's proof-of-possession key (docs/agent-delegated-reads.md, ain-integration docs/08-agent-delegation.md).
 *
 * When a product hands an agent a resource delegation (`ain-rdlg+jwt`), the token is bound to a KEY: its `cnf.jkt`
 * is the RFC 7638 thumbprint of the agent's public JWK, and every request that uses the token carries `X-AIN-PoP`,
 * a JWS over `{htm, htu, iat, jti}` signed with the matching private key. A token stolen from a message is useless
 * without the key; the key never leaves the runtime that holds it.
 *
 *   • the node makes one ES256 (P-256) keypair per hosted agent when the agent is created (hosted-agent-pop.ts)
 *     and keeps the private half in the encrypted secret store under a name no owner can set;
 *   • the public half rides in the agent card as the extension `https://ainetwork.ai/a2a-extension/pop/v1`
 *     (`params.jwk`, `kid` = thumbprint) and in `/api/shared-agents` items as `ref.popJwk`;
 *   • the runtime signs with it (`hostedAgentPopSigner`), a fresh `jti` per request.
 *
 * Self-contained like the rest of this directory: node's own crypto does ES256, and the container image needs no
 * new dependency. The node side imports from here (that direction is allowed); nothing here imports the node.
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign as cryptoSign, type KeyObject } from 'node:crypto';

export const HOSTED_AGENT_POP_EXTENSION_URI = 'https://ainetwork.ai/a2a-extension/pop/v1';
/** `typ` of the `X-AIN-PoP` JWS, as aindrive's verifier requires it. */
export const HOSTED_AGENT_POP_TOKEN_TYPE = 'ain-pop+jwt';
export const HOSTED_AGENT_POP_HEADER = 'X-AIN-PoP';

/** The public half, exactly as the card and the registry carry it. `kid` is the RFC 7638 SHA-256 thumbprint. */
export interface HostedAgentPopJwk { kty: 'EC'; crv: 'P-256'; x: string; y: string; kid: string }
/** The private half: the public members plus `d`. Never in a spec, a card, a log or a model's context. */
export interface HostedAgentPopPrivateJwk extends HostedAgentPopJwk { d: string }

/** RFC 7638: SHA-256 over the required members of an EC key, in lexicographic order, base64url. */
export function hostedAgentPopThumbprint(jwk: { kty: string; crv: string; x: string; y: string }): string {
  return createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
}

export function generateHostedAgentPopKey(): { publicJwk: HostedAgentPopJwk; privateJwk: HostedAgentPopPrivateJwk } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const priv = privateKey.export({ format: 'jwk' }) as { d: string };
  const publicJwk: HostedAgentPopJwk = { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, kid: hostedAgentPopThumbprint({ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y }) };
  return { publicJwk, privateJwk: { ...publicJwk, d: priv.d } };
}

/** The public members of a private JWK — what may be shown. */
export const hostedAgentPopPublicOf = (jwk: HostedAgentPopPrivateJwk): HostedAgentPopJwk => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid: jwk.kid });

/** The agent card extension advertising the key: `required: false` — a caller without a delegation ignores it. */
export const hostedAgentPopExtension = (jwk: HostedAgentPopJwk) => ({ uri: HOSTED_AGENT_POP_EXTENSION_URI, required: false, params: { jwk } });

export interface HostedAgentPopSigner {
  publicJwk: HostedAgentPopJwk;
  /** One `X-AIN-PoP` value for one request: method, the URL without query, now, a fresh jti. */
  sign(htm: string, htu: string): string;
}

const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/**
 * A signer from the private JWK the node handed this runtime (JSON text). Null when there is none or it is not
 * an ES256 key — the tools that need it are then not offered, and the reason is said in words.
 */
export function hostedAgentPopSigner(privateJwkJson: string | undefined): HostedAgentPopSigner | null {
  if (!privateJwkJson) return null;
  let jwk: Partial<HostedAgentPopPrivateJwk>;
  try { jwk = JSON.parse(privateJwkJson) as Partial<HostedAgentPopPrivateJwk>; } catch { return null; }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || typeof jwk.d !== 'string') return null;
  let key: KeyObject;
  try { key = createPrivateKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }, format: 'jwk' }); } catch { return null; }
  const publicJwk: HostedAgentPopJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: hostedAgentPopThumbprint({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }) };
  // The header carries the public key: aindrive checks its thumbprint against the token's `cnf.jkt`.
  const header = b64u(JSON.stringify({ alg: 'ES256', typ: HOSTED_AGENT_POP_TOKEN_TYPE, jwk: publicJwk }));
  return {
    publicJwk,
    sign(htm, htu) {
      const payload = b64u(JSON.stringify({ htm: htm.toUpperCase(), htu, iat: Math.floor(Date.now() / 1000), jti: randomUUID() }));
      // JWS ES256 wants the raw r||s signature, not DER.
      const signature = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
      return `${header}.${payload}.${b64u(signature)}`;
    },
  };
}

/**
 * Does a host match an allowlist of names, `*.suffix` wildcards and `*`? The gateway enforces this on every egress
 * request (hosted-agent-gateway.ts); the runtime reads it too, so it can say "this agent may not reach that host"
 * before offering a tool that would only fail.
 */
export function hostedAgentHostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowed.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) return h.endsWith(pattern.slice(1)) && h.length > pattern.length - 1;
    return h === pattern;
  });
}
