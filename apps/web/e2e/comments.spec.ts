import { expect, test } from '@playwright/test';

test('comments on an organization and sees it in the timeline', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e-admin@example.test');
  await page.getByLabel('Password').fill('E2ePassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good to see you, Erin/ })).toBeVisible();

  // Create the record through the API (same session), then open its page.
  const name = `Comment Works ${Date.now()}`;
  const uuid = await page.evaluate(async (orgName) => {
    await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' });
    const csrf = /(?:^|; )csrf_token=([^;]*)/.exec(document.cookie)?.[1] ?? '';
    const res = await fetch('/api/v1/organizations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
      body: JSON.stringify({ name: orgName }),
    });
    return ((await res.json()) as { uuid: string }).uuid;
  }, name);
  await page.goto(`/organizations/${uuid}`);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

  await page.getByRole('tab', { name: 'Comments' }).click();
  await page.getByRole('textbox', { name: 'Comment' }).fill('Renewal call booked for Friday');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByText('Comment added')).toBeVisible();

  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByText('commented')).toBeVisible();
  await expect(page.getByText('Renewal call booked for Friday')).toBeVisible();
});
