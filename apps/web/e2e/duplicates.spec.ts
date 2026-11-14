import { expect, test } from '@playwright/test';

test('finds duplicate contacts and merges them from the queue', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e-admin@example.test');
  await page.getByLabel('Password').fill('E2ePassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good to see you, Erin/ })).toBeVisible();

  const email = `twin-${Date.now()}@example.test`;
  await page.evaluate(async (addr) => {
    await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' });
    const token = decodeURIComponent(/(?:^|; )csrf_token=([^;]*)/.exec(document.cookie)?.[1] ?? '');
    const post = (path: string, body: unknown) =>
      fetch(`/api/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify(body),
      });
    await post('/contacts', { firstName: 'Twin', lastName: 'One', email: addr });
    await post('/contacts', { firstName: 'Twin', lastName: 'Two', email: addr });
  }, email);

  // The create form warns about the match while typing.
  await page.goto('/contacts');
  await page
    .getByRole('button', { name: /New Contact/ })
    .first()
    .click();
  await page.getByLabel('Email').fill(email);
  await expect(page.getByText('This might already exist')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto('/settings/duplicates');
  await page.getByRole('button', { name: 'Scan now' }).click();
  await expect(page.getByText(/Scanned/)).toBeVisible();
  await page.goto('/duplicates');
  const row = page.getByRole('listitem').filter({ hasText: 'Twin One' }).filter({ hasText: 'Twin Two' });
  await row.getByRole('button', { name: 'Keep this' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Merge' }).click();
  await expect(page.getByText('Merged')).toBeVisible();
  await expect(row).toHaveCount(0);
});
