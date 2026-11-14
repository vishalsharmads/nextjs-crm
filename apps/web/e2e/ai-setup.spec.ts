import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e-admin@example.test');
  await page.getByLabel('Password').fill('E2ePassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good to see you, Erin/ })).toBeVisible();
}

/** Calls the API as the signed-in admin, with the CSRF header the app sends. */
async function call(page: Page, method: string, path: string, body?: unknown) {
  const status = await page.evaluate(
    async ({ method, path, body }) => {
      await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' });
      const token = decodeURIComponent(/(?:^|; )csrf_token=([^;]*)/.exec(document.cookie)?.[1] ?? '');
      const res = await fetch(`/api/v1${path}`, {
        method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return res.status;
    },
    { method, path, body },
  );
  expect(status).toBeLessThan(300);
}

test('sets up the workspace with AI and checks a spreadsheet before importing it', async ({ page }) => {
  await signIn(page);
  // The simulated provider answers without a real model.
  await call(page, 'POST', '/modules/assistant/enable');
  await call(page, 'PATCH', '/m/assistant/config', { preset: 'simulated' });

  await page.goto('/m/assistant');
  await page.getByRole('link', { name: 'Set up with AI' }).click();
  await page.getByRole('button', { name: 'Start', exact: true }).click();

  await page.getByLabel(/Business name/).fill('Harbour Physio');
  await page.getByRole('button', { name: /Continue to questions/ }).click();
  await expect(page.getByLabel('Your answer')).toBeVisible();
  await page.getByLabel('Your answer').fill('Mostly referrals from doctors');
  await page.getByRole('button', { name: 'Answer' }).click();
  await page.getByRole('button', { name: /write the brief/i }).click();

  await expect(page.getByRole('button', { name: 'Approve the brief' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve the brief' }).click();

  // Keep the shared test workspace's branding and preset as they are.
  await expect(page.getByRole('button', { name: /Build my CRM/ })).toBeVisible();
  for (const name of [/Include .*brand/i, /Include .*preset/i]) {
    const box = page.getByRole('checkbox', { name });
    if (await box.count()) await box.first().uncheck();
  }
  await page.getByRole('button', { name: /Build my CRM/ }).click();
  await expect(page.getByText(/Your CRM is set up|Built, with/).first()).toBeVisible();

  await page.getByLabel('This file holds').selectOption('contact');
  await page.locator('input[type=file]').setInputFiles({
    name: 'patients.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('First name,Last name,Email\nAnn,Lee,ann@example.test\nBob,Ray,not-an-email\n'),
  });
  await expect(page.getByText('2 rows, 3 columns')).toBeVisible();
  await page.getByRole('button', { name: 'Check the file' }).click();
  await expect(page.getByRole('list', { name: 'Check results' })).toContainText('1 new');
  await expect(page.getByRole('list', { name: 'Check results' })).toContainText('1 with problems');

  await page.getByRole('button', { name: /^Import 1/ }).click();
  await expect(page.getByText(/Imported: 1 added/)).toBeVisible();

  // Other tests expect the assistant off.
  await call(page, 'POST', '/modules/assistant/disable');
});
