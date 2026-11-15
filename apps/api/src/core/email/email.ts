import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { Response } from 'express';
import { z } from 'zod';
import { RELATED_TYPES, type RelatedType } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import type { AuthUser, RequestContext } from '../../http/context';
import { db, type Db } from '../../db/knex';
import { env, isTest } from '../../config/env';
import { AppError, notFound } from '../../lib/errors';
import { decrypt, encrypt } from '../../lib/crypto';
import { newUuid } from '../../lib/ids';
import { logger } from '../../lib/logger';
import { every } from '../../lib/jobs';
import { mailbox, sendMail } from '../../lib/mailer';
import { audit } from '../audit/audit.service';
import { assertCan } from '../rbac/access';
import { getRow } from '../records/service';
import { recordDefs } from '../records/registry';
import { sanitizeBody } from '../activities/activities.def';
import { getBranding } from '../settings/settings.service';
import { restrictedRecipients } from '../privacy/privacy.service';
import { addParticipants, participantsFromAddresses, whereOnRecord } from '../activities/participants';
import { accessTokenFor, finishOAuth, mailOAuthProviders, startOAuth, tokenColumns } from './oauth';
import { logAccess } from '../audit/access-log';
import { activitiesDef } from '../activities/activities.def';

const server = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(true),
});

const accountBody = z.object({
  email: z.email().max(255),
  displayName: z.string().max(150).default(''),
  password: z.string().min(1).max(500),
  smtp: server,
  imap: server.nullish(),
});

interface AccountRow {
  id: number;
  uuid: string;
  user_id: number;
  email: string;
  display_name: string;
  smtp: { host: string; port: number; secure: boolean };
  imap: { host: string; port: number; secure: boolean } | null;
  auth_type: 'password' | 'oauth';
  password_enc: string | null;
  oauth_provider: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: Date | string | null;
  imap_last_uid: number | null;
  imap_state: Record<string, number> | null;
  sync_sent: number | boolean;
}

const accountDto = (a: Record<string, unknown>) => ({
  uuid: a.uuid,
  email: a.email,
  authType: a.auth_type ?? 'password',
  provider: a.oauth_provider
    ? (mailOAuthProviders().find((p) => p.key === a.oauth_provider)?.name ?? null)
    : null,
  syncSent: a.sync_sent === undefined ? true : !!a.sync_sent,
  displayName: a.display_name,
  smtp: a.smtp,
  imap: a.imap,
  lastSyncAt: a.last_sync_at ? new Date(a.last_sync_at as string).toISOString() : null,
  lastError: a.last_error,
  active: !!a.active,
});

/** Credentials for SMTP and IMAP: the stored password, or an OAuth access token (XOAUTH2). */
async function credentials(a: AccountRow) {
  if (a.auth_type === 'oauth') return { user: a.email, accessToken: await accessTokenFor(a) };
  return { user: a.email, pass: decrypt(a.password_enc!, 'mail_accounts.password_enc') };
}

async function transportFor(a: AccountRow) {
  const c = await credentials(a);
  return nodemailer.createTransport({
    host: a.smtp.host,
    port: a.smtp.port,
    secure: a.smtp.secure,
    auth: 'accessToken' in c ? { type: 'OAuth2', user: c.user, accessToken: c.accessToken } : c,
  });
}

async function imapClient(a: AccountRow) {
  const c = await credentials(a);
  return new ImapFlow({
    host: a.imap!.host,
    port: a.imap!.port,
    secure: a.imap!.secure,
    auth: 'accessToken' in c ? { user: c.user, accessToken: c.accessToken } : { user: c.user, pass: c.pass },
    logger: false,
  });
}

