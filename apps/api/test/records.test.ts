import { describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, createUser, loginAs } from './helpers';
import { db } from '../src/db/knex';

describe('record scope', () => {
  it('own scope cannot read, edit, delete or find other people’s records', async () => {
    const { client: rep1 } = await clientWithRoles(['sales_rep']);
    const { client: rep2 } = await clientWithRoles(['sales_rep']);
    const mine = await rep1
      .post('/contacts', { firstName: 'Owned', lastName: 'ByRepOne', email: 'owned.rep1@example.test' })
      .expect(201);

    expect((await rep2.get(`/contacts/${mine.body.uuid}`)).status).toBe(404);
    expect((await rep2.patch(`/contacts/${mine.body.uuid}`, { firstName: 'Hacked' })).status).toBe(404);
    expect((await rep2.get(`/contacts/${mine.body.uuid}/timeline`)).status).toBe(404);
    const list = await rep2.get('/contacts?q=ByRepOne').expect(200);
    expect(list.body.data).toHaveLength(0);
    const search = await rep2.get('/search?q=ByRepOne').expect(200);
    expect(search.body.data).toHaveLength(0);
    // Sales reps cannot delete at all.
    expect((await rep1.delete(`/contacts/${mine.body.uuid}`)).status).toBe(403);
    expect((await rep1.get(`/contacts/${mine.body.uuid}`)).status).toBe(200);
  });

  it('own scope cannot create records owned by someone else', async () => {
    const other = await createUser({ roleKeys: ['sales_rep'] });
    const { client } = await clientWithRoles(['sales_rep']);
    const res = await client.post('/contacts', { firstName: 'Gift', ownerUuid: other.uuid });
    expect(res.status).toBe(403);
  });

  it('team scope sees teammates’ records but not others', async () => {
    const [teamId] = await db('teams').insert({ uuid: crypto.randomUUID(), name: `Team ${Date.now()}` });
    const role = await createRole(['core.contacts.view', 'core.contacts.create'], {
      'core.contacts': 'team',
    });
    const a = await createUser({ roleKeys: [role], teamIds: [teamId!] });
    const b = await createUser({ roleKeys: [role], teamIds: [teamId!] });
    const outsider = await createUser({ roleKeys: [role] });
    const ca = await loginAs(a);
    const created = await ca.post('/contacts', { firstName: 'Teamwork' }).expect(201);
    expect((await (await loginAs(b)).get(`/contacts/${created.body.uuid}`)).status).toBe(200);
    expect((await (await loginAs(outsider)).get(`/contacts/${created.body.uuid}`)).status).toBe(404);
  });
});

