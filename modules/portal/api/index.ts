import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { z } from 'zod';
import {
  AppError,
  appUrl,
  audit,
  cookieOptions,
  db,
  defineRoutes,
  getBranding,
  getSettingsGroup,
  isModuleEnabled,
  iso,
  newUuid,
  notFound,
  randomToken,
  rateLimiter,
  resolveLinks,
  sendMail,
  sha256,
  systemContext,
  type ApiModule,
  type RequestContext,
} from '@app/api/module-api';
import { customerQuotes, respondAsCustomer } from '../../quotes/api';
import { customerInvoices } from '../../invoices/api';
import { customerContracts } from '../../contracts/api';
import * as m0001 from './migrations/0001_portal';

const ACCOUNTS = 'm_portal_accounts';
const TOKENS = 'm_portal_tokens';
const SESSIONS = 'm_portal_sessions';
const COOKIE = 'portal_session';
const COOKIE_PATH = '/api/v1/public/portal';
const SESSION_MS = 30 * 86_400_000;
const LOGIN_LINK_MS = 15 * 60_000;
const INVITE_LINK_MS = 7 * 86_400_000;

interface Account {
  id: number;
  uuid: string;
  contact_id: number;
  email: string;
  organization_access: number | boolean;
  status: 'active' | 'disabled';
}

// ---------- Sessions ----------

async function currentAccount(req: Request): Promise<Account> {
  const token = req.cookies?.[COOKIE] as string | undefined;
  if (!token) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
  const row = await db(`${SESSIONS} as s`)
    .join(`${ACCOUNTS} as a`, 'a.id', 's.account_id')
    .where('s.token_hash', sha256(token))
    .where('s.expires_at', '>', new Date())
    .where('a.status', 'active')
    .first('a.*', 's.id as session_id');
  if (!row) throw new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.');
  await db(SESSIONS).where({ id: row.session_id }).update({ last_seen_at: new Date() });
  return row as Account;
}

/**
 * What one customer may see: documents linked to their contact, plus (when staff allowed it)
 * documents of the organizations that contact belongs to.
 */
function matcherFor(account: Account) {
  return (qb: Knex.QueryBuilder) => {
    qb.where((w) => {
      w.where('contact_id', account.contact_id);
      if (account.organization_access)
        w.orWhereIn(
          'organization_id',
          db('contact_organization')
            .where({ contact_id: account.contact_id })
            .whereNull('ended_at')
            .select('organization_id'),
        );
    });
  };
}

const portalCtx = (ctx: RequestContext, account: Account): RequestContext => ({
  ...systemContext(`portal:${account.uuid}`),
  ip: ctx.ip,
  userAgent: ctx.userAgent,
});

// ---------- Login links ----------

