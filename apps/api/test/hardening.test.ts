import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { clientWithRoles, createRole, type Client } from './helpers';
import { db } from '../src/db/knex';
import { env } from '../src/config/env';
import { storage } from '../src/lib/storage';
import { storeFile } from '../src/core/files/files.service';
import { systemContext } from '../src/http/context';
import { purgePortalCredentials } from '../../../modules/portal/api';

describe('hardening', () => {
  let admin: Client;
  beforeAll(async () => {
    ({ client: admin } = await clientWithRoles(['admin']));
    for (const k of ['products', 'quotes', 'invoices', 'portal'])
      await admin.post(`/modules/${k}/enable`).expect(200);
  });

  it('hides linked records the viewer cannot see, and drops them when duplicating', async () => {
    const hiddenOrg = await admin.post('/organizations', { name: 'Secret Holdings' }).expect(201);
    const role = await createRole(['quotes.quotes.*', 'core.organizations.view', 'core.contacts.view'], {
      '*': 'own',
    });
    const { client, user } = await clientWithRoles([role]);
    // An admin hands this person a quote linked to an organization they do not own.
    const q = await admin
      .post('/m/quotes/quotes', {
        organizationUuid: hiddenOrg.body.uuid,
        ownerUuid: user.uuid,
        lines: [{ name: 'X', quantity: 1, unitPrice: 1 }],
      })
      .expect(201);
    const seen = await client.get(`/m/quotes/quotes/${q.body.uuid}`).expect(200);
    expect(seen.body.organization).toBeNull();
    const list = await client.get('/m/quotes/quotes').expect(200);
    expect(JSON.stringify(list.body)).not.toContain('Secret Holdings');
    const copy = await client.post(`/m/quotes/quotes/${q.body.uuid}/duplicate`).expect(201);
    const row = await db('m_quotes_quotes').where({ uuid: copy.body.uuid }).first('organization_id');
    expect(row.organization_id).toBeNull();
    // The admin still sees the link.
    expect((await admin.get(`/m/quotes/quotes/${q.body.uuid}`)).body.organization.name).toBe(
      'Secret Holdings',
    );
  });

  it('purges expired and spent portal sign-in links and sessions', async () => {
    const c = await admin
      .post('/contacts', { firstName: 'Purge', email: 'purge.me@example.test' })
      .expect(201);
    await admin.post('/m/portal/accounts', { contactUuid: c.body.uuid }).expect(201);
    const account = await db('m_portal_accounts').where({ email: 'purge.me@example.test' }).first('id');
    const old = new Date(Date.now() - 3 * 86_400_000);
    await db('m_portal_tokens').insert({
      account_id: account.id,
      token_hash: 'a'.repeat(64),
      expires_at: old,
    });
    await db('m_portal_sessions').insert({
      account_id: account.id,
      token_hash: 'b'.repeat(64),
      expires_at: old,
    });
    await purgePortalCredentials();
    expect(
      await db('m_portal_tokens')
        .where({ token_hash: 'a'.repeat(64) })
        .first(),
    ).toBeUndefined();
    expect(
      await db('m_portal_sessions')
        .where({ token_hash: 'b'.repeat(64) })
        .first(),
    ).toBeUndefined();
    // The fresh invitation link survives.
    expect(await db('m_portal_tokens').where({ account_id: account.id }).first()).toBeDefined();
  });

  it('removes stored bytes when the upload transaction rolls back', async () => {
    const put = vi.spyOn(storage, 'put');
    await expect(
      db.transaction(async (trx) => {
        await storeFile(trx, systemContext('test'), {
          buffer: Buffer.from('%PDF-1.4\n%%EOF'),
          originalName: 'x.pdf',
        });
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    const key = put.mock.calls.at(-1)![0];
    put.mockRestore();
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(path.join(path.resolve(env.STORAGE_DIR), key))).toBe(false);
  });
});
