import { beforeAll, describe, expect, it } from 'vitest';
import { anonymousClient, clientWithRoles, createRole, takeMail, type Client } from './helpers';
import { db } from '../src/db/knex';

const T = '/m/tickets/tickets';

describe('tickets', () => {
  let admin: Client;
  beforeAll(async () => {
    ({ client: admin } = await clientWithRoles(['admin']));
    for (const k of ['tickets', 'portal']) await admin.post(`/modules/${k}/enable`).expect(200);
  });

  it('sets response targets by priority, records first response, and resolves', async () => {
    const c = await admin
      .post('/contacts', { firstName: 'Tia', email: 'tia.tickets@example.test' })
      .expect(201);
    const t = await admin
      .post(T, {
        subject: 'Wifi down on floor 2',
        priority: 'urgent',
        contactUuid: c.body.uuid,
        assigneeUuid: '@me',
      })
      .expect(201);
    expect(t.body.number).toMatch(/^T-\d{5}$/);
    const created = Date.parse(t.body.createdAt);
    expect(Date.parse(t.body.firstResponseDueAt) - created).toBeCloseTo(4 * 3_600_000, -4);
    expect(Date.parse(t.body.resolveDueAt) - created).toBeCloseTo(24 * 3_600_000, -4);

    // Internal notes do not count as a response; public replies do.
    const note = await admin
      .post(`${T}/${t.body.uuid}/comments`, { body: 'Router rebooting', internal: true })
      .expect(201);
    expect(note.body.firstRespondedAt).toBeNull();
    const reply = await admin
      .post(`${T}/${t.body.uuid}/comments`, { body: 'We are on it', status: 'pending' })
      .expect(201);
    expect(reply.body).toMatchObject({
      status: 'pending',
      comments: [{ internal: true }, { internal: false }],
    });
    expect(reply.body.firstRespondedAt).not.toBeNull();

    // Lowering priority recomputes targets from creation.
    const low = await admin.patch(`${T}/${t.body.uuid}`, { priority: 'low' }).expect(200);
    expect(Date.parse(low.body.resolveDueAt) - created).toBeCloseTo(120 * 3_600_000, -4);
    const done = await admin.patch(`${T}/${t.body.uuid}`, { status: 'resolved' }).expect(200);
    expect(done.body.resolvedAt).not.toBeNull();

    const active = await admin.get(`${T}?status=active&contactUuid=${c.body.uuid}`).expect(200);
    expect(active.body.data).toHaveLength(0);
    const widget = await admin.get('/dashboards/widgets/module:tickets.open_count/data').expect(200);
    expect(widget.body).toHaveProperty('overdue');
  });

  it('flags overdue tickets and lists them', async () => {
    const t = await admin.post(T, { subject: 'Old one', priority: 'high' }).expect(201);
    await db('m_tickets_tickets')
      .where({ uuid: t.body.uuid })
      .update({ first_response_due_at: new Date(Date.now() - 60_000) });
    const one = await admin.get(`${T}/${t.body.uuid}`).expect(200);
    expect(one.body.responseOverdue).toBe(true);
    const overdue = await admin.get(`${T}?overdue=true`).expect(200);
    expect(overdue.body.data.map((x: { uuid: string }) => x.uuid)).toContain(t.body.uuid);
  });

  it('applies record scope by assignee or creator, and notifies new assignees', async () => {
    const role = await createRole(['tickets.tickets.*'], { '*': 'own' });
    const { client: agent, user: agentUser } = await clientWithRoles([role]);
    const theirs = await admin.post(T, { subject: 'Not assigned to the agent' }).expect(201);
    expect((await agent.get(`${T}/${theirs.body.uuid}`)).status).toBe(404);
    expect((await agent.post(`${T}/${theirs.body.uuid}/comments`, { body: 'x' })).status).toBe(404);
    takeMail();
    await admin.patch(`${T}/${theirs.body.uuid}`, { assigneeUuid: agentUser.uuid }).expect(200);
    expect((await agent.get(`${T}/${theirs.body.uuid}`)).status).toBe(200);
    const notes = await db('notifications').where({ user_id: agentUser.id, type: 'ticket.assigned' });
    expect(notes).toHaveLength(1);
    const mine = await agent.post(T, { subject: 'Raised by the agent' }).expect(201);
    expect((await agent.get(`${T}?assignee=none`)).body.data.map((x: { uuid: string }) => x.uuid)).toContain(
      mine.body.uuid,
    );
  });

  it('lets portal customers raise, read and reply to their own tickets without seeing internal notes', async () => {
    const c = await admin
      .post('/contacts', { firstName: 'Pat', email: 'pat.tickets@example.test' })
      .expect(201);
    takeMail();
    await admin.post('/m/portal/accounts', { contactUuid: c.body.uuid }).expect(201);
    const [invite] = takeMail().filter((m) => m.to === 'pat.tickets@example.test');
    const customer = await anonymousClient();
    const token = decodeURIComponent(/token=([^\s&"]+)/.exec(invite!.text)![1]!);
    await customer.post('/public/portal/session', { token }).expect(200);

    const raised = await customer
      .post('/public/portal/tickets', { subject: 'Locker key lost', description: 'Locker 14' })
      .expect(201);
    const staffView = await admin.get(`${T}/${raised.body.uuid}`).expect(200);
    expect(staffView.body).toMatchObject({ channel: 'portal', contact: { uuid: c.body.uuid } });

    await admin
      .post(`${T}/${raised.body.uuid}/comments`, { body: 'Charge them 10', internal: true })
      .expect(201);
    await admin
      .post(`${T}/${raised.body.uuid}/comments`, { body: 'A spare is at the desk', status: 'resolved' })
      .expect(201);
    const seen = await customer.get(`/public/portal/tickets/${raised.body.uuid}`).expect(200);
    expect(seen.body.comments.map((x: { body: string }) => x.body)).toEqual(['A spare is at the desk']);
    expect(JSON.stringify(seen.body)).not.toContain('Charge them');

    // Replying reopens it.
    const replied = await customer
      .post(`/public/portal/tickets/${raised.body.uuid}/replies`, { body: 'Thanks, still missing' })
      .expect(200);
    expect(replied.body.status).toBe('open');

    // Other people's tickets stay invisible.
    const other = await admin.post(T, { subject: 'Someone else' }).expect(201);
    expect((await customer.get(`/public/portal/tickets/${other.body.uuid}`)).status).toBe(404);
    expect(
      (await customer.post(`/public/portal/tickets/${other.body.uuid}/replies`, { body: 'hi' })).status,
    ).toBe(404);
    const list = await customer.get('/public/portal/tickets').expect(200);
    expect(list.body.data.map((x: { uuid: string }) => x.uuid)).toEqual([raised.body.uuid]);
  });
});
