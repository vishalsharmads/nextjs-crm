import { describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, createUser, loginAs } from './helpers';
import { db } from '../src/db/knex';
import { onEvent } from '../src/core/events/events';

const notes = (userId: number) =>
  db('notifications').where({ user_id: userId }).orderBy('id').select('type', 'link', 'title');

describe('record comments', () => {
  it('comments on a deal, notifies mentions in scope and the owner, keeps edits to the author', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const owner = await createUser({ roleKeys: ['sales_rep'] });
    const outsider = await createUser({ roleKeys: ['sales_rep'] });
    const deal = await admin.post('/deals', { title: 'Harbour fit-out', ownerUuid: owner.uuid }).expect(201);
    const url = `/deals/${deal.body.uuid}/comments`;
    const events: string[] = [];
    onEvent((e) => {
      if (e.uuid === deal.body.uuid) events.push(e.type);
      return Promise.resolve();
    });

    const posted = await admin
      .post(url, { body: '<p>Budget agreed?</p><script>x</script>', mentions: [owner.uuid, outsider.uuid] })
      .expect(201);
    expect(posted.body.body).toBe('<p>Budget agreed?</p>');
    // The outsider (own scope, not the owner) cannot see the deal, so is neither mentioned nor told.
    expect(posted.body.mentions.map((m: { uuid: string }) => m.uuid)).toEqual([owner.uuid]);
    expect((await notes(owner.id)).map((n) => n.type)).toContain('comment.mentioned');
    expect(await notes(outsider.id)).toHaveLength(0);
    expect(events).toContain('comment.created');

    // The owner sees the comment, in the list and on the timeline, but cannot edit it.
    const ownerClient = await loginAs(owner);
    const list = await ownerClient.get(url).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].canEdit).toBe(false);
    const tl = await ownerClient.get(`/deals/${deal.body.uuid}/timeline`).expect(200);
    expect(tl.body.data.some((i: { kind: string }) => i.kind === 'comment')).toBe(true);
    await ownerClient.patch(`${url}/${posted.body.uuid}`, { body: 'changed' }).expect(403);

    // Owner replies: the admin author is not the owner, so nobody else is told; owner is not told about their own.
    await ownerClient.post(url, { body: 'Yes, signed off.' }).expect(201);
    expect((await notes(owner.id)).filter((n) => n.type === 'comment.created')).toHaveLength(0);

    // Out of scope reads are 404.
    const outsiderClient = await loginAs(outsider);
    await outsiderClient.get(url).expect(404);
    await outsiderClient.post(url, { body: 'hi' }).expect(404);

    await admin.patch(`${url}/${posted.body.uuid}`, { body: 'Budget agreed at 40k?' }).expect(200);
    await admin.delete(`${url}/${posted.body.uuid}`).expect(204);
    expect((await admin.get(url).expect(200)).body.data).toHaveLength(1);
  });

  it('needs view permission on the record type', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const org = await admin.post('/organizations', { name: 'Comment Co' }).expect(201);
    const role = await createRole(['core.contacts.view'], { '*': 'all' });
    const { client } = await clientWithRoles([role]);
    await client.get(`/organizations/${org.body.uuid}/comments`).expect(403);
  });

  it('moves comments with a merge, finds them in search, and exports and erases them with the person', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const a = await admin.post('/contacts', { firstName: 'Mira', lastName: 'Kessel' }).expect(201);
    const b = await admin.post('/contacts', { firstName: 'Mira', lastName: 'Kessel' }).expect(201);
    const word = `quokka${Date.now().toString(36)}`;
    await admin.post(`/contacts/${b.body.uuid}/comments`, { body: `Prefers ${word} calls` }).expect(201);
    await admin
      .post('/contacts/merge', { primaryUuid: a.body.uuid, secondaryUuids: [b.body.uuid] })
      .expect(200);
    const after = await admin.get(`/contacts/${a.body.uuid}/comments`).expect(200);
    expect(after.body.data).toHaveLength(1);

    const hits = (await admin.get(`/search?q=${word}&types=contact`).expect(200)).body.data;
    expect(hits.map((h: { uuid: string }) => h.uuid)).toContain(a.body.uuid);

    const row = await db('contacts').where({ uuid: a.body.uuid }).first('id');
    const count = async () =>
      Number(
        (
          (await db('record_comments')
            .where({ entity: 'contact', record_id: row.id })
            .count({ c: '*' })
            .first()) as {
            c: number;
          }
        ).c,
      );
    expect(await count()).toBe(1);
    await admin.post(`/privacy/contact/${a.body.uuid}/anonymize`, {}).expect(200);
    expect(await count()).toBe(0);
  });
});
