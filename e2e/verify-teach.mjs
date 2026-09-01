/**
 * Adversarial re-check of findings 7 and 6 on node-u (:3422, teachable repo, backend stub / simulated_checks true).
 * Reproduces the ORIGINAL problem statements and confirms they no longer hold:
 *   7  the check screen announced simulated checks as measurements "in the live model"
 *   6  the result page said "Your lesson is ready — it learned all N questions" above "no training happened",
 *      with Publish as the filled primary button
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const NODE = 'http://localhost:3422';
const FIX = '/mnt/newdata/ainize/knowledge-marketplace-teachable/packages/e2e/fixtures/ds-preview/az152-check.jsonl';
const OUT = new URL('./results/verify/', import.meta.url).pathname;
const out = [];
const rec = (id, ok, msg) => { out.push({ id, ok, msg }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${msg}`); };
const one = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

const policy = await (await fetch(`${NODE}/api/teach/policy`)).json();
console.log(`node-u policy: backend=${policy.backend} simulated_checks=${policy.simulated_checks} publish=${policy.publish}\n`);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 1100 }, locale: 'en-US' });
// node-u meters lessons per client IP (5/day) and trusts proxy headers — a fresh XFF gives this run its own window
const ip = `10.${1 + Math.floor(Math.random() * 253)}.${1 + Math.floor(Math.random() * 253)}.${1 + Math.floor(Math.random() * 253)}`;
await ctx.route((u) => u.port === '3422', (r) => r.continue({ headers: { ...r.request().headers(), 'x-forwarded-for': ip } }));
console.log('visitor ip', ip);
const p = await ctx.newPage();

// ── upload
await p.goto(`${NODE}/teach/upload`, { waitUntil: 'domcontentloaded' });
await p.getByTestId('teach-upload').waitFor({ timeout: 60_000 });
await p.getByTestId('file-input').setInputFiles({ name: 'verify-check.jsonl', mimeType: 'application/x-ndjson', buffer: readFileSync(FIX) });
await p.waitForURL(/\/teach\/dataset\/[0-9a-f-]{36}$/, { timeout: 90_000 });
await p.getByTestId('teach-dataset').waitFor();

// ══════════════════ 7: BEFORE the check runs — is the simulation disclosed up front?
{
  const banner = await p.locator('[data-testid="checks-simulated"]').count() ? one(await p.locator('[data-testid="checks-simulated"]').innerText()) : null;
  const btn = one(await p.getByTestId('run-check').textContent());
  rec('7a', !!banner && /simulated/i.test(banner) && /not measured|demo node/i.test(banner), `warning shown BEFORE the button: "${banner}"`);
  rec('7b', /simulated/i.test(btn) && !/^Check what the model already knows$/.test(btn), `button label: "${btn}" (was "Check what the model already knows")`);
}

// ══════════════════ 7: run it
await p.getByTestId('run-check').click();
const running = await p.getByTestId('run-check').textContent().catch(() => null);
await p.getByTestId('checked-note').waitFor({ state: 'visible', timeout: 5 * 60_000 });
await p.waitForTimeout(600);
{
  const note = one(await p.getByTestId('checked-note').innerText());
  const rows = await p.evaluate(() => [...document.querySelectorAll('[data-testid="dataset-row"]')].map((r) => {
    const cell = r.querySelectorAll('td')[4];
    return [...cell.querySelectorAll('span')].map((s) => ({ t: s.textContent.trim().slice(0, 80), color: getComputedStyle(s).color }));
  }).flat().filter((x) => x.t));
  rec('7c', /simulated/i.test(note) && /nothing was measured in a live model|not measured/i.test(note) && !/in the live model/i.test(note),
    `result line: "${note}"`);
  const answered = rows.filter((r) => /answer/i.test(r.t));
  rec('7d', answered.length > 0 && answered.every((r) => /Simulated answer \(no model was asked\)/i.test(r.t)),
    `per-row quoted answers: ${JSON.stringify(answered.slice(0, 2))}`);
  rec('7e', answered.length > 0 && answered.every((r) => r.color === 'rgb(138, 75, 0)'),
    `per-row help is warning-toned, not grey: ${[...new Set(answered.map((r) => r.color))].join(', ')}`);
  rec('7f', !!running && !/live model|measur/i.test(running) && /making up|simulat/i.test(running),
    `the RUNNING label claims no live-model measurement either: "${one(running)}"`);
  await p.screenshot({ path: OUT + '07-teach-dataset-check-1280.png', fullPage: true });
}

// ══════════════════ 6: train and read the result page
await p.getByTestId('to-settings').click();
await p.waitForURL(/\/teach\/dataset\/[0-9a-f-]{36}\/settings/, { timeout: 60_000 });
await p.getByTestId('train-lesson').click();
const landed = await Promise.race([
  p.waitForURL(/\/teach\/lesson\/[0-9a-f-]{36}$/, { timeout: 180_000 }).then(() => 'ok'),
  p.getByTestId('settings-error').waitFor({ state: 'visible', timeout: 180_000 }).then(() => 'error'),
]);
if (landed === 'error') {
  rec('6-blocked', false, `node-u refused the training job: ${one(await p.getByTestId('settings-error').textContent())}`);
} else {
  const jobId = new URL(p.url()).pathname.split('/')[3];
  await p.locator('[data-testid="teach-lesson"][data-status="READY"], [data-testid="teach-lesson"][data-status="NEEDS_MORE"], [data-testid="teach-lesson"][data-status="FAILED"]').first().waitFor({ timeout: 5 * 60_000 });
  await p.waitForTimeout(900);
  // the node's own record of this job — /public exists only once a lesson is published, so read the store
  const { execSync } = await import('node:child_process');
  const jobRow = JSON.parse(execSync(`python3 -c "import sqlite3,json;c=sqlite3.connect('file:/home/comcom/.ngram-teachable/node-u/data/node.sqlite?mode=ro',uri=True);r=list(c.execute(\"select status,checks from teach_jobs where id='${jobId}'\"))[0];print(json.dumps({'status':r[0],'checks':json.loads(r[1] or '{}')}))"`).toString());
  const f = await p.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const box = (el) => el && { tag: el.tagName, w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color };
    return {
      h1: q('h1')?.textContent ?? null,
      resultTitle: q('[data-testid="result-title"]')?.textContent ?? null,
      learned: q('[data-testid="result-learned"]')?.textContent ?? null,
      simulated: q('[data-testid="simulated"]')?.textContent ?? null,
      simulatedBg: q('[data-testid="simulated"]') && getComputedStyle(q('[data-testid="simulated"]')).backgroundColor,
      order: [...document.querySelectorAll('[data-testid="result-title"], h1, [data-testid="simulated"], [data-testid="result-learned"]')].map((e) => e.getAttribute('data-testid') || e.tagName),
      publish: box(q('[data-testid="go-publish"]')), publishLabel: q('[data-testid="go-publish"]')?.textContent ?? null,
      publishNote: q('[data-testid="publish-demo"]')?.textContent ?? null,
      keep: box(q('[data-testid="go-keep"]')), keepLabel: q('[data-testid="go-keep"]')?.textContent ?? null,
    };
  });
  console.log(JSON.stringify(f, null, 1));
  rec('6a', !/Your lesson is ready/i.test(f.h1 ?? '') && /nothing was trained|Demo run finished/i.test(f.resultTitle ?? f.h1 ?? ''),
    `headline is now "${one(f.resultTitle ?? f.h1)}" (was "Your lesson is ready")`);
  const iTitle = f.order.indexOf('result-title'), iSim = f.order.indexOf('simulated'), iLearn = f.order.indexOf('result-learned');
  rec('6b', iSim > -1 && iSim < iLearn && iSim === iTitle + 1, `DOM order ${JSON.stringify(f.order)} — the admission comes before the counts`);
  rec('6c', f.simulatedBg === 'rgb(255, 243, 224)', `the admission is warning-toned, not a pale info box: ${f.simulatedBg} (was rgb(245, 238, 252))`);
  rec('6d', /illustrative|not measured/i.test(f.learned ?? ''), `the counts say what they are: "${one(f.learned)}"`);
  const keepFilled = f.keep && /rgb\(139, 62, 235\)/.test(f.keep.bg);
  const pubPlain = f.publish && /rgba\(0, 0, 0, 0\)|transparent/.test(f.publish.bg) && f.publish.h < 30;
  rec('6e', keepFilled && pubPlain, `"Keep it private" is the filled primary (${f.keep?.bg}, ${f.keep?.w}x${f.keep?.h}); publishing is a plain link (${f.publish?.bg}, ${f.publish?.w}x${f.publish?.h}, "${one(f.publishLabel)}")`);
  rec('6f', /placeholder/i.test(f.publishNote ?? ''), `the publish link is preceded by: "${one(f.publishNote)}"`);
  rec('6g', jobRow?.checks?.simulated === true, `the node's own record agrees: status=${jobRow?.status}, checks.simulated=${jobRow?.checks?.simulated}, note="${jobRow?.checks?.note}"`);
  await p.screenshot({ path: OUT + '06-teach-lesson-result-1280.png', fullPage: true });
}

console.log(`\n${out.filter((o) => o.ok).length}/${out.length} checks passed`);
await b.close();
