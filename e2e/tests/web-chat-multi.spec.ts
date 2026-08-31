/**
 * Teach mode — ChatMode multi-knowledge (TM-090) and the contamination banner (TM-091).
 * Runs against any node; on a pre-teach node (no `applied` in GET /api/chat/patches) the tests skip.
 * Tagged @runtime: the banner test loads/unloads a knowledge in the shared serving model as operator.
 */
import { test, expect } from '@playwright/test';
import { K, NODE_A, api, operatorToken, runtimeAvailable } from '../helpers/ainize';

test.describe.configure({ mode: 'serial' });

interface ChatPatches { items: { anchor: { id: string; name: string } }[]; applied?: string[]; overlaps?: { a: string; b: string; rows: number }[]; runtime: { available: boolean } }

test('TM-090 picker: tick up to 3 knowledges, order badges, overlap warning, route keeps the selection', async ({ page, request }) => {
  const { body } = await api<ChatPatches>(request, '/api/chat/patches');
  test.skip(!Array.isArray(body.applied), 'node without teach-mode chat (no applied[] in /api/chat/patches)');
  test.skip(body.items.length < 2, 'needs at least two testable knowledges');
  const pair = body.overlaps?.[0] ? [body.overlaps[0].a, body.overlaps[0].b] : body.items.slice(0, 2).map((e) => e.anchor.id);
  const nameOf = (id: string) => body.items.find((e) => e.anchor.id === id)?.anchor.name ?? id;

  await page.goto(`${NODE_A}/chat/${pair.join(',')}`);
  await expect(page.getByRole('heading', { name: /Knowledge to load \(pick up to 3\)/ })).toBeVisible();
  const boxes = page.getByRole('checkbox');
  await expect(boxes.filter({ hasNot: page.locator('[disabled]') }).first()).toBeVisible();
  for (const id of pair) await expect(page.getByRole('checkbox', { name: nameOf(id) })).toBeChecked();
  await expect(page.getByText('2/3 selected')).toBeVisible();
  await expect(page.getByText(/2 knowledges loaded together/)).toBeVisible();
  if (body.overlaps?.length) {
    const alert = page.getByTestId('chat-overlap').first();
    await expect(alert).toContainText(/overlap on [\d,]+ memory entries/);
    await expect(alert).toContainText(nameOf(pair[1]));   // ticked last → wins
  }
  // a third pick disables the rest (max 3) — needs an available runtime, otherwise every checkbox is disabled
  if (body.items.length >= 4 && body.runtime.available) {
    const third = body.items.map((e) => e.anchor.id).find((id) => !pair.includes(id))!;
    await page.getByRole('checkbox', { name: nameOf(third) }).check();
    await expect(page).toHaveURL(new RegExp(`/chat/${[...pair, third].map(encodeURIComponent).join(',')}$`));
    const fourth = body.items.map((e) => e.anchor.id).find((id) => ![...pair, third].includes(id))!;
    await expect(page.getByRole('checkbox', { name: nameOf(fourth) })).toBeDisabled();
    await page.getByRole('checkbox', { name: nameOf(third) }).uncheck();
  }
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByText('0/3 selected')).toBeVisible();
  await page.screenshot({ path: 'results/tm-090-picker.png', fullPage: true });
});

