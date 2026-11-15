import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { clientWithRoles, createRole } from './helpers';
import { db } from '../src/db/knex';
import { env } from '../src/config/env';
import { accessTokenFor, resetMailOAuthProviders } from '../src/core/email/oauth';
import { logSyncedMessage } from '../src/core/email/email';

let server: Server;
const tokenCalls: URLSearchParams[] = [];
const idToken = (email: string) =>
  ['e30', Buffer.from(JSON.stringify({ email })).toString('base64url'), 'sig'].join('.');

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      tokenCalls.push(p);
      res.setHeader('Content-Type', 'application/json');
      if (p.get('grant_type') === 'authorization_code')
        res.end(
          JSON.stringify({
            access_token: 'at-1',
            refresh_token: 'rt-1',
            expires_in: 3600,
            id_token: idToken('Rep@Mail.Example.test'),
          }),
        );
      else res.end(JSON.stringify({ access_token: 'at-2', expires_in: 3600 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(path.join(tmpdir(), 'mailoauth-'));
  const file = path.join(dir, 'providers.json');
  writeFileSync(
    file,
    JSON.stringify([
      {
        key: 'example',
        name: 'Example Mail',
        authorizeUrl: `http://127.0.0.1:${port}/authorize`,
        tokenUrl: `http://127.0.0.1:${port}/token`,
        scopes: ['openid', 'email', 'mail'],
        clientId: 'client-1',
        clientSecret: 'secret-1',
        imap: { host: 'imap.example.test', port: 993, secure: true },
        smtp: { host: 'smtp.example.test', port: 465, secure: true },
      },
    ]),
  );
  env.MAIL_OAUTH_PROVIDERS_FILE = file;
  resetMailOAuthProviders();
});
afterAll(() => {
  env.MAIL_OAUTH_PROVIDERS_FILE = undefined;
  resetMailOAuthProviders();
  server.close();
});

describe('two-way mailbox', () => {
  it('connects a mailbox with an OAuth provider from the operator file, and refreshes its token', async () => {
    const role = await createRole(['core.email.use', 'core.contacts.view'], { '*': 'own' });
    const { client, user } = await clientWithRoles([role]);
    const list = await client.get('/email/oauth/providers').expect(200);
    expect(list.body.data).toEqual([{ key: 'example', name: 'Example Mail' }]);
    const start = await client.post('/email/oauth/example/start').expect(200);
    const url = new URL(start.body.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    const state = url.searchParams.get('state')!;

    // An unknown or used state is refused; the state alone names the person (sessions may expire meanwhile).
    const { client: other } = await clientWithRoles([role]);
    const bad = await other.get('/email/oauth/callback?code=abc&state=nope').expect(303);
    expect(bad.headers.location).toContain('error=');
    expect(state).toHaveLength(64);

    const start2 = await client.post('/email/oauth/example/start').expect(200);
    const state2 = new URL(start2.body.url).searchParams.get('state')!;
    const done = await client.get(`/email/oauth/callback?code=abc&state=${state2}`).expect(303);
    expect(done.headers.location).toContain('connected=rep%40mail.example.test');
    expect(tokenCalls.at(-1)?.get('code_verifier')).toBeTruthy();

    const account = await db('mail_accounts').where({ user_id: user.id }).first();
    expect(account.auth_type).toBe('oauth');
    expect(account.access_token_enc).not.toContain('at-1');
    const accounts = await client.get('/email/accounts').expect(200);
    expect(accounts.body.data[0]).toMatchObject({ authType: 'oauth', provider: 'Example Mail' });

    await db('mail_accounts')
      .where({ id: account.id })
      .update({ token_expires_at: new Date(Date.now() - 1000) });
    const fresh = await db('mail_accounts').where({ id: account.id }).first();
    expect(await accessTokenFor(fresh)).toBe('at-2');
    expect(tokenCalls.at(-1)?.get('grant_type')).toBe('refresh_token');
  });

  it('logs mail written in the mail program (Sent) and replies in the same conversation', async () => {
    const { client: admin, user } = await clientWithRoles(['admin']);
    const stamp = Date.now();
    const contact = await admin
      .post('/contacts', { firstName: 'Sent', lastName: 'Log', email: `sent-${stamp}@example.test` })
      .expect(201);
    const account = { id: 0, user_id: user.id, email: `me-${stamp}@example.test` };
    const raw = [
      `From: Me <me-${stamp}@example.test>`,
      `To: sent-${stamp}@example.test`,
      `Subject: Offer ${stamp}`,
      `Message-ID: <offer-${stamp}@example.test>`,
      'Date: Mon, 16 Nov 2026 10:00:00 +0000',
      '',
      'Here is the offer.',
    ].join('\r\n');
    expect(
      await logSyncedMessage(
        { ...account, id: null as unknown as number },
        await simpleParser(raw),
        'outbound',
      ),
    ).toBe(true);
    // The same message again (another folder, or the CRM sent it) is not logged twice.
    expect(
      await logSyncedMessage(
        { ...account, id: null as unknown as number },
        await simpleParser(raw),
        'outbound',
      ),
    ).toBe(false);
    const msg = await db('email_messages')
      .where({ message_id: `<offer-${stamp}@example.test>` })
      .first();
    expect(msg.direction).toBe('outbound');
    const activity = await db('activities').where({ id: msg.activity_id }).first('uuid');

    await admin
      .post('/email/send', {
        to: [`sent-${stamp}@example.test`],
        subject: `Re: Offer ${stamp}`,
        body: '<p>Following up</p>',
        related: { type: 'contact', uuid: contact.body.uuid },
        replyToActivityUuid: activity.uuid,
      })
      .expect(201);
    const reply = await db('email_messages')
      .where({ subject: `Re: Offer ${stamp}` })
      .first();
    expect(reply.in_reply_to).toBe(`<offer-${stamp}@example.test>`);
    expect(reply.thread_id).toBe(msg.thread_id);
    // Replying to an email that is not on the record is refused.
    const stranger = await admin.post('/contacts', { firstName: 'Else' }).expect(201);
    await admin
      .post('/email/send', {
        to: ['x@example.test'],
        subject: 'Re: nope',
        body: '<p>x</p>',
        related: { type: 'contact', uuid: stranger.body.uuid },
        replyToActivityUuid: activity.uuid,
      })
      .expect(404);
  });
});
