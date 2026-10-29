import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e-admin@example.test');
  await page.getByLabel('Password').fill('E2ePassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good to see you, Erin/ })).toBeVisible();
}

test('page help explains settings from the code, and the knowledge base searches', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Help for this page' }).click();
  const sheet = page.getByRole('dialog', { name: 'Security' });
  // Generated from the settings schema: label, allowed range and default.
  await expect(sheet.getByRole('cell', { name: 'Minimum password length' })).toBeVisible();
  await expect(sheet.getByRole('cell', { name: '8 to 128' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto('/deals');
  // Shortcuts are ignored while typing, so start from the page, not a field.
  await page.getByRole('heading', { name: 'Deals', level: 1 }).click();
  await page.keyboard.press('Shift+?');
  await expect(page.getByRole('dialog', { name: 'Deals' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto('/help');
  await page.getByLabel('Search help').fill('quota');
  await expect(page.getByRole('button', { name: 'Reports' })).toBeVisible();
});
