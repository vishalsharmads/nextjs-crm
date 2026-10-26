import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SENSITIVE_MASK } from '@app/shared';
import {
  clientWithRoles,
  createRole,
  restoreSettingsAfterEach,
  setSettingsGroup,
  type Client,
} from './helpers';
import { db } from '../src/db/knex';
import { env } from '../src/config/env';
import { decrypt, encrypt, resetKeyRing } from '../src/lib/crypto';
import { storage } from '../src/lib/storage';
import { encryptExistingFiles, rotateKeys } from '../src/core/security/rotation';
import { createCipheriv, randomBytes } from 'node:crypto';

restoreSettingsAfterEach(['compliance']);

let admin: Client;
let fieldUuid = '';
beforeAll(async () => {
  ({ client: admin } = await clientWithRoles(['admin']));
  const f = await admin
    .post('/custom-fields', {
      entity: 'contact',
      key: 'diagnosis',
      label: 'Diagnosis',
      type: 'textarea',
      sensitivity: 'special',
      filterable: true,
    })
    .expect(201);
  fieldUuid = f.body.uuid;
});
afterAll(async () => {
  await admin.post(`/custom-fields/${fieldUuid}/archive`).expect(200);
});

describe('key ring', () => {
  it('writes key ids and still reads ciphertext from before the ring', () => {
    expect(encrypt('x').startsWith('v1.k0.')).toBe(true);
    // The pre-ring format: iv.tag.data with ENCRYPTION_KEY.
    const key = Buffer.from(env.ENCRYPTION_KEY, 'hex');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update('legacy', 'utf8'), c.final()]);
    const legacy = [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
    expect(decrypt(legacy)).toBe('legacy');
  });
});

describe('sensitive fields', () => {
  it('refuses unsuitable types and changes of sensitivity', async () => {
    expect(
      (
        await admin.post('/custom-fields', {
          entity: 'contact',
          key: 'blood_group',
          label: 'Blood group',
          type: 'select',
          options: [{ key: 'a', label: 'A' }],
          sensitivity: 'special',
        })
      ).status,
    ).toBe(422);
    expect((await admin.patch(`/custom-fields/${fieldUuid}`, { sensitivity: 'normal' })).status).toBe(422);
    expect((await db('custom_field_definitions').where({ uuid: fieldUuid }).first()).filterable).toBeFalsy();
  });

  it('stores values encrypted, masks them everywhere and logs every reveal', async () => {
    const c = await admin
      .post('/contacts', { firstName: 'Patient', custom: { diagnosis: 'Type 2 diabetes' } })
      .expect(201);
    expect(c.body.custom.diagnosis).toBe(SENSITIVE_MASK);
    const raw = await db('contacts').where({ uuid: c.body.uuid }).first('custom', 'id');
    expect(String(raw.custom.diagnosis)).toMatch(/^enc:v1\./);
    expect(JSON.stringify(raw.custom)).not.toContain('diabetes');

    // A form that sends the mask back leaves the value alone.
    await admin
      .patch(`/contacts/${c.body.uuid}`, { firstName: 'Patient A', custom: { diagnosis: SENSITIVE_MASK } })
      .expect(200);
    const after = await db('contacts').where({ uuid: c.body.uuid }).first('custom');
    expect(after.custom.diagnosis).toBe(raw.custom.diagnosis);

    await admin.patch(`/contacts/${c.body.uuid}`, { custom: { diagnosis: 'Asthma' } }).expect(200);
    const logs = await db('audit_logs').where({ entity: 'contact', entity_id: raw.id });
    expect(JSON.stringify(logs.map((l) => l.diff))).not.toMatch(/Asthma|diabetes|enc:v1/);

    const csv = await admin.get('/contacts/export').expect(200);
    expect(csv.text).not.toMatch(/Asthma/);

    const reader = await createRole(['core.contacts.view'], { 'core.contacts': 'all' });
    const { client } = await clientWithRoles([reader]);
    expect(
      (await client.get(`/custom-fields/reveal?entity=contact&uuid=${c.body.uuid}&key=diagnosis`)).status,
    ).toBe(403);
    const shown = await admin
      .get(`/custom-fields/reveal?entity=contact&uuid=${c.body.uuid}&key=diagnosis`)
      .expect(200);
    expect(shown.body.value).toBe('Asthma');
    // Logged even though access logging is off in this workspace.
    expect(await db('access_logs').where({ action: 'reveal', entity_id: raw.id }).first()).toBeTruthy();
  });
});

