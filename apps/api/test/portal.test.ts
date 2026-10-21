import { beforeAll, describe, expect, it } from 'vitest';
import { anonymousClient, clientWithRoles, createRole, takeMail, type Client } from './helpers';
import { db } from '../src/db/knex';

const P = '/public/portal';
const tokenFrom = (text: string) => decodeURIComponent(/token=([^\s&"]+)/.exec(text)![1]!);

async function signIn(email: string): Promise<Client> {
  takeMail();
  const customer = await anonymousClient();
  await customer.post(`${P}/login`, { email }).expect(200);
  const [mail] = takeMail();
  if (!mail) throw new Error('no login mail');
  await customer.post(`${P}/session`, { token: tokenFrom(mail.text) }).expect(200);
  return customer;
}

describe('client portal', () => {
  let staff: Client;
  beforeAll(async () => {
    ({ client: staff } = await clientWithRoles(['admin']));
    for (const k of ['products', 'quotes', 'invoices', 'contracts', 'portal']) {
      const res = await staff.post(`/modules/${k}/enable`);
      if (res.status !== 200) throw new Error(`enable ${k}: ${JSON.stringify(res.body)}`);
    }
  });

  it('invites by email link, makes links single-use, and never reveals who has access', async () => {
    const c = await staff
      .post('/contacts', { firstName: 'Paula', email: 'paula.portal@example.test' })
      .expect(201);
    takeMail();
    const acc = await staff.post('/m/portal/accounts', { contactUuid: c.body.uuid }).expect(201);
    expect(acc.body).toMatchObject({ status: 'active', email: 'paula.portal@example.test' });
    const [invite] = takeMail();
    expect(invite!.to).toBe('paula.portal@example.test');

    const customer = await anonymousClient();
    expect((await customer.get(`${P}/me`)).status).toBe(401);
    await customer.post(`${P}/session`, { token: tokenFrom(invite!.text) }).expect(200);
    expect((await customer.get(`${P}/me`).expect(200)).body.email).toBe('paula.portal@example.test');
    // The link cannot be used twice.
    const other = await anonymousClient();
    expect((await other.post(`${P}/session`, { token: tokenFrom(invite!.text) })).status).toBe(422);

    // Unknown and known emails get the same answer; only the known one gets mail.
    const anon = await anonymousClient();
    const unknown = await anon.post(`${P}/login`, { email: 'nobody@example.test' }).expect(200);
    expect(takeMail()).toHaveLength(0);
    const known = await anon.post(`${P}/login`, { email: 'PAULA.portal@example.test' }).expect(200);
    expect(known.body).toEqual(unknown.body);
    expect(takeMail()).toHaveLength(1);

    // A portal session is not a staff session, and a staff session is not a portal session.
    expect((await customer.get('/contacts')).status).toBe(401);
    expect((await staff.get(`${P}/me`)).status).toBe(401);
  });

  it("shows only the customer's own sent documents, and organization documents only when allowed", async () => {
    const org = await staff.post('/organizations', { name: 'Portal Org' }).expect(201);
    const c = await staff
      .post('/contacts', {
        firstName: 'Olga',
        email: 'olga.portal@example.test',
        organizationUuid: org.body.uuid,
      })
      .expect(201);
    await db('contact_organization')
      .insert({
        uuid: (await import('../src/lib/ids')).newUuid(),
        contact_id: (await db('contacts').where({ uuid: c.body.uuid }).first('id')).id,
        organization_id: (await db('organizations').where({ uuid: org.body.uuid }).first('id')).id,
      })
      .onConflict()
      .ignore();
    const line = [{ name: 'Desk', quantity: 1, unitPrice: 100 }];
    const mine = await staff.post('/m/quotes/quotes', { contactUuid: c.body.uuid, lines: line }).expect(201);
    const draft = await staff.post('/m/quotes/quotes', { contactUuid: c.body.uuid, lines: line }).expect(201);
    const orgQuote = await staff
      .post('/m/quotes/quotes', { organizationUuid: org.body.uuid, lines: line })
      .expect(201);
    const someoneElse = await staff.post('/m/quotes/quotes', { lines: line }).expect(201);
    for (const q of [mine, orgQuote, someoneElse])
      await staff.post(`/m/quotes/quotes/${q.body.uuid}/send`).expect(200);
    const inv = await staff
      .post('/m/invoices/invoices', { contactUuid: c.body.uuid, lines: line })
      .expect(201);
    await staff.post(`/m/invoices/invoices/${inv.body.uuid}/issue`).expect(200);

    const acc = await staff.post('/m/portal/accounts', { contactUuid: c.body.uuid }).expect(201);
    const customer = await signIn('olga.portal@example.test');
    const docs = await customer.get(`${P}/documents`).expect(200);
    const quoteIds = docs.body.quotes.map((q: { uuid: string }) => q.uuid);
    expect(quoteIds).toEqual([mine.body.uuid]);
    expect(docs.body.invoices.map((i: { uuid: string }) => i.uuid)).toEqual([inv.body.uuid]);
    expect(docs.body.quotes[0].owner).toBeUndefined();
    expect((await customer.get(`${P}/quotes/${draft.body.uuid}`)).status).toBe(404);
    expect((await customer.get(`${P}/quotes/${someoneElse.body.uuid}`)).status).toBe(404);
    expect((await customer.get(`${P}/quotes/${orgQuote.body.uuid}`)).status).toBe(404);

    await staff.patch(`/m/portal/accounts/${acc.body.uuid}`, { organizationAccess: true }).expect(200);
    const withOrg = await customer.get(`${P}/documents`).expect(200);
    expect(withOrg.body.quotes.map((q: { uuid: string }) => q.uuid).sort()).toEqual(
      [mine.body.uuid, orgQuote.body.uuid].sort(),
    );

    // Accepting online records the typed name, notifies staff and cannot be repeated.
    const accepted = await customer
      .post(`${P}/quotes/${mine.body.uuid}/accept`, { name: 'Olga O.' })
      .expect(200);
    expect(accepted.body).toMatchObject({ status: 'accepted', acceptedByName: 'Olga O.' });
    expect((await customer.post(`${P}/quotes/${mine.body.uuid}/accept`, { name: 'Olga O.' })).status).toBe(
      409,
    );
    expect(
      (await customer.post(`${P}/quotes/${someoneElse.body.uuid}/accept`, { name: 'Some One' })).status,
    ).toBe(404);
    const log = await db('audit_logs')
      .where({ entity_uuid: mine.body.uuid, action: 'quotes.quote.accepted' })
      .first();
    expect(log.actor_type).toBe('system');

    // Revoking access ends existing sessions immediately.
    await staff.patch(`/m/portal/accounts/${acc.body.uuid}`, { status: 'disabled' }).expect(200);
    expect((await customer.get(`${P}/documents`)).status).toBe(401);
  });

  it('only lets staff invite contacts inside their own scope', async () => {
    const hidden = await staff
      .post('/contacts', { firstName: 'Hidden', email: 'hidden.portal@example.test' })
      .expect(201);
    const role = await createRole(['portal.accounts.manage', 'core.contacts.view'], { '*': 'own' });
    const { client } = await clientWithRoles([role]);
    expect((await client.post('/m/portal/accounts', { contactUuid: hidden.body.uuid })).status).toBe(422);
    const noEmail = await staff.post('/contacts', { firstName: 'NoMail' }).expect(201);
    expect((await staff.post('/m/portal/accounts', { contactUuid: noEmail.body.uuid })).status).toBe(422);
  });
});