describe('contacts and organizations', () => {
  it('creates, links, filters, soft-deletes and restores', async () => {
    const { client } = await clientWithRoles(['admin']);
    const org = await client
      .post('/organizations', { name: 'Linkable Ltd', website: 'https://www.linkable.test' })
      .expect(201);
    expect(org.body.domain).toBe('linkable.test');
    const c = await client
      .post('/contacts', {
        firstName: 'Lin',
        lastName: 'Kable',
        email: 'Lin@Linkable.test',
        phone: '+44 20 7946 0000',
        organizationUuid: org.body.uuid,
        tags: ['VIP'],
      })
      .expect(201);
    expect(c.body.organizations[0].organization.name).toBe('Linkable Ltd');
    expect(c.body.tags.map((t: { name: string }) => t.name)).toEqual(['VIP']);
    const byOrg = encodeURIComponent(
      JSON.stringify({
        and: [
          { field: 'organization', op: 'eq', value: org.body.uuid },
          { field: 'tags', op: 'in', value: ['vip'] },
        ],
      }),
    );
    const filtered = await client.get(`/contacts?filter=${byOrg}`).expect(200);
    expect(filtered.body.data.map((x: { uuid: string }) => x.uuid)).toEqual([c.body.uuid]);
    expect((await client.get(`/organizations/${org.body.uuid}/contacts`)).body.data).toHaveLength(1);

    await client.delete(`/contacts/${c.body.uuid}`).expect(204);
    expect((await client.get(`/contacts/${c.body.uuid}`)).status).toBe(404);
    const trashed = await client.get('/contacts?trashed=only').expect(200);
    expect(trashed.body.data.some((x: { uuid: string }) => x.uuid === c.body.uuid)).toBe(true);
    await client.post(`/contacts/${c.body.uuid}/restore`).expect(200);
    const timeline = await client.get(`/contacts/${c.body.uuid}/timeline`).expect(200);
    expect(timeline.body.data.map((i: { kind: string }) => i.kind)).toEqual(
      expect.arrayContaining(['created', 'change']),
    );
  });

  it('detects duplicates and merges them, keeping related records', async () => {
    const { client } = await clientWithRoles(['admin']);
    const a = await client
      .post('/contacts', { firstName: 'Dup', lastName: 'Licate', email: 'dup@example.test', tags: ['alpha'] })
      .expect(201);
    const check = await client.post('/contacts/check-duplicates', { email: 'DUP@example.test' }).expect(200);
    expect(check.body.data[0].uuid).toBe(a.body.uuid);
    expect(check.body.data[0].reasons).toContain('Same email');
    const b = await client
      .post('/contacts', {
        firstName: 'Dupe',
        lastName: 'Licate',
        email: 'dup@example.test',
        phone: '+15551234567',
        tags: ['beta'],
      })
      .expect(201);
    const deal = await client
      .post('/deals', { title: 'Follows merge', contactUuid: b.body.uuid })
      .expect(201);
    await client
      .post('/activities', {
        type: 'note',
        body: '<p>Hello</p>',
        related: { type: 'contact', uuid: b.body.uuid },
      })
      .expect(201);

    await client
      .post('/contacts/merge', {
        primaryUuid: a.body.uuid,
        secondaryUuids: [b.body.uuid],
        pick: { first_name: b.body.uuid },
      })
      .expect(200);
    const merged = await client.get(`/contacts/${a.body.uuid}`).expect(200);
    expect(merged.body.firstName).toBe('Dupe');
    expect(merged.body.phone).toBe('+15551234567');
    expect(merged.body.tags.map((t: { name: string }) => t.name).sort()).toEqual(['alpha', 'beta']);
    expect((await client.get(`/contacts/${b.body.uuid}`)).status).toBe(404);
    expect((await client.get(`/deals/${deal.body.uuid}`)).body.contact.uuid).toBe(a.body.uuid);
    const acts = await client.get(`/activities/for?type=contact&uuid=${a.body.uuid}`).expect(200);
    expect(acts.body.data).toHaveLength(1);
    expect((await client.post(`/contacts/${b.body.uuid}/restore`)).status).toBe(409);
  });

  it('sanitizes rich text in activity bodies', async () => {
    const { client } = await clientWithRoles(['admin']);
    const res = await client
      .post('/activities', {
        type: 'note',
        body: '<p onclick="x()">Hi<script>alert(1)</script><a href="javascript:alert(1)">x</a></p>',
      })
      .expect(201);
    expect(res.body.body).not.toMatch(/script|onclick|javascript:/);
    expect(res.body.body).toContain('<p>Hi');
  });
});

describe('deals and pipelines', () => {
  it('creates in the first open stage, moves across stages, and requires a lost reason', async () => {
    const { client } = await clientWithRoles(['admin']);
    const deal = await client.post('/deals', { title: 'Kanban mover', value: 1200 }).expect(201);
    expect(deal.body.stage.key).toBe('qualified');
    expect(deal.body.status).toBe('open');
    expect(deal.body.reference).toMatch(/^\d{5}$/);
    const board = await client.get('/deals/board').expect(200);
    const stages = board.body.columns.map((c: { stage: { uuid: string; key: string } }) => c.stage);
    const won = stages.find((s: { key: string }) => s.key === 'won');
    const lost = stages.find((s: { key: string }) => s.key === 'lost');
    const proposal = stages.find((s: { key: string }) => s.key === 'proposal');

    const moved = await client
      .patch(`/deals/${deal.body.uuid}/stage`, { stageUuid: proposal.uuid })
      .expect(200);
    expect(moved.body.stage.key).toBe('proposal');
    await client.patch(`/deals/${deal.body.uuid}/stage`, { stageUuid: lost.uuid }).expect(422);
    const lostDeal = await client
      .patch(`/deals/${deal.body.uuid}/stage`, { stageUuid: lost.uuid, lostReason: 'Price' })
      .expect(200);
    expect(lostDeal.body.status).toBe('lost');
    expect(lostDeal.body.lostReason).toBe('Price');
    const wonDeal = await client.patch(`/deals/${deal.body.uuid}/stage`, { stageUuid: won.uuid }).expect(200);
    expect(wonDeal.body.status).toBe('won');
    expect(wonDeal.body.lostReason).toBeNull();
    const history = await client.get(`/deals/${deal.body.uuid}/timeline?kinds=stage`).expect(200);
    expect(history.body.data).toHaveLength(4);
  });

  it('orders cards within a column', async () => {
    const { client } = await clientWithRoles(['admin']);
    const a = await client.post('/deals', { title: 'Order A' }).expect(201);
    const b = await client.post('/deals', { title: 'Order B' }).expect(201);
    const moved = await client
      .patch(`/deals/${b.body.uuid}/stage`, { stageUuid: b.body.stage.uuid, afterUuid: a.body.uuid })
      .expect(200);
    expect(moved.body.position).toBeLessThan(a.body.position);
  });

  it('manages pipelines and stages, moving deals when a stage is removed', async () => {
    const { client } = await clientWithRoles(['admin']);
    const p = await client.post('/pipelines', { name: 'Renewals' }).expect(201);
    expect(p.body.stages).toHaveLength(4);
    const withStage = await client
      .post(`/pipelines/${p.body.uuid}/stages`, { name: 'Negotiating', probability: 70 })
      .expect(201);
    const names = withStage.body.stages.map((s: { name: string }) => s.name);
    expect(names.indexOf('Negotiating')).toBeLessThan(names.indexOf('Won'));
    const first = withStage.body.stages[0];
    const deal = await client
      .post('/deals', { title: 'Renewal deal', pipelineUuid: p.body.uuid })
      .expect(201);
    expect(deal.body.pipeline.uuid).toBe(p.body.uuid);
    await client.delete(`/pipelines/${p.body.uuid}/stages/${first.uuid}`).expect(422);
    const target = withStage.body.stages[1];
    await client.delete(`/pipelines/${p.body.uuid}/stages/${first.uuid}?moveTo=${target.uuid}`).expect(200);
    expect((await client.get(`/deals/${deal.body.uuid}`)).body.stage.uuid).toBe(target.uuid);
    await client.post(`/pipelines/${p.body.uuid}/stages`, { name: 'Also won', isWon: true }).expect(422);
  });
});