describe('upload encryption and key rotation', () => {
  const upload = async (contactUuid: string, text: string) =>
    (
      await admin.agent
        .post('/api/v1/files')
        .set('x-csrf-token', admin.csrf)
        .field('entity', 'contact')
        .field('uuid', contactUuid)
        .attach('file', Buffer.from(text), 'note.txt')
        .expect(201)
    ).body.uuid as string;

  it('encrypts new uploads, existing files on request, and rotates every key', async () => {
    const c = await admin
      .post('/contacts', { firstName: 'Files', custom: { diagnosis: 'Secret' } })
      .expect(201);
    const plainUuid = await upload(c.body.uuid, 'before encryption');
    await setSettingsGroup('compliance', { encryptUploads: true });
    const sealedUuid = await upload(c.body.uuid, 'sealed text');

    const sealed = await db('files').where({ uuid: sealedUuid }).first();
    expect(sealed.enc_kid).toBe('k0');
    expect((await storage.get(sealed.storage_key)).subarray(0, 4).toString()).toBe('ENC1');
    const { body: link } = await admin.get(`/files/${sealedUuid}/url`).expect(200);
    expect((await admin.agent.get(link.url).expect(200)).text).toBe('sealed text');

    expect(await encryptExistingFiles()).toBeGreaterThanOrEqual(1);
    expect((await db('files').where({ uuid: plainUuid }).first()).enc_kid).toBe('k0');

    const previous = env.ENCRYPTION_KEYS;
    env.ENCRYPTION_KEYS = `k1:${'1'.repeat(64)},k0:${env.ENCRYPTION_KEY}`;
    resetKeyRing();
    try {
      const counts = await rotateKeys();
      expect(counts.files).toBeGreaterThanOrEqual(2);
      expect(counts['contacts.custom']).toBeGreaterThanOrEqual(1);
      expect((await db('files').where({ uuid: plainUuid }).first()).enc_kid).toBe('k1');
      const row = await db('contacts').where({ uuid: c.body.uuid }).first('custom');
      expect(String(row.custom.diagnosis)).toMatch(/^enc:v1\.k1\./);
      const shown = await admin
        .get(`/custom-fields/reveal?entity=contact&uuid=${c.body.uuid}&key=diagnosis`)
        .expect(200);
      expect(shown.body.value).toBe('Secret');
      const { body: again } = await admin.get(`/files/${plainUuid}/url`).expect(200);
      expect((await admin.agent.get(again.url).expect(200)).text).toBe('before encryption');
    } finally {
      // Put everything back under k0 so later test files read it with the default ring.
      env.ENCRYPTION_KEYS = `k0:${env.ENCRYPTION_KEY},k1:${'1'.repeat(64)}`;
      resetKeyRing();
      await rotateKeys();
      env.ENCRYPTION_KEYS = previous;
      resetKeyRing();
    }
  });
});

describe('data map', () => {
  it('lists personal data, its sensitivity and who receives it', async () => {
    const map = await admin.get('/privacy/data-map').expect(200);
    const contacts = map.body.records.find((r: { entity: string }) => r.entity === 'contact');
    expect(contacts.customFields).toContainEqual({
      key: 'diagnosis',
      label: 'Diagnosis',
      sensitivity: 'special',
    });
    expect(map.body.recipients[0].name).toMatch(/SMTP/);
    expect(map.body.system.map((s: { area: string }) => s.area)).toContain('Audit log');
  });
});
