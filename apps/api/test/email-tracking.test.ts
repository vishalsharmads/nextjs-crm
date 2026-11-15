import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { clientWithRoles, restoreSettingsAfterEach, setSettingsGroup, takeMail } from './helpers';
import { db } from '../src/db/knex';
import { getApp } from './helpers';

restoreSettingsAfterEach(['features', 'compliance']);

describe('email tracking', () => {
  it('counts opens and clicks only when allowed, and never redirects anywhere but the stored links', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const stamp = Date.now();
    const contact = await admin
      .post('/contacts', { firstName: 'Track', email: `track-${stamp}@example.test` })
      .expect(201);
    const send = (subject: string, to = `track-${stamp}@example.test`) =>
      admin
        .post('/email/send', {
          to: [to],
          subject,
          body: '<p>See <a href="https://shop.example.test/offer?a=1&amp;b=2">the offer</a></p>',
          related: { type: 'contact', uuid: contact.body.uuid },
          track: true,
        })
        .expect(201);

    // The workspace has tracking off: nothing is added.
    takeMail();
    await send(`Off ${stamp}`);
    expect(
      (
        await db('email_messages')
          .where({ subject: `Off ${stamp}` })
          .first()
      ).tracking_token,
    ).toBeNull();

    await admin.patch('/settings/features', { emailTracking: true }).expect(200);
    takeMail();
    await send(`On ${stamp}`);
    const mail = takeMail().find((m) => m.subject === `On ${stamp}`)!;
    const msg = await db('email_messages')
      .where({ subject: `On ${stamp}` })
      .first();
    expect(msg.tracking_token).toHaveLength(43);
    expect(mail.html).toContain(`/api/v1/t/o/${msg.tracking_token}.gif`);
    expect(mail.html).not.toContain('https://shop.example.test');
    // The timeline keeps the message as written.
    const activity = await db('activities').where({ id: msg.activity_id }).first('body');
    expect(activity.body).toContain('https://shop.example.test');

    const app = await getApp();
    await request(app)
      .get(`/api/v1/t/o/${msg.tracking_token}.gif`)
      .expect(200)
      .expect('Content-Type', 'image/gif');
    const click = await request(app).get(`/api/v1/t/c/${msg.tracking_token}/0`).expect(302);
    expect(click.headers.location).toBe('https://shop.example.test/offer?a=1&b=2');
    await request(app).get(`/api/v1/t/c/${msg.tracking_token}/5`).expect(404);
    const after = await db('email_messages').where({ id: msg.id }).first();
    expect([after.open_count, after.click_count]).toEqual([1, 1]);
    const list = await admin.get(`/activities/for?type=contact&uuid=${contact.body.uuid}`).expect(200);
    const tracked = list.body.data.find((a: { subject: string }) => a.subject === `On ${stamp}`);
    expect(tracked.tracking).toMatchObject({ opens: 1, clicks: 1 });

    // Someone who opted out of marketing is never tracked.
    await db('contacts').where({ uuid: contact.body.uuid }).update({ marketing_opt_out: true });
    await send(`OptOut ${stamp}`);
    expect(
      (
        await db('email_messages')
          .where({ subject: `OptOut ${stamp}` })
          .first()
      ).tracking_token,
    ).toBeNull();
    await db('contacts').where({ uuid: contact.body.uuid }).update({ marketing_opt_out: false });

    // The privacy profile turns tracking off whatever the workspace says.
    await setSettingsGroup('compliance', { profile: 'privacy' });
    await send(`Privacy ${stamp}`);
    expect(
      (
        await db('email_messages')
          .where({ subject: `Privacy ${stamp}` })
          .first()
      ).tracking_token,
    ).toBeNull();
  });
});
