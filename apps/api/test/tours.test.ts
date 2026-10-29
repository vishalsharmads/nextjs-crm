import { describe, expect, it } from 'vitest';
import { clientWithRoles } from './helpers';
import { db } from '../src/db/knex';

describe('guided tour progress', () => {
  it('remembers finished tours per person, once each, audited', async () => {
    const { client, user } = await clientWithRoles(['admin']);
    expect((await client.get('/me').expect(200)).body.toursSeen).toEqual([]);
    await client.post('/me/tours/welcome/seen').expect(204);
    await client.post('/me/tours/welcome/seen').expect(204);
    await client.post('/me/tours/pipeline/seen').expect(204);
    expect((await client.get('/me').expect(200)).body.toursSeen).toEqual(['welcome', 'pipeline']);
    await client.post('/me/tours/Bad%20Id/seen').expect(422);
    expect(await db('audit_logs').where({ action: 'user.tour_seen', entity_id: user.id })).toHaveLength(3);
  });
});
