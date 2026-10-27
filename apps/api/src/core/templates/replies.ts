import Handlebars from 'handlebars';
import { SAVED_REPLY_PREFIX, type RelatedType, type SavedReply } from '@app/shared';
import { db } from '../../db/knex';
import type { AuthUser, RequestContext } from '../../http/context';
import { escapeLike } from '../records/filters';
import { notFound } from '../../lib/errors';
import { assertCan, can } from '../rbac/access';
import { logAccess } from '../audit/access-log';
import { getRow } from '../records/service';
import { recordDefs } from '../records/registry';
import { getBranding, getGroup } from '../settings/settings.service';
import { getLabels } from '../labels/labels.service';
import { sanitizeBody } from '../activities/activities.def';
import { todayIn } from '../commerce/documents';

const VIEW: Record<RelatedType, string> = {
  contact: 'core.contacts.view',
  organization: 'core.organizations.view',
  deal: 'core.deals.view',
  lead: 'core.leads.view',
};

export async function listReplies(): Promise<SavedReply[]> {
  const rows = await db('templates')
    .where({ channel: 'email' })
    .where('key', 'like', `${escapeLike(SAVED_REPLY_PREFIX)}%`)
    .orderBy('name');
  return rows.map((r) => ({ uuid: r.uuid, key: r.key, name: r.name, subject: r.subject }));
}

/** A record as a template sees it: the user's own view (scope, hidden fields, masked values). */
async function recordVars(user: AuthUser, type: RelatedType, uuid: string, ctx?: RequestContext) {
  assertCan(user, VIEW[type]);
  const def = recordDefs[type];
  const row = await getRow(def, user, uuid);
  if (ctx)
    await logAccess(ctx, {
      action: 'view',
      entity: def.entity,
      entityId: row.id as number,
      entityUuid: uuid,
    });
  const [dto] = (await def.toDtos([row], { user, conn: db })) as Record<string, unknown>[];
  return dto ?? null;
}

/**
 * Render a saved reply for the record it is inserted on. Values are escaped by Handlebars and the
 * result is sanitized like any email or note body, so the reply can go straight into the editor.
 */
export async function renderReply(
  ctx: RequestContext,
  user: AuthUser,
  uuid: string,
  related: { type: RelatedType; uuid: string } | null | undefined,
) {
  const t = await db('templates')
    .where({ uuid, channel: 'email' })
    .where('key', 'like', `${escapeLike(SAVED_REPLY_PREFIX)}%`)
    .first();
  if (!t) throw notFound('Template');
  const vars: Record<string, unknown> = {};
  if (related) {
    const record = await recordVars(user, related.type, related.uuid, ctx);
    vars[related.type] = record;
    vars.record = record;
    // A deal's contact and organization fill their own placeholders when the user may see them.
    if (related.type === 'deal' && record) {
      for (const [type, ref] of [
        ['contact', record.contact],
        ['organization', record.organization],
      ] as const) {
        const linked = ref as { uuid: string } | null;
        if (linked && can(user, VIEW[type]))
          vars[type] = await recordVars(user, type, linked.uuid, ctx).catch(() => null);
      }
    }
  }
  const [branding, labels, general] = await Promise.all([
    getBranding(),
    getLabels('en'),
    getGroup('general'),
  ]);
  Object.assign(vars, {
    branding,
    labels,
    user: {
      firstName: user.firstName,
      lastName: user.lastName,
      name: `${user.firstName} ${user.lastName}`.trim(),
      email: user.email,
    },
    today: todayIn(general.timezone),
  });
  const render = (src: string) => Handlebars.compile(src, { strict: false })(vars);
  return { subject: render(t.subject as string), html: sanitizeBody(render(t.body as string)) ?? '' };
}
