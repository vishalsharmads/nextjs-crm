import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { env } from '../../config/env';
import { db } from '../../db/knex';
import { decrypt, encrypt } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { logger } from '../../lib/logger';

/**
 * Mailbox sign-in with OAuth 2.0 (authorization code + PKCE) and XOAUTH2 for IMAP and SMTP.
 * Which providers exist, with their endpoints and client credentials, comes from a file the
 * operator supplies (MAIL_OAUTH_PROVIDERS_FILE), so no provider is named in the product (plan D1).
 */
const server = z.object({
  host: z.string().min(1),
  port: z.number().int(),
  secure: z.boolean().default(true),
});
const providerSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  name: z.string().min(1).max(60),
  authorizeUrl: z.url({ protocol: /^https?$/ }),
  tokenUrl: z.url({ protocol: /^https?$/ }),
  scopes: z.array(z.string().min(1)).min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  /** Extra query parameters for the sign-in page (for example to always get a refresh token). */
  authorizeParams: z.record(z.string(), z.string()).default({}),
  imap: server,
  smtp: server,
});
export type MailOAuthProvider = z.infer<typeof providerSchema>;

let cached: { file: string; providers: MailOAuthProvider[] } | null = null;

export function mailOAuthProviders(): MailOAuthProvider[] {
  const file = env.MAIL_OAUTH_PROVIDERS_FILE;
  if (!file) return [];
  if (cached?.file === file) return cached.providers;
  try {
    const providers = z.array(providerSchema).parse(JSON.parse(readFileSync(file, 'utf8')));
    cached = { file, providers };
    return providers;
  } catch (err) {
    logger.error({ err }, 'MAIL_OAUTH_PROVIDERS_FILE could not be read');
    return [];
  }
}

/** Test hook: forget the parsed file. */
export const resetMailOAuthProviders = () => {
  cached = null;
};

export function providerByKey(key: string): MailOAuthProvider {
  const p = mailOAuthProviders().find((x) => x.key === key);
  if (!p) throw new AppError('NOT_FOUND', 'That sign-in option is not available');
  return p;
}

const base64url = (b: Buffer) => b.toString('base64url');

/** Where the provider sends people back. */
export function redirectUri() {
  const app = new URL(env.APP_URL);
  return `${app.origin}/api/v1/email/oauth/callback`;
}

/** Start a sign-in: a one-time state and PKCE verifier, and the provider's sign-in address. */
export async function startOAuth(userId: number, key: string): Promise<string> {
  const p = providerByKey(key);
  const state = base64url(randomBytes(48));
  const verifier = base64url(randomBytes(48));
  await db('mail_oauth_states')
    .where('created_at', '<', new Date(Date.now() - 15 * 60_000))
    .delete();
  await db('mail_oauth_states').insert({ state, user_id: userId, provider: key, code_verifier: verifier });
  const url = new URL(p.authorizeUrl);
  url.search = new URLSearchParams({
    ...p.authorizeParams,
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: redirectUri(),
    scope: p.scopes.join(' '),
    state,
    code_challenge: base64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

async function tokenRequest(p: MailOAuthProvider, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: p.clientId,
      ...(p.clientSecret ? { client_secret: p.clientSecret } : {}),
      ...params,
    }).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (!res.ok || !body.access_token) {
    logger.warn({ status: res.status, error: body.error }, 'Mailbox token request failed');
    throw new AppError(
      'UPSTREAM_FAILED',
      'The mail provider did not accept the sign-in. Try connecting again.',
    );
  }
  return body as TokenResponse;
}

/** The email address in an ID token (received directly from the token endpoint over TLS). */
function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString()) as {
      email?: string;
      preferred_username?: string;
      upn?: string;
    };
    const email = claims.email ?? claims.preferred_username ?? claims.upn ?? null;
    return email && /@/.test(email) ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Finish a sign-in: exchange the code. The person is the one who started it, identified by the
 * one-time state (not the session, which may have expired while they were at the provider).
 */
export async function finishOAuth(
  state: string,
  code: string,
): Promise<{ userId: number; email: string; provider: MailOAuthProvider; tokens: TokenResponse }> {
  const row = await db('mail_oauth_states').where({ state }).first();
  await db('mail_oauth_states').where({ state }).delete();
  if (!row || new Date(row.created_at).getTime() < Date.now() - 15 * 60_000)
    throw new AppError('VALIDATION_FAILED', 'This sign-in expired. Start again from Settings → Email.');
  const p = providerByKey(row.provider as string);
  const tokens = await tokenRequest(p, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: row.code_verifier as string,
  });
  const email = emailFromIdToken(tokens.id_token);
  if (!email)
    throw new AppError(
      'UPSTREAM_FAILED',
      'The mail provider did not say which address you signed in with. Ask your administrator to add the "openid email" scopes.',
    );
  return { userId: row.user_id as number, email, provider: p, tokens };
}

export const tokenColumns = (t: TokenResponse) => ({
  access_token_enc: encrypt(t.access_token, 'mail_accounts.access_token_enc'),
  ...(t.refresh_token
    ? { refresh_token_enc: encrypt(t.refresh_token, 'mail_accounts.refresh_token_enc') }
    : {}),
  token_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000),
});

/**
 * A valid access token for an OAuth mailbox, refreshed when it expires within two minutes. A failed
 * refresh marks the mailbox so its owner is asked to reconnect.
 */
export async function accessTokenFor(account: {
  id: number;
  oauth_provider: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: Date | string | null;
}): Promise<string> {
  const expires = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (account.access_token_enc && expires > Date.now() + 120_000)
    return decrypt(account.access_token_enc, 'mail_accounts.access_token_enc');
  if (!account.refresh_token_enc || !account.oauth_provider)
    throw new AppError('VALIDATION_FAILED', 'Reconnect this mailbox: its sign-in expired.');
  const p = providerByKey(account.oauth_provider);
  try {
    const tokens = await tokenRequest(p, {
      grant_type: 'refresh_token',
      refresh_token: decrypt(account.refresh_token_enc, 'mail_accounts.refresh_token_enc'),
    });
    await db('mail_accounts').where({ id: account.id }).update(tokenColumns(tokens));
    return tokens.access_token;
  } catch (err) {
    await db('mail_accounts')
      .where({ id: account.id })
      .update({ last_error: 'Sign-in expired. Reconnect this mailbox in Settings → Email.' });
    throw err;
  }
}
