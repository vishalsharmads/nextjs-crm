import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e-admin@example.test');
  await page.getByLabel('Password').fill('E2ePassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good to see you, Erin/ })).toBeVisible();
}

test('finds an integration, turns it on and saves its settings', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/modules');

  await page.getByRole('tab', { name: /Available/ }).click();
  await page.getByLabel('Category').selectOption('integration');
  await page.getByPlaceholder('Search modules').fill('chat');
  await page.getByRole('switch', { name: 'Chat notifications turned on' }).click();
  await expect(page.getByText('Turned on', { exact: true }).first()).toBeVisible();

  await page.getByRole('tab', { name: /Turned on/ }).click();
  await page.getByRole('link', { name: 'Chat notifications details' }).click();
  await expect(page.getByRole('heading', { name: 'Chat notifications', level: 1 })).toBeVisible();
  await expect(page.getByText('Needs settings')).toBeVisible();

  await page.getByLabel(/Incoming webhook address/).fill('https://chat.example.com/hooks/abc');
  await page.getByLabel('What to post').selectOption('deals');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await expect(page.getByLabel(/Incoming webhook address/)).toHaveAttribute(
    'placeholder',
    'Saved. Type to replace it',
  );
  await expect(page.getByText('Needs settings')).toBeHidden();

  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByText('Changed settings')).toBeVisible();

  await page.getByRole('switch', { name: 'Chat notifications turned on' }).click();
  await expect(page.getByText('Turned off. Its data is kept.')).toBeVisible();
});
