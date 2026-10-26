import { z } from 'zod';
import {
  DATA_SUBJECT_ENTITIES,
  PRIVACY_REQUEST_STATUSES,
  consentChangeSchema,
  privacyRequestCreateSchema,
  privacyRequestUpdateSchema,
} from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import { hmac } from '../../lib/crypto';
import { env } from '../../config/env';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { assertCan } from '../rbac/access';
import { getRow } from '../records/service';
import { recordDefs } from '../records/registry';
import { consentSummary, recordConsent, withdrawMarketing } from './consent.service';
import { eraseSubject, exportSubject, setRestriction } from './privacy.service';
import { createRequest, getRequest, listRequests, updateRequest } from './requests.service';
import { addDays } from '../commerce/documents';
import { parseUnsubscribeToken } from './unsubscribe';

const params = z.object({ entity: z.enum(DATA_SUBJECT_ENTITIES), uuid: z.uuid() });

/** Confirmation token so a hard delete needs two deliberate calls (preview, then confirm). */
const confirmToken = (entity: string, uuid: string) =>
  hmac(env.CSRF_SECRET, `hard-delete:${entity}:${uuid}`).slice(0, 16);

export const privacyRoutes = defineRoutes('/privacy', ['privacy'])
  .add({
    method: 'get',
    path: '/requests',
    permission: 'core.privacy.manage',
    query: z.object({
      status: z.enum([...PRIVACY_REQUEST_STATUSES, 'active']).optional(),
      overdue: z.stringbool().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }),
    handler: ({ query }) => listRequests(query),
  })
  .add({
    method: 'post',
    path: '/requests',
    permission: 'core.privacy.manage',
    body: privacyRequestCreateSchema,
    status: 201,
    handler: ({ ctx, user, body }) => createRequest(ctx, user, body),
  })
  .add({
    method: 'get',
    path: '/requests/:uuid',
    permission: 'core.privacy.manage',
    params: z.object({ uuid: z.uuid() }),
    handler: ({ params: p }) => getRequest(p.uuid),
  })
  .add({
    method: 'patch',
    path: '/requests/:uuid',
    permission: 'core.privacy.manage',
    params: z.object({ uuid: z.uuid() }),
    body: privacyRequestUpdateSchema,
    handler: ({ ctx, user, params: p, body }) => updateRequest(ctx, user, p.uuid, body),
  })
  .add({
    method: 'get',
    path: '/:entity/:uuid/export',
    permission: 'core.privacy.manage',
    params,
    summary: 'Everything held about the person (access and portability), as a ZIP of JSON and files',
    handler: ({ ctx, user, params: p, res }) => exportSubject(ctx, user, p.entity, p.uuid, res),
  })
  .add({
    method: 'post',
    path: '/:entity/:uuid/anonymize',
    permission: 'core.privacy.manage',
    params,
    summary: 'Erase personal data everywhere but keep the record (and its deals/activities) for reporting',
    handler: ({ ctx, user, params: p }) => eraseSubject(ctx, user, p.entity, p.uuid, 'anonymize'),
  })
  .add({
    method: 'post',
    path: '/:entity/:uuid/restriction',
    permission: 'core.privacy.manage',
    params,
    body: z.object({ restricted: z.boolean() }),
    summary: 'Restrict processing: automations, webhooks and outgoing email skip the record',
    handler: async ({ ctx, user, params: p, body }) => {
      await setRestriction(ctx, user, p.entity, p.uuid, body.restricted);
    },
  })
  .add({
    method: 'get',
    path: '/:entity/:uuid/consents',
    permission: 'authenticated',
    params,
    handler: async ({ user, params: p }) => {
      const def = recordDefs[p.entity];
      assertCan(user, `${def.resource}.view`);
      const row = await getRow(def, user, p.uuid);
      return consentSummary({ entity: p.entity, id: row.id as number });
    },
  })
  .add({
    method: 'post',
    path: '/:entity/:uuid/consents',
    permission: 'authenticated',
    params,
    body: consentChangeSchema,
    summary: 'Record consent given or withdrawn outside the CRM (phone, paper, email)',
    handler: async ({ ctx, user, params: p, body }) => {
      const def = recordDefs[p.entity];
      assertCan(user, `${def.resource}.update`);
      await db.transaction(async (trx) => {
        const row = await getRow(def, user, p.uuid, trx, { forUpdate: true });
        await recordConsent(
          trx,
          ctx,
          { entity: p.entity, id: row.id as number, uuid: p.uuid },
          { purposeKey: body.purposeKey, status: body.status, source: 'manual', note: body.note },
        );
      });
      const row = await getRow(def, user, p.uuid);
      return consentSummary({ entity: p.entity, id: row.id as number });
    },
  })
  .add({
    method: 'delete',
    path: '/:entity/:uuid',
    permission: 'core.privacy.manage',
    params,
    query: z.object({ confirm: z.string().max(64).optional() }),
    summary: 'Permanently delete a record and its data everywhere. Call once to get a confirmation code.',
    handler: async ({ ctx, user, params: p, query }) => {
      await getRow(recordDefs[p.entity], user, p.uuid, db, { withDeleted: true });
      const expected = confirmToken(p.entity, p.uuid);
      if (query.confirm !== expected) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Permanent deletion cannot be undone. Repeat with the confirmation code.',
          [{ path: 'confirm', message: expected }],
        );
      }
      return eraseSubject(ctx, user, p.entity, p.uuid, 'delete');
    },
  });

