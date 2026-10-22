import type { NextFunction, Request, Response } from 'express';
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
  every,
  applyScope,
  logger,
  type AuthUser,
  uploadSingle,
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
import { createTicketAsCustomer, customerTickets, replyAsCustomer } from '../../tickets/api';
import {
  customerDocument,
  customerHasOpenRequest,
  customerLibrary,
  signAsCustomer,
  submitFileAsCustomer,
} from '../../documents/api';
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
    .join('contacts as c', 'c.id', 'a.contact_id')
    .whereNull('c.deleted_at') // Archiving the contact ends portal access.
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

/**
 * Issue a one-time link and email it. A new invite cancels earlier unused links; login links are
 * throttled to one a minute per account so nobody can flood a customer's inbox.
 */
async function emailLink(account: Account, purpose: 'login' | 'invite', ctx: RequestContext) {
  const token = randomToken(32);
  const issued = await db.transaction(async (trx) => {
    if (purpose === 'login') {
      const recent = await trx(TOKENS)
        .where({ account_id: account.id })
        .where('created_at', '>', new Date(Date.now() - 60_000))
        // Login links expire within LOGIN_LINK_MS; invitation links last longer and do not count.
        // (+1 minute margin: DATETIME rounds to whole seconds.)
        .where('expires_at', '<=', new Date(Date.now() + LOGIN_LINK_MS + 60_000))
        .first('id');
      if (recent) return false;
    } else {
      await trx(TOKENS)
        .where({ account_id: account.id })
        .whereNull('used_at')
        .update({ used_at: new Date() });
    }
    await trx(TOKENS).insert({
      account_id: account.id,
      token_hash: sha256(token),
      expires_at: new Date(Date.now() + (purpose === 'invite' ? INVITE_LINK_MS : LOGIN_LINK_MS)),
    });
    await audit(trx, ctx, {
      action: `portal.${purpose}_link_issued`,
      entity: 'portal.account',
      entityId: account.id,
      entityUuid: account.uuid,
    });
    return true;
  });
  if (!issued) return;
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
const ticketLimiter = rateLimiter(20);

/** Before multipart parsing: the caller must hold a portal session and own an open file request. */
async function uploadGate(req: Request, res: Response, next: NextFunction) {
  try {
    const account = await currentAccount(req);
    if (
      !isModuleEnabled('documents') ||
      !(await customerHasOpenRequest(account.contact_id, String(req.params.uuid)))
    )
      throw notFound('File request');
    res.locals.portalAccount = account;
    next();
  } catch (err) {
    next(err);
  }
}

const publicRoutes = defineRoutes('/public/portal', ['portal'], 'portal')
  .add({
    method: 'post',
    path: '/login',
    permission: 'public',
    before: [loginLimiter],
    body: z.object({ email: z.email().max(254) }),
    summary: 'Email a sign-in link. Always answers the same way, so it cannot reveal who has access.',
    handler: async ({ ctx, body }) => {
      const account = await db(`${ACCOUNTS} as a`)
        .join('contacts as c', 'c.id', 'a.contact_id')
        .whereNull('c.deleted_at')
        .where({ 'a.email': body.email.toLowerCase(), 'a.status': 'active' })
        .first('a.*');
      // Sent in the background: response time and mail errors must not reveal who has access.
      if (account)
        void emailLink(account as Account, 'login', portalCtx(ctx, account as Account)).catch(
          (err: unknown) => logger.error({ err }, 'Portal sign-in email failed'),
        );
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
        const acc = await trx(`${ACCOUNTS} as a`)
          .join('contacts as c', 'c.id', 'a.contact_id')
          .whereNull('c.deleted_at')
          .where({ 'a.id': link.account_id, 'a.status': 'active' })
          .first('a.*');
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
        // Identity only: numbering, terms and other settings stay internal.
        business: {
          name: commerce.legalName || branding.appName,
          legalName: commerce.legalName,
          address: commerce.address,
          taxId: commerce.taxId,
          email: commerce.email,
          phone: commerce.phone,
        },
        features: {
          quotes: isModuleEnabled('quotes'),
          invoices: isModuleEnabled('invoices'),
          contracts: isModuleEnabled('contracts'),
          tickets: isModuleEnabled('tickets'),
          documents: isModuleEnabled('documents'),
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
    path: '/tickets',
    permission: 'public',
    handler: async ({ req }) => {
      const account = await currentAccount(req);
      if (!isModuleEnabled('tickets')) return { data: [] };
      return { data: await customerTickets(matcherFor(account)) };
    },
  })
  .add({
    method: 'post',
    path: '/tickets',
    permission: 'public',
    before: [ticketLimiter],
    body: z.object({
      subject: z.string().trim().min(3).max(250),
      description: z.string().trim().min(1).max(10000),
    }),
    status: 201,
    summary:
      'The customer raises a support ticket. It is linked to their contact (and primary organization).',
    handler: async ({ req, ctx, body }) => {
      const account = await currentAccount(req);
      if (!isModuleEnabled('tickets')) throw notFound('Ticket');
      const uuid = await createTicketAsCustomer(portalCtx(ctx, account), account.contact_id, body);
      return (await customerTickets(matcherFor(account), uuid))[0];
    },
  })
  .add({
    method: 'get',
    path: '/tickets/:uuid',
    permission: 'public',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ req, params }) => {
      const account = await currentAccount(req);
      if (!isModuleEnabled('tickets')) throw notFound('Ticket');
      const [t] = await customerTickets(matcherFor(account), params.uuid);
      if (!t) throw notFound('Ticket');
      return t;
    },
  })
  .add({
    method: 'post',
    path: '/tickets/:uuid/replies',
    permission: 'public',
    before: [ticketLimiter],
    params: z.object({ uuid: z.uuid() }),
    body: z.object({ body: z.string().trim().min(1).max(10000) }),
    handler: async ({ req, ctx, params, body }) => {
      const account = await currentAccount(req);
      if (!isModuleEnabled('tickets')) throw notFound('Ticket');
      await replyAsCustomer(
        portalCtx(ctx, account),
        matcherFor(account),
        account.contact_id,
        params.uuid,
        body.body,
      );
      return (await customerTickets(matcherFor(account), params.uuid))[0];
    },
  })
  .add({
    method: 'get',
    path: '/library',
    permission: 'public',
    summary: 'Documents shared with the customer and files they have been asked for.',
    handler: async ({ req }) => {
      const account = await currentAccount(req);
      if (!isModuleEnabled('documents')) return { documents: [], requests: [] };
      return customerLibrary(account.contact_id);
    },
  })
  .add({
    method: 'get',
    path: '/docs/:uuid',
    permission: 'public',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ req, params }) => {
      const account = await currentAccount(req);
      if (!isModuleEnabled('documents')) throw notFound('Document');
      return customerDocument(account.contact_id, params.uuid);
    },
  })
  .add({
    method: 'post',
    path: '/docs/:uuid/sign',
    permission: 'public',
    before: [ticketLimiter],
    params: z.object({ uuid: z.uuid() }),
    body: z.object({ name: z.string().trim().min(2).max(200), agree: z.literal(true) }),
    summary: 'Sign by typing a full name and confirming agreement.',
    handler: async ({ req, ctx, params, body }) => {
      const account = await currentAccount(req);
      if (!isModuleEnabled('documents')) throw notFound('Document');
      await signAsCustomer(portalCtx(ctx, account), account.contact_id, params.uuid, body.name);
      return customerDocument(account.contact_id, params.uuid);
    },
  })
  .add({
    method: 'post',
    path: '/requests/:uuid/upload',
    permission: 'public',
    before: [ticketLimiter, uploadGate, uploadSingle()],
    params: z.object({ uuid: z.uuid() }),
    status: 201,
    handler: async ({ req, res, ctx, params }) => {
      const account = (res as Response).locals.portalAccount as Account;
      if (!req.file) throw new AppError('VALIDATION_FAILED', 'Choose a file to upload');
      await submitFileAsCustomer(portalCtx(ctx, account), account.contact_id, params.uuid, req.file);
      return { ok: true };
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

/** Portal accounts for contacts this staff member can see (contact record scope applies). */
async function accountsQuery(user: AuthUser) {
  const qb = db(`${ACCOUNTS} as a`)
    .join('contacts as c', 'c.id', 'a.contact_id')
    .whereNull('c.deleted_at')
    .select('a.*', 'c.uuid as contact_uuid', 'c.full_name as contact_name');
  await applyScope(qb, user, 'core.contacts', ['c.owner_id']);
  return { qb };
}

async function scopedAccount(user: AuthUser, uuid: string) {
  const { qb } = await accountsQuery(user);
  const a = await qb.where('a.uuid', uuid).first();
  if (!a) throw notFound('Portal account');
  return a as Record<string, unknown> & Account;
}

const staffRoutes = defineRoutes('/m/portal/accounts', ['portal'], 'portal')
  .add({
    method: 'get',
    path: '/',
    permission: 'portal.accounts.manage',
    handler: async ({ user }) => {
      const { qb } = await accountsQuery(user);
      return { data: (await qb.orderBy('a.id', 'desc').limit(500)).map(accountDto) };
    },
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
      await emailLink(account, 'invite', ctx);
      return accountDto(await scopedAccount(user, uuid));
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
    handler: async ({ ctx, user, params, body }) => {
      await scopedAccount(user, params.uuid);
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
      return accountDto(await scopedAccount(user, params.uuid));
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/invite',
    permission: 'portal.accounts.manage',
    params: z.object({ uuid: z.uuid() }),
    summary: 'Send a fresh invitation link.',
    handler: async ({ ctx, user, params }) => {
      const a = await scopedAccount(user, params.uuid);
      if (a.status !== 'active')
        throw new AppError('CONFLICT', 'Restore access before sending an invitation');
      await db.transaction(async (trx) => {
        await trx(ACCOUNTS).where({ id: a.id }).update({ invited_at: new Date() });
        await audit(trx, ctx, {
          action: 'portal.account.reinvited',
          entity: 'portal.account',
          entityId: a.id,
          entityUuid: params.uuid,
        });
      });
      // Issuing the link is audited on its own and cancels earlier unused invitations.
      await emailLink(a, 'invite', ctx);
      return { ok: true };
    },
  });

/** Remove sign-in links and sessions that can no longer be used (expired or spent over a day ago). */
export async function purgePortalCredentials() {
  if (!isModuleEnabled('portal')) return { tokens: 0, sessions: 0 };
  const dayAgo = new Date(Date.now() - 86_400_000);
  const tokens = await db(TOKENS)
    .where((w) => w.where('expires_at', '<', new Date()).orWhere('used_at', '<', dayAgo))
    .delete();
  const sessions = await db(SESSIONS).where('expires_at', '<', new Date()).delete();
  return { tokens, sessions };
}

export const portal: ApiModule = {
  routes: () => [publicRoutes, staffRoutes],
  migrations: { '0001_portal': m0001 },
  start: () => every(6 * 60 * 60_000, 'portal.purge', purgePortalCredentials),
};
