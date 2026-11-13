import { describe, expect, it } from 'vitest';
import { clientWithRoles, createUser, loginAs } from './helpers';
import { db } from '../src/db/knex';

async function notes(userId: number) {
  return db('notifications').where({ user_id: userId }).orderBy('id').select('type', 'link');
}

describe('activity comments', () => {
  it('comments, mentions only people who can see the task, and keeps edits to the author', async () => {
    const { client: admin, user: adminUser } = await clientWithRoles(['admin']);
    const rep = await createUser({ roleKeys: ['sales_rep'] });
    const outsider = await createUser({ roleKeys: ['sales_rep'] });
    const task = await admin
      .post('/activities', { type: 'task', subject: 'Prepare proposal', assigneeUuid: rep.uuid })
      .expect(201);
    const url = `/activities/${task.body.uuid}/comments`;

    const posted = await admin
      .post(url, {
        body: '<p>Can you check this?</p><script>x</script>',
        mentions: [rep.uuid, outsider.uuid],
      })
      .expect(201);
    expect(posted.body.body).toBe('<p>Can you check this?</p>');
    expect(posted.body.canEdit).toBe(true);
    // The outsider's own scope cannot see the task, so they are not mentioned.
    expect(posted.body.mentions.map((m: { uuid: string }) => m.uuid)).toEqual([rep.uuid]);
    expect((await notes(rep.id)).map((n) => n.type)).toContain('activity.mentioned');
    expect((await notes(outsider.id)).some((n) => n.type === 'activity.mentioned')).toBe(false);
    expect((await notes(rep.id)).find((n) => n.type === 'activity.mentioned')?.link).toBe(
      `/tasks/${task.body.uuid}`,
    );

    const repClient = await loginAs(rep);
    const list = await repClient.get(url).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].canEdit).toBe(false);
    // Only the author edits or deletes.
    expect((await repClient.patch(`/activities/comments/${posted.body.uuid}`, { body: 'x' })).status).toBe(
      403,
    );
    const reply = await repClient.post(url, { body: 'Done, looks good' }).expect(201);
    // The creator hears about replies on their task.
    expect((await notes(adminUser.id)).map((n) => n.type)).toContain('activity.commented');

    // Outside scope the task and its comments do not exist.
    const out = await loginAs(outsider);
    expect((await out.get(url)).status).toBe(404);
    expect((await out.post(url, { body: 'hi' })).status).toBe(404);

    const edited = await repClient
      .patch(`/activities/comments/${reply.body.uuid}`, { body: 'Done' })
      .expect(200);
    expect(edited.body.editedAt).not.toBeNull();
    await repClient.delete(`/activities/comments/${reply.body.uuid}`).expect(204);
    expect((await admin.get(url)).body.data).toHaveLength(1);
    const logged = await db('audit_logs')
      .where({ entity: 'activity', entity_uuid: task.body.uuid })
      .where('action', 'like', 'activity.comment%')
      .pluck('action');
    expect(logged).toEqual(expect.arrayContaining(['activity.comment_added', 'activity.comment_deleted']));
  });

  it('removes comments when the person the task is about is erased', async () => {
    const { client } = await clientWithRoles(['admin']);
    const c = await client.post('/contacts', { firstName: 'Erase', lastName: 'Me' }).expect(201);
    const task = await client
      .post('/activities', { type: 'task', subject: 'Call', related: { type: 'contact', uuid: c.body.uuid } })
      .expect(201);
    await client.post(`/activities/${task.body.uuid}/comments`, { body: 'About Erase Me' }).expect(201);
    await client.post(`/activities/${task.body.uuid}/checklist`, { label: 'Call Erase Me' }).expect(201);
    const id = (await db('activities').where({ uuid: task.body.uuid }).first('id')).id;
    const count = async () =>
      Number((await db('activity_comments').where({ activity_id: id }).count('* as n').first())?.n);
    expect(await count()).toBe(1);
    await client.post(`/privacy/contact/${c.body.uuid}/anonymize`).expect(200);
    expect(await count()).toBe(0);
    expect(await db('activity_checklist_items').where({ activity_id: id }).first()).toBeUndefined();
  });
});
