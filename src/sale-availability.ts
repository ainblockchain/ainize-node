/** A ledger attestation does not prove that a seller still has the file today. */
export function saleAvailability<T extends { anchor: { author: string; patch_sha256: string }; sellable: boolean }>(
  entry: T, localAddress: string, hasBody: (sha: string) => boolean,
): T & { body_available: boolean | null } {
  const localSeller = entry.anchor.author.toLowerCase() === localAddress.toLowerCase();
  const body_available = localSeller ? hasBody(entry.anchor.patch_sha256) : null;
  return { ...entry, body_available, sellable: entry.sellable && body_available !== false };
}
