/**
 * Adversarial regression checks the wave-0/1 fixes could plausibly have broken:
 *   R1  the accuracy-denominator change must not print a number where NOTHING was measured
 *       (node-a owns 3 DRAFT items with zero attestations)
 *   R2  the "Current only" default on /explore must not hide an item from the operator who OWNS it
 *       (node-a owns 3 SUPERSEDED items: krx-all-2761-ep12 / -ep6 / pixelplus-087600)
 */
import { chromium } from 'playwright';
const BASE = 'http://localhost:3402';
const PASS = 'e2e-pass-a';
const OUT = new URL('./results/verify/', import.meta.url).pathname;
const out = [];
const rec = (id, ok, msg) => { out.push({ id, ok, msg }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${msg}`); };

const tok = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASS }) })).json().then((j) => j.token);
const mine = await (await fetch(`${BASE}/api/me/patches?limit=200`, { headers: { authorization: `Bearer ${tok}` } })).json();
const drafts = mine.items.filter((i) => i.status === 'DRAFT');
const sup = mine.items.filter((i) => i.status === 'SUPERSEDED');
console.log(`owner state: ${drafts.length} DRAFT (0 attestations), ${sup.length} SUPERSEDED, ${mine.items.length} owned`);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 }, locale: 'en-US' });
const p = await ctx.newPage();

// sign in through the real form
await p.goto(`${BASE}/signing`, { waitUntil: 'domcontentloaded' });
await p.getByLabel(/password/i).first().fill(PASS);
await p.getByRole('button', { name: /sign in|confirm|set password|log in/i }).first().click();
await p.waitForURL(/\/dashboard|\/$|\/signing\?/, { timeout: 30_000 }).catch(() => {});
await p.waitForTimeout(1200);

// ── R1: a DRAFT with no attestation must show no accuracy percentage anywhere
{
  const d = drafts[0];
  await p.goto(`${BASE}/node-a/${d.anchor.id}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  const t = (await p.evaluate(() => document.body.innerText)).replace(/ /g, ' ');
  const pcts = [...t.matchAll(/\d+(\.\d+)?%[^\n]{0,60}/g)].map((m) => m[0]);
  const checked = /checked by verifiers|\d+\/\d+ checked/.test(t);
  const accLine = (t.match(/Accuracy[^\n]*/g) || []);
  // what the API says about this item
  const api = await (await fetch(`${BASE}/api/patches/${d.anchor.id}`, { headers: { authorization: `Bearer ${tok}` } })).json();
  const scored = (api.attestations ?? []).some((a) => a.score && a.score.free_generation);
  rec('R1a', !scored && !checked, `DRAFT ${d.anchor.id}: API attestations=${(api.attestations ?? []).length} scored=${scored}; page prints a "checked" denominator=${checked}`);
  rec('R1b', pcts.filter((x) => !/^100% of/.test(x)).length === 0 || accLine.length === 0, `accuracy lines on the page: ${JSON.stringify(accLine)}; all % strings: ${JSON.stringify(pcts)}`);
  await p.screenshot({ path: OUT + 'R1-draft-no-score-1280.png', fullPage: true });
}

// ── R2: the operator's own console must show every item they own, superseded included
{
  await p.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  const dash = (await p.evaluate(() => document.body.innerText)).replace(/ /g, ' ');
  const seen = sup.map((s) => ({ id: s.anchor.id, on: dash.includes(s.anchor.id) || dash.includes(s.anchor.name) }));
  rec('R2a', seen.every((s) => s.on), `dashboard (My knowledge) shows the owner's superseded items: ${JSON.stringify(seen)}`);
  // and each one opens on its own manage page
  const one = sup[0];
  await p.goto(`${BASE}/project/node-a/${one.anchor.id}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction((id) => document.body.innerText.includes(id), one.anchor.id, { timeout: 30_000 }).catch(() => {});
  await p.waitForTimeout(600);
  const m = (await p.evaluate(() => document.body.innerText)).replace(/ /g, ' ');
  rec('R2b', m.includes(one.anchor.name) || m.includes(one.anchor.id), `manage page for the superseded ${one.anchor.id} opens and names it`);
  // the public explore default hides it (that is the fix) but the DIRECT page is still reachable for anyone
  const pub = await fetch(`${BASE}/api/patches/${one.anchor.id}`);
  rec('R2c', pub.ok, `the hidden item's own page is still served publicly (HTTP ${pub.status}) — hidden from the list, not from the product`);
  await p.screenshot({ path: OUT + 'R2-operator-superseded-1280.png', fullPage: true });
}

// ── R2d: the operator's own drafts are visible to them and invisible to the public
{
  const d = drafts[0];
  const anon = await fetch(`${BASE}/api/patches/${d.anchor.id}`);
  const owner = await fetch(`${BASE}/api/patches/${d.anchor.id}`, { headers: { authorization: `Bearer ${tok}` } });
  rec('R2d', anon.status === 404 && owner.ok, `DRAFT ${d.anchor.id}: anonymous ${anon.status}, owner ${owner.status}`);
}

console.log(`\n${out.filter((o) => o.ok).length}/${out.length} checks passed`);
await b.close();
