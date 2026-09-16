/**
 * Which node endpoints may be published to a visitor.
 *
 * A peer table is a list of addresses this node dials, and on most deployments some of them are on the
 * operator's own network — `http://192.168.1.41:3402`, `http://localhost:3514`. Publishing those on a public
 * page does two bad things at once: it describes the shape of somebody's LAN to anyone who asks, and it hands
 * the reader a link that resolves to THEIR OWN machine, which is worse than no link at all.
 *
 * The operator still sees everything. They are the one debugging why a peer is unreachable, and every address
 * in that table is one they configured or one their node learned on their behalf.
 *
 * This is about what is PUBLISHED on the web surface, not about what nodes tell each other: peer exchange
 * (`/p2p/peers`) must keep carrying private addresses, because two nodes on one LAN reach each other by
 * exactly those and a mesh that hid them from its own members would not form.
 */

/** Hosts that mean "somewhere on the reader's own network, not mine". */
const PRIVATE_HOST = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,       // link-local
  /^\[?f[cd][0-9a-f]{2}:/i, // unique-local IPv6
  /\.local$/i,
];

/** True when an endpoint is one a stranger could actually reach. */
export function isPublicEndpoint(endpoint: string | null | undefined): boolean {
  if (!endpoint) return false;
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    // not a URL at all: it cannot be offered as a link, whatever it is
    return false;
  }
  return !PRIVATE_HOST.some((re) => re.test(host));
}

/**
 * The endpoint as it may be published, or null when it may not be.
 *
 * Null rather than a redacted string: a caller that renders whatever it is given would print "(private)" as if
 * it were an address, and a caller that checks for null has to decide what to show. The second is the one that
 * produces a correct page.
 */
export const publicEndpoint = (endpoint: string | null | undefined): string | null =>
  (isPublicEndpoint(endpoint) ? (endpoint as string) : null);

/**
 * A gossiped `PeerInfo` as it may be published: its own endpoint and its agents' URLs masked by the same rule.
 *
 * The nested copies are the ones that get missed. A peer row carries the whole info object it last gossiped,
 * so masking the row's `endpoint` and leaving `info.endpoint` beside it publishes the address anyway — which
 * is exactly what happened the first time this was fixed.
 */
export function publicPeerInfo<T extends { endpoint?: string | null; agents?: { url?: string }[] }>(info: T | null | undefined): T | null {
  if (!info) return null ;
  const out = { ...info } as T & { endpoint?: string | null; agents?: { url?: string }[] };
  out.endpoint = publicEndpoint(info.endpoint);
  if (Array.isArray(info.agents)) {
    // an agent URL is an endpoint with a path on it; the host is what decides
    out.agents = info.agents.map((a) => ({ ...a, url: publicEndpoint(a?.url) ?? undefined }));
  }
  return out as T;
}
