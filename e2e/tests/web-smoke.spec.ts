import { test, expect } from '@playwright/test';
import { NODE_A } from '../helpers/ainize';

test('smoke: landing loads with the English hero and navigation', async ({ page }) => {
  await page.goto(NODE_A + '/');
  await expect(page).toHaveTitle(/Ainize/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/knowledge/i);
  const links = await page.locator('a').allTextContents();
  expect(links.join(' ')).toMatch(/Explore/i);
  await page.screenshot({ path: 'results/smoke-landing.png' });
});
