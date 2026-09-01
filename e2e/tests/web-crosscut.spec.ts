/**
 * Cross-cutting scenarios AZ-085..AZ-100 (errors, accessibility, i18n, performance) against the LIVE demo cluster.
 * Ground truth for every label: packages/web/src/i18n/pages/*.ts. Tests that touch the shared serving model are
 * serialised in the `runtime` block below; the others only read public pages / the API.
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { K, NODE_A, PASSWORDS, VLLM, api, loginViaUi, operatorToken, sleep, startThrowawayNode, waitForLockFree, waitForRuntime } from '../helpers/ainize';
import { KRX_NPZ, PIXEL_NPZ, httpDown } from '../helpers/operator-cli';
import {
  AGO_EN, AGO_KO, CHAT, CANCEL_STRIP, DATE_TIME, PURPLE, agoLabel, bubble, bytesLabel, chatPicker, chatTextarea, ensureRuntime, focusInfo, footerText,
  completeTurn, freshTries, lastTurn, loadAxe, noHorizontalScroll, nodeAAddress, numLabel, pickerBoxes, pickerItems, readQuota, runAxe, sendPrompt, tabUntil, visitorOrigin, waitForPicker, waitForTurn,
  type FocusInfo,
} from '../helpers/crosscut-ui';

// node-a teaches since the teach-mode merge, so the header shows the Teach item (hidden on nodes with teach off).
const HEADER_NAV_EN = ['Explore knowledge', 'Live test', 'Teach', 'Network', 'Public record', 'Docs & API', 'Sign in'];
const HEADER_NAV_KO = ['지식 둘러보기', '라이브 테스트', '가르치기', '네트워크', '공개 기록', '문서·API', '로그인'];
const headerNav = (page: Page) => page.locator('header nav a');
const headerLink = (page: Page, name: string) => page.locator('header nav').getByRole('link', { name, exact: true });
const langButton = (page: Page) => page.getByRole('button', { name: 'language' });
const h1 = (page: Page) => page.getByRole('heading', { level: 1 });

type CatalogItem = { anchor: { id: string; name: string; price: string; currency: string; rows: number; size_bytes: number; benchmark: { queries: number; samples: { prompt: string; expect: string }[] } }; status: string; downloads: number };
type PatchDetail = CatalogItem & { revenue: string; passed: number; quorum: number; integrity_checks: number; listed_at?: number; attestations: { verifier_name?: string; verified_on: string; score: Record<string, string>; passed: boolean; created_at: number }[] };

/* ================================================================== runtime-touching scenarios (serial) */
test.describe('runtime', () => {
  // Not serial: each test calls ensureRuntime() first, so a vLLM hiccup in one test must not skip the rest of the block.
  test.describe.configure({ timeout: 15 * 60_000 });

  test('AZ-085 Show a plain error when the node API is unreachable on every public page', async ({ page, context, request }) => {
    await ensureRuntime(request);
    const V = await visitorOrigin();   // 2 tries only — no per-scenario quota bucket, whose route would collide with the offline simulation below
    await page.goto(`${V}/chat/${K.final}`);
    await waitForPicker(page, 4);

    // Warm the lazily loaded page chunks while online (an offline SPA cannot fetch a chunk it never loaded), but keep
    // their API data out of the RTK cache so the offline visit shows what a cold page shows.
    const blocked = ['**/api/catalog*', '**/api/ledger*', '**/api/nodes', '**/api/branches'];
    for (const p of blocked) await page.route(p, (r) => r.abort('failed'));
    await headerLink(page, 'Explore knowledge').click();
    await expect(h1(page)).toHaveText('Explore knowledge');
    await headerLink(page, 'Public record').click();
    await expect(h1(page)).toHaveText('Public record');
    await headerLink(page, 'Network').click();
    await expect(h1(page)).toHaveText('Network');
    await headerLink(page, 'Live test').click();
    await waitForPicker(page, 4);
    for (const p of blocked) await page.unroute(p);
    await page.waitForTimeout(500);

    // Step 3 — offline send
    await context.setOffline(true);
    await sendPrompt(page, 'hello');
    const alert = lastTurn(page).getByRole('alert');
    await expect(alert).toHaveText(CHAT.networkError);
    await expect(lastTurn(page).getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(lastTurn(page)).not.toContainText('TypeError');

    // Step 4 — back online, Retry resends the same prompt
    await context.setOffline(false);
    await lastTurn(page).getByRole('button', { name: 'Retry' }).click();
    await expect(lastTurn(page)).toContainText('hello');
    expect((await completeTurn(page, request)).status).toBe('done');
    await expect(bubble(page, 'base')).toBeVisible();
    await expect(bubble(page, 'patched')).toBeVisible();
    await expect(bubble(page, 'base').getByText(/^reply \d+(ms|\.\ds)$/)).toBeVisible();
    await expect(bubble(page, 'patched').getByText(/^reply \d+(ms|\.\ds)$/)).toBeVisible();

    // Step 5 — offline Explore
    await context.setOffline(true);
    await headerLink(page, 'Explore knowledge').click();
    await expect(page.getByText('Something went wrong: TypeError: Failed to fetch')).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(page.getByRole('status', { name: 'loading' })).toHaveCount(0);

    // Step 6 — offline Public record / Network
    await headerLink(page, 'Public record').click();
    await expect(page.getByText('No records yet.')).toBeVisible();
    await headerLink(page, 'Network').click();
    await expect(page.getByRole('heading', { name: 'This node' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Model server' })).toBeVisible();
    await expect(page.getByText('No connected nodes yet. Add another node’s endpoint from Account settings.')).toBeVisible();
    const tracksTitle = page.getByRole('heading', { name: 'Knowledge tracks' });
    await expect(tracksTitle).toBeVisible();
    await expect(tracksTitle.locator('xpath=following::*[@role="status"][1]')).toBeVisible();   // spinner under 'Knowledge tracks'
    await expect(page.locator('header').getByText('AI Network', { exact: true })).toBeVisible();
    await context.setOffline(false);
    test.info().annotations.push({ type: 'note', description: 'LedgerPage / NetworkPage have no error branch: offline they show "No records yet." and the cached node cards + a spinner, never an explicit error (matches the scenario text; flagged as a UX gap).' });
  });

  test('AZ-087 Switch the whole UI between English and Korean and keep the choice across reloads and pages', async ({ page, request }) => {
    await ensureRuntime(request);
    const V = await visitorOrigin();
    await freshTries(page);   // this scenario's own 20 tries/hour
    const cat = await api<{ total: number }>(request, '/api/catalog');
    const total = numLabel(cat.body.total);

    // Step 1 — English defaults
    await page.goto(`${V}/explore`);
    await expect(h1(page)).toHaveText('Explore knowledge');
    await expect(page.getByRole('button', { name: 'Most popular' })).toBeVisible();
    await expect(page.getByText('Model', { exact: true })).toBeVisible();
    await expect(page.getByText('Topic', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveCount(2);
    await expect(page.getByPlaceholder('Search by name or description')).toBeVisible();
    await expect(page.getByText('Show', { exact: true })).toBeVisible();
    const currentTotal = numLabel((await api<{ total: number }>(request, '/api/catalog?status=LISTED,ANNOUNCED,VERIFYING,CHALLENGED')).body.total);
    await expect(page.getByText(`${currentTotal} knowledge`)).toBeVisible();   // Explore opens on "Current only"
    await expect(headerNav(page)).toHaveText(HEADER_NAV_EN);
    await expect(langButton(page)).toHaveText('한국어');
    // the tab names the page, and <html lang> declares the language actually on screen
    await expect(page).toHaveTitle('Explore knowledge · Ainize');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');

    // Step 2/3 — Korean
    await langButton(page).click();
    await expect(h1(page)).toHaveText('지식 둘러보기');
    await expect(page.getByRole('button', { name: '인기순' })).toBeVisible();
    await expect(page.getByText('대상 모델', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('주제', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: '전체', exact: true })).toHaveCount(2);
    await expect(page.getByPlaceholder('지식 이름·설명 검색')).toBeVisible();
    await expect(page.getByText('표시', { exact: true })).toBeVisible();
    await expect(page.getByText(`지식 ${currentTotal}개`)).toBeVisible();
    await expect(page.getByText('검증 완료', { exact: true }).first()).toBeVisible();   // 검증 배지
    await expect(page.getByText('판매 중', { exact: true }).first()).toBeVisible();      // 목록 상태 칩 (status.LISTED)
    await expect(page).toHaveTitle('지식 둘러보기 · Ainize');
    expect(await page.evaluate(() => document.documentElement.lang), '<html lang> follows the toggle without a reload').toBe('ko');
    // the retired versions and their Korean chip come back with '모든 버전'
    await page.getByRole('button', { name: '모든 버전', exact: true }).click();
    await expect(page.getByText(`지식 ${total}개`)).toBeVisible();
    await expect(page.getByText(`최신 버전: ${K.final}`, { exact: true }).first()).toBeVisible();
    const krxItem = page.locator(`main a[href$="/${K.final}"]`);
    await expect(krxItem).toContainText('만든 사람: node-a · 대상 모델: Qwen3.8-Flash-Next · 주제: krx-ticker-codes');
    await expect(headerNav(page)).toHaveText(HEADER_NAV_KO);
    await expect(langButton(page)).toHaveText('English');
    await expect(page.locator('header').getByText('AI Network', { exact: true })).toBeVisible();
    await expect(page.getByText(/\bAIN\b/).first()).toBeVisible();
    await expect(page.locator('body')).not.toHaveText(/\b(explore|nav|common|item|status|units|price|footer)\.[a-z_]+/);

    // Step 4 — persists across reload and routes; landing has its own toggle
    await page.reload();
    await expect(h1(page)).toHaveText('지식 둘러보기');
    await page.goto(`${V}/`);
    await expect(h1(page)).toHaveText('지식을 AI에 끼우다');
    // Hangul renders on the landing page even where the host has no system Korean face: the display stack ends in
    // the webfont index.html downloads, so the headings and both hero pills are not blank boxes.
    const hero = await h1(page).evaluate((el) => ({ font: getComputedStyle(el).fontFamily, w: el.getBoundingClientRect().width }));
    expect(hero.font, 'display stack carries the Hangul fallback').toContain('Noto Sans KR');
    expect(hero.w, 'the Korean h1 actually renders glyphs').toBeGreaterThan(100);
    // Every Korean label on the page renders glyphs: the defect made the hero pills (and the headings) blank runs
    // inside their padding, so measure the CONTENT width of every link carrying one of the hero labels.
    for (const label of ['지식 둘러보기', '라이브 테스트 해보기']) {
      const widths = await page.getByRole('link', { name: label, exact: true }).evaluateAll((els) => els.map((el) => {
        const cs = getComputedStyle(el);
        return el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      }));
      expect(widths.length, `"${label}" is on the Korean landing page`).toBeGreaterThan(0);
      for (const w of widths) expect(w, `"${label}" renders glyphs, not blanks`).toBeGreaterThan(40);
    }
    await expect(page).toHaveTitle('지식을 AI에 끼우다 · Ainize');
    await langButton(page).click();
    await expect(h1(page)).toHaveText('Plug knowledge into your AI');
    await expect(page).toHaveTitle('Plug knowledge into your AI · Ainize');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    await langButton(page).click();
    await expect(h1(page)).toHaveText('지식을 AI에 끼우다');
    await page.goto(`${V}/ledger`);
    await expect(h1(page)).toHaveText('공개 기록');
    await expect(page).toHaveTitle('공개 기록 · Ainize');
    await page.goto(`${V}/${await nodeAAddress(request)}/${K.final}`);
    await expect(page).toHaveTitle(`${await h1(page).innerText()} · Ainize`);   // a knowledge page is named after the knowledge
    await page.goto(`${V}/no-such-page-here`);
    await expect(page).toHaveTitle('404. 페이지를 찾을 수 없습니다 · Ainize');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ko');
    await page.goto(`${V}/chat/${K.final}`);
    await expect(h1(page)).toHaveText('라이브 테스트');
    await expect(page).toHaveTitle('라이브 테스트 · Ainize');

    // Step 5
    expect(await page.evaluate(() => localStorage.getItem('ainize.locale'))).toBe('ko');

    // Step 6 — Korean bubble meta
    await waitForPicker(page, 4);
    await page.getByRole('button', { name: K.pixelPrompt.trim(), exact: true }).click();
    await chatTextarea(page).press('Enter');
    expect((await completeTurn(page, request)).status).toBe('done');
    const patched = bubble(page, 'patched');
    await expect(patched.getByText(/^응답 (\d+ms|\d+\.\d초)$/)).toBeVisible();
    await expect(patched.getByText(/^· 넣는 데 (\d+ms|\d+\.\d초)$/)).toBeVisible();
    await expect(patched.getByText('✓ 정답', { exact: true })).toBeVisible();   // the hit chip (teach mode adds a '정답 가르치기' button to the same bubble)
    await langButton(page).click();
    await page.reload();
    await expect(h1(page)).toHaveText('Live test');
    expect(await page.evaluate(() => localStorage.getItem('ainize.locale'))).toBe('en');
  });

  test('AZ-089 Recover automatically after the node process restarts under an open Live test tab', async ({ page, request }) => {
    // Budget: the shared vLLM hangs for ~5 min about once an hour, and step 6 has to wait it out (ensureRuntime) —
    // so the test and the private node's watchdog both get room for one outage on top of the ~2 min happy path.
    test.setTimeout(24 * 60_000);
    await ensureRuntime(request);
    // The demo node-a is never killed. The SIGTERM + restart happen for real on a private serving node built from the
    // same binary + web UI (name node-a, same public record, same shared model) that holds the pixelplus body.
    const node = await startThrowawayNode('az089', { name: 'node-az089', stableId: 'az089', roles: 'seller,serving', ledger: 'ain', runtimeApi: VLLM, maxLifeS: 1_320 });
    try {
      await node.seed(PIXEL_NPZ, 'az089-seed');
      expect(await waitForRuntime(request, node.url), 'private node sees the shared model').toBe(true);
      await page.goto(`${node.url}/chat/${K.pixel}`);
      await waitForPicker(page, 1);
      const nItems = await pickerItems(page).count();
      expect(nItems).toBeGreaterThan(0);

      // Step 1/2 — the pid behind the port, then SIGTERM
      const pidBefore = node.pid;
      expect(pidBefore).toBeTruthy();
      await node.kill();
      expect(await httpDown(node.url), 'port closed after SIGTERM').toBe(true);

      // Step 3 — every API call is refused while the port is closed
      await page.getByRole('button', { name: K.pixelPrompt.trim(), exact: true }).click();
      await chatTextarea(page).press('Enter');
      await expect(lastTurn(page).getByRole('alert')).toHaveText(CHAT.networkError);
      await expect(lastTurn(page).getByRole('button', { name: 'Retry' })).toBeVisible();

      // Step 4/5 — restart after ~10 s; the 20 s poll of /api/chat/patches succeeds again without a reload
      await page.waitForTimeout(10_000);
      const poll = page.waitForResponse((r) => r.url().includes('/api/chat/patches') && r.status() === 200, { timeout: 90_000 });
      await node.start();
      expect(node.pid).not.toBe(pidBefore);
      expect((await poll).ok()).toBe(true);
      const info = await api<{ node: { name: string } }>(request, '/api/info', { node: node.url });
      expect(info.status).toBe(200);
      expect(info.body.node.name).toBe('node-az089');
      await expect(pickerItems(page)).toHaveCount(nItems);
      await expect(page.locator('header').getByText('AI Network', { exact: true })).toBeVisible();

      // Step 6 — Retry succeeds
      await ensureRuntime(request);            // never press Retry into a hanging shared model (hourly vLLM outage)
      await waitForLockFree(request, node.url);
      await lastTurn(page).getByRole('button', { name: 'Retry' }).click();
      expect((await completeTurn(page, request)).status).toBe('done');
      await expect(bubble(page, 'base')).toBeVisible();
      const patched = bubble(page, 'patched');
      await expect(patched.getByText(/^· loaded in (\d+ms|\d+\.\ds)$/)).toBeVisible();
      await expect(patched.getByText('✓ Correct')).toBeVisible();
      await expect(patched).toContainText(K.pixelExpect);

      // Step 7 — the shared table was restored
      const rt = await api<{ applied: unknown[] }>(request, '/api/runtime', { node: node.url });
      expect(rt.body.applied).toEqual([]);
    } finally {
      await node.stop();
    }
  });

  test('AZ-091 Show honest loading states while a 331.7 MB knowledge is loaded, and allow cancelling', async ({ page, request }) => {
    await ensureRuntime(request);
    const V = await visitorOrigin();
    await freshTries(page);   // this scenario's own 20 tries/hour
    await page.goto(`${V}/chat/${K.final}`);
    await waitForPicker(page, 4);

    // Step 1
    const foot0 = await footerText(page);
    expect(foot0).toMatch(/^(Free tries are limited per hour\. No sign-in needed\.|Free trial \d+\/20 left this hour)/);

    // Step 2 — in-flight UI
    const compare = page.getByRole('radio', { name: 'Compare' });
    await compare.click();
    await expect(compare).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: K.pixelPrompt.trim(), exact: true }).click();
    await chatTextarea(page).press('Enter');
    const turn = lastTurn(page);
    await expect(turn.getByText('You', { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(turn.locator('[aria-label="Generating…"]')).toHaveCount(2, { timeout: 5000 });
    await expect(turn.getByText('Includes loading and unloading — this can take tens of seconds.')).toHaveCount(2);
    const sending = page.getByRole('button', { name: 'Waiting for the answer…' });
    await expect(sending).toBeVisible();
    await expect(sending).toBeDisabled();
    await expect(sending.locator('span[aria-hidden]')).toHaveCount(1);   // spinner
    const strip = page.getByRole('status').filter({ hasText: CANCEL_STRIP });
    await expect(strip).toBeVisible();
    await expect(strip.getByRole('button', { name: /^(Cancel|Stop waiting)$/ })).toBeVisible();
    for (const r of ['Compare', 'After only', 'Before only']) await expect(page.getByRole('radio', { name: r })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: 'Enable thinking' })).toBeDisabled();
    await expect(chatTextarea(page)).toBeDisabled();
    for (let i = 0; i < 4; i++) await expect(pickerBoxes(page).nth(i)).toBeEnabled();

    // Step 3 — meta line after the answer
    expect((await completeTurn(page, request)).status).toBe('done');
    const patched = bubble(page, 'patched');
    await expect(patched.getByText('After loading', { exact: true })).toBeVisible();
    await expect(patched.getByText(/^reply (\d+ms|\d+\.\ds)$/)).toBeVisible();
    const loaded = await patched.getByText(/^· loaded in (\d+ms|\d+\.\ds)$/).innerText();
    await expect(patched.getByText('✓ Correct')).toBeVisible();
    const base = bubble(page, 'base');
    await expect(base.getByText('Before loading', { exact: true })).toBeVisible();
    await expect(base.getByText(/^reply (\d+ms|\d+\.\ds)$/)).toBeVisible();
    test.info().annotations.push({ type: 'note', description: `AZ-091 applied time: ${loaded}` });

    // Step 4 — cancel within 2 s
    const quotaBefore = await readQuota(page);
    expect(quotaBefore).not.toBeNull();
    await sendPrompt(page, K.pixelPrompt.trim());
    await strip.getByRole('button', { name: /^(Cancel|Stop waiting)$/ }).click({ timeout: 2000 });
    // D3: which of the two the visitor is told depends on whether the node had already taken the shared lock when the
    // button was pressed, and that is a genuine race — the scenario documents BOTH and requires the message to say
    // which happened. ("Request cancelled." is the pre-D3 wording and must no longer appear.)
    const alert = lastTurn(page).getByRole('alert');
    const FREE = 'You stopped waiting. The node had not started this test yet, so no free try was used.';
    const CHARGED = 'You stopped waiting, but the test had already started on the shared model, so it still counts as one free try.';
    await expect(alert).toHaveText(new RegExp(`^(${FREE.replace(/[.]/g, '\\.')}|${CHARGED.replace(/[.]/g, '\\.')})$`));
    const charged = (await alert.innerText()).includes('still counts as one free try');
    await expect(lastTurn(page).getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(chatTextarea(page)).toBeEnabled({ timeout: 2000 });

    // Step 5 — the counter never moves at cancel time (no response arrived). What the retry costs follows the message:
    // cancelled while QUEUED nothing reached the model, so only the retry is charged; cancelled while RUNNING the node
    // finishes the work and charges it too.
    expect(await readQuota(page)).toBe(quotaBefore);
    await lastTurn(page).getByRole('button', { name: 'Retry' }).click();
    const done = await completeTurn(page, request);
    expect(done.status).toBe('done');
    const drop = (quotaBefore as number) - (await readQuota(page) as number);
    const expected = charged ? 2 : 1;
    if (done.retries === 0) expect(drop, charged ? 'cancelled-while-running + retry are both charged' : 'cancelled while queued is free, so only the retry is charged').toBe(expected);
    else { expect([expected - 1, expected]).toContain(drop); test.info().annotations.push({ type: 'note', description: `runtime hiccup during step 5 (${done.retries} retry); quota drop observed: ${drop}` }); }
    test.info().annotations.push({ type: 'note', description: charged
      ? 'The give-up landed after the node had taken the shared lock, so the try was charged and cancel + retry dropped the quota by two — the honest half of the D3 behaviour.'
      : 'The give-up landed while the request was still queued: nothing was sent to the model, HTTP 499, and only the retry was charged (quota dropped by one).' });
  });

  test('AZ-093 Operate the Live test and sign-in entirely from the keyboard with visible focus', async ({ page, request }) => {
    await ensureRuntime(request);
    await operatorToken(request);   // makes sure the operator password exists for step 6
    const V = await visitorOrigin();
    await freshTries(page);   // this scenario's own 20 tries/hour
    const cp = await api<{ items: CatalogItem[] }>(request, '/api/chat/patches');
    const items = cp.body.items;
    const final = items.find((e) => e.anchor.id === K.final)!;
    const samples = final.anchor.benchmark.samples;

    await page.goto(`${V}/chat/${K.final}`);
    await waitForPicker(page, 4);
    await page.locator('body').click({ position: { x: 5, y: 5 } });   // focus the document, not a control

    // Step 1 — focus order + ring
    const order: FocusInfo[] = [];
    for (let i = 0; i < 40; i++) { await page.keyboard.press('Tab'); order.push(await focusInfo(page)); }
    const names = order.map((f) => f.name);
    const expected: (string | RegExp)[] = [
      'Ainize home', ...HEADER_NAV_EN, 'language',
      'Dismiss', 'Your knowledge', 'Open lesson',   // teach banner + collapsed lesson basket head the column on a teaching node
      'Clear selection',                            // the multi-select picker's count row
      ...items.map((e) => new RegExp(`^${e.anchor.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)),
      'Details →', ...samples.slice(0, 8).map((s) => s.prompt.trim()), `Show ${samples.length - 8} more`,
      'Compare', 'After only', 'Before only',
    ];
    for (const [i, e] of expected.entries()) {
      if (typeof e === 'string') expect(names[i], `tab stop ${i}`).toBe(e); else expect(names[i], `tab stop ${i}`).toMatch(e);
    }
    const checkboxIdx = expected.length;
    expect(order[checkboxIdx].type, 'checkbox after the radios').toBe('checkbox');
    expect(order[checkboxIdx + 1].tag, 'textarea after the checkbox').toBe('textarea');
    expect(order[checkboxIdx + 2].name, 'Send is skipped while disabled').not.toBe('Send');
    for (const f of order.slice(0, checkboxIdx + 1)) {
      expect(f.outlineStyle, `${f.name} outline style`).toBe('solid');
      expect(f.outlineWidth, `${f.name} outline width`).toBe('2px');
      expect(f.outlineColor, `${f.name} outline color`).toBe(PURPLE);
      expect(f.outlineOffset, `${f.name} outline offset`).toBe('2px');
    }
    const ta = order[checkboxIdx + 1];
    expect(ta.borderColor).toBe(PURPLE);
    expect(ta.boxShadow).toContain('3px');

    // Step 2 — pick ep12 with Enter
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    // multi-select picker: ticking adds to the stack, so untick (final) with Space first, then tick epoch 12
    const finalBox = await tabUntil(page, (f) => f.type === 'checkbox' && f.name.includes('(final)'));
    expect(finalBox).not.toBeNull();
    await page.keyboard.press('Space');
    const ep12 = await tabUntil(page, (f) => f.type === 'checkbox' && f.name.includes('epoch 12'));
    expect(ep12).not.toBeNull();
    await page.keyboard.press('Space');
    await expect(page).toHaveURL(new RegExp(`/chat/${K.ep12}$`));
    await expect(pickerItems(page).filter({ hasText: 'epoch 12' })).toContainText('Loads 1.');
    const head = page.locator('section[aria-live="polite"] h2');
    await expect(head).toHaveText('KRX ticker codes for 2,761 listed companies — epoch 12');
    await expect(head.locator('xpath=following-sibling::span[1]')).toHaveText('Newer version available');

    // Step 3 — radios / checkbox from the keyboard
    const afterOnly = await tabUntil(page, (f) => f.role === 'radio' && f.name === 'After only');
    expect(afterOnly).not.toBeNull();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('radio', { name: 'After only' })).toHaveAttribute('aria-checked', 'true');
    const cb = await tabUntil(page, (f) => f.type === 'checkbox');
    expect(cb).not.toBeNull();
    await page.keyboard.press('Space');
    await expect(page.getByText('Thinking is on — replies are slower')).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.getByText('Off by default. When on, the model reasons at length before answering, so replies are slower. Keep it off for short factual questions.')).toBeVisible();
    await expect(page.getByText('Thinking is on — replies are slower')).toHaveCount(0);

    // Step 4 — Shift+Enter newline, IME guard, Enter sends
    const box = await tabUntil(page, (f) => f.tag === 'textarea');
    expect(box).not.toBeNull();
    const textarea = chatTextarea(page);
    const h0 = (await textarea.boundingBox())!.height;
    await page.keyboard.type('종목코드');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('픽셀플러스');
    await expect(textarea).toHaveValue('종목코드\n픽셀플러스');
    const h1px = (await textarea.boundingBox())!.height;
    expect(h1px).toBeGreaterThan(h0);
    expect(h1px).toBeLessThanOrEqual(160);
    await textarea.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
    await page.waitForTimeout(300);
    await expect(page.locator('article')).toHaveCount(0);   // no submit during IME composition
    await expect(textarea).toHaveValue('종목코드\n픽셀플러스');
    await page.keyboard.press('Enter');
    await expect(page.locator('article')).toHaveCount(1);
    await expect(textarea).toHaveValue('');

    // Step 5 — Cancel reachable before the composer while pending; Clear conversation afterwards
    await expect(textarea).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Waiting for the answer…' })).toBeDisabled();
    await page.keyboard.press('Shift+Tab');
    const afterShiftTab = await focusInfo(page);
    let cancel = afterShiftTab.name === 'Cancel' || afterShiftTab.name === 'Stop waiting' ? afterShiftTab : null;
    if (!cancel) cancel = await tabUntil(page, (f) => f.tag === 'button' && (f.name === 'Cancel' || f.name === 'Stop waiting'), 80, 'Shift+Tab');
    expect(cancel, 'Cancel is reachable from the keyboard').not.toBeNull();
    expect(await page.evaluate(() => {
      const strip = document.querySelector('[role="status"] button');
      const ta = document.querySelector('textarea');
      return !!strip && !!ta && !!(strip.compareDocumentPosition(ta) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), 'cancel strip precedes the composer in DOM order').toBe(true);
    test.info().annotations.push({ type: 'note', description: `Shift+Tab from the (now disabled) textarea landed on: ${afterShiftTab.tag} "${afterShiftTab.name}"` });
    expect((await completeTurn(page, request)).status).toBe('done');
    await expect(bubble(page, 'patched')).toBeVisible();
    await expect(lastTurn(page).locator('[aria-busy]')).toHaveCount(1);   // 'After only' → a single bubble
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    const clear = await tabUntil(page, (f) => f.tag === 'button' && f.name === 'Clear conversation');
    expect(clear).not.toBeNull();
    await page.keyboard.press('Enter');
    await expect(page.getByText('No questions yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear conversation' })).toHaveCount(0);

    // Step 6 — sign-in from the keyboard
    await page.goto(`${NODE_A}/signing`);
    const pw = page.getByLabel('Operator password');
    await expect(pw).toBeFocused();
    await page.keyboard.type('definitely-wrong-password');
    await page.keyboard.press('Enter');
    await expect(page.locator('form').getByText('wrong password')).toBeVisible();
    await pw.fill('');
    await page.keyboard.type(PASSWORDS[NODE_A]);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(h1(page)).toHaveText('My knowledge');
  });
  test('AZ-092 Keep every page usable at 360 px width without horizontal page scrolling @mobile', async ({ page, request }, testInfo) => {
    // The mobile project (Pixel 5: isMobile + dpr 2.75) scales the LAYOUT viewport (~827 CSS px), so the 360px CSS
    // breakpoints (sm 600 / md 960) and body-overflow can't be measured there. The real 360px assertions run under
    // the web project at an exact 360px CSS viewport (set below); @mobile keeps the scenario in the mobile pass too.
    test.skip(testInfo.project.name === 'mobile', 'Pixel 5 mobile emulation scales the layout viewport away from 360 CSS px; the 360px assertions run under the web project');
    await page.setViewportSize({ width: 360, height: 740 });
    await ensureRuntime(request);
    const V = await visitorOrigin();
    await freshTries(page);   // this scenario's own 20 tries/hour
    const addr = await nodeAAddress(request);
    const overflow: Record<string, { ok: boolean; scrollWidth: number; innerWidth: number }> = {};

    // Step 1 — landing nav wraps, four controls tappable and on screen
    await page.goto(`${V}/`);
    const nav = page.locator('nav').first();
    expect(await nav.evaluate((el) => getComputedStyle(el).flexWrap)).toBe('wrap');
    for (const [i, c] of [page.getByRole('link', { name: 'Explore knowledge' }).first(), page.getByRole('link', { name: 'Live test' }).first(), page.getByRole('link', { name: 'Node sign-in' }), langButton(page)].entries()) {
      await expect(c).toBeVisible();
      const box = (await c.boundingBox())!;
      expect(box.x, `landing control ${i} left`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `landing control ${i} right`).toBeLessThanOrEqual(360.5);
    }
    overflow.landing = await noHorizontalScroll(page);

    // Step 2 — Explore: header items present/reachable (record which sit outside 360), list item padding + icon + hidden price
    await page.goto(`${V}/explore`);
    await expect(h1(page)).toHaveText('Explore knowledge');
    const headerItems: [string, ReturnType<Page['locator']>][] = [['Ainize home', page.getByRole('link', { name: 'Ainize home' })], ['AI Network', page.locator('header').getByText('AI Network', { exact: true })], ...HEADER_NAV_EN.map((n) => [n, headerLink(page, n)] as [string, ReturnType<Page['locator']>]), ['한국어', langButton(page)]];
    const outside: string[] = [];
    for (const [label, c] of headerItems) {
      await expect(c, `${label} present`).toBeVisible();   // in the DOM and reachable (nav scrolls)
      const box = (await c.boundingBox())!;
      if (box.x < 0 || box.x + box.width > 360.5) outside.push(label);
    }
    const firstItem = page.locator(`main a[href$="/${K.final}"]`);
    expect(await firstItem.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('16px');
    expect(await firstItem.locator('img').first().evaluate((el) => getComputedStyle(el).width)).toBe('40px');
    await expect(firstItem.getByText(/^\d+(\.\d+)? AIN$/)).toBeHidden();   // price column hidden below 600 px
    overflow.explore = await noHorizontalScroll(page);

    // Step 3 — detail stats wrap; verification table scrolls inside its wrapper
    await page.goto(`${V}/${addr}/${K.final}`);
    const ys = new Set<number>();
    for (const n of ['Purchases', 'accuracy', 'Memory entries', 'Facts', 'Size', 'Price', 'Revenue']) {
      const el = page.getByText(n, { exact: true }).first();
      await expect(el).toBeVisible();
      ys.add(Math.round((await el.boundingBox())!.y));
    }
    expect(ys.size, 'stats wrap onto several rows').toBeGreaterThan(1);
    await page.getByRole('tab', { name: 'Verification' }).dispatchEvent('click');   // dispatch avoids the overflowing-header interception
    const wrapper = page.getByRole('table').first().locator('xpath=..');
    await expect(wrapper).toBeVisible();
    const dims = await wrapper.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: getComputedStyle(el).overflowX }));
    expect(dims.overflowX).toBe('auto');
    expect(dims.scrollWidth).toBeGreaterThan(dims.clientWidth);
    await wrapper.evaluate((el) => { el.scrollLeft = 200; });
    expect(await wrapper.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    overflow.detail = await noHorizontalScroll(page);

    // Step 4 — chat: picker stacks above the transcript, bubbles stack, textarea + Send on one row
    await page.goto(`${V}/chat/${K.final}`);
    await waitForPicker(page, 4);
    const pickerBox = (await chatPicker(page).boundingBox())!;
    const mainBox = (await page.locator('section[aria-live="polite"]').boundingBox())!;
    expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(mainBox.y + 1);
    expect(Math.abs(pickerBox.width - mainBox.width)).toBeLessThan(2);
    await page.getByRole('button', { name: K.pixelPrompt.trim(), exact: true }).click();
    await chatTextarea(page).press('Enter');
    expect((await completeTurn(page, request)).status).toBe('done');
    // both boxes in ONE layout read: the transcript scrolls smoothly to the new turn, so two separate
    // boundingBox() calls can be taken at different scroll offsets and appear to overlap
    const [b1, b2] = await page.evaluate(() => {
      const turn = [...document.querySelectorAll('article')].pop()!;
      const bubbles = [...turn.querySelectorAll<HTMLElement>('[aria-busy]')];
      const box = (re: RegExp) => { const r = bubbles.find((b) => re.test(b.innerText))!.getBoundingClientRect(); return { x: r.x, y: r.y, height: r.height }; };
      return [box(/Before loading/), box(/After loading/)];
    });
    expect(b2.y).toBeGreaterThanOrEqual(b1.y + b1.height - 1);
    expect(Math.abs(b1.x - b2.x)).toBeLessThan(2);
    const ta = (await chatTextarea(page).boundingBox())!;
    const send = (await page.getByRole('button', { name: 'Send' }).boundingBox())!;
    expect(send.x).toBeGreaterThan(ta.x + ta.width - 1);
    expect(Math.abs((ta.y + ta.height) - (send.y + send.height))).toBeLessThan(12);
    overflow.chat = await noHorizontalScroll(page);

    // Step 5 — ledger map scrolls inside its box, legend wraps
    await page.goto(`${V}/ledger`);
    await expect(h1(page)).toHaveText('Public record');
    await page.getByRole('heading', { name: 'Origin → derivative map' }).scrollIntoViewIfNeeded();
    const svg = page.locator('svg[role="img"]');
    await expect(svg).toBeVisible();
    const gbox = svg.locator('xpath=..');
    const g = await gbox.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: getComputedStyle(el).overflowX }));
    expect(g.overflowX).toBe('auto');
    expect(g.scrollWidth).toBeGreaterThan(g.clientWidth);
    expect(await gbox.locator('xpath=following-sibling::div[1]').evaluate((el) => getComputedStyle(el).flexWrap)).toBe('wrap');
    overflow.ledger = await noHorizontalScroll(page);

    // Step 6 says "true on every page": Docs → REST API is the one that used to break it (85 operation rows whose
    // unbreakable <code> path plus a nowrap auth tag pushed the body to 528 px), so it is measured with the tab open.
    await page.goto(`${V}/docs`);
    await expect(h1(page)).toHaveText('Docs · API · CLI');
    await page.getByRole('tab', { name: 'REST API' }).dispatchEvent('click');
    await expect(page.locator('details summary code').first()).toBeVisible();
    overflow.docs = await noHorizontalScroll(page);

    // Step 7 — the same header at desktop widths: the ledger badge used to be painted 65 px over the first nav link
    // (Home was `flex: 1; min-width: 0` around a 121 px logo and a nowrap badge, neither of which can shrink).
    const geom: Record<number, { intersects: boolean; headerH: number; sameRow: boolean; navNeed: number; navWidth: number }> = {};
    for (const w of [1440, 1280, 1024, 960]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(`${V}/explore`);
      await expect(h1(page)).toHaveText('Explore knowledge');
      // measure with the webfonts in place: while the fallback face is showing the nav is wider than the bar and
      // wraps to a second row — graceful, but not the steady state this step is about
      await page.evaluate(() => document.fonts.ready);
      geom[w] = await page.evaluate(() => {
        const box = (el: Element | null | undefined) => { const r = el!.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
        const badge = box([...document.querySelectorAll('header span')].find((x) => /^(AI Network|P2P)$/.test(x.textContent ?? '')));
        const first = box(document.querySelector('header nav a'));
        const home = box(document.querySelector('header a'));
        const nav = document.querySelector('header nav')!;
        return {
          intersects: badge.l < first.r && first.l < badge.r && badge.t < first.b && first.t < badge.b,
          headerH: Math.round(document.querySelector('header')!.getBoundingClientRect().height),
          sameRow: home.t < first.b && first.t < home.b,
          navNeed: Math.round([...nav.children].reduce((sum, el) => sum + el.getBoundingClientRect().width, 0)),
          navWidth: Math.round(nav.getBoundingClientRect().width),
        };
      });
      expect(geom[w].intersects, `ledger badge over the first nav link at ${w}px`).toBe(false);
      expect(geom[w].sameRow, `logo and nav share one row at ${w}px`).toBe(true);
      expect(geom[w].headerH, `header stays one 81px row at ${w}px`).toBe(81);
      expect(geom[w].navNeed, `the nav fits the space left beside the logo at ${w}px`).toBeLessThanOrEqual(geom[w].navWidth);
    }
    test.info().annotations.push({ type: 'note', description: `desktop header geometry: ${JSON.stringify(geom)}` });
    await page.setViewportSize({ width: 360, height: 740 });

    // Step 6 — no body-level horizontal scroll on any page
    const bad = Object.entries(overflow).filter(([, v]) => !v.ok).map(([k, v]) => `${k}: scrollWidth ${v.scrollWidth} > innerWidth ${v.innerWidth}`);
    test.info().annotations.push({ type: 'note', description: `overflow per page: ${JSON.stringify(overflow)}; header items outside the 360px viewport: ${outside.join(', ') || 'none'}` });
    if (bad.length) test.info().annotations.push({ type: 'product-bug', description: `PRODUCT BUG (Header.tsx Nav/NavItem: white-space:nowrap, no flex-wrap): the header nav is ~552px wide and overflows a 360px viewport, so document.documentElement.scrollWidth > window.innerWidth on ${bad.join('; ')}. Landing is unaffected (its own flex-wrap nav).` });
    expect(bad, 'document.documentElement.scrollWidth <= window.innerWidth on every page (header nav overflow is the known defect)').toEqual([]);
  });

});

/* ================================================================== API / read-only scenarios */

test('AZ-086 Refuse to downgrade to an integrity-only attestation during the 15-minute runtime grace period', async ({ page, request }) => {
  await operatorToken(request);   // creates the password when the node has none
  const addr = await nodeAAddress(request);
  const ledgerBefore = (await api<{ info: { records: number } }>(request, '/api/ledger?limit=1')).body.info.records;

  // Step 1 — cookie login
  const login = await api<{ ok: boolean; token: string }>(request, '/api/auth/login', { method: 'POST', data: { password: PASSWORDS[NODE_A] } });
  expect(login.status).toBe(200);
  expect(login.body.ok).toBe(true);
  expect(typeof login.body.token).toBe('string');
  expect(login.headers['set-cookie'] ?? '').toContain('ngram_session=');

  // Steps 2–4, for real, on a private verifier node built from the same binary (name node-a, reads the same public
  // record) whose serving API is a closed port and that already holds the krx-all-2761 body; background verification is
  // off (verifier.auto=false), so the node cannot attest anything on its own — the shared vLLM is never paused.
  const attestsBefore = (await api<PatchDetail>(request, `/api/patches/${K.final}`)).body.attestations.length;
  const vnode = await startThrowawayNode('az086', { name: 'node-az086', stableId: 'az086', roles: 'verifier', ledger: 'ain', set: { 'verifier.auto': 'false' }, maxLifeS: 480 });
  try {
    const vtoken = await vnode.seed(KRX_NPZ, 'az086-seed', { schema: 'krx-ticker-codes', queries: 1, samples: [{ prompt: K.pixelPrompt, expect: K.pixelExpect }] });
    const verify = await api<{ error: string }>(request, `/api/patches/${K.final}/verify`, { method: 'POST', token: vtoken, node: vnode.url });
    expect(verify.status).toBe(500);
    expect(verify.body).toEqual({ error: 'runtime unavailable (serving API unreachable) — waiting up to 15 min before hash-only fallback' });

    await page.goto(`${vnode.url}/${addr}/${K.final}`);
    await page.getByRole('tab', { name: 'Verification' }).click();
    await expect(page.getByText('Run on the real model').locator('xpath=following-sibling::span')).toHaveText('2/2');
    await expect(page.getByText('Integrity only', { exact: true }).locator('xpath=following-sibling::span')).toHaveText('0');
    const rows = page.getByRole('table').first().locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('node-b');
    await expect(rows.nth(1)).toContainText('node-c');
    for (let i = 0; i < 2; i++) { await expect(rows.nth(i)).toContainText('run on the real model'); await expect(rows.nth(i)).toContainText('26/26'); }
    await expect(page.getByText('integrity only', { exact: true })).toHaveCount(0);

    const ev = await api<{ events: { level: string; message: string }[] }>(request, '/api/events?limit=5&kind=verifier', { node: vnode.url });
    expect(ev.body.events[0].level).toBe('info');
    expect(ev.body.events[0].message).toBe(`verifying ${K.final} (KRX ticker codes for 2,761 listed companies (final))`);
    expect((await api<PatchDetail>(request, `/api/patches/${K.final}`)).body.attestations.length, 'no attestation was appended').toBe(attestsBefore);
    const ledgerAfter = (await api<{ info: { records: number } }>(request, '/api/ledger?limit=1')).body.info.records;
    expect(ledgerAfter).toBeGreaterThanOrEqual(ledgerBefore);   // other nodes may append unrelated records meanwhile; ours appended none
  } finally {
    await vnode.stop();
  }
});

test('AZ-088 Keep the operator signed in across refresh and new tabs via the session cookie, and sign out cleanly', async ({ page, context, request }) => {
  await operatorToken(request);   // ensures the password exists (idempotent)
  const pw = PASSWORDS[NODE_A];

  // Step 1
  await page.goto(`${NODE_A}/signing`);
  await expect(h1(page)).toHaveText('Sign in to your node');
  await page.getByLabel('Operator password').fill(pw);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(h1(page)).toHaveText('My knowledge');
  await expect(headerLink(page, 'My knowledge')).toBeVisible();
  await expect(page.getByRole('button', { name: 'node-a ▾' })).toBeVisible();
  await expect(headerLink(page, 'Sign in')).toHaveCount(0);

  // Step 2 — refresh + new tab
  await page.reload();
  await expect(h1(page)).toHaveText('My knowledge');
  await expect(page).toHaveURL(/\/dashboard$/);
  const tab2 = await context.newPage();
  await tab2.goto(`${NODE_A}/account`);
  await expect(tab2.getByRole('heading', { level: 1 })).toHaveText('Account settings');
  await expect(tab2).toHaveURL(/\/account$/);
  await tab2.close();

  // Step 3 — cookie attributes
  const cookie = (await context.cookies(NODE_A)).find((c) => c.name === 'ngram_session');
  expect(cookie).toBeDefined();
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.sameSite).toBe('Lax');
  const days = (cookie!.expires - Date.now() / 1000) / 86400;
  expect(days).toBeGreaterThan(29);
  expect(days).toBeLessThanOrEqual(30.1);
  expect(await page.evaluate(() => document.cookie)).not.toContain('ngram_session');

  // Step 4 — landing redirects a signed-in operator
  await page.goto(`${NODE_A}/`);
  await expect(page).toHaveURL(/\/dashboard$/);

  // Step 5 — log out
  await page.getByRole('button', { name: 'node-a ▾' }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await page.waitForTimeout(2500);   // let any redirect chain settle
  const landed = page.url();
  test.info().annotations.push({ type: 'note', description: `after Log out the browser landed on ${landed}` });
  expect.soft(landed, 'Log out lands on the landing page').toBe(`${NODE_A}/`);
  if (landed === `${NODE_A}/`) await expect.soft(h1(page)).toHaveText('Plug knowledge into your AI');
  await page.goto(`${NODE_A}/dashboard`);
  await expect(page).toHaveURL(`${NODE_A}/signing?next=%2Fdashboard`);
  const me = await (await page.request.get(`${NODE_A}/api/auth/me`)).json() as { signedIn: boolean };
  expect(me.signedIn).toBe(false);

  // Step 6 — next is honoured
  await page.getByLabel('Operator password').fill(pw);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(h1(page)).toHaveText('My knowledge');
});

test('AZ-090 Reflect the model-server outage consistently on Network, Manage and My knowledge', async ({ page, request }) => {
  await operatorToken(request);
  const addr = await nodeAAddress(request);
  await loginViaUi(page);

  // Step 4 — the healthy state on the live node-a (the shared vLLM is never paused by the suite)
  await ensureRuntime(request);
  await page.goto(`${NODE_A}/network`);
  const status = page.getByText('Status', { exact: true }).locator('xpath=following-sibling::dd[1]');
  await expect(status).toHaveText('available — knowledge can be loaded live');
  await expect(page.getByText('Model', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('Qwen3.8-Flash-Next');
  await expect(page.getByText('Live connection', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('connected — load and unload without restart');
  expect(await status.locator('span').first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(68, 164, 95)');   // green dot
  await page.goto(`${NODE_A}/project/${addr}/${K.final}`);
  await expect(page.getByRole('heading', { name: 'Load into / unload from the model' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load into model' })).toBeEnabled();
  await expect(page.getByText('Model runtime unavailable')).toHaveCount(0);
  await page.goto(`${NODE_A}/dashboard`);
  await expect(page.getByRole('heading', { name: 'Purchased knowledge' })).toBeVisible();
  await expect(page.getByText('Model runtime unavailable')).toHaveCount(0);

  // Steps 1–3 — the outage, for real, on a private node built from the same binary + web UI (name node-a) whose serving
  // API is a closed port; it owns one draft (body present) so its manage page has the load/unload section.
  const off = await startThrowawayNode('az090', { name: 'node-az090', stableId: 'az090', roles: 'seller,serving', ledger: 'ain', maxLifeS: 480 });
  try {
    await off.seed(PIXEL_NPZ, 'az090-draft');
    const offAddr = (await api<{ node: { address: string } }>(request, '/api/info', { node: off.url })).body.node.address;
    const rt = await api<{ available: boolean; error?: string; model?: string | null }>(request, '/api/runtime', { node: off.url });
    expect(rt.body.available).toBe(false);
    const reason = rt.body.error ?? '';
    expect(reason).toBe('serving API unreachable');
    await loginViaUi(page, off.url);

    await page.goto(`${off.url}/network`);
    const offStatus = page.getByText('Status', { exact: true }).locator('xpath=following-sibling::dd[1]');
    await expect(offStatus).toHaveText(reason);   // rt.error replaces "available — knowledge can be loaded live"
    expect(await offStatus.locator('span').first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(218, 218, 218)');   // grey dot
    await expect(page.getByText('Live connection', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('not connected');
    await expect(page.getByText('Model', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('—');

    await page.goto(`${off.url}/project/${offAddr}/az090-draft`);
    await expect(page.getByRole('heading', { name: 'Load into / unload from the model' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load into model' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Unload' })).toBeDisabled();
    await expect(page.getByText(`not loaded · Model runtime unavailable: ${reason} — load/unload is disabled for now.`)).toBeVisible();

    await page.goto(`${off.url}/dashboard`);
    await expect(page.getByRole('heading', { name: 'Purchased knowledge' })).toBeVisible();
    await expect(page.getByText(`Model runtime unavailable: ${reason} — load/unload is disabled for now.`)).toBeVisible();
    for (const b of await page.getByRole('button', { name: /^(Load into model|Unload)$/ }).all()) await expect(b).toBeDisabled();
  } finally {
    await off.stop();
  }
});

test('AZ-094 Expose meaningful roles and accessible names to screen readers on the core pages', async ({ page, browser, request }) => {
  await operatorToken(request);
  const addr = await nodeAAddress(request);
  const axe = await loadAxe(request);
  const axeReport: string[] = [];
  const critical: string[] = [];
  /**
   * Frozen backlog of SERIOUS violations the scenario asks to document rather than fix (`<page>: <rule>`). A serious
   * violation on a page/rule pair that is not listed here fails the test, so the debt cannot grow silently while the
   * critical gate stays green. Counts move with the catalog, so only the pair is pinned; the exact numbers are recorded
   * in the annotation below.
   *   color-contrast : the grey-on-white body/meta text of the ainize palette (documented in the scenario itself)
   *   nested-interactive : the /ledger origin map is <svg role="img"> (asserted by step 4) holding <a> node boxes
   */
  const A11Y_BASELINE = new Set([
    '/explore: color-contrast',
    '/chat: color-contrast',
    '/<addr>/krx-all-2761: color-contrast',
    '/ledger: color-contrast',
    '/ledger: nested-interactive',
  ]);
  const newSerious: string[] = [];
  const audit = async (p: Page, name: string) => {
    if (!axe) return;
    const v = await runAxe(p, axe);
    for (const x of v) {
      const line = `${name}: ${x.id} (${x.impact}) x${x.nodes} → ${x.targets.join(' | ')}`;
      if (x.impact === 'critical') critical.push(line);
      if (x.impact === 'critical' || x.impact === 'serious') axeReport.push(line);
      if (x.impact === 'serious' && !A11Y_BASELINE.has(`${name}: ${x.id}`)) newSerious.push(line);
    }
  };

  // Step 1 — Explore header controls (visitor), then the operator menu
  await page.goto(`${NODE_A}/explore`);
  const home = page.getByRole('link', { name: 'Ainize home' });
  await expect(home).toBeVisible();
  await expect(home.locator('img')).toHaveAttribute('alt', 'Ainize');
  await expect(langButton(page)).toHaveAttribute('aria-label', 'language');
  await expect(langButton(page)).toHaveText('한국어');
  const sort = page.getByRole('button', { name: 'Most popular' });
  await expect(sort).toHaveAttribute('aria-haspopup', 'listbox');
  await sort.click();
  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole('option', { name: 'Most popular' })).toHaveAttribute('aria-selected', 'true');
  await expect(listbox.getByRole('option', { name: 'Newest' })).toHaveAttribute('aria-selected', 'false');
  await sort.click();
  await audit(page, '/explore');
  await loginViaUi(page);
  await page.goto(`${NODE_A}/explore`);
  const menuBtn = page.getByRole('button', { name: 'node-a ▾' });
  await expect(menuBtn).toHaveAttribute('aria-haspopup', 'menu');
  await expect(menuBtn).toHaveAttribute('aria-expanded', 'false');
  await menuBtn.click();
  await expect(menuBtn).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['Register a knowledge file', 'Account settings', 'Files & changes', 'Log out']);
  await menuBtn.click();
  await expect(menuBtn).toHaveAttribute('aria-expanded', 'false');

  // Step 2 — Live test as a visitor (fresh context)
  const ctx = await browser.newContext();
  const chat = await ctx.newPage();
  let sawSpinner = false;
  await chat.route('**/api/chat/patches', async (route) => { await sleep(1500); await route.continue(); });
  const spinnerProbe = (async () => {
    for (let i = 0; i < 30 && !sawSpinner; i++) { sawSpinner = (await chat.getByRole('status', { name: 'loading' }).count()) > 0; await sleep(50); }
  })();
  await chat.goto(`${NODE_A}/chat/${K.final}`);
  await spinnerProbe;
  await chat.unroute('**/api/chat/patches');
  expect(sawSpinner, 'spinner exposes role=status aria-label=loading').toBe(true);
  await waitForPicker(chat, 4);
  await expect(chat.locator('aside[aria-label="Knowledge to load (pick up to 3)"]')).toBeVisible();
  const items = chat.locator('aside[aria-label="Knowledge to load (pick up to 3)"] li > label');
  await expect(items).toHaveCount(4);
  await expect(items.filter({ hasText: '(final)' }).getByRole('checkbox')).toBeChecked();
  await expect(items.filter({ hasText: 'epoch 12' }).getByRole('checkbox')).not.toBeChecked();
  const group = chat.getByRole('radiogroup', { name: 'View' });
  await expect(group).toBeVisible();
  await expect(group.getByRole('radio')).toHaveCount(3);
  await expect(group.getByRole('radio', { name: 'Compare' })).toHaveAttribute('aria-checked', 'true');
  await expect(chat.getByRole('textbox', { name: CHAT.placeholderEn })).toBeVisible();
  await expect(chat.locator('section[aria-live="polite"]')).toBeVisible();
  await audit(chat, '/chat');
  await ctx.setOffline(true);
  await sendPrompt(chat, 'x');
  const alert = chat.getByRole('alert');
  await expect(alert).toHaveText(CHAT.networkError);
  await ctx.setOffline(false);
  await ctx.close();

  // Step 3 — tabs + status chip tooltip
  await page.goto(`${NODE_A}/${addr}/${K.final}`);
  const tablist = page.getByRole('tablist');
  await expect(tablist).toBeVisible();
  await expect(tablist.getByRole('tab')).toHaveText(['Overview', 'Verification', 'Origins & derivatives', 'Buy', 'History']);
  await expect(tablist.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  await expect(tablist.getByRole('tab', { name: 'Buy' })).toHaveAttribute('aria-selected', 'false');
  await tablist.getByRole('tab', { name: 'Buy' }).click();
  await expect(tablist.getByRole('tab', { name: 'Buy' })).toHaveAttribute('aria-selected', 'true');
  await tablist.getByRole('tab', { name: 'Overview' }).click();
  // the LISTED chip explains itself as a listing state; "Verified" is the attestation badge and keeps the glossary help
  const chip = page.locator('main').getByText('For sale', { exact: true }).first().locator('xpath=ancestor-or-self::span[@title][1]');
  await expect(chip).toHaveAttribute('title', 'On sale as the current version for this topic. Whether it passed verification is what the "Verified" badge beside it says.');
  await audit(page, '/<addr>/krx-all-2761');

  // Step 4 — ledger map + pagination
  await page.goto(`${NODE_A}/ledger`);
  const svg = page.locator('svg[role="img"]');
  await expect(svg).toHaveAttribute('aria-label', 'knowledge origin and derivative map');
  await expect(page.getByRole('button', { name: 'previous' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'next' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'First', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Last', exact: true })).toBeVisible();
  await audit(page, '/ledger');

  // Step 5 — axe
  test.info().annotations.push({ type: 'note', description: axe ? `axe serious/critical: ${axeReport.length ? axeReport.join(' || ') : 'none'}` : 'axe-core could not be downloaded (no internet) — step 5 not run' });
  test.info().annotations.push({ type: 'note', description: 'Tabs have no arrow-key navigation (role=tab buttons only react to click/Enter) — P2 gap as noted in the scenario.' });
  expect(axe, 'axe-core available').toBeTruthy();
  expect(critical, 'no critical axe violations').toEqual([]);
  expect(newSerious, 'no serious axe violation outside the documented backlog (A11Y_BASELINE)').toEqual([]);
});

test('AZ-095 Format large numbers, sizes and prices consistently (270,053 entries, 331.7 MB, 25 AIN)', async ({ page, request }) => {
  const addr = await nodeAAddress(request);
  const cat = (await api<{ items: CatalogItem[] }>(request, '/api/catalog?sort=popular')).body.items;
  const krx = cat.find((e) => e.anchor.id === K.final)!;
  const pix = cat.find((e) => e.anchor.id === K.pixel)!;
  const detail = (await api<PatchDetail>(request, `/api/patches/${K.final}`)).body;
  const ledger = (await api<{ info: { records: number; height: number } }>(request, '/api/ledger?limit=1')).body.info;
  const AIN_NOTE = 'AIN = AI Network token (this demo runs a local dev chain)';
  const exec = detail.attestations.filter((a) => a.passed && a.verified_on !== 'hash-only');
  const score = exec[exec.length - 1].score.free_generation;   // e.g. "26/26"
  const [hit, tot] = score.split('/').map(Number);
  const pctText = `${Math.round((hit / tot) * 1000) / 10}%`;

  // Step 1 — Explore meta lines and price column ("All versions": the superseded rows are hidden by default)
  await page.goto(`${NODE_A}/explore`);
  await page.getByRole('button', { name: 'All versions', exact: true }).click();
  const krxItem = page.locator(`main a[href$="/${K.final}"]`);
  await expect(krxItem).toContainText(`${numLabel(krx.anchor.benchmark.queries)} facts · ${numLabel(krx.anchor.rows)} memory entries · Size ${bytesLabel(krx.anchor.size_bytes)} · ${numLabel(krx.downloads)} downloads`);
  expect(numLabel(krx.anchor.rows)).toBe('270,053');
  expect(bytesLabel(krx.anchor.size_bytes)).toBe('331.7 MB');
  await expect(krxItem.getByText('25 AIN', { exact: true })).toBeVisible();
  await expect(krxItem.getByText(AIN_NOTE)).toBeVisible();
  const pixItem = page.locator(`main a[href$="/${K.pixel}"]`);
  await expect(pixItem).toContainText(`8 facts · 2,992 memory entries · Size 3.7 MB · ${numLabel(pix.downloads)} downloads`);
  await expect(pixItem.getByText('0.1 AIN', { exact: true })).toBeVisible();
  if (pix.downloads === 1) test.info().annotations.push({ type: 'note', description: "pixelplus-087600 reads '1 downloads' (no singular form) — P2 copy defect (i18n item.downloads)." });

  // Step 2 — stats strip + description line
  await page.goto(`${NODE_A}/${addr}/${K.final}`);
  const stat = (name: string) => page.getByText(name, { exact: true }).first().locator('xpath=preceding-sibling::div[1]');
  const revenueLabel = (r: string | number) => `${Number(r).toLocaleString('en-US', { maximumFractionDigits: 6 })} AIN`; // earned amounts: 0 → "0 AIN", never "Free"
  // Purchases / Revenue are live values other groups can change mid-test: compare against a fresh API read (page polls every 10 s).
  await expect.poll(async () => {
    const fresh = (await api<PatchDetail>(request, `/api/patches/${K.final}`)).body;
    const v = [await stat('Purchases').innerText(), await stat('Revenue').innerText(), numLabel(fresh.downloads), revenueLabel(fresh.revenue)];
    return v[0] === v[2] && v[1] === v[3] ? 'match' : `page ${v[0]} / ${v[1]} vs api ${v[2]} / ${v[3]}`;
  }, { timeout: 40_000, message: 'Purchases / Revenue match the API' }).toBe('match');
  await expect(stat('accuracy')).toHaveText(pctText);
  await expect(page.getByText('accuracy', { exact: true }).first().locator('xpath=following-sibling::div[1]')).toHaveText(score);
  await expect(stat('Memory entries')).toHaveText('270,053');
  await expect(stat('Facts')).toHaveText('2,761');
  await expect(stat('Size')).toHaveText('331.7 MB');
  await expect(stat('Price')).toHaveText('25 AIN');
  // the denominator under the bar is the attestation's own, not the anchor's 2,761 coverage claim
  await expect(page.getByText(`Accuracy ${pctText} on ${tot} of 2,761 questions checked by verifiers`)).toBeVisible();
  // A zero revenue reads '0 AIN' (only prices render 'Free') — the scenario recorded the old 'Free' as a defect; fixed in recordText.ts revenueLabel.
  const zeroRevenue = (await Promise.all(cat.map(async (e) => (await api<PatchDetail>(request, `/api/patches/${e.anchor.id}`)).body))).find((d) => Number(d.revenue) === 0);
  if (zeroRevenue) {
    await page.goto(`${NODE_A}/${addr}/${zeroRevenue.anchor.id}`);
    await expect(stat('Revenue')).toHaveText('0 AIN');
  }

  // Step 3 — Buy tab price
  await page.getByRole('tab', { name: 'Buy' }).click();
  const buyPrice = page.locator('dt').filter({ hasText: /^Price$/ }).locator('xpath=following-sibling::dd[1]');
  await expect(buyPrice).toContainText('25 AIN · pay once per download');
  await expect(buyPrice).toContainText(AIN_NOTE);

  // Step 4 — picker item + header facts
  await page.goto(`${NODE_A}/chat/${K.final}`);
  await waitForPicker(page, 4);
  const item = pickerItems(page).filter({ hasText: '(final)' });
  await expect(item).toContainText('2,761 facts');
  await expect(item).toContainText(`${pctText} accuracy`);
  await expect(item).toContainText('25 AIN');
  await expect(page.locator('section[aria-live="polite"] small').first()).toHaveText('2,761 facts');

  // Step 5 — ledger counts
  await page.goto(`${NODE_A}/ledger`);
  await expect(page.getByText('Records', { exact: true }).locator('xpath=following-sibling::div[1]')).toHaveText(numLabel(ledger.records));
  const height = page.getByText('Blocks recorded', { exact: true }).locator('xpath=following-sibling::div[1]');
  expect(ledger.height).toBeGreaterThan(999);
  await expect(height).toHaveText(/^\d{1,3}(,\d{3})+$/);   // thousands-separated block height
  const shown = Number((await height.innerText()).replace(/,/g, ''));
  const liveHeight = (await api<{ info: { height: number } }>(request, '/api/ledger?limit=1')).body.info.height;   // the dev chain keeps producing blocks
  expect(Math.abs(shown - liveHeight)).toBeLessThanOrEqual(30);

  // Step 6 — Korean keeps en-US grouping
  await page.goto(`${NODE_A}/explore`);
  await langButton(page).click();
  const krxKo = page.locator(`main a[href$="/${K.final}"]`);
  await expect(krxKo).toContainText('기억 항목 270,053개');
  await expect(krxKo).toContainText('사실 2,761건');
  await page.goto(`${NODE_A}/chat/${K.final}`);
  await waitForPicker(page, 4);
  await expect(pickerItems(page).filter({ hasText: '(final)' })).toContainText('25 AIN');
});

test('AZ-096 Read the Terms page and reach the 404 pages from bad URLs', async ({ page, request }) => {
  const addr = await nodeAAddress(request);
  await page.goto(`${NODE_A}/explore`);
  await page.locator('footer').getByRole('link', { name: 'Terms and Policies' }).click();
  await expect(page).toHaveURL(/\/terms$/);
  await expect(h1(page)).toHaveText('Terms and Policies');
  await expect(page.getByText('Last updated: August 31, 2026')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['1. What Ainize is', '2. Terms of use', '3. Privacy policy', '4. Contact']);
  await expect(page.getByRole('heading', { level: 3 })).toHaveText([
    '2.1 Node identity', '2.2 Knowledge is data, not advice', '2.3 Verification is best-effort', '2.4 Payments', '2.5 Prohibited use', '2.6 No warranty',
    '3.1 What a node stores about you', '3.2 Operator console', '3.3 Files and change history', '3.4 Your rights',
  ]);
  const list = page.getByRole('heading', { name: '2.5 Prohibited use' }).locator('xpath=following-sibling::ul[1]');
  expect(await list.locator('li').count()).toBeGreaterThanOrEqual(3);
  await expect(page.getByText('Questions about these terms:')).toBeVisible();
  await expect(page.locator('main').getByRole('link', { name: 'support@ainize.ai' })).toHaveAttribute('href', /^mailto:support@ainize\.ai/);

  // single-segment unknown path
  const shell = await request.get(`${NODE_A}/this-page-does-not-exist`);
  expect(shell.status()).toBe(200);
  await page.goto(`${NODE_A}/this-page-does-not-exist`);
  await expect(h1(page)).toHaveText('404. Page not found');
  await expect(page.getByText("Either something went wrong or the page doesn't exist anymore.")).toBeVisible();
  await expect(page.locator('header')).toBeVisible();
  await expect(page.locator('footer')).toBeVisible();
  await page.getByRole('link', { name: 'Go to Explore →' }).click();
  await expect(page).toHaveURL(/\/explore$/);
  await expect(h1(page)).toHaveText('Explore knowledge');

  // two-segment unknown knowledge
  await page.goto(`${NODE_A}/${addr}/no-such-knowledge`);
  await expect(h1(page)).toHaveText('404. Page not found');
  await expect(page.getByText('This node does not know the knowledge "no-such-knowledge". It may not have propagated yet, or the address is wrong.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Explore →' })).toBeVisible();
  const r = await api<{ error: string }>(request, '/api/patches/no-such-knowledge');
  expect(r.status).toBe(404);
  expect(r.body).toEqual({ error: 'patch not found' });
});

test('AZ-097 Show helpful empty states when a filter, search or section has nothing to display', async ({ page, request }) => {
  const total = (await api<{ total: number }>(request, '/api/catalog')).body.total;
  const ledgerInfo = (await api<{ info: { records: number } }>(request, '/api/ledger?limit=1')).body.info;
  const challenge = (await api<{ records: unknown[] }>(request, '/api/ledger?kind=challenge')).body.records.length;
  const routeKR = (await api<{ branch: unknown }>(request, '/api/route?jurisdiction=KR')).body.branch;

  // Step 1 — search miss
  await page.goto(`${NODE_A}/explore`);
  const search = page.getByPlaceholder('Search by name or description');
  await search.fill('zzzz');
  await expect(page.getByText('0 knowledge')).toBeVisible();
  const empty = page.getByText('No knowledge matches. Try another model, topic or search term.');
  await expect(empty).toBeVisible();
  expect(await empty.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed');
  await expect(page.getByRole('status', { name: 'loading' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'First', exact: true })).toHaveCount(0);

  // Step 2 — chips bring the list back (Explore opens on "Current only", so the count is the current ones)
  const current = (await api<{ total: number }>(request, '/api/catalog?status=LISTED,ANNOUNCED,VERIFYING,CHALLENGED')).body.total;
  await search.fill('');
  await page.getByRole('button', { name: 'krx-ticker-codes', exact: true }).click();
  await page.getByRole('button', { name: 'Qwen3.8-Flash-Next', exact: true }).click();
  await expect(page.getByText(`${numLabel(current)} knowledge`)).toBeVisible();
  await expect(page.getByText('1 / 1')).toBeVisible();
  await page.getByRole('button', { name: 'All versions', exact: true }).click();
  await expect(page.getByText(`${numLabel(total)} knowledge`)).toBeVisible();

  // Step 3 — ledger kind without records
  await page.goto(`${NODE_A}/ledger`);
  await expect(page.getByText('Records', { exact: true }).locator('xpath=following-sibling::div[1]')).toHaveText(numLabel(ledgerInfo.records));
  const kindBtn = page.getByRole('button', { name: 'All records' });
  await kindBtn.click();
  expect(challenge, "no 'challenge' record on the ledger (precondition)").toBe(0);
  await page.getByRole('option', { name: 'Re-verification request' }).click();
  await expect(page.getByText('No "Re-verification request" records yet.')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await page.getByRole('button', { name: 'Re-verification request' }).click();
  await page.getByRole('option', { name: 'All records' }).click();
  await expect(page.getByRole('table').first().locator('tbody tr')).toHaveCount(Math.min(20, ledgerInfo.records));

  // Step 4 — tracks table + router miss
  await page.goto(`${NODE_A}/network`);
  const tracks = page.getByRole('heading', { name: 'Knowledge tracks' }).locator('xpath=following::table[1]');
  await expect(tracks).toContainText('finance/KRX-latest');
  await expect(tracks).toContainText('finance/KRX-history');
  await expect(page.getByText('No tracks yet.')).toHaveCount(0);
  expect(routeKR, 'no track matches jurisdiction=KR (precondition)').toBeNull();
  await expect(page.getByPlaceholder('jurisdiction')).toHaveValue('jurisdiction');
  await expect(page.getByPlaceholder('KR')).toHaveValue('KR');
  await page.getByRole('button', { name: 'Find nodes' }).click();
  await expect(page.getByText('No track matches jurisdiction=KR.')).toBeVisible();

  // Step 5 — empty transcript
  await page.goto(`${NODE_A}/chat/${K.final}`);
  await waitForPicker(page, 4);
  await expect(page.getByText('No questions yet')).toBeVisible();
  await expect(page.getByText('Click a sample question below or type your own. You get two answers side by side: before and after loading the knowledge.')).toBeVisible();
});

test('AZ-098 Display relative times (\'5m ago\') with an absolute-time tooltip that keeps ticking', async ({ page, request }) => {
  test.setTimeout(6 * 60_000);
  const addr = await nodeAAddress(request);
  const detail = (await api<PatchDetail>(request, `/api/patches/${K.final}`)).body;
  type Rec = { ts: number; kind: string; hash: string; sig?: string };
  const fetchRecords = async () => (await api<{ records: Rec[] }>(request, '/api/ledger?limit=1000')).body.records;
  const keyOf = (r: Rec) => (r.sig && r.sig.startsWith('0x') ? r.sig : r.hash).slice(0, 14);
  /** The page re-renders on every poll (≤ 10 s apart): accept the value for "now" or for up to 12 s ago. */
  const fresh = (text: string, ts: number, locale: 'en' | 'ko' = 'en') => text === agoLabel(ts, locale) || text === agoLabel(ts, locale, Date.now() - 20_000);

  // Step 1 — grey line under the status chip
  await page.goto(`${NODE_A}/${addr}/${K.final}`);
  const meta = page.getByText(/^By node-a · target model Qwen3\.8-Flash-Next · verified \d+(s|m|h|d|mo|y) ago/);
  await expect(meta).toBeVisible();
  const metaAgo = /verified (\d+(?:s|m|h|d|mo|y) ago)/.exec(await meta.innerText())![1];
  expect(fresh(metaAgo, detail.listed_at!)).toBe(true);

  // Step 2 — verification Time column + tooltip
  await page.getByRole('tab', { name: 'Verification' }).click();
  const timeCells = page.getByRole('table').first().locator('tbody tr td:last-child');
  await expect(timeCells).toHaveCount(detail.attestations.length);
  for (let i = 0; i < detail.attestations.length; i++) {
    await expect(timeCells.nth(i)).toHaveText(AGO_EN);
    await expect(timeCells.nth(i)).toHaveAttribute('title', DATE_TIME);
    expect(fresh(await timeCells.nth(i).innerText(), detail.attestations[i].created_at)).toBe(true);
  }

  // Step 3 — ledger: newest first, tooltip, ticking (rows are tracked by record id: other nodes keep appending records)
  await page.goto(`${NODE_A}/ledger`);
  const rows = page.getByRole('table').first().locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  let records = await fetchRecords();
  await expect.poll(async () => {
    records = await fetchRecords();
    const newest = records.reduce((a, b) => (b.ts > a.ts ? b : a));
    expect(records[0].ts).toBe(newest.ts);   // API order is newest first
    return (await rows.first().innerText()).includes(keyOf(records[0]));
  }, { timeout: 30_000, message: 'first row is the newest record' }).toBe(true);
  const newestRow = rows.filter({ hasText: keyOf(records[0]) }).first();   // by record id: new records keep arriving from other nodes
  const firstTime = newestRow.locator('td').first();
  await expect(firstTime).toHaveText(AGO_EN);
  await expect(firstTime).toHaveAttribute('title', DATE_TIME);
  const firstText = await firstTime.innerText();
  const firstAge = Math.floor((Date.now() - records[0].ts) / 1000);
  const firstMatch = firstAge < 60
    ? /^(\d+)s ago$/.test(firstText) && Math.abs(Number(/^(\d+)s ago$/.exec(firstText)![1]) - firstAge) <= 5
    : fresh(firstText, records[0].ts);
  expect(firstMatch, `newest record shows a fresh relative time (got "${firstText}", record age ~${firstAge}s)`).toBe(true);
  const idx = records.slice(0, 20).findIndex((r) => /m ago$/.test(agoLabel(r.ts, 'en')));
  const target = records[idx >= 0 ? idx : 0];
  const row = () => rows.filter({ hasText: keyOf(target) }).first();
  const cell = () => row().locator('td').first();
  const before = await cell().innerText();
  const minuteBefore = /^(\d+)m ago$/.exec(before)?.[1];
  await page.waitForTimeout(70_000);
  const after = await cell().innerText();
  expect(fresh(after, target.ts), `row for ${keyOf(target)} re-rendered (before "${before}", after "${after}")`).toBe(true);
  if (minuteBefore !== undefined) {
    const m = /^(\d+)m ago$/.exec(after)?.[1];
    expect(m, 'minute value re-rendered by the 10 s poll').toBeDefined();
    expect(Number(m) - Number(minuteBefore)).toBeGreaterThanOrEqual(1);
    expect(Number(m) - Number(minuteBefore)).toBeLessThanOrEqual(2);
  } else {
    test.info().annotations.push({ type: 'note', description: `no ledger record in the minutes range at test time (tracked row read "${before}" → "${after}") — ticking verified on the Network "Last seen" column instead` });
  }

  // Step 4 — network Last seen refreshes every 15 s (the two DIRECT peers node-b/node-c; the live cluster may also
  // list extra known-from-ledger nodes, which show a static "… (from the record)" time — those are not the peers).
  const peers = (await api<{ peers: { endpoint: string }[] }>(request, '/api/nodes')).body.peers;
  expect(peers.length, 'at least the two seeded direct peers').toBeGreaterThanOrEqual(2);
  await page.goto(`${NODE_A}/network`);
  const peerTable = page.getByRole('heading', { name: 'Connected nodes' }).locator('xpath=following::table[1]');
  const seenFor = (endpoint: string) => peerTable.locator('tbody tr', { hasText: endpoint }).locator('td:last-child');
  const read = async () => Promise.all(peers.map((p) => seenFor(p.endpoint).first().innerText()));
  const s0 = await read();
  for (const x of s0) expect(x, 'direct-peer Last seen is a live relative time').toMatch(/^\d+(s|m) ago$/);
  await page.waitForTimeout(20_000);
  const s1 = await read();
  for (const x of s1) expect(x).toMatch(/^\d+(s|m) ago$/);
  expect(s1.join('|'), 'Last seen refreshed on the 15 s poll').not.toBe(s0.join('|'));

  // Step 5 — Korean units, same absolute tooltip
  await langButton(page).click();
  await page.goto(`${NODE_A}/ledger`);
  const koRows = page.getByRole('table').first().locator('tbody tr');
  await expect(koRows.first()).toBeVisible();
  records = await fetchRecords();
  const koCell = koRows.filter({ hasText: keyOf(records[0]) }).first().locator('td').first();
  await expect(koCell).toHaveText(AGO_KO);                 // Korean units (분/시간/일 전)
  await expect(koCell).toHaveAttribute('title', DATE_TIME); // same absolute tooltip format as English
  const koText = await koCell.innerText();
  const koAge = Math.floor((Date.now() - records[0].ts) / 1000);   // seconds ticks fast: compare within a small band
  const koMatch = koAge < 60
    ? /^(\d+)초 전$/.test(koText) && Math.abs(Number(/^(\d+)초 전$/.exec(koText)![1]) - koAge) <= 5
    : fresh(koText, records[0].ts, 'ko');
  expect(koMatch, `ko relative time is fresh (got "${koText}", record age ~${koAge}s)`).toBe(true);
});

test('AZ-099 Verify what happens to scroll position and filters on browser Back from a detail page', async ({ page, request }) => {
  const addr = await nodeAAddress(request);
  const items = (await api<{ items: CatalogItem[] }>(request, '/api/catalog?sort=popular')).body.items;

  // Step 1/2 — ledger, kind Verification, map box → detail at the top
  await page.goto(`${NODE_A}/ledger`);
  await page.getByRole('button', { name: 'All records' }).click();
  await page.getByRole('option', { name: 'Verification', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Verification', exact: true })).toBeVisible();
  const graphTitle = page.getByRole('heading', { name: 'Origin → derivative map' });
  await graphTitle.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.locator(`svg a[href$="/${K.final}"]`).click();
  await expect(page).toHaveURL(`${NODE_A}/${addr}/${K.final}`);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // Step 3/4 — History tab, scroll, Back, Forward
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.goBack();
  await expect(page).toHaveURL(`${NODE_A}/ledger`);
  await expect(h1(page)).toHaveText('Public record');
  await page.waitForTimeout(500);
  const backY = await page.evaluate(() => window.scrollY);
  test.info().annotations.push({ type: 'note', description: `scrollY after Back on /ledger: ${backY}` });
  expect.soft(backY, 'ledger reopens scrolled to the top after Back').toBe(0);
  await expect(page.getByRole('button', { name: 'All records' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(`${NODE_A}/${addr}/${K.final}`);
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByRole('alert')).toHaveCount(0);
  test.info().annotations.push({ type: 'note', description: 'Back resets the ledger to the top with "All records", Forward reopens the detail on Overview (no position/filter/tab restoration) — P2 UX finding, as described in the scenario.' });

  // Step 5 — explore: last item, open, Back (the last "popular" item is superseded → show all versions first)
  await page.goto(`${NODE_A}/explore`);
  await page.getByRole('button', { name: 'All versions', exact: true }).click();
  const last = items[items.length - 1];
  const lastItem = page.locator(`main a[href$="/${last.anchor.id}"]`);
  await lastItem.scrollIntoViewIfNeeded();
  await lastItem.click();
  await expect(page).toHaveURL(`${NODE_A}/${addr}/${last.anchor.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(last.anchor.name);
  await page.goBack();
  await expect(page).toHaveURL(`${NODE_A}/explore`);
  // Back reopens Explore in its default view — the "Show" choice is component state, like the sort and the chips
  await expect(page.getByRole('button', { name: 'Current only', exact: true })).toHaveCSS('border-color', 'rgb(139, 62, 235)');
  await page.getByRole('button', { name: 'All versions', exact: true }).click();
  await expect(page.locator('main a', { hasText: 'node-a /' })).toHaveCount(items.length);
  await expect(page.getByRole('status', { name: 'loading' })).toHaveCount(0);
  await page.waitForTimeout(500);
  const exploreY = await page.evaluate(() => window.scrollY);
  test.info().annotations.push({ type: 'note', description: `scrollY after Back on /explore: ${exploreY}` });
  expect.soft(exploreY, 'explore reopens at the top after Back').toBe(0);
  await expect(page.getByRole('button', { name: 'Most popular' })).toBeVisible();
  await expect(page.getByText('1 / 1')).toBeVisible();
});

test('AZ-100 Degrade gracefully when clipboard copy is unavailable or denied', async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: NODE_A });
  const addr = await nodeAAddress(request);
  const detail = (await api<{ anchor: { patch_sha256: string } }>(request, `/api/patches/${K.final}`)).body;
  const me = (await api<{ address: string }>(request, '/api/auth/me')).body;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // Step 1 — Copy → Copied → Copy
  await page.goto(`${NODE_A}/${addr}/${K.final}`);
  const hashRow = page.getByText('Content hash', { exact: false }).locator('xpath=ancestor-or-self::div[1]');
  const copy = hashRow.getByRole('button', { name: 'Copy', exact: true });
  await copy.click();
  await expect(hashRow.getByRole('button', { name: 'Copied', exact: true })).toBeVisible({ timeout: 1000 });
  await expect(hashRow.getByRole('button', { name: 'Copy', exact: true })).toBeVisible({ timeout: 2500 });

  // Step 2 — clipboard holds the sha256; paste it into the Explore search box
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toMatch(/^[0-9a-f]{64}$/);
  expect(clip).toBe(detail.anchor.patch_sha256);
  expect(clip.startsWith('57c9346349afd6fa')).toBe(true);
  await page.goto(`${NODE_A}/explore`);
  const search = page.getByPlaceholder('Search by name or description');
  await search.click();
  await page.keyboard.press('ControlOrMeta+V');
  await expect(search).toHaveValue(detail.anchor.patch_sha256);
  await search.fill('');

  // Step 3/4 — clipboard removed: silent no-op, no crash
  await page.goto(`${NODE_A}/${addr}/${K.final}`);
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); });
  await hashRow.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.waitForTimeout(800);
  await expect(hashRow.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
  await expect(hashRow.getByRole('button', { name: 'Copied', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Verification' }).click();
  await expect(page.getByRole('tab', { name: 'Verification' })).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);

  // Step 5 — sign-in page address copy, with and without the override
  await page.goto(`${NODE_A}/signing`);
  const addrRow = page.getByText('Account address', { exact: true }).locator('xpath=following::dd[1]');
  await addrRow.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(addrRow.getByRole('button', { name: 'Copied', exact: true })).toBeVisible({ timeout: 1000 });
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(me.address);
  await expect(addrRow.getByRole('button', { name: 'Copy', exact: true })).toBeVisible({ timeout: 2500 });
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); });
  await addrRow.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.waitForTimeout(800);
  await expect(addrRow.getByRole('button', { name: 'Copied', exact: true })).toHaveCount(0);
  await expect(addrRow.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
  expect(errors).toEqual([]);

  // Step 6 (optional) — insecure (non-localhost) origin: navigator.clipboard is undefined by the platform
  const lan = await visitorOrigin();
  if (lan !== NODE_A) {
    await page.goto(`${lan}/${addr}/${K.final}`);
    expect(await page.evaluate(() => typeof navigator.clipboard)).toBe('undefined');
    await hashRow.getByRole('button', { name: 'Copy', exact: true }).click();
    await page.waitForTimeout(800);
    await expect(hashRow.getByRole('button', { name: 'Copied', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible();
    expect(errors).toEqual([]);
  } else {
    test.info().annotations.push({ type: 'note', description: 'no non-localhost address reachable — optional insecure-context step not run' });
  }
  test.info().annotations.push({ type: 'note', description: 'CopyButton swallows clipboard failures silently (label stays "Copy", no feedback) — P2 UX finding, as described in the scenario.' });
});
