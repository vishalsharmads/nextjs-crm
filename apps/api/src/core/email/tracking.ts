import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env';
import { db } from '../../db/knex';
import { defineRoutes } from '../../http/routes';
import { getGroup, effectiveCompliance } from '../settings/settings.service';

/**
 * Email open and click tracking. Off unless the workspace turns it on; never under the privacy or
 * health data profiles (`noEmailTracking` floor); never for recipients who opted out of marketing.
 * The pixel and link addresses carry a random token only, no record ids.
 */
export async function trackingAllowed(): Promise<boolean> {
  const [features, compliance] = await Promise.all([getGroup('features'), effectiveCompliance()]);
  return features.emailTracking && !compliance.noEmailTracking;
}

/** Any recipient a known person who opted out of marketing (or is restricted)? Then no tracking. */
export async function recipientsRefuseTracking(addresses: string[]): Promise<boolean> {
  const emails = addresses.map((a) => a.trim().toLowerCase());
  if (!emails.length) return false;
  for (const table of ['contacts', 'leads']) {
    const hit = await db(table)
      .whereIn('email_norm', emails)
      .where((w) => w.where('marketing_opt_out', true).orWhere('processing_restricted', true))
      .first('id');
    if (hit) return true;
  }
  return false;
}

const origin = () => new URL(env.APP_URL).origin;

/** Add the open pixel and route links through the click counter. Returns the token and the links. */
export function instrument(html: string): { html: string; token: string; links: string[] } {
  const token = randomBytes(32).toString('base64url');
  const links: string[] = [];
  const rewritten = html.replace(/href="(https?:\/\/[^"]+)"/gi, (_m, url: string) => {
    links.push(url.replace(/&amp;/g, '&'));
    return `href="${origin()}/api/v1/t/c/${token}/${links.length - 1}"`;
  });
  const pixel = `<img src="${origin()}/api/v1/t/o/${token}.gif" width="1" height="1" alt="" style="display:block;border:0">`;
  return { html: `${rewritten}${pixel}`, token, links };
}

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export const trackingRoutes = defineRoutes('/t', ['email'])
  .add({
    method: 'get',
    path: '/o/:file',
    permission: 'public',
    params: z.object({ file: z.string().regex(/^[A-Za-z0-9_-]{43}\.gif$/) }),
    summary: 'Email open pixel',
    handler: async ({ params, res }) => {
      const token = params.file.slice(0, -4);
      const now = new Date();
      await db('email_messages')
        .where({ tracking_token: token })
        .update({
          open_count: db.raw('open_count + 1'),
          first_opened_at: db.raw('COALESCE(first_opened_at, ?)', [now]),
          last_opened_at: now,
        });
      res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(GIF);
    },
  })
  .add({
    method: 'get',
    path: '/c/:token/:index',
    permission: 'public',
    params: z.object({
      token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      index: z.coerce.number().int().min(0).max(500),
    }),
    summary: 'Email link click: counts it and goes on to the original address',
    handler: async ({ params, res }) => {
      const row = await db('email_messages')
        .where({ tracking_token: params.token })
        .first('id', 'tracking_links');
      const links = (row?.tracking_links as string[] | null) ?? [];
      const target = links[params.index];
      // Only addresses stored when the email was sent: never an open redirect.
      if (!row || !target || !/^https?:\/\//i.test(target)) {
        res.status(404).type('text/plain').send('This link is no longer available.');
        return;
      }
      await db('email_messages')
        .where({ id: row.id })
        .update({ click_count: db.raw('click_count + 1'), last_clicked_at: new Date() });
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.redirect(302, target);
    },
  });