const unsubscribeBody = z.object({
  token: z.string().max(200).optional(),
  /** CCPA/CPRA "Do not sell or share my personal information". */
  doNotSell: z.boolean().optional(),
});

/** Public opt-out: the unsubscribe page and mail clients' one-click unsubscribe. */
export const publicPrivacyRoutes = defineRoutes('/public/privacy', ['public'])
  .add({
    method: 'get',
    path: '/unsubscribe',
    permission: 'public',
    query: z.object({ token: z.string().max(200) }),
    summary: 'Check an unsubscribe link (reveals nothing about the person)',
    handler: async ({ query }) => {
      const t = parseUnsubscribeToken(query.token);
      if (!t) throw new AppError('NOT_FOUND', 'This link is not valid');
      const row = await db(recordDefs[t.entity].table).where({ uuid: t.uuid }).first('marketing_opt_out');
      return { valid: !!row, optedOut: !!row?.marketing_opt_out };
    },
  })
  .add({
    method: 'post',
    path: '/unsubscribe',
    permission: 'public',
    query: z.object({ token: z.string().max(200).optional() }),
    body: unsubscribeBody,
    handler: async ({ ctx, query, body }) => {
      const t = parseUnsubscribeToken(body.token ?? query.token ?? '');
      if (!t) throw new AppError('NOT_FOUND', 'This link is not valid');
      await db.transaction(async (trx) => {
        const row = await trx(recordDefs[t.entity].table).where({ uuid: t.uuid }).forUpdate().first('id');
        if (!row) return;
        const subject = { entity: t.entity, id: row.id as number, uuid: t.uuid };
        await withdrawMarketing(trx, ctx, subject, 'unsubscribe');
        if (body.doNotSell) {
          // Recorded as a completed request: there is nothing more to do than stop.
          const uuid = newUuid();
          const today = new Date().toISOString().slice(0, 10);
          const [id] = await trx('privacy_requests').insert({
            uuid,
            type: 'opt_out_sale_share',
            status: 'completed',
            subject_type: t.entity,
            subject_id: row.id,
            channel: 'unsubscribe link',
            received_at: today,
            due_at: addDays(today, 15),
            resolution: 'Opted out through the unsubscribe page. Marketing consent withdrawn.',
            completed_at: new Date(),
          });
          await audit(trx, ctx, {
            action: 'privacy_request.created',
            entity: 'privacy_request',
            entityId: id,
            entityUuid: uuid,
            diff: { type: 'opt_out_sale_share', source: 'unsubscribe' },
          });
        }
      });
      return { ok: true };
    },
  });
