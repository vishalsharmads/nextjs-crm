import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e-admin@example.test');
  await page.getByLabel('Password').fill('E2ePassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good to see you, Erin/ })).toBeVisible();
}

test('a module record type gets list, form, detail and search pages', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/modules');
  // The marketplace lists turned-on modules under Turned on and the rest under Available.
  const toggle = page.getByRole('switch', { name: 'Sample records turned on' });
  await page.getByRole('tab', { name: /Turned on/ }).click();
  if (!(await toggle.count())) {
    await page.getByRole('tab', { name: /Available/ }).click();
    await toggle.click();
    await page.getByRole('tab', { name: /Turned on/ }).click();
  }
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // The module has only record types, so it opens on the first one.
  await page.goto('/m/records-demo');
  await expect(page).toHaveURL(/\/m\/records-demo\/items$/);
  await page.getByRole('button', { name: 'New Item' }).first().click();
  await page.getByLabel('Name').fill('Playwright forklift');
  await page.getByLabel('Value').fill('2500');
  await page.getByRole('button', { name: 'Create Item' }).click();

  const peek = page.getByRole('dialog', { name: 'Playwright forklift' });
  await expect(peek).toContainText('2,500');
  await peek.getByRole('button', { name: 'Open full page' }).click();
  await expect(page).toHaveURL(/\/m\/records-demo\/items\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Playwright forklift', level: 1 })).toBeVisible();

  await page.goto('/m/records-demo/items');
  await expect(page.getByRole('link', { name: 'Playwright forklift' })).toBeVisible();

  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search or jump to…').fill('Playwright forklift');
  await page.getByRole('option', { name: /^Playwright forklift/ }).click();
  await expect(page.getByRole('heading', { name: 'Playwright forklift', level: 1 })).toBeVisible();
});
