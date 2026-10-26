import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e-admin@example.test');
  await page.getByLabel('Password').fill('E2ePassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good to see you, Erin/ })).toBeVisible();
}

/** Signed-in API calls from the page's session (setup steps that are not under test). */
async function api(page: Page, method: 'get' | 'post' | 'patch', path: string, data?: object) {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf_token')?.value ?? '';
  const res = await page.request[method](`/api/v1${path}`, { data, headers: { 'x-csrf-token': csrf } });
  expect(res.ok(), `${method} ${path}: ${res.status()}`).toBeTruthy();
  return res.json();
}

test('consent from a web form, then export and erase the person', async ({ page }) => {
  await signIn(page);
  await api(page, 'patch', '/settings/compliance', {
    consentPurposes: [
      {
        key: 'newsletter',
        label: 'Newsletter',
        text: 'Send me the monthly newsletter.',
        lawfulBasis: 'consent',
        marketing: true,
      },
    ],
  });
  const form = await api(page, 'post', '/forms', {
    name: 'Newsletter sign-up',
    entity: 'contact',
    fields: [
      { target: 'firstName', label: 'First name', required: true },
      { target: 'email', label: 'Email', required: true },
    ],
    settings: { consentPurposes: [{ key: 'newsletter', required: false }], successMessage: 'Thanks!' },
  });

  // The public form: the box starts unticked and is recorded only when ticked.
  await page.goto(`/f/${form.uuid}`);
  const box = page.getByRole('checkbox', { name: 'Send me the monthly newsletter.' });
  await expect(box).not.toBeChecked();
  await page.getByLabel('First name').fill('Grace');
  await page.getByLabel('Email').fill('grace@e2e.test');
  await box.check();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Thanks!')).toBeVisible();

  const list = await api(page, 'get', '/contacts?q=grace%40e2e.test');
  const uuid = list.data[0].uuid as string;
  await page.goto(`/contacts/${uuid}`);
  await page.getByRole('tab', { name: 'Privacy' }).click();
  await expect(page.getByText('Given', { exact: true })).toBeVisible();
  await expect(page.getByText('“Send me the monthly newsletter.”')).toBeVisible();

  const request = await api(page, 'post', '/privacy/requests', {
    type: 'erasure',
    subjectEntity: 'contact',
    subjectUuid: uuid,
  });
  await page.goto(`/settings/privacy?request=${request.uuid}`);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Grace');

  const download = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Download their data' }).click();
  expect((await download).suggestedFilename()).toMatch(/^personal-data-.*\.zip$/);

  await dialog.getByRole('button', { name: 'Erase personal data' }).click();
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Personal data erased' })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  await page.goto(`/contacts/${uuid}`);
  await expect(page.getByRole('heading', { name: /Anonymized/ })).toBeVisible();
});
