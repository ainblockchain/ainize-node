/**
 * A browser wallet's signature, made without a browser.
 *
 * `personal_sign` is keccak256 ONCE over `\x19Ethereum Signed Message:\n<byte length><message>`, signed with plain
 * secp256k1, returned as a bare 65-byte r‖s‖v with v = 27 + recovery. ain-util cannot produce that — it exposes
 * no "sign this hash" entry point, only its own double-keccak scheme — which is the same wall a MetaMask user hits
 * from the other side, and why this signs with the curve library directly.
 *
 * The digest comes from `hashEip191` in core, the same function the node verifies with, so this fixture cannot
 * drift from the verifier. What stops BOTH from drifting away from a real wallet is the published-vector test in
 * core (`hashEip191('hello world')`), which pins the digest itself against what viem, ethers and web3.js compute.
 */
import { createHmac } from 'node:crypto';
import * as secp from '@noble/secp256k1';
import { hashEip191 } from '@ainize/core';

// noble v2 keeps its own crypto out of the bundle: synchronous signing needs an HMAC provided by the host.
secp.etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) =>
  Uint8Array.from(createHmac('sha256', k).update(Buffer.concat(m.map((x) => Buffer.from(x)))).digest());

export function personalSign(message: string, privateKey: string): string {
  const sig = secp.sign(hashEip191(message), privateKey.replace(/^0x/, ''));
  return `0x${Buffer.concat([Buffer.from(sig.toCompactRawBytes()), Buffer.from([27 + sig.recovery])]).toString('hex')}`;
}
