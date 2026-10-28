import { createHash } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { defineRoutes } from '../../http/routes';
import type { AuthUser } from '../../http/context';
import { db } from '../../db/knex';
import { env } from '../../config/env';
import { AppError, notFound } from '../../lib/errors';
import { randomToken, sha256 } from '../../lib/crypto';
import { newUuid } from '../../lib/ids';
import { rateLimiter } from '../../modules/helpers';
import type { Db } from '../../db/knex';
import { mfaRequiredFor } from '@app/shared';
import { audit } from '../audit/audit.service';
import { loadAccess } from '../rbac/access';
import { effectiveCompliance, effectiveSecurity, getBranding, getGroup } from '../settings/settings.service';
import { iso } from '../records/hydrate';

/** Access tokens are short-lived; refresh tokens rotate on every use. */
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 30 * 86_400_000;
const CODE_TTL_MS = 5 * 60_000;
/** An approval lasts at most this long without the person approving again (or the compliance limit). */
const MAX_GRANT_DAYS = 365;

const tokenBody = z.object({
  grant_type: z.string().max(40),
  code: z.string().max(200).optional(),
  code_verifier: z.string().min(43).max(128).optional(),
  client_id: z.string().max(64).optional(),
  redirect_uri: z.string().max(2000).optional(),
  refresh_token: z.string().max(200).optional(),
});

/** Registration is public: its own tight per-address limit, separate from sign-in. */
const registerLimiter = rateLimiter(10);
/** Token and revocation calls, per address, apart from the sign-in limiter. */
const clientLimiter = rateLimiter(60);
export const OAUTH_TOKEN_PREFIX = 'mat_';
const SCOPES = { read: 'mcp:read', full: 'mcp:full' } as const;

const origin = () => new URL(env.APP_URL).origin;
export const mcpResource = () => `${origin()}/api/v1/mcp`;
const resourceMetadataUrl = () => `${origin()}/.well-known/oauth-protected-resource/api/v1/mcp`;

/** The header that tells an MCP client where to find the authorization server. */
export const wwwAuthenticate = () => `Bearer resource_metadata="${resourceMetadataUrl()}"`;

async function mcpEnabled() {
  return (await getGroup('mcp')).enabled;
}