async function emailLink(account: Account, purpose: 'login' | 'invite') {
  const token = randomToken(32);
  await db(TOKENS).insert({
    account_id: account.id,
    token_hash: sha256(token),
    expires_at: new Date(Date.now() + (purpose === 'invite' ? INVITE_LINK_MS : LOGIN_LINK_MS)),
  });
  const [branding, commerce, contact] = await Promise.all([
    getBranding(),
    getSettingsGroup('commerce'),
    db('contacts').where({ id: account.contact_id }).first('first_name'),
  ]);
  const name = commerce.legalName || branding.appName;
  const url = appUrl(`/p/portal/verify?token=${encodeURIComponent(token)}`);
  const hello = contact?.first_name ? `Hi ${contact.first_name},` : 'Hello,';
  const lead =
    purpose === 'invite'
      ? `${name} has given you access to your documents online. Use the button below to sign in. The link works for 7 days.`
      : 'Use the button below to sign in. The link works for 15 minutes and only once.';
  await sendMail({
    to: account.email,
    subject: purpose === 'invite' ? `Your documents from ${name}` : `Sign in to ${name}`,
    html: `<p>${escapeHtml(hello)}</p><p>${escapeHtml(lead)}</p><p><a href="${url}">Sign in</a></p><p>If you did not ask for this, you can ignore this email.</p>`,
    text: `${hello}\n\n${lead}\n\n${url}\n\nIf you did not ask for this, you can ignore this email.`,
    fromName: branding.emailFromName || name,
    fromAddress: branding.emailFromAddress || undefined,
  });
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------- Customer-facing routes (no staff session; the portal cookie is the credential) ----------

const loginLimiter = rateLimiter(5);
const sessionLimiter = rateLimiter(20);

const publicRoutes = defineRoutes('/public/portal', ['portal'], 'portal')
  .add({
    method: 'post',
    path: '/login',
    permission: 'public',
    before: [loginLimiter],
    body: z.object({ email: z.email().max(254) }),
    summary: 'Email a sign-in link. Always answers the same way, so it cannot reveal who has access.',
    handler: async ({ body }) => {
      const account = await db(ACCOUNTS).where({ email: body.email.toLowerCase(), status: 'active' }).first();
      if (account) await emailLink(account as Account, 'login');
      return { ok: true };
    },
  })
  .add({
    method: 'post',
    path: '/session',
    permission: 'public',
    before: [sessionLimiter],
    body: z.object({ token: z.string().min(20).max(200) }),
    summary: 'Exchange a one-time link for a portal session cookie.',
    handler: async ({ ctx, res, body }) => {
      const token = randomToken(32);
      const account = await db.transaction(async (trx) => {
        const link = await trx(TOKENS)
          .where({ token_hash: sha256(body.token) })
          .forUpdate()
          .first();
        if (!link || link.used_at || new Date(link.expires_at) < new Date())
          throw new AppError(
            'VALIDATION_FAILED',
            'This link has expired or was already used. Ask for a new one.',
          );
        const acc = await trx(ACCOUNTS).where({ id: link.account_id, status: 'active' }).first();
        if (!acc)
          throw new AppError(
            'VALIDATION_FAILED',
            'This link has expired or was already used. Ask for a new one.',
          );
        await trx(TOKENS).where({ id: link.id }).update({ used_at: new Date() });
        await trx(SESSIONS).insert({
          account_id: acc.id,
          token_hash: sha256(token),
          expires_at: new Date(Date.now() + SESSION_MS),
          ip: ctx.ip?.slice(0, 64) ?? null,
          user_agent: ctx.userAgent?.slice(0, 255) ?? null,
        });
        await trx(ACCOUNTS).where({ id: acc.id }).update({ last_login_at: new Date() });
        await audit(trx, portalCtx(ctx, acc as Account), {
          action: 'portal.signed_in',
          entity: 'portal.account',
          entityId: acc.id,
          entityUuid: acc.uuid,
        });
        return acc as Account;
      });
      (res as Response).cookie(COOKIE, token, cookieOptions(COOKIE_PATH, SESSION_MS));
      return { ok: true, account: account.uuid };
    },
  })
  .add({
    method: 'post',
    path: '/logout',
    permission: 'public',
    handler: async ({ req, res }) => {
      const token = req.cookies?.[COOKIE] as string | undefined;
      if (token)
        await db(SESSIONS)
          .where({ token_hash: sha256(token) })
          .delete();
      (res as Response).clearCookie(COOKIE, { path: COOKIE_PATH });
    },
  })
  .add({
    method: 'get',
    path: '/me',
    permission: 'public',
    handler: async ({ req }) => {
      const account = await currentAccount(req);
      const [contact, commerce, branding] = await Promise.all([
        db('contacts').where({ id: account.contact_id }).first('first_name', 'last_name', 'full_name'),
        getSettingsGroup('commerce'),
        getBranding(),
      ]);
      return {
        name: contact?.full_name ?? '',
        firstName: contact?.first_name ?? '',
        email: account.email,
        business: { ...commerce, name: commerce.legalName || branding.appName },
        features: {
          quotes: isModuleEnabled('quotes'),
          invoices: isModuleEnabled('invoices'),
          contracts: isModuleEnabled('contracts'),
        },
      };
    },
  })
  .add({
    method: 'get',
    path: '/documents',
    permission: 'public',
    handler: async ({ req }) => {
      const account = await currentAccount(req);
      const match = matcherFor(account);
      const [quotes, invoices, contracts] = await Promise.all([
        isModuleEnabled('quotes') ? customerQuotes(match) : [],
        isModuleEnabled('invoices') ? customerInvoices(match) : [],
        isModuleEnabled('contracts') ? customerContracts(match) : [],
      ]);
      return { quotes, invoices, contracts };
    },
  })
  .add({
    method: 'get',
    path: '/quotes/:uuid',
    permission: 'public',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ req, params }) => {
      const account = await currentAccount(req);
      if (!isModuleEnabled('quotes')) throw notFound('Quote');
      const [q] = await customerQuotes(matcherFor(account), params.uuid);
      if (!q) throw notFound('Quote');
      return q;
    },
  })
  .add({
    method: 'post',
    path: '/quotes/:uuid/accept',
    permission: 'public',
    params: z.object({ uuid: z.uuid() }),
    body: z.object({ name: z.string().trim().min(2).max(200) }),
    summary: 'The customer accepts a sent quote, typing their name as a signature.',
    handler: async ({ req, ctx, params, body }) => {
      const account = await currentAccount(req);
      if (!isModuleEnabled('quotes')) throw notFound('Quote');
      await respondAsCustomer(portalCtx(ctx, account), matcherFor(account), params.uuid, {
        accept: true,
        name: body.name,
      });
      return (await customerQuotes(matcherFor(account), params.uuid))[0];
    },
  })
  .add({
    method: 'post',
    path: '/quotes/:uuid/decline',
    permission: 'public',
    params: z.object({ uuid: z.uuid() }),
    body: z.object({ reason: z.string().trim().max(500).nullish() }),
    handler: async ({ req, ctx, params, body }) => {
      const account = await currentAccount(req);
      if (!isModuleEnabled('quotes')) throw notFound('Quote');
      await respondAsCustomer(portalCtx(ctx, account), matcherFor(account), params.uuid, {
        accept: false,
        reason: body.reason ?? null,
      });
      return (await customerQuotes(matcherFor(account), params.uuid))[0];
    },
  })
  .add({
    method: 'get',
    path: '/invoices/:uuid',
    permission: 'public',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ req, params }) => {
      const account = await currentAccount(req);
      if (!isModuleEnabled('invoices')) throw notFound('Invoice');
      const [inv] = await customerInvoices(matcherFor(account), params.uuid);
      if (!inv) throw notFound('Invoice');
      return inv;
    },
  });

