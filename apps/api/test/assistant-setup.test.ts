import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clientWithRoles,
  createRole,
  createUser,
  loginAs,
  restoreSettingsAfterEach,
  type Client,
} from './helpers';

/** A small business website to read. */
const PAGE = `<!doctype html><html><head>
<title>Bright Smiles Dental | Family dentist in Leeds</title>
<meta name="description" content="Friendly family dental care, check-ups and whitening.">
<meta name="theme-color" content="#0E7C86">
<link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
<style>.btn{background:#0e7c86;color:#fff}.hero{color:#F2A541}.x{color:#333333}</style>
</head><body><img class="site-logo" src="/img/logo.png" alt="Bright Smiles">
<h1>Your family dentist</h1><p>Check-ups, hygiene and whitening for all ages.</p>
<script>var secret = 1;</script></body></html>`;

// The build sets the workspace's name and branding: put them back so later files see the defaults.
restoreSettingsAfterEach(['branding', 'general', 'features']);

describe('AI setup mode', () => {
  let admin: Client;
  let server: Server;
  let site = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/img/logo.png') {
        res.setHeader('content-type', 'image/png');
        res.end(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
            'base64',
          ),
        );
        return;
      }
      if (req.url === '/') {
        res.writeHead(301, { location: '/home' });
        res.end();
        return;
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    ({ client: admin } = await clientWithRoles(['admin']));
    await admin.post('/modules/assistant/enable').expect(200);
    await admin.patch('/m/assistant/config', { preset: 'simulated' }).expect(200);
  });

  afterAll(() => {
    server.close();
  });

  it('is for admins only', async () => {
    const role = await createRole(['assistant.chat.use']);
    const member = await loginAs(await createUser({ roleKeys: [role] }));
    await member.post('/m/assistant/setup').expect(403);
    await member.get('/m/assistant/setup/latest').expect(403);
  });

  it('interviews the business, then writes a brief to edit and approve', async () => {
    const s = await admin.post('/m/assistant/setup').expect(201);
    expect(s.body.step).toBe('profile');
    await admin
      .put(`/m/assistant/setup/${s.body.uuid}/profile`, {
        businessName: 'Bright Smiles',
        industry: 'Dental clinic',
        offerings: 'check-ups and whitening',
        problems: 'Patients forget appointments',
      })
      .expect(200);

    let session = (await admin.post(`/m/assistant/setup/${s.body.uuid}/interview`, {}).expect(200)).body;
    expect(session.step).toBe('interview');
    expect(session.interview).toHaveLength(1);
    expect(session.interview[0]).toMatchObject({
      done: false,
      question: expect.any(String),
      suggestions: expect.any(Array),
    });
    for (let i = 0; i < 4; i++)
      session = (
        await admin.post(`/m/assistant/setup/${s.body.uuid}/interview`, { answer: `Answer ${i}` }).expect(200)
      ).body;
    expect(session.interview.at(-1).done).toBe(true);
    expect(session.interview.filter((t: { answer?: string }) => t.answer).length).toBe(4);
    // Done means done: asking again adds nothing.
    const again = (await admin.post(`/m/assistant/setup/${s.body.uuid}/interview`, {}).expect(200)).body;
    expect(again.interview).toHaveLength(session.interview.length);

    const briefed = (await admin.post(`/m/assistant/setup/${s.body.uuid}/brief`).expect(200)).body;
    expect(briefed.step).toBe('brief');
    expect(briefed.brief).toMatchObject({
      businessName: 'Bright Smiles',
      problems: ['Patients forget appointments'],
    });

    const edited = { ...briefed.brief, vocabulary: { contact: { singular: 'Patient', plural: 'Patients' } } };
    const approved = (
      await admin.put(`/m/assistant/setup/${s.body.uuid}/brief`, { brief: edited, approve: true }).expect(200)
    ).body;
    expect(approved.step).toBe('proposal');
    expect(approved.brief.vocabulary.contact.plural).toBe('Patients');

    const latest = (await admin.get('/m/assistant/setup/latest').expect(200)).body;
    expect(latest.session.uuid).toBe(s.body.uuid);
  });

  it('reads the website once: name, description, logos, brand colours and text', async () => {
    const s = await admin.post('/m/assistant/setup').expect(201);
    await admin
      .put(`/m/assistant/setup/${s.body.uuid}/profile`, { businessName: 'Bright', website: site })
      .expect(200);
    const read = (await admin.post(`/m/assistant/setup/${s.body.uuid}/website`).expect(200)).body.website;
    expect(read).toMatchObject({
      url: `${site}home`,
      name: 'Bright Smiles Dental',
      description: 'Friendly family dental care, check-ups and whitening.',
    });
    expect(read.logos[0]).toBe(`${site}img/logo.png`);
    expect(read.logos).toContain(`${site}apple.png`);
    expect(read.colors.slice(0, 2)).toEqual(['#0e7c86', '#f2a541']);
    expect(read.colors).not.toContain('#333333');
    expect(read.text).toContain('Check-ups, hygiene and whitening');
    expect(read.text).not.toContain('secret');
  });

  it('proposes a setup from the brief and builds what the admin chose, with their edits', async () => {
    const s = await admin.post('/m/assistant/setup').expect(201);
    const name = `Glow ${Date.now().toString(36)}`;
    await admin
      .put(`/m/assistant/setup/${s.body.uuid}/profile`, { businessName: name, website: site })
      .expect(200);
    await admin.post(`/m/assistant/setup/${s.body.uuid}/website`).expect(200);
    const brief = (await admin.post(`/m/assistant/setup/${s.body.uuid}/brief`).expect(200)).body.brief;
    await admin.post(`/m/assistant/setup/${s.body.uuid}/proposal`).expect(422);
    const fieldLabel = `Insurer ${Date.now().toString(36)}`;
    await admin
      .put(`/m/assistant/setup/${s.body.uuid}/brief`, {
        brief: {
          ...brief,
          stages: [{ name: 'Enquiry' }, { name: 'Consultation' }, { name: 'Treatment' }],
          track: [{ entity: 'contact', label: fieldLabel, type: 'text' }],
          roles: [{ name: 'Receptionist' }],
        },
        approve: true,
      })
      .expect(200);

    const proposed = (await admin.post(`/m/assistant/setup/${s.body.uuid}/proposal`).expect(200)).body
      .proposal.items;
    const ids = proposed.map((i: { id: string }) => i.id);
    expect(ids).toEqual(expect.arrayContaining(['branding', 'pipeline', 'fields', 'roles', 'reports']));
    const pipeline = proposed.find((i: { id: string }) => i.id === 'pipeline');
    // A won and a lost stage are added when the process has none.
    expect(pipeline.preview.lists[0].items.map((x: { label: string }) => x.label)).toEqual([
      'Enquiry',
      'Consultation',
      'Treatment',
      'Won',
      'Lost',
    ]);
    const branding = proposed.find((i: { id: string }) => i.id === 'branding');
    // The website colour is darkened until white text on it is readable.
    expect(branding.payload.primary).toMatch(/^#[0-9A-F]{6}$/);

    const built = (
      await admin
        .post(`/m/assistant/setup/${s.body.uuid}/build`, {
          include: ['branding', 'pipeline', 'fields', 'reports'],
          edits: {
            branding: { set: [{ path: ['appName'], value: `${name} CRM` }] },
            pipeline: { drop: [{ path: ['stages'], index: 1 }] },
          },
        })
        .expect(200)
    ).body;
    expect(built.step).toBe('built');
    const results = built.built.results as { area: string; ok: boolean; message: string }[];
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.area)).toEqual(
      expect.arrayContaining(['setup', 'branding', 'logo', 'report']),
    );

    const brand = (await admin.get('/settings/branding').expect(200)).body;
    expect(brand.branding.appName).toBe(`${name} CRM`);
    const { db } = await import('../src/db/knex');
    const pipe = await db('pipelines')
      .where({ name: `${name} sales` })
      .first();
    const stages = await db('pipeline_stages')
      .where({ pipeline_id: pipe.id })
      .orderBy('sort_order')
      .pluck('name');
    expect(stages).toEqual(['Enquiry', 'Treatment', 'Won', 'Lost']);
    expect(await db('custom_field_definitions').where({ label: fieldLabel }).first()).toBeTruthy();
    expect(await db('roles').where({ name: 'Receptionist' }).first()).toBeUndefined();
    expect(await db('saved_reports').where({ name: 'Deals by stage' }).first()).toBeTruthy();
  });

  it('maps spreadsheet columns to fields and explains problems in plain words', async () => {
    const s = await admin.post('/m/assistant/setup').expect(201);
    const targets = [
      { key: 'firstName', label: 'First name' },
      { key: 'email', label: 'Email', format: 'An email address' },
    ];
    const mapped = (
      await admin
        .post(`/m/assistant/setup/${s.body.uuid}/mapping`, {
          entity: 'contact',
          headers: ['Name', 'Mail', 'Also mail', 'Notes'],
          sample: [['Ann', 'ann@x.test', 'a@x.test', 'hi']],
          targets,
          suggested: { Name: 'firstName', Mail: 'email', 'Also mail': 'email', Notes: 'nope' },
        })
        .expect(200)
    ).body;
    // Only real fields, each used once; unknown fields become "no field".
    expect(mapped.mapping).toEqual({ Name: 'firstName', Mail: 'email', 'Also mail': null, Notes: null });

    const explained = (
      await admin
        .post(`/m/assistant/setup/${s.body.uuid}/explain`, {
          entity: 'contact',
          problems: [
            { message: 'email: Invalid email address', count: 2, rows: [3, 4] },
            { message: 'Unknown stage "Maybe"', count: 1, rows: [5] },
          ],
          targets,
        })
        .expect(200)
    ).body.explanations;
    expect(explained[0].explanation).toMatch(/email address is not in a valid form/);
    expect(explained[1].fix).toMatch(/existing stage/);
  });

  it('reads JSON out of a model reply, and tells brand colours from greys', async () => {
    const { parseJsonReply } = await import('../../../modules/assistant/api/setup');
    const { brandHex } = await import('../../../modules/assistant/api/website');
    expect(parseJsonReply('Sure!\n```json\n{"done": true}\n```')).toEqual({ done: true });
    expect(parseJsonReply('Here: {"a": 1} hope it helps')).toEqual({ a: 1 });
    expect(parseJsonReply('no json here')).toBeNull();
    expect(brandHex('#0E7C86')).toBe('#0e7c86');
    expect(brandHex('#fff')).toBeNull();
    expect(brandHex('#777777')).toBeNull();
    const { readableBrand, keyOf } = await import('../../../modules/assistant/api/proposal');
    const { contrastRatio } = await import('@app/shared');
    // A pale website yellow becomes a colour text can sit on.
    const yellow = readableBrand('#FFEE55');
    expect(
      Math.max(contrastRatio(yellow, '#FFFFFF'), contrastRatio(yellow, '#000000')),
    ).toBeGreaterThanOrEqual(4.5);
    expect(readableBrand('#0E7C86')).toBe('#0E7C86');
    const used = new Set<string>();
    expect([keyOf('Insurance ID', used), keyOf('insurance-id', used), keyOf('2nd phone', used)]).toEqual([
      'insurance_id',
      'insurance_id_2',
      'f_2nd_phone',
    ]);
  });
});