/** Discovery documents (RFC 9728, RFC 8414), served at the site root. Off while MCP is off. */
export function oauthWellKnownRouter(): Router {
  const r = Router();
  const gate = (_req: Request, res: Response, next: NextFunction) =>
    void mcpEnabled().then((on) => (on ? next() : res.status(404).end()), next);
  const resource = (_req: Request, res: Response) =>
    res.json({
      resource: mcpResource(),
      authorization_servers: [origin()],
      scopes_supported: Object.values(SCOPES),
      bearer_methods_supported: ['header'],
    });
  r.get('/.well-known/oauth-protected-resource', gate, resource);
  r.get('/.well-known/oauth-protected-resource/api/v1/mcp', gate, resource);
  r.get('/.well-known/oauth-authorization-server', gate, (_req, res) => {
    const app = new URL(env.APP_URL);
    res.json({
      issuer: origin(),
      // The approval page is part of the app, so a person signs in and sees what they allow.
      authorization_endpoint: `${app.origin}${app.pathname.replace(/\/$/, '')}/oauth/authorize`,
      token_endpoint: `${origin()}/api/v1/oauth/token`,
      registration_endpoint: `${origin()}/api/v1/oauth/register`,
      revocation_endpoint: `${origin()}/api/v1/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: Object.values(SCOPES),
    });
  });
  return r;
}

/** Redirect URIs must be https, or http on this machine (desktop clients). */
const redirectUri = z
  .url()
  .max(2000)
  .refine((u) => {
    const url = new URL(u);
    if (url.hash) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    // Native apps may use their own scheme (not javascript:, data: and the like).
    return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(url.protocol);
  }, 'Use https, a loopback address, or an app scheme');

async function clientFor(clientId: string, uri: string) {
  const client = await db('oauth_clients').where({ client_id: clientId }).first();
  if (!client) throw new AppError('VALIDATION_FAILED', 'Unknown client');
  const uris = (
    typeof client.redirect_uris === 'string' ? JSON.parse(client.redirect_uris) : client.redirect_uris
  ) as string[];
  // Exact match only: never redirect a code anywhere the client did not register.
  if (!uris.includes(uri))
    throw new AppError('VALIDATION_FAILED', 'That redirect address is not registered for this client');
  return client as { id: number; client_id: string; name: string };
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

interface Grant {
  clientId: number;
  userId: number;
  readOnly: boolean;
  /** Shared by every token of one approval; reuse of a spent refresh token revokes them all. */
  familyId: string;
  /** When the person approved the client; refreshes never extend past the credential age limit. */
  grantedAt: Date;
  codeId?: number | null;
}

async function issueTokens(conn: Db, g: Grant) {
  const access = `${OAUTH_TOKEN_PREFIX}${randomToken(32)}`;
  const refresh = `mrt_${randomToken(32)}`;
  const { apiKeyMaxDays } = await effectiveCompliance();
  const limit = g.grantedAt.getTime() + (apiKeyMaxDays > 0 ? apiKeyMaxDays : MAX_GRANT_DAYS) * 86_400_000;
  const refreshUntil = new Date(Math.min(Date.now() + REFRESH_TTL_MS, limit));
  const [id] = await conn('oauth_tokens').insert({
    uuid: newUuid(),
    client_id: g.clientId,
    user_id: g.userId,
    access_hash: sha256(access),
    refresh_hash: sha256(refresh),
    read_only: g.readOnly,
    access_expires_at: new Date(Math.min(Date.now() + ACCESS_TTL_S * 1000, refreshUntil.getTime())),
    refresh_expires_at: refreshUntil,
    family_id: g.familyId,
    granted_at: g.grantedAt,
    code_id: g.codeId ?? null,
  });
  return {
    id: id!,
    body: {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: g.readOnly ? SCOPES.read : `${SCOPES.read} ${SCOPES.full}`,
    },
  };
}

/** Token lifecycle in the audit log, attributed to the person the token acts for. */
async function auditToken(
  conn: Db,
  req: Request,
  userId: number,
  action: string,
  tokenId: number,
  diff?: unknown,
) {
  const user = await conn('users')
    .where({ id: userId })
    .first('id', 'uuid', 'email', 'first_name', 'last_name');
  await audit(
    conn,
    { ...req.ctx, user: user ? ({ id: user.id, via: 'mcp' } as AuthUser) : null },
    {
      action,
      entity: 'oauth_token',
      entityId: tokenId,
      diff,
    },
  );
}

/** Whether a person may hold AI-client tokens now (two-factor enrolment when the workspace requires it). */
async function mayHoldTokens(userId: number, conn: Db = db) {
  const u = await conn('users')
    .where({ id: userId, status: 'active' })
    .whereNull('deleted_at')
    .first('totp_enabled');
  if (!u) return false;
  if (u.totp_enabled) return true;
  return !mfaRequiredFor(await loadAccess(userId), await effectiveSecurity(), await effectiveCompliance());
}

/** OAuth errors use the RFC 6749 shape, which clients expect, not the app's error shape. */
function oauthError(res: Response, error: string, description: string, status = 400) {
  res.status(status).json({ error, error_description: description });
}

const requireMcp = async (_req: Request, _res: Response, next: NextFunction) => {
  try {
    if (!(await mcpEnabled())) throw new AppError('NOT_FOUND', 'AI client access is turned off');
    next();
  } catch (err) {
    next(err);
  }
};

const authorizeQuery = z.object({
  client_id: z.uuid(),
  redirect_uri: z.string().max(2000),
  response_type: z.literal('code'),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(500).optional(),
  scope: z.string().max(200).optional(),
});

export const oauthRoutes = defineRoutes('/oauth', ['mcp'])
  .add({
    method: 'post',
    path: '/register',
    permission: 'public',
    before: [requireMcp, registerLimiter],
    summary: 'Dynamic client registration (RFC 7591) for MCP clients',
    body: z.unknown(),
    handler: async ({ req, res, body }) => {
      const parsed = z
        .object({
          client_name: z.string().trim().min(1).max(200).optional(),
          redirect_uris: z.array(redirectUri).min(1).max(10),
        })
        .safeParse(body);
      if (!parsed.success)
        return oauthError(res, 'invalid_redirect_uri', parsed.error.issues[0]?.message ?? 'Invalid');
      const clientId = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx('oauth_clients').insert({
          client_id: clientId,
          name: parsed.data.client_name ?? 'AI client',
          redirect_uris: JSON.stringify(parsed.data.redirect_uris),
        });
        await audit(trx, req.ctx, {
          action: 'oauth.client_registered',
          entity: 'oauth_client',
          entityId: id,
          entityUuid: clientId,
          diff: { name: parsed.data.client_name ?? null, redirectUris: parsed.data.redirect_uris },
        });
      });
      res.status(201).json({
        client_id: clientId,
        client_name: parsed.data.client_name ?? 'AI client',
        redirect_uris: parsed.data.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    },
  })
  .add({
    method: 'get',
    path: '/authorize/info',
    permission: 'authenticated',
    before: [requireMcp],
    summary: 'What the approval page shows: the client asking, and what it may do',
    query: authorizeQuery,
    handler: async ({ query }) => {
      const client = await clientFor(query.client_id, query.redirect_uri);
      const { appName } = await getBranding();
      return {
        appName,
        // Names are chosen by whoever registered the client: show where codes go and when it appeared.
        client: {
          name: client.name,
          redirectUri: query.redirect_uri,
          registeredAt: iso(
            (await db('oauth_clients').where({ id: client.id }).first('created_at'))?.created_at,
          ),
        },
        wantsFull: (query.scope ?? '').split(' ').includes(SCOPES.full),
      };
    },
  })
  .add({
    method: 'post',
    path: '/authorize',
    permission: 'authenticated',
    before: [requireMcp],
    summary: 'The signed-in person approves the client; returns where to send the browser',
    body: authorizeQuery.extend({ access: z.enum(['read', 'full']), approve: z.boolean() }),
    handler: async ({ ctx, user, body }) => {
      // Only a person in the app approves clients, never a token or an API key.
      if (!user.sessionId) throw new AppError('FORBIDDEN', 'Sign in to approve AI clients');
      const client = await clientFor(body.client_id, body.redirect_uri);
      const target = new URL(body.redirect_uri);
      if (body.state) target.searchParams.set('state', body.state);
      if (!body.approve) {
        target.searchParams.set('error', 'access_denied');
        return { redirect: target.toString() };
      }
      const code = randomToken(32);
      await db.transaction(async (trx) => {
        await trx('oauth_codes').insert({
          code_hash: sha256(code),
          client_id: client.id,
          user_id: user.id,
          redirect_uri: body.redirect_uri,
          code_challenge: body.code_challenge,
          read_only: body.access === 'read',
          expires_at: new Date(Date.now() + CODE_TTL_MS),
        });
        await audit(trx, ctx, {
          action: 'oauth.client_approved',
          entity: 'oauth_client',
          entityUuid: client.client_id,
          diff: { name: client.name, access: body.access },
        });
      });
      target.searchParams.set('code', code);
      target.searchParams.set('iss', origin());
      return { redirect: target.toString() };
    },
  })
  .add({
    method: 'post',
    path: '/token',
    permission: 'public',
    before: [requireMcp, clientLimiter],
    summary: 'Exchange a code (with its PKCE verifier) or a refresh token for tokens',
    body: z.unknown(),
    handler: async ({ req, res, body }) => {
      res.set('Cache-Control', 'no-store');
      const parsed = tokenBody.safeParse(body ?? {});
      if (!parsed.success) return oauthError(res, 'invalid_request', 'Malformed token request');
      const b = parsed.data;
      if (b.grant_type === 'authorization_code') {
        if (!b.code || !b.code_verifier || !b.client_id || !b.redirect_uri)
          return oauthError(
            res,
            'invalid_request',
            'code, code_verifier, client_id and redirect_uri are required',
          );
        const result = await db.transaction(async (trx) => {
          const row = await trx('oauth_codes as c')
            .join('oauth_clients as k', 'k.id', 'c.client_id')
            .where('c.code_hash', sha256(b.code!))
            .forUpdate()
            .first('c.*', 'k.client_id as public_id');
          if (!row) return null;
          if (row.used_at) {
            // A replayed code: revoke whatever it already produced (RFC 6749 §4.1.2).
            await trx('oauth_tokens')
              .where({ code_id: row.id })
              .whereNull('revoked_at')
              .update({ revoked_at: new Date() });
            return null;
          }
          await trx('oauth_codes').where({ id: row.id }).update({ used_at: new Date() });
          // A code works once, briefly, for the client and address it was issued to, with its verifier.
          const valid =
            new Date(row.expires_at) > new Date() &&
            row.public_id === b.client_id &&
            row.redirect_uri === b.redirect_uri &&
            s256(b.code_verifier!) === row.code_challenge;
          if (!valid || !(await mayHoldTokens(row.user_id, trx))) return null;
          const issued = await issueTokens(trx, {
            clientId: row.client_id,
            userId: row.user_id,
            readOnly: !!row.read_only,
            familyId: newUuid(),
            grantedAt: new Date(),
            codeId: row.id,
          });
          await auditToken(trx, req, row.user_id, 'oauth.token_issued', issued.id, { client: b.client_id });
          return issued.body;
        });
        if (!result) return oauthError(res, 'invalid_grant', 'The code is invalid, expired or already used');
        res.json(result);
        return;
      }
      if (b.grant_type === 'refresh_token') {
        if (!b.refresh_token || !b.client_id)
          return oauthError(res, 'invalid_request', 'refresh_token and client_id are required');
        const result = await db.transaction(async (trx) => {
          const row = await trx('oauth_tokens as t')
            .join('oauth_clients as k', 'k.id', 't.client_id')
            .where('t.refresh_hash', sha256(b.refresh_token!))
            .forUpdate()
            .first('t.*', 'k.client_id as public_id');
          if (!row || row.public_id !== b.client_id) return null;
          if (row.revoked_at) {
            // A spent refresh token used again: someone has a copy. End the whole grant (OAuth 2.1 §4.3.1).
            await trx('oauth_tokens')
              .where({ family_id: row.family_id })
              .whereNull('revoked_at')
              .update({ revoked_at: new Date() });
            await auditToken(trx, req, row.user_id, 'oauth.token_reuse_detected', row.id);
            return null;
          }
          if (new Date(row.refresh_expires_at) <= new Date() || !(await mayHoldTokens(row.user_id, trx)))
            return null;
          // Rotation: the old pair stops working the moment a new one is issued.
          await trx('oauth_tokens').where({ id: row.id }).update({ revoked_at: new Date() });
          const issued = await issueTokens(trx, {
            clientId: row.client_id,
            userId: row.user_id,
            readOnly: !!row.read_only,
            familyId: row.family_id,
            grantedAt: new Date(row.granted_at),
          });
          await auditToken(trx, req, row.user_id, 'oauth.token_refreshed', issued.id);
          return issued.body;
        });
        if (!result)
          return oauthError(res, 'invalid_grant', 'The refresh token is invalid, expired or already used');
        res.json(result);
        return;
      }
      oauthError(res, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
    },
  })
  .add({
    method: 'post',
    path: '/revoke',
    permission: 'public',
    before: [clientLimiter],
    summary: 'Revoke an access or refresh token (RFC 7009)',
    body: z.unknown(),
    handler: async ({ req, res, body }) => {
      const raw = (body as { token?: unknown } | null)?.token;
      const token = typeof raw === 'string' ? raw : '';
      if (token)
        await db.transaction(async (trx) => {
          const row = await trx('oauth_tokens')
            .where((w) => w.where({ access_hash: sha256(token) }).orWhere({ refresh_hash: sha256(token) }))
            .whereNull('revoked_at')
            .first('id', 'user_id', 'family_id');
          if (!row) return;
          await trx('oauth_tokens')
            .where({ family_id: row.family_id })
            .whereNull('revoked_at')
            .update({ revoked_at: new Date() });
          await auditToken(trx, req, row.user_id, 'oauth.token_revoked', row.id);
        });
      // Always 200, so the endpoint does not reveal which tokens exist (RFC 7009).
      res.status(200).end();
    },
  });

/** `Authorization: Bearer mat_…` on the MCP endpoint: acts as the person who approved the client. */
export async function authenticateOAuthToken(token: string): Promise<AuthUser | null> {
  if (!token.startsWith(OAUTH_TOKEN_PREFIX)) return null;
  const row = await db('oauth_tokens as t')
    .join('users as u', 'u.id', 't.user_id')
    .where('t.access_hash', sha256(token))
    .whereNull('t.revoked_at')
    .where('t.access_expires_at', '>', new Date())
    .whereNull('u.deleted_at')
    .where('u.status', 'active')
    .first(
      't.id',
      't.read_only',
      't.granted_at',
      'u.id as user_id',
      'u.uuid',
      'u.email',
      'u.first_name',
      'u.last_name',
    );
  if (!row) return null;
  // The same rules as personal tokens: two-factor enrolment when required, and the credential age limit.
  const { apiKeyMaxDays } = await effectiveCompliance();
  if (
    apiKeyMaxDays > 0 &&
    row.granted_at &&
    Date.now() - new Date(row.granted_at).getTime() > apiKeyMaxDays * 86_400_000
  )
    return null;
  if (!(await mayHoldTokens(row.user_id as number))) return null;
  void db('oauth_tokens')
    .where({ id: row.id })
    .update({ last_used_at: new Date() })
    .catch(() => undefined);
  return {
    id: row.user_id,
    uuid: row.uuid,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    ...(await loadAccess(row.user_id as number)),
    sessionId: null,
    tokenId: row.id,
    readOnly: !!row.read_only,
  };
}

/** Profile → Connected apps: clients the person approved, with a way to disconnect them. */
export const connectedAppsRoutes = defineRoutes('/me/connected-apps', ['mcp'])
  .add({
    method: 'get',
    path: '/',
    permission: 'authenticated',
    handler: async ({ user }) => ({
      data: (
        await db('oauth_tokens as t')
          .join('oauth_clients as c', 'c.id', 't.client_id')
          .where('t.user_id', user.id)
          .whereNull('t.revoked_at')
          .where('t.refresh_expires_at', '>', new Date())
          .orderBy('t.id', 'desc')
          .select('t.uuid', 't.read_only', 't.last_used_at', 't.created_at', 'c.name')
      ).map((r) => ({
        uuid: r.uuid as string,
        name: r.name as string,
        access: r.read_only ? 'read' : 'full',
        lastUsedAt: iso(r.last_used_at),
        connectedAt: iso(r.created_at)!,
      })),
    }),
  })
  .add({
    method: 'post',
    path: '/:uuid/revoke',
    permission: 'authenticated',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const row = await trx('oauth_tokens')
          .where({ uuid: params.uuid, user_id: user.id })
          .whereNull('revoked_at')
          .first('id');
        if (!row) throw notFound('Connection');
        await trx('oauth_tokens').where({ id: row.id }).update({ revoked_at: new Date() });
        await audit(trx, ctx, {
          action: 'oauth.disconnected',
          entity: 'oauth_token',
          entityId: row.id,
          entityUuid: params.uuid,
        });
      });
    },
  });

/** Drop what no longer matters: unused clients after a day, spent codes, and long-dead tokens. */
export async function purgeOAuth(now = new Date()) {
  const day = new Date(now.getTime() - 86_400_000);
  await db('oauth_codes').where('expires_at', '<', day).delete();
  await db('oauth_tokens')
    .where('refresh_expires_at', '<', new Date(now.getTime() - 30 * 86_400_000))
    .delete();
  await db('oauth_clients')
    .where('created_at', '<', day)
    .whereNotExists(db('oauth_tokens').whereRaw('oauth_tokens.client_id = oauth_clients.id'))
    .whereNotExists(db('oauth_codes').whereRaw('oauth_codes.client_id = oauth_clients.id'))
    .delete();
}