describe('leads, activities, search, files', () => {
  it('converts a lead into a contact, organization and deal', async () => {
    const { client } = await clientWithRoles(['admin']);
    const lead = await client
      .post('/leads', {
        firstName: 'Lee',
        lastName: 'Convert',
        email: 'lee@convert.test',
        companyName: 'Convertible Inc',
      })
      .expect(201);
    await client
      .post('/activities', {
        type: 'call',
        subject: 'Intro call',
        related: { type: 'lead', uuid: lead.body.uuid },
      })
      .expect(201);
    const res = await client.post(`/leads/${lead.body.uuid}/convert`, { dealValue: 500 }).expect(200);
    expect(res.body.contactUuid).toBeTruthy();
    expect(res.body.organizationUuid).toBeTruthy();
    expect(res.body.dealUuid).toBeTruthy();
    const after = await client.get(`/leads/${lead.body.uuid}`).expect(200);
    expect(after.body.status).toBe('converted');
    const acts = await client.get(`/activities/for?type=contact&uuid=${res.body.contactUuid}`).expect(200);
    expect(acts.body.data[0].subject).toBe('Intro call');
    await client.post(`/leads/${lead.body.uuid}/convert`, {}).expect(409);
  });

  it('completes tasks and lists the calendar', async () => {
    const { client } = await clientWithRoles(['admin']);
    const due = new Date(Date.now() - 3600_000).toISOString();
    const task = await client
      .post('/activities', { type: 'task', subject: 'Overdue task', dueAt: due })
      .expect(201);
    expect(task.body.overdue).toBe(true);
    expect(task.body.assignee).toBeTruthy();
    const done = await client.post(`/activities/${task.body.uuid}/complete`).expect(200);
    expect(done.body.completedAt).toBeTruthy();
    expect(done.body.overdue).toBe(false);
    const from = new Date(Date.now() - 86400_000).toISOString();
    const to = new Date(Date.now() + 86400_000).toISOString();
    const cal = await client
      .get(`/activities/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .expect(200);
    expect(cal.body.data.some((a: { uuid: string }) => a.uuid === task.body.uuid)).toBe(true);
  });

  it('searches across types', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client.post('/organizations', { name: 'Zephyrine Holdings' }).expect(201);
    await client.post('/contacts', { firstName: 'Zephyrine', lastName: 'Okoro' }).expect(201);
    const res = await client.get('/search?q=zephyr').expect(200);
    expect(res.body.data.map((r: { type: string }) => r.type).sort()).toEqual(['contact', 'organization']);
  });

  it('uploads files to a record and serves them through signed links that respect access', async () => {
    const { client } = await clientWithRoles(['sales_rep']);
    const c = await client.post('/contacts', { firstName: 'Filer' }).expect(201);
    const up = await client.agent
      .post('/api/v1/files')
      .set('x-csrf-token', client.csrf)
      .field('entity', 'contact')
      .field('uuid', c.body.uuid)
      .attach('file', Buffer.from('hello world'), 'notes.txt')
      .expect(201);
    expect(up.body.mime).toBe('text/plain');
    const { body: link } = await client.get(`/files/${up.body.uuid}/url`).expect(200);
    const dl = await client.agent.get(link.url).expect(200);
    expect(dl.text).toBe('hello world');
    const { client: other } = await clientWithRoles(['sales_rep']);
    expect((await other.get(`/files/${up.body.uuid}/url`)).status).toBe(404);
    expect((await other.agent.get(link.url)).status).toBe(404);
    const exe = await client.agent
      .post('/api/v1/files')
      .set('x-csrf-token', client.csrf)
      .field('entity', 'contact')
      .field('uuid', c.body.uuid)
      .attach('file', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]), 'invoice.pdf');
    expect(exe.status).toBe(415);
  });
});