/** Put a sent message in the mailbox's Sent folder, so it shows in the person's mail program. */
async function appendToSent(a: AccountRow, raw: Buffer) {
  if (!a.imap) return;
  const client = await imapClient(a);
  await client.connect();
  try {
    const folders = await client.list();
    const sent =
      folders.find((f) => f.specialUse === '\\Sent')?.path ??
      folders.find((f) => /^sent/i.test(f.name))?.path;
    if (sent) await client.append(sent, raw, ['\\Seen']);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

// ---------- Threads ----------

const normSubject = (s: string) =>
  s
    .replace(/^\s*((re|fw|fwd|aw|sv|antw)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();

/**
 * The conversation a message belongs to: the thread of a message it replies to (In-Reply-To,
 * References), else a recent message with the same subject between the same people, else a new one.
 */
export async function threadFor(
  conn: Db,
  m: { inReplyTo?: string | null; references?: string[]; subject: string; addresses: string[] },
): Promise<string> {
  const ids = [m.inReplyTo, ...(m.references ?? [])].filter((x): x is string => !!x).slice(-20);
  if (ids.length) {
    const hit = await conn('email_messages')
      .whereIn('message_id', ids)
      .whereNotNull('thread_id')
      .first('thread_id');
    if (hit) return hit.thread_id as string;
  }
  const subject = normSubject(m.subject);
  if (subject && m.addresses.length) {
    const recent = await conn('email_messages')
      .whereNotNull('thread_id')
      .where('sent_at', '>=', new Date(Date.now() - 30 * 86_400_000))
      .orderBy('sent_at', 'desc')
      .limit(200)
      .select('thread_id', 'subject', 'from_address', 'to_addresses');
    const people = new Set(m.addresses.map((a) => a.toLowerCase()));
    const match = recent.find((r) => {
      if (normSubject(r.subject as string) !== subject) return false;
      const theirs = [r.from_address as string, ...((r.to_addresses as string[] | null) ?? [])];
      return theirs.some((a) => people.has(String(a).toLowerCase()));
    });
    if (match) return match.thread_id as string;
  }
  return newUuid();
}

// ---------- Sending ----------

const sendBody = z.object({
  to: z.array(z.email()).min(1).max(20),
  cc: z.array(z.email()).max(20).default([]),
  subject: z.string().trim().min(1).max(500),
  body: z.string().min(1).max(200_000),
  related: z.object({ type: z.enum(RELATED_TYPES), uuid: z.uuid() }).nullish(),
  accountUuid: z.uuid().nullish(),
  inReplyTo: z.string().max(500).nullish(),
  /** Reply to this email (an activity): sets In-Reply-To and References from its conversation. */
  replyToActivityUuid: z.uuid().nullish(),
});

/** Find the record an email is about: explicit, else the first contact matching a recipient. */
async function resolveRelated(
  user: AuthUser,
  related: { type: RelatedType; uuid: string } | null | undefined,
  addresses: string[],
) {
  if (related) {
    const def = recordDefs[related.type];
    const row = await getRow(def, user, related.uuid);
    return { type: related.type, id: row.id };
  }
  const c = await db('contacts')
    .whereIn(
      'email_norm',
      addresses.map((a) => a.toLowerCase()),
    )
    .whereNull('deleted_at')
    .first('id');
  return c ? { type: 'contact' as const, id: c.id as number } : null;
}

export async function sendEmail(ctx: RequestContext, user: AuthUser, input: z.infer<typeof sendBody>) {
  assertCan(user, 'core.email.use');
  const account = input.accountUuid
    ? ((await db('mail_accounts')
        .where({ uuid: input.accountUuid, user_id: user.id, active: true })
        .first()) as AccountRow | undefined)
    : ((await db('mail_accounts').where({ user_id: user.id, active: true }).first()) as
        AccountRow | undefined);
  if (input.accountUuid && !account) throw notFound('Mail account');
  const related = await resolveRelated(user, input.related, [...input.to, ...input.cc]);
  if (
    (await restrictedRecipients([...input.to, ...input.cc])) ||
    (related &&
      (related.type === 'contact' || related.type === 'lead') &&
      (await isRestrictedId(related.type, related.id)))
  )
    throw new AppError(
      'FORBIDDEN',
      'Processing is restricted for a recipient or the linked record. Lift the restriction before emailing.',
    );

  // A reply continues the conversation in the recipient's mail program too.
  let inReplyTo = input.inReplyTo ?? null;
  let references: string[] = inReplyTo ? [inReplyTo] : [];
  if (input.replyToActivityUuid) {
    const original = await db('activities')
      .join('email_messages as m', 'm.activity_id', 'activities.id')
      .where('activities.uuid', input.replyToActivityUuid)
      .whereNull('activities.deleted_at')
      .first('activities.id', 'm.message_id', 'm.thread_id');
    // The email must be on the record the reply is about (anyone who sees a record sees its emails).
    const onRecord =
      original && related
        ? await db('activities')
            .where({ 'activities.id': original.id })
            .where((w) => whereOnRecord(w, related.type, related.id))
            .first('id')
        : null;
    if (!original || !onRecord) throw notFound('Email');
    if (original.message_id) {
      inReplyTo = original.message_id as string;
      references = original.thread_id
        ? ((await db('email_messages')
            .where({ thread_id: original.thread_id })
            .whereNotNull('message_id')
            .orderBy('sent_at')
            .limit(20)
            .pluck('message_id')) as string[])
        : [inReplyTo];
    }
  }

  const html = sanitizeBody(input.body) ?? '';
  const text = html
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/p>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .trim();
  const name = `${user.firstName} ${user.lastName}`.trim() || user.email;
  let messageId: string | null = null;

  if (account && !mailbox.capture) {
    // Build the message once: the same bytes go out by SMTP and into the Sent folder.
    const built = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
      from: { name: account.display_name || name, address: account.email },
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      html,
      text,
      inReplyTo: inReplyTo ?? undefined,
      references: references.length ? references : undefined,
    });
    const raw = built.message as unknown as Buffer;
    messageId = built.messageId ?? null;
    await (
      await transportFor(account)
    ).sendMail({
      envelope: { from: account.email, to: [...input.to, ...input.cc] },
      raw,
    });
    await appendToSent(account, raw).catch((err: unknown) =>
      logger.warn({ err, account: account.uuid }, 'Could not copy the message to the Sent folder'),
    );
  } else {
    // No personal mailbox: send through the workspace SMTP, replies go to the user.
    const branding = await getBranding();
    for (const to of input.to) {
      await sendMail({
        to,
        subject: input.subject,
        html,
        text,
        fromName: `${name} (${branding.appName})`,
        fromAddress: branding.emailFromAddress || undefined,
        replyTo: user.email,
      });
    }
  }

  return db.transaction(async (trx) => {
    const activityUuid = newUuid();
    const [activityId] = await trx('activities').insert({
      uuid: activityUuid,
      type: 'email',
      subject: input.subject,
      body: html,
      completed_at: new Date(),
      owner_id: user.id,
      assignee_id: user.id,
      related_type: related?.type ?? null,
      related_id: related?.id ?? null,
      created_by: user.id,
      updated_by: user.id,
      custom: JSON.stringify({}),
    });
    const own = account?.email ?? user.email;
    await addParticipants(
      trx,
      activityId!,
      await participantsFromAddresses(
        trx,
        [
          ...input.to.map((address) => ({ address, role: 'to' as const })),
          ...input.cc.map((address) => ({ address, role: 'cc' as const })),
        ],
        [own],
      ),
    );
    await trx('email_messages').insert({
      uuid: newUuid(),
      thread_id: await threadFor(trx, {
        inReplyTo,
        references,
        subject: input.subject,
        addresses: [...input.to, ...input.cc],
      }),
      activity_id: activityId,
      mail_account_id: account?.id ?? null,
      direction: 'outbound',
      message_id: messageId,
      in_reply_to: inReplyTo,
      from_address: account?.email ?? user.email,
      to_addresses: JSON.stringify(input.to),
      cc_addresses: JSON.stringify(input.cc),
      subject: input.subject,
    });
    await audit(trx, ctx, {
      action: 'email.sent',
      entity: related?.type ?? 'email',
      entityId: related?.id ?? null,
      diff: { to: input.to, subject: input.subject },
    });
    return { activityUuid };
  });
}

// ---------- Receiving (IMAP) ----------

/**
 * Log one message from a synced folder when anyone on it is a known contact or lead: inbound mail
 * from INBOX, outbound mail the person wrote in their mail program (Sent). Returns whether it was logged.
 */
export async function logSyncedMessage(
  account: Pick<AccountRow, 'id' | 'user_id' | 'email'>,
  parsed: ParsedMail,
  direction: 'inbound' | 'outbound',
): Promise<boolean> {
  const from = parsed.from?.value[0]?.address?.toLowerCase();
  if (!from || !parsed.messageId) return false;
  // Already logged (sent from the CRM, or seen in another folder).
  if (await db('email_messages').where({ message_id: parsed.messageId }).first()) return false;
  const list = (v: typeof parsed.to) =>
    (Array.isArray(v) ? v.flatMap((t) => t.value) : (v?.value ?? []))
      .map((t) => t.address?.toLowerCase())
      .filter((a): a is string => !!a);
  const toList = list(parsed.to);
  const ccList = list(parsed.cc);
  // Logged when anyone on it is a known contact or lead (not only the sender).
  const people = await participantsFromAddresses(
    db,
    [
      { address: from, role: 'from' },
      ...toList.map((address) => ({ address, role: 'to' as const })),
      ...ccList.map((address) => ({ address, role: 'cc' as const })),
    ],
    [account.email],
  );
  const home = people.find((p) => p.kind === 'contact') ?? people.find((p) => p.kind === 'lead');
  if (!home) return false;
  const references = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references
      ? [parsed.references]
      : [];
  const html = sanitizeBody(typeof parsed.html === 'string' ? parsed.html : (parsed.textAsHtml ?? '')) ?? '';
  await db.transaction(async (trx) => {
    const [activityId] = await trx('activities').insert({
      uuid: newUuid(),
      type: 'email',
      subject: (parsed.subject ?? '(no subject)').slice(0, 255),
      body: html.slice(0, 200_000),
      completed_at: parsed.date ?? new Date(),
      owner_id: account.user_id,
      assignee_id: account.user_id,
      related_type: home.kind,
      related_id: home.record_id,
      custom: JSON.stringify({}),
    });
    await addParticipants(trx, activityId!, people);
    await trx('email_messages').insert({
      uuid: newUuid(),
      thread_id: await threadFor(trx, {
        inReplyTo: parsed.inReplyTo,
        references,
        subject: parsed.subject ?? '',
        addresses: [from, ...toList, ...ccList],
      }),
      activity_id: activityId,
      mail_account_id: account.id,
      direction,
      message_id: parsed.messageId,
      in_reply_to: parsed.inReplyTo ?? null,
      from_address: from,
      to_addresses: JSON.stringify(toList),
      cc_addresses: JSON.stringify(ccList),
      subject: (parsed.subject ?? '').slice(0, 500),
      sent_at: parsed.date ?? new Date(),
    });
  });
  return true;
}

/** New messages of one folder since the last seen UID (the first sync looks back 7 days). */
async function syncFolder(
  client: ImapFlow,
  account: AccountRow,
  folder: string,
  state: Record<string, number>,
  direction: 'inbound' | 'outbound',
): Promise<number> {
  let logged = 0;
  let lastUid = state[folder] ?? 0;
  const lock = await client.getMailboxLock(folder);
  try {
    const query = lastUid ? { uid: `${lastUid + 1}:*` } : { since: new Date(Date.now() - 7 * 86_400_000) };
    for await (const msg of client.fetch(query, { uid: true, source: true }, { uid: true })) {
      if (msg.uid <= lastUid) continue;
      lastUid = Math.max(lastUid, msg.uid);
      if (!msg.source) continue;
      if (await logSyncedMessage(account, await simpleParser(msg.source), direction)) logged++;
    }
  } finally {
    lock.release();
  }
  if (lastUid) state[folder] = lastUid;
  return logged;
}

/** Pull new mail from INBOX (and the Sent folder unless turned off) and log what involves known people. */
export async function syncAccount(account: AccountRow): Promise<number> {
  if (!account.imap) return 0;
  const client = await imapClient(account);
  const state: Record<string, number> = { ...(account.imap_state ?? {}) };
  if (state.INBOX === undefined && account.imap_last_uid) state.INBOX = account.imap_last_uid;
  let logged = 0;
  await client.connect();
  try {
    logged += await syncFolder(client, account, 'INBOX', state, 'inbound');
    if (account.sync_sent) {
      const folders = await client.list();
      const sent = folders.find((f) => f.specialUse === '\\Sent')?.path;
      if (sent) logged += await syncFolder(client, account, sent, state, 'outbound');
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  await db('mail_accounts')
    .where({ id: account.id })
    .update({
      imap_state: JSON.stringify(state),
      imap_last_uid: state.INBOX ?? null,
      last_sync_at: new Date(),
      last_error: null,
    });
  return logged;
}

export async function syncAllMailboxes() {
  const accounts = (await db('mail_accounts').where({ active: true }).whereNotNull('imap')) as AccountRow[];
  for (const a of accounts) {
    await syncAccount(a).catch(async (err: unknown) => {
      logger.warn({ err, account: a.uuid }, 'Mailbox sync failed');
      await db('mail_accounts')
        .where({ id: a.id })
        .update({ last_error: (err as Error).message.slice(0, 900), last_sync_at: new Date() });
    });
  }
}

export const startMailSync = () => {
  if (!isTest) every(5 * 60_000, 'mail-sync', syncAllMailboxes);
};

// ---------- Routes ----------

/** Back to Settings → Email after an OAuth sign-in, with the outcome for a message. */
function backToSettings(res: Response, outcome: { connected?: string; error?: string }) {
  const url = new URL(`${env.APP_URL.replace(/\/$/, '')}/settings/email`);
  for (const [k, v] of Object.entries(outcome)) if (v) url.searchParams.set(k, v);
  res.redirect(303, url.toString());
}

export const emailRoutes = defineRoutes('/email', ['email'])
  .add({
    method: 'get',
    path: '/oauth/providers',
    permission: 'core.email.use',
    summary: 'Sign-in options for mailboxes that the server operator configured',
    handler: () => ({ data: mailOAuthProviders().map((p) => ({ key: p.key, name: p.name })) }),
  })
  .add({
    method: 'post',
    path: '/oauth/:key/start',
    permission: 'core.email.use',
    params: z.object({ key: z.string().max(41) }),
    handler: async ({ user, params }) => ({ url: await startOAuth(user.id, params.key) }),
  })
  .add({
    method: 'get',
    path: '/oauth/callback',
    permission: 'core.email.use',
    query: z.object({
      code: z.string().max(4000).optional(),
      state: z.string().max(100).optional(),
      error: z.string().max(200).optional(),
    }),
    summary: 'Where the mail provider sends people back after signing in',
    handler: async ({ ctx, user, query, res }) => {
      if (query.error || !query.code || !query.state)
        return backToSettings(res, { error: 'The sign-in was cancelled or refused.' });
      try {
        const { email, provider, tokens } = await finishOAuth(user.id, query.state, query.code);
        const uuid = newUuid();
        await db.transaction(async (trx) => {
          await trx('mail_accounts')
            .insert({
              uuid,
              user_id: user.id,
              email,
              display_name: `${user.firstName} ${user.lastName}`.trim(),
              smtp: JSON.stringify(provider.smtp),
              imap: JSON.stringify(provider.imap),
              auth_type: 'oauth',
              oauth_provider: provider.key,
              password_enc: null,
              active: true,
              last_error: null,
              ...tokenColumns(tokens),
            })
            .onConflict(['user_id', 'email'])
            .merge([
              'smtp',
              'imap',
              'auth_type',
              'oauth_provider',
              'password_enc',
              'access_token_enc',
              'refresh_token_enc',
              'token_expires_at',
              'active',
              'last_error',
            ]);
          await audit(trx, ctx, {
            action: 'mail_account.connected',
            entity: 'mail_account',
            diff: { email, via: provider.key },
          });
        });
        return backToSettings(res, { connected: email });
      } catch (err) {
        return backToSettings(res, {
          error: err instanceof AppError ? err.message : 'The mailbox could not be connected. Try again.',
        });
      }
    },
  })
  .add({
    method: 'patch',
    path: '/accounts/:uuid',
    permission: 'core.email.use',
    params: z.object({ uuid: z.uuid() }),
    body: z.object({ syncSent: z.boolean() }),
    summary: 'Choose whether mail you send from your mail program is logged too',
    handler: async ({ ctx, user, params, body }) => {
      const n = await db('mail_accounts')
        .where({ uuid: params.uuid, user_id: user.id })
        .update({ sync_sent: body.syncSent });
      if (!n) throw notFound('Mail account');
      await audit(db, ctx, {
        action: 'mail_account.updated',
        entity: 'mail_account',
        entityUuid: params.uuid,
        diff: body,
      });
      return accountDto(await db('mail_accounts').where({ uuid: params.uuid }).first());
    },
  })
  .add({
    method: 'get',
    path: '/threads/:threadId',
    permission: 'core.activities.view',
    params: z.object({ threadId: z.uuid() }),
    query: z.object({ type: z.enum(RELATED_TYPES), uuid: z.uuid() }),
    summary: 'The messages of one conversation, as seen from a record the caller can open',
    handler: async ({ ctx, user, params, query }) => {
      // Visibility follows the record (decision D9): only messages on this record are listed.
      const def = recordDefs[query.type];
      assertCan(user, `${def.resource}.view`);
      const record = await getRow(def, user, query.uuid);
      const qb = db('activities')
        .join('email_messages as m', 'm.activity_id', 'activities.id')
        .whereNull('activities.deleted_at')
        .where('m.thread_id', params.threadId);
      whereOnRecord(qb, query.type, record.id as number);
      const rows = (await qb
        .orderBy('m.sent_at')
        .limit(200)
        .select(
          'activities.*',
          'm.direction',
          'm.from_address',
          'm.to_addresses',
          'm.cc_addresses',
          'm.message_id',
          'm.sent_at',
        )) as Record<string, unknown>[];
      await logAccess(ctx, {
        action: 'view',
        entity: query.type,
        entityId: record.id as number,
        entityUuid: query.uuid,
        detail: { thread: params.threadId },
      });
      const dtos = await activitiesDef.toDtos(rows as never[], { user, conn: db });
      return {
        data: dtos.map((a, i) => ({
          ...a,
          message: {
            direction: rows[i]!.direction as 'inbound' | 'outbound',
            from: rows[i]!.from_address as string,
            to: (rows[i]!.to_addresses as string[] | null) ?? [],
            cc: (rows[i]!.cc_addresses as string[] | null) ?? [],
            messageId: (rows[i]!.message_id as string | null) ?? null,
            sentAt: new Date(rows[i]!.sent_at as string).toISOString(),
          },
        })),
      };
    },
  })
  .add({
    method: 'get',
    path: '/accounts',
    permission: 'core.email.use',
    handler: async ({ user }) => ({
      data: (await db('mail_accounts').where({ user_id: user.id })).map(accountDto),
    }),
  })
  .add({
    method: 'post',
    path: '/accounts',
    permission: 'core.email.use',
    body: accountBody,
    status: 201,
    summary: 'Connect a mailbox. SMTP is verified before saving.',
    handler: async ({ ctx, user, body }) => {
      if (!isTest && !mailbox.capture) {
        await nodemailer
          .createTransport({
            host: body.smtp.host,
            port: body.smtp.port,
            secure: body.smtp.secure,
            auth: { user: body.email, pass: body.password },
          })
          .verify()
          .catch((err: Error) => {
            throw new AppError('VALIDATION_FAILED', `Could not sign in to the mail server: ${err.message}`, [
              { path: 'password', message: 'Sign-in failed' },
            ]);
          });
      }
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        await trx('mail_accounts')
          .insert({
            uuid,
            user_id: user.id,
            email: body.email.toLowerCase(),
            display_name: body.displayName,
            smtp: JSON.stringify(body.smtp),
            imap: body.imap ? JSON.stringify(body.imap) : null,
            password_enc: encrypt(body.password, 'mail_accounts.password_enc'),
          })
          .onConflict(['user_id', 'email'])
          .merge(['display_name', 'smtp', 'imap', 'password_enc']);
        await audit(trx, ctx, {
          action: 'mail_account.connected',
          entity: 'mail_account',
          entityUuid: uuid,
          diff: { email: body.email },
        });
      });
      return accountDto(
        await db('mail_accounts').where({ user_id: user.id, email: body.email.toLowerCase() }).first(),
      );
    },
  })
  .add({
    method: 'delete',
    path: '/accounts/:uuid',
    permission: 'core.email.use',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ ctx, user, params }) => {
      const n = await db('mail_accounts').where({ uuid: params.uuid, user_id: user.id }).delete();
      if (!n) throw notFound('Mail account');
      await audit(db, ctx, {
        action: 'mail_account.disconnected',
        entity: 'mail_account',
        entityUuid: params.uuid,
      });
    },
  })
  .add({
    method: 'post',
    path: '/accounts/:uuid/sync',
    permission: 'core.email.use',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ user, params }) => {
      const a = (await db('mail_accounts').where({ uuid: params.uuid, user_id: user.id }).first()) as
        AccountRow | undefined;
      if (!a) throw notFound('Mail account');
      if (!a.imap) throw new AppError('VALIDATION_FAILED', 'Add incoming mail (IMAP) settings to sync');
      return { logged: await syncAccount(a) };
    },
  })
  .add({
    method: 'post',
    path: '/send',
    permission: 'core.email.use',
    body: sendBody,
    status: 201,
    handler: ({ ctx, user, body }) => sendEmail(ctx, user, body),
  });

async function isRestrictedId(type: 'contact' | 'lead', id: number) {
  const row = await db(recordDefs[type].table).where({ id }).first('processing_restricted');
  return !!row?.processing_restricted;
}
