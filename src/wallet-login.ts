/**
 * What a person reads in their wallet before they sign in.
 *
 * `operatorLoginMessage` in core is `ainize-login:<node>:<nonce>` — right for a CLI, where nothing renders it and
 * the only reader is a verifier. A browser wallet is the opposite: the string IS the interface. MetaMask shows
 * `personal_sign` bytes verbatim, and a person asked to approve an opaque token has been trained to click through
 * exactly the prompt an attacker needs them to click through. So the wallet scheme gets a message written to be
 * read: what it is for, which node, from which site, and that it spends nothing.
 *
 * This lives here rather than in core because only one party ever builds it. The node issues it with the nonce and
 * verifies against the string it stored — nobody reconstructs it, so there is no second implementation to keep in
 * step, and the format can change without a release of anything else. The CLI's message stays in core, where it
 * belongs, because there both sides build it.
 *
 * The lines are deliberately not parsed on the way back in. The nonce is the identifier; the text is for the human.
 */
export function walletLoginMessage(t: { node: string; nodeName?: string; nonce: string; origin?: string; expiresAt: number }): string {
  return [
    'Sign in to Ainize',
    '',
    `Node:    ${t.nodeName ? `${t.nodeName} (${t.node})` : t.node}`,
    ...(t.origin ? [`Site:    ${t.origin}`] : []),
    `Nonce:   ${t.nonce}`,
    `Expires: ${new Date(t.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
    '',
    'Signing proves you hold this address. It is not a transaction: it moves no funds and',
    'approves no spending. If you did not just ask to sign in, reject it.',
  ].join('\n');
}

/**
 * The site a sign-in is being asked from, as the node sees it — never as the caller claims it.
 *
 * The Origin header is set by the browser and cannot be written by page script, which is what makes it worth
 * showing at all. A caller that sends none (curl, the CLI) gets no Site line rather than a blank one, because an
 * empty field next to a filled one reads as "no site" and this must never be ambiguous.
 */
export function requestOrigin(header: string | undefined): string | undefined {
  if (!header || header === 'null') return undefined;
  try { const u = new URL(header); return u.origin; } catch { return undefined; }
}
