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
import { authLimiter } from '../../middleware/rate-limit';
import { audit } from '../audit/audit.service';
import { loadAccess } from '../rbac/access';
import { getBranding, getGroup } from '../settings/settings.service';
import { iso } from '../records/hydrate';

/** Access tokens are short-lived; refresh tokens rotate on every use. */
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 30 * 86_400_000;
const CODE_TTL_MS = 5 * 60_000;
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

async function issueTokens(clientId: number, userId: number, readOnly: boolean) {
  const access = `${OAUTH_TOKEN_PREFIX}${randomToken(32)}`;
  const refresh = `mrt_${randomToken(32)}`;
  const uuid = newUuid();
  await db('oauth_tokens').insert({
    uuid,
    client_id: clientId,
    user_id: userId,
    access_hash: sha256(access),
    refresh_hash: sha256(refresh),
    read_only: readOnly,
    access_expires_at: new Date(Date.now() + ACCESS_TTL_S * 1000),
    refresh_expires_at: new Date(Date.now() + REFRESH_TTL_MS),
  });
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope: readOnly ? SCOPES.read : `${SCOPES.read} ${SCOPES.full}`,
  };
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
    before: [requireMcp, authLimiter],
    summary: 'Dynamic client registration (RFC 7591) for MCP clients',
    body: z.unknown(),
    handler: async ({ res, body }) => {
      const parsed = z
        .object({
          client_name: z.string().trim().min(1).max(200).optional(),
          redirect_uris: z.array(redirectUri).min(1).max(10),
        })
        .safeParse(body);
      if (!parsed.success)
        return oauthError(res, 'invalid_redirect_uri', parsed.error.issues[0]?.message ?? 'Invalid');
      const clientId = newUuid();
      await db('oauth_clients').insert({
        client_id: clientId,
        name: parsed.data.client_name ?? 'AI client',
        redirect_uris: JSON.stringify(parsed.data.redirect_uris),
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
        client: { name: client.name, redirectHost: new URL(query.redirect_uri).host },
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
    before: [requireMcp, authLimiter],
    summary: 'Exchange a code (with its PKCE verifier) or a refresh token for tokens',
    body: z.unknown(),
    handler: async ({ res, body }) => {
      res.set('Cache-Control', 'no-store');
      const b = (body ?? {}) as Record<string, string | undefined>;
      if (b.grant_type === 'authorization_code') {
        if (!b.code || !b.code_verifier || !b.client_id || !b.redirect_uri)
          return oauthError(
            res,
            'invalid_request',
            'code, code_verifier, client_id and redirect_uri are required',
          );
        const row = await db('oauth_codes as c')
          .join('oauth_clients as k', 'k.id', 'c.client_id')
          .where('c.code_hash', sha256(b.code))
          .first('c.*', 'k.client_id as public_id');
        // A code works once, briefly, for the client and address it was issued to, with its verifier.
        const valid =
          row &&
          !row.used_at &&
          new Date(row.expires_at) > new Date() &&
          row.public_id === b.client_id &&
          row.redirect_uri === b.redirect_uri &&
          s256(b.code_verifier) === row.code_challenge;
        if (row) await db('oauth_codes').where({ id: row.id }).update({ used_at: new Date() });
        if (!valid) return oauthError(res, 'invalid_grant', 'The code is invalid, expired or already used');
        const user = await db('users')
          .where({ id: row.user_id, status: 'active' })
          .whereNull('deleted_at')
          .first('id');
        if (!user) return oauthError(res, 'invalid_grant', 'The account is not active');
        res.json(await issueTokens(row.client_id, row.user_id, !!row.read_only));
        return;
      }
      if (b.grant_type === 'refresh_token') {
        if (!b.refresh_token) return oauthError(res, 'invalid_request', 'refresh_token is required');
        const row = await db('oauth_tokens')
          .where({ refresh_hash: sha256(b.refresh_token) })
          .first();
        if (!row || row.revoked_at || new Date(row.refresh_expires_at) <= new Date())
          return oauthError(res, 'invalid_grant', 'The refresh token is invalid or expired');
        // Rotation: the old pair stops working the moment a new one is issued.
        const n = await db('oauth_tokens')
          .where({ id: row.id })
          .whereNull('revoked_at')
          .update({ revoked_at: new Date() });
        if (!n) return oauthError(res, 'invalid_grant', 'The refresh token was already used');
        res.json(await issueTokens(row.client_id, row.user_id, !!row.read_only));
        return;
      }
      oauthError(res, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
    },
  })
  .add({
    method: 'post',
    path: '/revoke',
    permission: 'public',
    before: [authLimiter],
    summary: 'Revoke an access or refresh token (RFC 7009)',
    body: z.unknown(),
    handler: async ({ res, body }) => {
      const token = String((body as { token?: unknown } | null)?.token ?? '');
      if (token)
        await db('oauth_tokens')
          .where((w) => w.where({ access_hash: sha256(token) }).orWhere({ refresh_hash: sha256(token) }))
          .whereNull('revoked_at')
          .update({ revoked_at: new Date() });
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
    .first('t.id', 't.read_only', 'u.id as user_id', 'u.uuid', 'u.email', 'u.first_name', 'u.last_name');
  if (!row) return null;
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