// ---------- Staff routes ----------

const accountDto = (a: Record<string, unknown>) => ({
  uuid: a.uuid as string,
  email: a.email as string,
  status: a.status as string,
  organizationAccess: !!a.organization_access,
  contact: { uuid: a.contact_uuid as string, name: a.contact_name as string },
  invitedAt: iso(a.invited_at),
  lastLoginAt: iso(a.last_login_at),
});

const accountsQuery = () =>
  db(`${ACCOUNTS} as a`)
    .join('contacts as c', 'c.id', 'a.contact_id')
    .select('a.*', 'c.uuid as contact_uuid', 'c.full_name as contact_name');

const staffRoutes = defineRoutes('/m/portal/accounts', ['portal'], 'portal')
  .add({
    method: 'get',
    path: '/',
    permission: 'portal.accounts.manage',
    handler: async () => ({
      data: (await accountsQuery().orderBy('a.id', 'desc').limit(500)).map(accountDto),
    }),
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'portal.accounts.manage',
    body: z.object({ contactUuid: z.uuid(), organizationAccess: z.boolean().default(false) }),
    status: 201,
    summary: 'Give a contact portal access and email them an invitation.',
    handler: async ({ ctx, user, body }) => {
      // Staff can only invite contacts they can see.
      const { contact_id } = await resolveLinks(user, { contactUuid: body.contactUuid });
      const contact = await db('contacts').where({ id: contact_id! }).first('email');
      if (!contact?.email)
        throw new AppError('VALIDATION_FAILED', 'This contact has no email address', [
          { path: 'contactUuid', message: 'Add an email address first' },
        ]);
      const email = String(contact.email).toLowerCase();
      const clash = await db(ACCOUNTS).where({ email }).whereNot({ contact_id: contact_id! }).first('id');
      if (clash) throw new AppError('CONFLICT', 'Another portal account already uses this email address');
      const existing = await db(ACCOUNTS).where({ contact_id: contact_id! }).first();
      const uuid = existing?.uuid ?? newUuid();
      await db.transaction(async (trx) => {
        if (existing)
          await trx(ACCOUNTS).where({ id: existing.id }).update({
            email,
            status: 'active',
            organization_access: body.organizationAccess,
            invited_at: new Date(),
          });
        else
          await trx(ACCOUNTS).insert({
            uuid,
            contact_id,
            email,
            organization_access: body.organizationAccess,
            invited_at: new Date(),
            created_by: user.id,
          });
        await audit(trx, ctx, {
          action: 'portal.account.invited',
          entity: 'portal.account',
          entityUuid: uuid,
          diff: { email, organizationAccess: body.organizationAccess },
        });
      });
      const account = (await db(ACCOUNTS).where({ uuid }).first()) as Account;
      await emailLink(account, 'invite');
      return accountDto(await accountsQuery().where('a.uuid', uuid).first());
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'portal.accounts.manage',
    params: z.object({ uuid: z.uuid() }),
    body: z.object({
      status: z.enum(['active', 'disabled']).optional(),
      organizationAccess: z.boolean().optional(),
    }),
    summary: 'Disabling access also signs the customer out everywhere.',
    handler: async ({ ctx, params, body }) => {
      await db.transaction(async (trx) => {
        const a = await trx(ACCOUNTS).where({ uuid: params.uuid }).forUpdate().first();
        if (!a) throw notFound('Portal account');
        const patch: Record<string, unknown> = {};
        if (body.status) patch.status = body.status;
        if (body.organizationAccess !== undefined) patch.organization_access = body.organizationAccess;
        if (Object.keys(patch).length) await trx(ACCOUNTS).where({ id: a.id }).update(patch);
        if (body.status === 'disabled') {
          await trx(SESSIONS).where({ account_id: a.id }).delete();
          await trx(TOKENS).where({ account_id: a.id }).whereNull('used_at').update({ used_at: new Date() });
        }
        await audit(trx, ctx, {
          action: 'portal.account.updated',
          entity: 'portal.account',
          entityId: a.id,
          entityUuid: params.uuid,
          diff: body,
        });
      });
      return accountDto(await accountsQuery().where('a.uuid', params.uuid).first());
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/invite',
    permission: 'portal.accounts.manage',
    params: z.object({ uuid: z.uuid() }),
    summary: 'Send a fresh invitation link.',
    handler: async ({ ctx, params }) => {
      const a = await db(ACCOUNTS).where({ uuid: params.uuid, status: 'active' }).first();
      if (!a) throw notFound('Portal account');
      await db(ACCOUNTS).where({ id: a.id }).update({ invited_at: new Date() });
      await emailLink(a as Account, 'invite');
      await audit(db, ctx, {
        action: 'portal.account.reinvited',
        entity: 'portal.account',
        entityUuid: params.uuid,
      });
      return { ok: true };
    },
  });

export const portal: ApiModule = {
  routes: () => [publicRoutes, staffRoutes],
  migrations: { '0001_portal': m0001 },
};
