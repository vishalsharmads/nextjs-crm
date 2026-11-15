import { expect, test } from '@playwright/test';

test('a visitor books a meeting through a public booking page', async ({ page, browser }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e-admin@example.test');
  await page.getByLabel('Password').fill('E2ePassword123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good to see you, Erin/ })).toBeVisible();
  const slug = `e2e-book-${Date.now()}`;
  const allDay = [['00:00', '23:59']];
  await page.evaluate(
    async ({ slug, allDay }) => {
      await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' });
      const token = decodeURIComponent(/(?:^|; )csrf_token=([^;]*)/.exec(document.cookie)?.[1] ?? '');
      const res = await fetch('/api/v1/me/booking-page', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({
          slug,
          title: 'Book a call with Erin',
          timeZone: 'UTC',
          hours: {
            sun: allDay,
            mon: allDay,
            tue: allDay,
            wed: allDay,
            thu: allDay,
            fri: allDay,
            sat: allDay,
          },
          meetingTypes: [
            { key: 'intro', name: 'Intro call', durationMin: 30, noticeHours: 1, horizonDays: 7 },
          ],
        }),
      });
      if (!res.ok) throw new Error(await res.text());
    },
    { slug, allDay },
  );

  // A visitor without an account.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/book/${slug}`);
  await expect(visitor.getByRole('heading', { name: 'Book a call with Erin' })).toBeVisible();
  await visitor.getByRole('region', { name: 'Times' }).getByRole('button').nth(3).click();
  await visitor.getByLabel('Your name').fill('Petra Visitor');
  await visitor.getByLabel('Email').fill(`petra-${Date.now()}@example.test`);
  await visitor.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(visitor.getByRole('heading', { name: 'You are booked' })).toBeVisible();
});