test('TM-090 api: patch_ids loads in order, one usage event per knowledge, malformed bodies → 400 @runtime', async ({ request }) => {
  const { body } = await api<ChatPatches>(request, '/api/chat/patches');
  test.skip(!Array.isArray(body.applied), 'node without teach-mode chat');
  const bad1 = await api(request, '/api/chat', { method: 'POST', data: { patch_id: K.final, patch_ids: [K.pixel], mode: 'base', messages: [{ role: 'user', content: 'x' }] } });
  expect(bad1.status).toBe(400);
  const bad2 = await api(request, '/api/chat', { method: 'POST', data: { patch_ids: ['a', 'b', 'c', 'd'], mode: 'base', messages: [{ role: 'user', content: 'x' }] } });
  expect(bad2.status).toBe(400);
  test.skip(!(await runtimeAvailable(request)), 'serving model unavailable');
  const ids = body.items.map((e) => e.anchor.id);
  test.skip(!ids.includes(K.final) || !ids.includes(K.pixel), 'demo knowledge not testable here');
  const before = await api<{ events: { patch_id: string }[] }>(request, '/api/events?kind=usage&limit=1');
  const r = await api<{ patch_id: string; patch_ids: string[]; applied: { patch_id: string; applied_ms: number | null; was_applied: boolean }[]; applied_ms: number | null; benchmark_hits: Record<string, boolean | null>; benchmark_hit: boolean | null; patched: { content: string } | null }>(
    request, '/api/chat', { method: 'POST', data: { patch_ids: [K.final, K.pixel], mode: 'compare', messages: [{ role: 'user', content: K.pixelPrompt }], max_tokens: 16 } });
  expect(r.status).toBe(200);
  expect(r.body.patch_id).toBe(K.final);
  expect(r.body.patch_ids).toEqual([K.final, K.pixel]);
  expect(r.body.applied.map((a) => a.patch_id)).toEqual([K.final, K.pixel]);
  expect(r.body.applied_ms).toBe(r.body.applied.reduce((s, a) => s + (a.applied_ms ?? 0), 0));
  expect(Object.keys(r.body.benchmark_hits)).toEqual([K.final, K.pixel]);
  expect(r.body.patched?.content.replace(/\s/g, '')).toContain(K.pixelExpect);
  const after = await api<{ events: { patch_id: string; data: { patch_ids: string[] } }[] }>(request, '/api/events?kind=usage&limit=2');
  expect(after.body.events.map((e) => e.patch_id).sort()).toEqual([K.final, K.pixel].sort());
  expect(after.body.events[0].data.patch_ids).toEqual([K.final, K.pixel]);
  expect(after.body.events[0]).not.toEqual(before.body.events[0]);
});

test('TM-091 contamination banner when the operator keeps a knowledge loaded @runtime', async ({ page, request }) => {
  const { body } = await api<ChatPatches>(request, '/api/chat/patches');
  test.skip(!Array.isArray(body.applied), 'node without teach-mode chat');
  test.skip(!(await runtimeAvailable(request)), 'serving model unavailable');
  test.skip(!body.items.some((e) => e.anchor.id === K.pixel), 'pixelplus-087600 not testable here');
  test.skip((body.applied ?? []).length > 0, 'operator already has knowledge pinned — precondition not met');
  const pixelName = body.items.find((e) => e.anchor.id === K.pixel)!.anchor.name;

  await page.goto(`${NODE_A}/chat/${K.pixel}`);
  await expect(page.getByTestId('chat-contaminated')).toHaveCount(0);

  const token = await operatorToken(request);
  const applied = await api(request, `/api/patches/${K.pixel}/apply`, { method: 'POST', token });
  expect(applied.status).toBe(200);
  try {
    const now = await api<ChatPatches>(request, '/api/chat/patches');
    expect(now.body.applied).toEqual([K.pixel]);
    await page.reload();
    const banner = page.getByTestId('chat-contaminated');
    await expect(banner).toContainText(`This node also has ${pixelName} loaded for everyone`);
    await expect(page.getByText('Always loaded')).toBeVisible();
    await page.screenshot({ path: 'results/tm-091-banner.png', fullPage: true });
    const r = await api<{ applied: { was_applied: boolean }[] }>(request, '/api/chat', { method: 'POST', data: { patch_id: K.pixel, mode: 'patched', messages: [{ role: 'user', content: K.pixelPrompt }], max_tokens: 16 } });
    expect(r.status).toBe(200);
    expect(r.body.applied[0].was_applied).toBe(true);
    const rt = await api<{ applied: { patch_id: string }[] }>(request, '/api/runtime');
    expect(rt.body.applied.map((a) => a.patch_id)).toContain(K.pixel);
  } finally {
    await api(request, `/api/patches/${K.pixel}/remove`, { method: 'POST', token });
  }
  const back = await api<ChatPatches>(request, '/api/chat/patches');
  expect(back.body.applied).toEqual([]);
});
