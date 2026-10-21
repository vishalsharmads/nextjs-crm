import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toPatch } from '@app/shared';
import { clientWithRoles } from './helpers';

describe('PATCH keeps fields it was not sent', () => {
  it('toPatch drops defaults', () => {
    const s = toPatch(z.object({ a: z.string().default('x'), b: z.boolean().default(true), c: z.number() }));
    expect(s.parse({ c: 1 })).toEqual({ c: 1 });
  });

  it('one-field edits never reset defaulted fields', async () => {
    const { client, user } = await clientWithRoles(['admin']);
    const c = await client
      .post('/contacts', { firstName: 'Al', lastName: 'Keep', jobTitle: 'x' })
      .expect(201);
    expect(
      (await client.patch(`/contacts/${c.body.uuid}`, { jobTitle: 'y' }).expect(200)).body.lastName,
    ).toBe('Keep');
    const d = await client.post('/deals', { title: 'V', value: 500 }).expect(201);
    expect((await client.patch(`/deals/${d.body.uuid}`, { title: 'V2' }).expect(200)).body.value).toBe(500);
    const a = await client.post('/activities', { type: 'task', subject: 'S', priority: 'high' }).expect(201);
    expect(
      (await client.patch(`/activities/${a.body.uuid}`, { subject: 'S2' }).expect(200)).body.priority,
    ).toBe('high');
    const team = await client.post('/teams', { name: 'Keepers', memberUuids: [user.uuid] }).expect(201);
    await client.patch(`/teams/${team.body.uuid}`, { name: 'Keepers 2' }).expect(200);
    const teams = await client.get('/teams').expect(200);
    const t = teams.body.data.find((x: { uuid: string }) => x.uuid === team.body.uuid);
    expect(t.members?.length ?? t.memberCount).toBe(1);
  });
});
