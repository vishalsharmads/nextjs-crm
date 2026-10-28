import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e-admin@example.test');
  await page.getByLabel('Password').fill('E2ePassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good to see you, Erin/ })).toBeVisible();
}

test('an admin creates an object and its records', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/objects');
  await page.getByRole('button', { name: 'New object' }).click();
  const dialog = page.getByRole('dialog', { name: 'New object' });
  await dialog.getByLabel('Singular name').fill('Vessel');
  await dialog.getByLabel('Plural name').fill('Vessels');
  await expect(dialog.getByLabel('Key')).toHaveValue('vessel');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Created')).toBeVisible();

  await page.getByRole('link', { name: 'Vessels' }).first().click();
  await expect(page).toHaveURL(/\/o\/vessel$/);
  await page.getByRole('button', { name: 'New Vessel' }).first().click();
  await page.getByLabel('Name').fill('Sea Breeze');
  await page.getByRole('button', { name: 'Create Vessel' }).click();
  await expect(page.getByRole('dialog', { name: 'Sea Breeze' })).toBeVisible();
});
