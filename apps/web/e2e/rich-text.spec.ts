import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e-admin@example.test');
  await page.getByLabel('Password').fill('E2ePassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good to see you, Erin/ })).toBeVisible();
}

test('writes a saved reply with a field, then inserts it into a formatted note', async ({ page }) => {
  await signIn(page);

  await page.goto('/settings/templates');
  await page.getByRole('button', { name: 'New saved reply' }).click();
  const sheet = page.getByRole('dialog', { name: 'New saved reply' });
  await sheet.getByLabel('Name').fill('Visit thanks');
  await sheet.getByLabel('Subject').fill('Thanks for visiting');
  const body = sheet.getByRole('textbox', { name: 'Body' });
  await body.click();
  await page.keyboard.type('Thanks ');
  await page.keyboard.type('{{');
  await expect(page.getByRole('listbox', { name: 'Insert field' })).toBeVisible();
  await page.keyboard.type('first name');
  await page.keyboard.press('Enter');
  await page.keyboard.type(', see you soon.');
  await expect(body.locator('[data-merge-field]').first()).toHaveText(/\{\{(contact|lead)\.firstName\}\}/);
  await sheet.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByText('Template saved')).toBeVisible();

  await page.goto('/contacts');
  await page
    .getByRole('button', { name: /New Contact/ })
    .first()
    .click();
  await page.getByLabel('First name').fill('Nora');
  await page.getByLabel('Last name').fill('Reply');
  await page.getByRole('button', { name: 'Create Contact' }).click();
  await page
    .getByRole('dialog', { name: 'Nora Reply' })
    .getByRole('button', { name: 'Open full page' })
    .click();

  const note = page.getByRole('textbox', { name: 'Details' });
  await note.click();
  // Markdown shortcuts format as you type.
  await page.keyboard.type('**Met** today. ');
  await expect(note.locator('strong')).toHaveText('Met');
  await page.keyboard.type('/visit');
  await expect(page.getByRole('listbox', { name: 'Insert saved reply' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(note).toContainText('Thanks Nora, see you soon.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('Note added')).toBeVisible();
  await expect(page.locator('.rte-prose').filter({ hasText: 'Thanks Nora, see you soon.' })).toBeVisible();
  await expect(page.locator('.rte-prose strong').filter({ hasText: 'Met' }).first()).toBeVisible();
});
