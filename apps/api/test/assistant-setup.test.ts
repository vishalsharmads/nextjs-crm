import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientWithRoles, createRole, createUser, loginAs, type Client } from './helpers';

/** A small business website to read. */
const PAGE = `<!doctype html><html><head>
<title>Bright Smiles Dental | Family dentist in Leeds</title>
<meta name="description" content="Friendly family dental care, check-ups and whitening.">
<meta name="theme-color" content="#0E7C86">
<link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
<style>.btn{background:#0e7c86;color:#fff}.hero{color:#F2A541}.x{color:#333333}</style>
</head><body><img class="site-logo" src="/img/logo.svg" alt="Bright Smiles">
<h1>Your family dentist</h1><p>Check-ups, hygiene and whitening for all ages.</p>
<script>var secret = 1;</script></body></html>`;

describe('AI setup mode', () => {
  let admin: Client;
  let server: Server;
  let site = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
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
    expect(read.logos[0]).toBe(`${site}img/logo.svg`);
    expect(read.logos).toContain(`${site}apple.png`);
    expect(read.colors.slice(0, 2)).toEqual(['#0e7c86', '#f2a541']);
    expect(read.colors).not.toContain('#333333');
    expect(read.text).toContain('Check-ups, hygiene and whitening');
    expect(read.text).not.toContain('secret');
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
  });
});
