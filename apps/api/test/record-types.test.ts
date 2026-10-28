import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, createUser, loginAs, unique, type Client } from './helpers';
import { db } from '../src/db/knex';
import { scaffoldModule, addToInstalled } from '../src/cli/scaffold';
import { defineRecordType } from '../src/core/records/record-type';
import { registerRecordType, unregisterRecordType } from '../src/core/records/registry';
import { eventTouchesRestricted } from '../src/core/privacy/privacy.service';
import { newUuid } from '../src/lib/ids';

const BASE = '/m/records-demo/items';
const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.join(',')).join('\n'));

describe('module record types', () => {
  let admin: Client;
  let fieldUuid: string;

  beforeAll(async () => {
    ({ client: admin } = await clientWithRoles(['admin']));
    await admin.post('/modules/records-demo/enable').expect(200);
    const field = await admin
      .post('/custom-fields', {
        entity: 'demo_item',
        key: 'grade',
        label: 'Grade',
        type: 'select',
        filterable: true,
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
        ],
      })
      .expect(201);
    fieldUuid = field.body.uuid;
  });

  afterAll(async () => {
    await admin.post(`/custom-fields/${fieldUuid}/archive`);
    await admin.post('/modules/records-demo/enable').expect(200);
  });

  it('creates, reads, updates, filters, deletes and restores records', async () => {
    const org = await admin.post('/organizations', { name: unique('Org ') }).expect(201);
    const created = await admin
      .post(BASE, {
        name: 'Forklift',
        status: 'active',
        value: 1250.5,
        dueOn: '2026-12-01',
        organizationUuid: org.body.uuid,
        custom: { grade: 'a' },
      })
      .expect(201);
    expect(created.body).toMatchObject({
      name: 'Forklift',
      value: 1250.5,
      dueOn: '2026-12-01',
      organization: { uuid: org.body.uuid },
      custom: { grade: 'a' },
    });
    expect(created.body.owner).not.toBeNull();
    const uuid = created.body.uuid as string;

    await admin.post(BASE, { name: '' }).expect(422);
    // Forms send '' for empty optional inputs and 'true'/'false' from yes/no selects.
    const blank = await admin.post(BASE, { name: 'Blank', notes: '', dueOn: '', value: '' }).expect(201);
    expect(blank.body).toMatchObject({ notes: null, dueOn: null, value: null });
    // An empty select on create falls back to the column default; clearing it later stores null.
    const defaulted = await admin.post(BASE, { name: 'Defaulted', status: null }).expect(201);
    expect(defaulted.body.status).toBe('active');
    const cleared = await admin.patch(`${BASE}/${defaulted.body.uuid}`, { status: '' }).expect(200);
    expect(cleared.body.status).toBeNull();
    await admin.post(BASE, { name: 'X', status: 'nope' }).expect(422);
    await admin.post(BASE, { name: 'X', custom: { grade: 'z' } }).expect(422);

    const patched = await admin.patch(`${BASE}/${uuid}`, { status: 'inactive' }).expect(200);
    expect(patched.body).toMatchObject({ status: 'inactive', value: 1250.5, custom: { grade: 'a' } });

    await admin.post(BASE, { name: 'Pallet', custom: { grade: 'b' } }).expect(201);
    const filter = encodeURIComponent(JSON.stringify({ field: 'cf.grade', op: 'eq', value: 'a' }));
    const list = await admin.get(`${BASE}?filter=${filter}&sort=-value`).expect(200);
    expect(list.body.data.map((r: { uuid: string }) => r.uuid)).toContain(uuid);
    expect(list.body.data.every((r: { custom: { grade: string } }) => r.custom.grade === 'a')).toBe(true);

    const timeline = await admin.get(`${BASE}/${uuid}/timeline`).expect(200);
    expect(timeline.body.data.length).toBeGreaterThan(0);

    await admin.delete(`${BASE}/${uuid}`).expect(204);
    await admin.get(`${BASE}/${uuid}`).expect(404);
    const trash = await admin.get(`${BASE}?trashed=only`).expect(200);
    expect(trash.body.data.map((r: { uuid: string }) => r.uuid)).toContain(uuid);
    await admin.post(`${BASE}/${uuid}/restore`).expect(200);

    const actions = await db('audit_logs').where({ entity: 'demo_item', entity_uuid: uuid }).pluck('action');
    expect(actions).toEqual(
      expect.arrayContaining([
        'demo_item.created',
        'demo_item.updated',
        'demo_item.deleted',
        'demo_item.restored',
      ]),
    );
  });

  it('is searchable, has saved views and appears in the bootstrap', async () => {
    const name = unique('Searchable widget ');
    const rec = await admin.post(BASE, { name }).expect(201);
    const search = await admin.get(`/search?q=${encodeURIComponent(name)}`).expect(200);
    expect(search.body.data).toContainEqual(
      expect.objectContaining({ type: 'demo_item', uuid: rec.body.uuid, url: `${BASE}/${rec.body.uuid}` }),
    );

    const view = await admin
      .post('/saved-views', {
        entity: 'demo_item',
        name: 'Grade A',
        filters: { field: 'cf.grade', op: 'eq', value: 'a' },
      })
      .expect(201);
    await admin.get(`${BASE}?view=${view.body.uuid}`).expect(200);

    const boot = await admin.get('/meta/bootstrap').expect(200);
    expect(boot.body.recordTypes).toContainEqual(
      expect.objectContaining({ entity: 'demo_item', moduleKey: 'records-demo', route: 'items' }),
    );
    expect(boot.body.labels.demo_item).toEqual({ singular: 'Item', plural: 'Items' });
    expect(boot.body.customFields.some((f: { entity: string }) => f.entity === 'demo_item')).toBe(true);
  });

  it('imports, exports and runs bulk actions', async () => {
    const tag = unique('imp');
    const up = await admin.agent
      .post('/api/v1/imports')
      .set('x-csrf-token', admin.csrf)
      .field('entity', 'demo_item')
      .attach(
        'file',
        csv([
          ['Name', 'Value', 'Due on', 'Grade'],
          [`${tag} one`, '10.25', '2026-01-02', 'A'],
          [`${tag} two`, 'abc', '', ''],
        ]),
        'items.csv',
      )
      .expect(201);
    expect(up.body.suggested).toMatchObject({
      Name: 'name',
      Value: 'value',
      'Due on': 'dueOn',
      Grade: 'custom.grade',
    });
    const start = await admin
      .post('/imports/start', { entity: 'demo_item', fileUuid: up.body.fileUuid, mapping: up.body.suggested })
      .expect(200);
    const status = await admin.get(`/imports/${start.body.jobUuid}`).expect(200);
    expect(status.body.result).toMatchObject({ created: 1, failed: 1 });

    const found = await admin.get(`${BASE}?q=${encodeURIComponent(`${tag} one`)}`).expect(200);
    expect(found.body.data[0]).toMatchObject({ value: 10.25, dueOn: '2026-01-02', custom: { grade: 'a' } });

    const exp = await admin.get(`${BASE}/export?q=${encodeURIComponent(tag)}`).expect(200);
    expect(exp.text).toContain('Name');
    expect(exp.text).toContain(`${tag} one`);

    const other = await createUser({ roleKeys: ['admin'] });
    const bulk = await admin
      .post(`${BASE}/bulk`, { action: 'assign', uuids: [found.body.data[0].uuid], ownerUuid: other.uuid })
      .expect(200);
    expect(bulk.body.affected).toBe(1);
    await admin
      .post(`${BASE}/bulk`, { action: 'add_tags', uuids: [found.body.data[0].uuid], tags: ['x'] })
      .expect(422);
  });

  it('applies own scope: others cannot see, change, export or read the history of a record', async () => {
    const role = await createRole(['records-demo.items.*'], { 'records-demo.items': 'own' });
    const rep = await loginAs(await createUser({ roleKeys: [role] }));
    const mine = await rep.post(BASE, { name: 'Rep owned' }).expect(201);
    const theirs = await admin.post(BASE, { name: unique('Admin owned ') }).expect(201);

    await rep.get(`${BASE}/${theirs.body.uuid}`).expect(404);
    await rep.patch(`${BASE}/${theirs.body.uuid}`, { name: 'Hijack' }).expect(404);
    const list = await rep.get(BASE).expect(200);
    const seen = list.body.data.map((r: { uuid: string }) => r.uuid);
    expect(seen).toContain(mine.body.uuid);
    expect(seen).not.toContain(theirs.body.uuid);
    const search = await rep.get(`/search?q=${encodeURIComponent(theirs.body.name)}`).expect(200);
    expect(search.body.data.map((r: { uuid: string }) => r.uuid)).not.toContain(theirs.body.uuid);

    await rep.delete(`${BASE}/${theirs.body.uuid}`).expect(404);
    await rep.get(`${BASE}/${theirs.body.uuid}/timeline`).expect(404);
    const bulk = await rep.post(`${BASE}/bulk`, { action: 'delete', uuids: [theirs.body.uuid] }).expect(200);
    expect(bulk.body.affected).toBe(0);
    await admin.delete(`${BASE}/${theirs.body.uuid}`).expect(204);
    await rep.post(`${BASE}/${theirs.body.uuid}/restore`).expect(404);
    await admin.post(`${BASE}/${theirs.body.uuid}/restore`).expect(200);
    const exp = await rep.get(`${BASE}/export`).expect(200);
    expect(exp.text).toContain('Rep owned');
    expect(exp.text).not.toContain(theirs.body.name);
    const auditor = await loginAs(
      await createUser({
        roleKeys: [
          await createRole(['records-demo.items.view', 'core.audit.view'], { 'records-demo.items': 'own' }),
        ],
      }),
    );
    const history = await auditor.get('/audit-logs?pageSize=100').expect(200);
    expect(JSON.stringify(history.body)).not.toContain(theirs.body.uuid);
    const wide = await loginAs(
      await createUser({
        roleKeys: [
          await createRole(['records-demo.items.view', 'core.audit.view'], { 'records-demo.items': 'all' }),
        ],
      }),
    );
    const all = await wide.get(`/audit-logs?pageSize=100&entity=demo_item`).expect(200);
    expect(JSON.stringify(all.body)).toContain(theirs.body.uuid);

    const noPerm = await loginAs(await createUser({ roleKeys: [await createRole(['core.contacts.view'])] }));
    await noPerm.get(BASE).expect(403);
  });

  it('links only to records the user may see, and hides names of others', async () => {
    const role = await createRole(['records-demo.items.*', 'core.organizations.view'], {
      'records-demo.items': 'all',
      'core.organizations': 'own',
    });
    const rep = await loginAs(await createUser({ roleKeys: [role] }));
    const hidden = await admin.post('/organizations', { name: unique('Hidden org ') }).expect(201);
    const res = await rep.post(BASE, { name: 'Probe', organizationUuid: hidden.body.uuid }).expect(422);
    expect(res.body.error.details[0].path).toBe('organizationUuid');

    const linked = await admin
      .post(BASE, { name: unique('Linked '), organizationUuid: hidden.body.uuid })
      .expect(201);
    expect(linked.body.organization.name).toBe(hidden.body.name);
    const seen = await rep.get(`${BASE}/${linked.body.uuid}`).expect(200);
    expect(seen.body.organization).toBeNull();
  });

  it('keeps hidden custom fields out of a module type export', async () => {
    const secret = await admin
      .post('/custom-fields', {
        entity: 'demo_item',
        key: 'secret_code',
        label: 'Secret code',
        type: 'text',
        visibility: { default: 'hidden', roles: {} },
      })
      .expect(201);
    try {
      const role = await createRole(['records-demo.items.*'], { 'records-demo.items': 'all' });
      const rep = await loginAs(await createUser({ roleKeys: [role] }));
      const name = unique('Secretive ');
      await admin.post(BASE, { name, custom: { secret_code: 'XYZZY' } }).expect(201);
      const exp = await rep.get(`${BASE}/export?q=${encodeURIComponent(name)}`).expect(200);
      expect(exp.text).toContain(name);
      expect(exp.text).not.toContain('Secret code');
      expect(exp.text).not.toContain('XYZZY');
      const got = await rep.get(`${BASE}?q=${encodeURIComponent(name)}`).expect(200);
      expect(got.body.data[0].custom).not.toHaveProperty('secret_code');
    } finally {
      await admin.post(`/custom-fields/${secret.body.uuid}/archive`);
    }
  });

  it('treats events about a linked restricted contact as restricted', async () => {
    const contact = await admin
      .post('/contacts', { firstName: 'Restricted', lastName: unique('L') })
      .expect(201);
    await admin.post(`/privacy/contact/${contact.body.uuid}/restriction`, { restricted: true }).expect(204);
    const def = defineRecordType({
      moduleKey: 'records-demo',
      entity: 'demo_visit',
      route: 'visits',
      table: 'm_records_demo_visits',
      resource: 'records-demo.visits',
      labels: { singular: 'Visit', plural: 'Visits' },
      titleColumn: 'name',
      columns: [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'person', label: 'Person', kind: 'relation', relation: 'contact' },
      ],
    });
    registerRecordType(def);
    try {
      const touched = await eventTouchesRestricted({
        entity: 'demo_visit',
        uuid: newUuid(),
        record: { person: { uuid: contact.body.uuid, name: 'x' } },
      });
      expect(touched).toBe(true);
    } finally {
      unregisterRecordType('demo_visit');
    }
  });

  it('offers record type events to automations', async () => {
    const list = await admin.get('/automations').expect(200);
    expect(list.body.events).toContain('demo_item.created');
    await admin
      .post('/automations', {
        name: unique('On item '),
        triggerEvent: 'demo_item.created',
        actions: [{ type: 'notify', to: 'owner', title: 'New item {{record.name}}' }],
      })
      .expect(201);
    await admin
      .post('/automations', { name: 'Bad', triggerEvent: 'nothing.created', actions: [] })
      .expect(422);
  });

  it('hides a disabled module’s record types', async () => {
    await admin.post('/modules/records-demo/disable').expect(204);
    try {
      await admin.get(BASE).expect(404);
      await admin.get('/saved-views?entity=demo_item').expect(422);
      const automations = await admin.get('/automations').expect(200);
      expect(automations.body.events).not.toContain('demo_item.created');
      const boot = await admin.get('/meta/bootstrap').expect(200);
      expect(boot.body.recordTypes.some((t: { entity: string }) => t.entity === 'demo_item')).toBe(false);
    } finally {
      await admin.post('/modules/records-demo/enable').expect(200);
    }
  });
});

