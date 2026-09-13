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
 * What a person reads before they let a command line speak for them.
 *
 * This is the one prompt in the product where the wrong click has a lasting consequence: a sign-in expires, a
 * binding does not. So it says the three things that decide whether to approve — WHICH key, on WHICH machine, and
 * for HOW long — and it says them in the bytes being signed, not only on the page around them. A field that lived
 * only in the page could be varied freely by whoever built the link while the wallet showed something reassuring.
 *
 * The label is the CLI's own words about itself and is shown in quotes for exactly that reason. It is never a
 * claim the node stands behind, and it is stripped of anything that could forge structure in the message.
 */
export function deviceAuthMessage(t: { node: string; nodeName?: string; delegate: string; label?: string | null; expiresAt: number; code: string }): string {
  return [
    'Authorize a command line to act as you',
    '',
    `Node:    ${t.nodeName ? `${t.nodeName} (${t.node})` : t.node}`,
    `Key:     ${t.delegate}`,
    ...(t.label ? [`Named:   "${safeLabel(t.label)}"  (its own description of itself)`] : []),
    `Until:   ${new Date(t.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
    `Request: ${t.code}`,
    '',
    'From now until then, that key can act as this address on this node: teach, publish, spend what',
    'this address may spend. It is not a transaction and moves no funds now. You can end it at any',
    'time from Account settings. If you did not just run `ainize login`, reject it.',
  ].join('\n');
}

/** A label is the CLI's own words. Newlines and quotes would let it forge lines in the message around it. */
export function safeLabel(label: string): string {
  return label.replace(/[\r\n"]+/g, ' ').trim().slice(0, 60);
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
