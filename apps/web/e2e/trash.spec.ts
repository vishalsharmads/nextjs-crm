import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e-admin@example.test');
  await page.getByLabel('Password').fill('E2ePassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good to see you, Erin/ })).toBeVisible();
}

test('creates from the command palette, deletes, then restores from the trash', async ({ page }) => {
  await signIn(page);

  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search or jump to…').fill('new org');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/organizations$/);
  await page.getByLabel('Name').fill('Palette Trash Ltd');
  await page.getByRole('button', { name: 'Create Organization' }).click();
  await page.getByRole('button', { name: 'Open full page' }).click();
  await expect(page.getByRole('heading', { name: 'Palette Trash Ltd', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/organizations$/);
  await expect(page.getByText('Organization deleted')).toBeVisible();

  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search or jump to…').fill('trash');
  await page.keyboard.press('Enter');
  await expect(page).toHaveTitle(/^Trash/);
  await page.getByRole('tab', { name: 'Organizations' }).click();
  await expect(page.getByText('Palette Trash Ltd')).toBeVisible();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('Organization restored')).toBeVisible();
  await expect(page.getByText('No deleted organizations')).toBeVisible();
});
