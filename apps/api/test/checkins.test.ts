import { beforeAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, takeMail, type Client } from './helpers';

const V = '/m/coworking-checkins/visits';

describe('front desk check-ins', () => {
  let desk: Client;
  beforeAll(async () => {
    ({ client: desk } = await clientWithRoles(['admin']));
    await desk.post('/modules/coworking-checkins/enable').expect(200);
  });

  it('checks members in once, emails hosts when guests arrive, and checks out', async () => {
    const member = await desk
      .post('/contacts', { firstName: 'Mia', email: 'mia.member@example.test' })
      .expect(201);
    const visit = await desk
      .post(V, { kind: 'member', contactUuid: member.body.uuid, badge: 'B-12' })
      .expect(201);
    expect(visit.body).toMatchObject({ kind: 'member', member: { uuid: member.body.uuid }, badge: 'B-12' });
    expect((await desk.post(V, { kind: 'member', contactUuid: member.body.uuid })).status).toBe(409);

    takeMail();
    const guest = await desk
      .post(V, {
        kind: 'visitor',
        visitorName: 'Gus <b>Guest</b>',
        visitorCompany: 'Acme',
        hostUuid: member.body.uuid,
      })
      .expect(201);
    expect(guest.body).toMatchObject({
      kind: 'visitor',
      host: { uuid: member.body.uuid },
      hostNotified: true,
    });
    const mail = takeMail().find((m) => m.to === 'mia.member@example.test');
    expect(mail?.subject).toContain('has arrived');
    expect(mail?.html).not.toContain('<b>');

    const inNow = await desk.get(`${V}?scope=in`).expect(200);
    expect(inNow.body.data.map((v: { uuid: string }) => v.uuid)).toEqual(
      expect.arrayContaining([visit.body.uuid, guest.body.uuid]),
    );
    await desk.post(`${V}/${guest.body.uuid}/check-out`).expect(200);
    expect((await desk.post(`${V}/${guest.body.uuid}/check-out`)).status).toBe(409);
    const today = await desk.get(`${V}?scope=today`).expect(200);
    expect(
      today.body.data.some(
        (v: { uuid: string; checkedOutAt: string | null }) => v.uuid === guest.body.uuid && v.checkedOutAt,
      ),
    ).toBe(true);
    const widget = await desk.get('/dashboards/widgets/module:coworking-checkins.today/data').expect(200);
    expect(widget.body.members).toBeGreaterThanOrEqual(1);
  });

  it('lets viewers see who is in without checking anyone in', async () => {
    const role = await createRole(['coworking-checkins.checkins.view']);
    const { client } = await clientWithRoles([role]);
    await client.get(V).expect(200);
    expect((await client.post(V, { kind: 'visitor', visitorName: 'X' })).status).toBe(403);
  });
});
