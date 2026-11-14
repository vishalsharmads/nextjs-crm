import { describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, unique } from './helpers';

interface Hit {
  type: string;
  uuid: string;
  title: string;
  score: number;
  matched?: string;
  url: string | null;
}

describe('global search', () => {
  it('ranks an exact name above partial matches', async () => {
    const { client } = await clientWithRoles(['admin']);
    const word = unique('Quill').replace(/[^A-Za-z]/g, '');
    await client.post('/organizations', { name: `${word} Holdings International` }).expect(201);
    const exact = await client.post('/organizations', { name: word }).expect(201);
    const res = await client.get(`/search?q=${word}&types=organization&limit=10`).expect(200);
    const hits = res.body.data as Hit[];
    expect(hits.length).toBe(2);
    expect(hits[0]!.uuid).toBe(exact.body.uuid);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('finds visible text custom fields and never hidden ones', async () => {
    const { client: admin } = await clientWithRoles(['admin']);
    const role = await createRole(['core.contacts.view'], { '*': 'all' });
    const key = `ref_${Date.now().toString(36)}`;
    const field = await admin
      .post('/custom-fields', {
        entity: 'contact',
        key,
        label: 'Member number',
        type: 'text',
        filterable: true,
        visibility: { default: 'write', roles: { [role]: 'hidden' } },
      })
      .expect(201);
    const code = `MX${Date.now()}`;
    const c = await admin.post('/contacts', { firstName: 'Nora', custom: { [key]: code } }).expect(201);
    const mine = (await admin.get(`/search?q=${code}&types=contact`).expect(200)).body.data as Hit[];
    expect(mine.map((h) => h.uuid)).toContain(c.body.uuid);
    expect(mine.find((h) => h.uuid === c.body.uuid)!.matched).toBe('Member number');
    const { client: viewer } = await clientWithRoles([role]);
    const theirs = (await viewer.get(`/search?q=${code}&types=contact`).expect(200)).body.data as Hit[];
    expect(theirs).toHaveLength(0);
    await admin.patch(`/custom-fields/${field.body.uuid}`, { active: false }).expect(200);
  });

  it('finds notes by their text and links to the record they belong to', async () => {
    const { client } = await clientWithRoles(['admin']);
    const deal = await client.post('/deals', { title: 'Search note deal' }).expect(201);
    const word = `zanzibar${Date.now().toString(36)}`;
    await client
      .post('/activities', {
        type: 'note',
        body: `<p>Client asked about the ${word} renewal</p>`,
        related: { type: 'deal', uuid: deal.body.uuid },
      })
      .expect(201);
    const hits = (await client.get(`/search?q=${word}`).expect(200)).body.data as Hit[];
    const note = hits.find((h) => h.type === 'activity');
    expect(note?.url).toBe(`/deals/${deal.body.uuid}`);
    // Leaving activities out of the types skips them.
    const only = (await client.get(`/search?q=${word}&types=deal`).expect(200)).body.data as Hit[];
    expect(only.some((h) => h.type === 'activity')).toBe(false);
  });

  it('searches text with an email address in it', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client.get(`/search?q=${encodeURIComponent('first-last@example.test')}`).expect(200);
    await client.get(`/search?q=${encodeURIComponent('"exact words" -not (x)')}`).expect(200);
  });
});