describe('module:new scaffold', () => {
  it('generates a module with a record type, migration and manifest', () => {
    const files = scaffoldModule({ key: 'fleet', entity: 'vehicle', plural: 'Vehicles' });
    expect(Object.keys(files)).toEqual([
      'modules/fleet/manifest.json',
      'modules/fleet/package.json',
      'modules/fleet/api/index.ts',
      'modules/fleet/api/migrations/0001_vehicles.ts',
      'modules/fleet/web/index.tsx',
    ]);
    const manifest = JSON.parse(files['modules/fleet/manifest.json']!);
    expect(manifest.permissions.map((p: { key: string }) => p.key)).toContain('fleet.vehicles.view');
    expect(manifest.menu_items[0].path).toBe('/m/fleet/vehicles');
    expect(files['modules/fleet/api/index.ts']).toContain("table: 'm_fleet_vehicles'");
    expect(files['modules/fleet/api/migrations/0001_vehicles.ts']).toContain('FULLTEXT');
  });

  it('rejects core and reserved keys', () => {
    expect(() => scaffoldModule({ key: 'x1', entity: 'contact', plural: 'Contacts' })).toThrow();
    expect(() => scaffoldModule({ key: 'x1', entity: 'team', plural: 'Teams' })).toThrow();
    expect(() => scaffoldModule({ key: 'Bad Key', entity: 'thing', plural: 'Things' })).toThrow();
  });

  it('adds the module to installed.ts once', () => {
    const src = "import a from 'x';\n\nexport const installedModuleSources = [\n  { manifest: a },\n];\n";
    const once = addToInstalled(src, 'fleet');
    expect(once).toContain("import fleet from '../../../../modules/fleet/manifest.json'");
    expect(once).toContain('{ manifest: fleet, api: fleetApi },\n];');
    expect(addToInstalled(once, 'fleet')).toBe(once);
  });
});
