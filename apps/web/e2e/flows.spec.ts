import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e-admin@example.test');
  await page.getByLabel('Password').fill('E2ePassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good to see you, Erin/ })).toBeVisible();
}

test('signs in with branding applied and signs out', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in to E2E Workspace' })).toBeVisible();
  await page.getByLabel('Email').fill('e2e-admin@example.test');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Email or password is incorrect');
  await signIn(page);
  await expect(page).toHaveTitle(/E2E Workspace/);
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
});

test('creates a custom field and uses it on a new contact', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/fields');
  await page.getByRole('button', { name: 'New field' }).click();
  await page.getByLabel('Label').fill('Preferred language');
  await page.getByLabel('Type').selectOption('select');
  for (const opt of ['English', 'Spanish']) {
    await page.getByPlaceholder('Add an option and press Enter').fill(opt);
    await page.getByPlaceholder('Add an option and press Enter').press('Enter');
  }
  await page.getByRole('button', { name: 'Create field' }).click();
  await expect(page.getByText('cf.preferred_language')).toBeVisible();

  await page.goto('/contacts');
  await page.getByRole('button', { name: /New Contact/ }).click();
  await page.getByLabel('First name').fill('Lucia');
  await page.getByLabel('Last name').fill('Playwright');
  await page.getByLabel('Email').fill('lucia@e2e.test');
  await page.getByRole('button', { name: 'Preferred language' }).click();
  await page.getByRole('option', { name: 'Spanish' }).click();
  await page.getByRole('button', { name: 'Create Contact' }).click();
  await expect(page.getByRole('dialog')).toContainText('Spanish');
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Lucia Playwright' })).toBeVisible();
});

test('moves a deal across stages on the board', async ({ page }) => {
  await signIn(page);
  await page.goto('/deals');
  await page.getByRole('button', { name: /New Deal/ }).click();
  await page.getByLabel('Title').fill('Board mover');
  await page.getByRole('button', { name: 'Create Deal' }).click();
  const card = page.getByRole('article').filter({ hasText: 'Board mover' });
  await expect(page.getByRole('listitem', { name: 'Qualified' }).getByText('Board mover')).toBeVisible();

  // Keyboard drag: focus, pick up, move one column right, drop.
  await card.locator('..').focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('listitem', { name: 'Meeting scheduled' }).getByText('Board mover'),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('listitem', { name: 'Meeting scheduled' }).getByText('Board mover'),
  ).toBeVisible();
});
