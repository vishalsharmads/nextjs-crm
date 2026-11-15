import { describe, expect, it } from 'vitest';
import { clientWithRoles, createUser } from './helpers';
import { db } from '../src/db/knex';
import { threadFor } from '../src/core/email/email';
import { newUuid } from '../src/lib/ids';

describe('activity participants and email threads', () => {
  it('shows a meeting on every participant, and only accepts records the writer can see', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const a = await admin.post('/contacts', { firstName: 'Pia', lastName: `One${Date.now()}` }).expect(201);
    const b = await admin.post('/contacts', { firstName: 'Bo', lastName: `Two${Date.now()}` }).expect(201);
    const org = await admin.post('/organizations', { name: `Part Org ${Date.now()}` }).expect(201);
    const colleague = await createUser({ roleKeys: ['sales_rep'] });
    const meeting = await admin
      .post('/activities', {
        type: 'meeting',
        subject: 'Kick-off',
        startAt: new Date(Date.now() + 86_400_000).toISOString(),
        related: { type: 'contact', uuid: a.body.uuid },
        participants: [
          { kind: 'contact', uuid: b.body.uuid },
          { kind: 'organization', uuid: org.body.uuid },
          { kind: 'user', uuid: colleague.uuid, role: 'attendee' },
        ],
      })
      .expect(201);
    expect(meeting.body.participants.map((p: { uuid: string }) => p.uuid).sort()).toEqual(
      [b.body.uuid, org.body.uuid, colleague.uuid].sort(),
    );
    for (const [type, uuid] of [
      ['contacts', b.body.uuid],
      ['organizations', org.body.uuid],
    ]) {
      const tl = await admin.get(`/${type}/${uuid}/timeline`).expect(200);
      expect(
        tl.body.data.some((i: { activity?: { uuid: string } }) => i.activity?.uuid === meeting.body.uuid),
      ).toBe(true);
    }
    const forB = await admin.get(`/activities/for?type=contact&uuid=${b.body.uuid}`).expect(200);
    expect(forB.body.data.map((x: { uuid: string }) => x.uuid)).toContain(meeting.body.uuid);

    // Editing the list replaces it; a record outside the writer's scope is refused.
    await admin.patch(`/activities/${meeting.body.uuid}`, { participants: [] }).expect(200);
    const after = await admin.get(`/activities/for?type=contact&uuid=${b.body.uuid}`).expect(200);
    expect(after.body.data.map((x: { uuid: string }) => x.uuid)).not.toContain(meeting.body.uuid);
    const { client: rep } = await clientWithRoles(['sales_rep']);
    await rep
      .post('/activities', {
        type: 'call',
        subject: 'Probe',
        participants: [{ kind: 'contact', uuid: b.body.uuid }],
      })
      .expect(422);
  });

  it('threads replies by header, and by subject between the same people', async () => {
    const t1 = newUuid();
    await db('email_messages').insert({
      uuid: newUuid(),
      thread_id: t1,
      direction: 'outbound',
      message_id: '<first@example.test>',
      from_address: 'me@example.test',
      to_addresses: JSON.stringify(['ann@example.test']),
      subject: 'Proposal',
    });
    expect(
      await threadFor(db, { inReplyTo: '<first@example.test>', subject: 'whatever', addresses: [] }),
    ).toBe(t1);
    expect(await threadFor(db, { subject: 'RE: Fwd: Proposal', addresses: ['ann@example.test'] })).toBe(t1);
    expect(
      await threadFor(db, { subject: 'Re: Proposal', addresses: ['someone.else@example.test'] }),
    ).not.toBe(t1);
  });

  it('logs sent email on every known recipient and groups a conversation in the timeline', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const stamp = Date.now();
    const a = await admin
      .post('/contacts', { firstName: 'Mail', lastName: 'A', email: `a-${stamp}@example.test` })
      .expect(201);
    const b = await admin
      .post('/contacts', { firstName: 'Mail', lastName: 'B', email: `b-${stamp}@example.test` })
      .expect(201);
    await admin
      .post('/email/send', {
        to: [`a-${stamp}@example.test`],
        cc: [`b-${stamp}@example.test`],
        subject: `Quote ${stamp}`,
        body: '<p>Here it is</p>',
      })
      .expect(201);
    await admin
      .post('/email/send', {
        to: [`a-${stamp}@example.test`],
        subject: `Re: Quote ${stamp}`,
        body: '<p>And again</p>',
      })
      .expect(201);
    const tlB = await admin.get(`/contacts/${b.body.uuid}/timeline`).expect(200);
    expect(
      tlB.body.data.some((i: { activity?: { subject: string } }) => i.activity?.subject === `Quote ${stamp}`),
    ).toBe(true);
    const tlA = await admin.get(`/contacts/${a.body.uuid}/timeline`).expect(200);
    const emails = tlA.body.data.filter((i: { activity?: { type: string } }) => i.activity?.type === 'email');
    expect(emails).toHaveLength(1);
    expect(emails[0].activity.thread.count).toBe(2);
    const thread = await admin
      .get(`/email/threads/${emails[0].activity.thread.id}?type=contact&uuid=${a.body.uuid}`)
      .expect(200);
    expect(thread.body.data.map((m: { subject: string }) => m.subject)).toEqual([
      `Quote ${stamp}`,
      `Re: Quote ${stamp}`,
    ]);
  });
});
