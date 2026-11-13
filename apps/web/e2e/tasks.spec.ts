import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e-admin@example.test');
  await page.getByLabel('Password').fill('E2ePassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good to see you, Erin/ })).toBeVisible();
}

test('adds a repeating task with a checklist, comments, completes it and gets the next one', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/tasks');
  await page.getByLabel('New task').fill('Weekly e2e review');
  await page.getByLabel('Due').fill('2031-01-06T09:00');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('link', { name: 'Weekly e2e review' }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);

  await page.getByLabel('New checklist item').fill('Read the numbers');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Tick Read the numbers' })).toBeVisible();

  await page.getByLabel('Repeat').selectOption('weekly');
  await expect(page.getByText(/Every week\. Completing it creates the next one\./)).toBeVisible();

  await page.getByLabel('Comment', { exact: true }).click();
  await page.keyboard.type('Looks on track');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.getByText('Looks on track')).toBeVisible();

  await page.getByRole('button', { name: 'Complete' }).click();
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();

  await page.goto('/tasks');
  const next = page.getByRole('link', { name: 'Weekly e2e review' });
  await expect(next).toHaveCount(1);
  await next.click();
  await expect(page.getByLabel('Due')).toHaveValue('2031-01-13T09:00');
  await expect(page.getByRole('checkbox', { name: 'Tick Read the numbers' })).not.toBeChecked();
});
