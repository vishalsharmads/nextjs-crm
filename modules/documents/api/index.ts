import type { NextFunction, Request, Response } from 'express';
import Handlebars from 'handlebars';
import { z } from 'zod';
import { formatDocNumber, toPatch } from '@app/shared';
import {
  AppError,
  applyScope,
  assertCan,
  can,
  audit,
  db,
  defineRoutes,
  emit,
  getBranding,
  getRow,
  getSettingsGroup,
  iso,
  newUuid,
  nextDocNumber,
  notFound,
  notify,
  recordDefs,
  registerModuleWidget,
  sanitizeDocumentHtml,
  sha256,
  storeFile,
  todayIn,
  uploadSingle,
  userRefs,
  type ApiModule,
  type AuthUser,
  type Db,
  type Knex,
  type RequestContext,
} from '@app/api/module-api';
import * as m0001 from './migrations/0001_documents';

const TEMPLATES = 'm_documents_templates';
const DOCS = 'm_documents_documents';
const REQUESTS = 'm_documents_requests';

// ---------- Access: everything belongs to a contact and follows that contact's record scope ----------

/** The contact (row) if the user may see it; otherwise 404, like any out-of-scope record. */
async function visibleContact(user: AuthUser, uuid: string, conn: Db = db) {
  assertCan(user, 'core.contacts.view');
  return getRow(recordDefs.contact, user, uuid, conn);
}

/** Restrict a documents/requests query to contacts the user can see. */
async function scopeByContact(qb: Knex.QueryBuilder, user: AuthUser, alias: string) {
  qb.join('contacts as sc', 'sc.id', `${alias}.contact_id`).whereNull('sc.deleted_at');
  await applyScope(qb, user, 'core.contacts', ['sc.owner_id']);
}

async function scopedDoc(user: AuthUser, uuid: string, conn: Db = db, forUpdate = false) {
  const qb = conn(`${DOCS} as d`).where('d.uuid', uuid).select('d.*');
  await scopeByContact(qb, user, 'd');
  if (forUpdate) qb.forUpdate();
  const row = await qb.first();
  if (!row) throw notFound('Document');
  return row as Record<string, unknown> & { id: number; uuid: string; status: string };
}

async function scopedRequest(user: AuthUser, uuid: string, conn: Db = db, forUpdate = false) {
  const qb = conn(`${REQUESTS} as r`).where('r.uuid', uuid).select('r.*');
  await scopeByContact(qb, user, 'r');
  if (forUpdate) qb.forUpdate();
  const row = await qb.first();
  if (!row) throw notFound('File request');
  return row as Record<string, unknown> & { id: number; uuid: string; status: string };
}

// ---------- Rendering ----------

/** Variables a template can use. Values come from what the generating user is allowed to see. */
async function mergeVars(
  user: AuthUser,
  contactRow: Record<string, unknown>,
  dealUuid: string | null | undefined,
) {
  const [contact] = (await recordDefs.contact.toDtos([contactRow], { user, conn: db })) as Record<
    string,
    unknown
  >[];
  const orgLink = await db('contact_organization')
    .where({ contact_id: contactRow.id, is_primary: true })
    .whereNull('ended_at')
    .first('organization_id');
  let organization: Record<string, unknown> | null = null;
  // Only organizations the user may see are merged in; otherwise placeholders stay empty.
  if (orgLink && can(user, 'core.organizations.view')) {
    const org = await db('organizations').where({ id: orgLink.organization_id }).first('uuid');
    const orgRow = org
      ? await getRow(recordDefs.organization, user, org.uuid as string).catch(() => null)
      : null;
    if (orgRow)
      organization =
        (
          (await recordDefs.organization.toDtos([orgRow], { user, conn: db })) as Record<string, unknown>[]
        )[0] ?? null;
  }
  let deal: Record<string, unknown> | null = null;
  if (dealUuid) {
    assertCan(user, 'core.deals.view');
    const dealRow = await getRow(recordDefs.deal, user, dealUuid).catch(() => {
      throw new AppError('VALIDATION_FAILED', 'Linked record not found', [
        { path: 'dealUuid', message: 'Not found' },
      ]);
    });
    deal =
      ((await recordDefs.deal.toDtos([dealRow], { user, conn: db })) as Record<string, unknown>[])[0] ?? null;
  }
  const [general, commerce, branding] = await Promise.all([
    getSettingsGroup('general'),
    getSettingsGroup('commerce'),
    getBranding(),
  ]);
  return {
    contact,
    organization,
    deal,
    business: { name: commerce.legalName || branding.appName, ...commerce },
    user: { name: `${user.firstName} ${user.lastName}`.trim(), email: user.email },
    today: todayIn(general.timezone),
  };
}

/** Handlebars escapes every value; the template's own markup is sanitized after rendering. */
function render(template: string, vars: object): string {
  try {
    return sanitizeDocumentHtml(Handlebars.compile(template, { strict: false })(vars));
  } catch (err) {
    throw new AppError(
      'VALIDATION_FAILED',
      `The template has an error: ${(err as Error).message.split('\n')[0]}`,
      [{ path: 'body', message: 'Check the {{placeholders}}' }],
    );
  }
}

function compileCheck(body: string) {
  try {
    Handlebars.precompile(body);
  } catch (err) {
    throw new AppError('VALIDATION_FAILED', 'The template has an error', [
      { path: 'body', message: (err as Error).message.split('\n')[0]! },
    ]);
  }
}

// ---------- DTOs ----------

const templateDto = (r: Record<string, unknown>) => ({
  uuid: r.uuid as string,
  name: r.name as string,
  description: r.description as string,
  body: r.body as string,
  requiresSignature: !!r.requires_signature,
  active: !!r.active,
  updatedAt: iso(r.updated_at)!,
});

async function docDtos(rows: Record<string, unknown>[], withBody: boolean) {
  const contactIds = [...new Set(rows.map((r) => r.contact_id as number))];
  const contacts = contactIds.length
    ? new Map(
        (await db('contacts').whereIn('id', contactIds).select('id', 'uuid', 'full_name')).map((c) => [
          c.id as number,
          { uuid: c.uuid as string, name: c.full_name as string },
        ]),
      )
    : new Map<number, { uuid: string; name: string }>();
  const users = await userRefs(rows.map((r) => r.created_by as number | null));
  return rows.map((r) => ({
    uuid: r.uuid as string,
    number: r.number as string,
    title: r.title as string,
    status: r.status as string,
    requiresSignature: !!r.requires_signature,
    contact: contacts.get(r.contact_id as number) ?? null,
    sharedAt: iso(r.shared_at),
    signedName: (r.signed_name as string | null) ?? null,
    signedAt: iso(r.signed_at),
    createdBy: users.get(r.created_by as number) ?? null,
    createdAt: iso(r.created_at)!,
    ...(withBody ? { bodyHtml: r.body_html as string } : {}),
  }));
}

async function requestDtos(rows: Record<string, unknown>[]) {
  const fileIds = rows.map((r) => r.file_id).filter((v): v is number => typeof v === 'number');
  const files = fileIds.length
    ? new Map(
        (
          await db('files')
            .whereIn('id', fileIds)
            .whereNull('deleted_at')
            .select('id', 'uuid', 'original_name', 'mime', 'size')
        ).map((f) => [
          f.id as number,
          {
            uuid: f.uuid as string,
            name: f.original_name as string,
            mime: f.mime as string,
            size: Number(f.size),
          },
        ]),
      )
    : new Map<number, { uuid: string; name: string; mime: string; size: number }>();
  return rows.map((r) => ({
    uuid: r.uuid as string,
    name: r.name as string,
    description: r.description as string,
    status: r.status as string,
    dueDate: (r.due_date as string | null) ?? null,
    file: files.get(r.file_id as number) ?? null,
    reviewNote: (r.review_note as string | null) ?? null,
    submittedAt: iso(r.submitted_at),
    reviewedAt: iso(r.reviewed_at),
    createdAt: iso(r.created_at)!,
  }));
}

async function emitDoc(type: 'document.shared' | 'document.signed', uuid: string, actorId: number | null) {
  const [record] = await docDtos([await db(DOCS).where({ uuid }).first()], false);
  await emit({
    type,
    entity: 'document',
    uuid,
    record: record as unknown as Record<string, unknown>,
    actorId,
  });
}

async function emitRequest(
  type: 'document_request.submitted' | 'document_request.reviewed',
  uuid: string,
  actorId: number | null,
) {
  const [record] = await requestDtos([await db(REQUESTS).where({ uuid }).first()]);
  await emit({
    type,
    entity: 'document_request',
    uuid,
    record: record as unknown as Record<string, unknown>,
    actorId,
  });
}

// ---------- Routes ----------

const templateBody = z.object({
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(500).default(''),
  body: z.string().min(1).max(200_000),
  requiresSignature: z.boolean().default(false),
  active: z.boolean().default(true),
});

const uuidParam = z.object({ uuid: z.uuid() });

const templateRoutes = defineRoutes('/m/documents/templates', ['documents'], 'documents')
  .add({
    method: 'get',
    path: '/',
    permission: 'documents.documents.view',
    handler: async () => ({ data: (await db(TEMPLATES).orderBy('name')).map(templateDto) }),
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'documents.templates.manage',
    body: templateBody,
    status: 201,
    handler: async ({ ctx, body }) => {
      compileCheck(body.body);
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx(TEMPLATES).insert({
          uuid,
          name: body.name,
          description: body.description,
          body: body.body,
          requires_signature: body.requiresSignature,
          active: body.active,
        });
        await audit(trx, ctx, {
          action: 'documents.template.created',
          entity: 'documents.template',
          entityId: id,
          entityUuid: uuid,
          diff: { name: body.name },
        });
      });
      return templateDto(await db(TEMPLATES).where({ uuid }).first());
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'documents.templates.manage',
    params: uuidParam,
    body: toPatch(templateBody),
    handler: async ({ ctx, params, body }) => {
      if (body.body !== undefined) compileCheck(body.body);
      await db.transaction(async (trx) => {
        const t = await trx(TEMPLATES).where({ uuid: params.uuid }).forUpdate().first();
        if (!t) throw notFound('Template');
        const patch: Record<string, unknown> = { updated_at: new Date() };
        if (body.name !== undefined) patch.name = body.name;
        if (body.description !== undefined) patch.description = body.description;
        if (body.body !== undefined) patch.body = body.body;
        if (body.requiresSignature !== undefined) patch.requires_signature = body.requiresSignature;
        if (body.active !== undefined) patch.active = body.active;
        await trx(TEMPLATES).where({ id: t.id }).update(patch);
        await audit(trx, ctx, {
          action: 'documents.template.updated',
          entity: 'documents.template',
          entityId: t.id,
          entityUuid: params.uuid,
          diff: { ...body, body: body.body ? '(changed)' : undefined },
        });
      });
      return templateDto(await db(TEMPLATES).where({ uuid: params.uuid }).first());
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/preview',
    permission: 'documents.documents.view',
    params: uuidParam,
    body: z.object({ contactUuid: z.uuid(), dealUuid: z.uuid().nullish() }),
    summary: 'Render the template for a contact without saving anything.',
    handler: async ({ user, params, body }) => {
      const t = await db(TEMPLATES).where({ uuid: params.uuid }).first();
      if (!t) throw notFound('Template');
      const contact = await visibleContact(user, body.contactUuid);
      return { html: render(t.body, await mergeVars(user, contact, body.dealUuid)) };
    },
  });

const docRoutes = defineRoutes('/m/documents/documents', ['documents'], 'documents')
  .add({
    method: 'get',
    path: '/',
    permission: 'documents.documents.view',
    query: z.object({
      contactUuid: z.uuid().optional(),
      status: z.enum(['draft', 'shared', 'signed', 'void']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }),
    handler: async ({ user, query }) => {
      const qb = db(`${DOCS} as d`).select('d.*');
      await scopeByContact(qb, user, 'd');
      if (query.contactUuid) qb.where('sc.uuid', query.contactUuid);
      if (query.status) qb.where('d.status', query.status);
      const total = Number(((await qb.clone().clearSelect().count({ c: '*' }).first()) as { c: number }).c);
      const rows = await qb
        .orderBy('d.id', 'desc')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      return {
        data: await docDtos(rows, false),
        meta: { page: query.page, pageSize: query.pageSize, total },
      };
    },
  })
  .add({
    method: 'get',
    path: '/:uuid',
    permission: 'documents.documents.view',
    params: uuidParam,
    handler: async ({ user, params }) => (await docDtos([await scopedDoc(user, params.uuid)], true))[0],
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'documents.documents.create',
    body: z.object({
      templateUuid: z.uuid(),
      contactUuid: z.uuid(),
      dealUuid: z.uuid().nullish(),
      title: z.string().trim().max(200).optional(),
    }),
    status: 201,
    summary: 'Generate a draft from a template for a contact.',
    handler: async ({ ctx, user, body }) => {
      const t = await db(TEMPLATES).where({ uuid: body.templateUuid, active: true }).first();
      if (!t)
        throw new AppError('VALIDATION_FAILED', 'Template not found', [
          { path: 'templateUuid', message: 'Not found' },
        ]);
      const contact = await visibleContact(user, body.contactUuid);
      const html = render(t.body, await mergeVars(user, contact, body.dealUuid));
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const dealId = body.dealUuid
          ? (await trx('deals').where({ uuid: body.dealUuid }).first('id'))?.id
          : null;
        const n = await nextDocNumber(trx, 'document');
        const [id] = await trx(DOCS).insert({
          uuid,
          number: formatDocNumber('D-', n, 5),
          title: body.title || t.name,
          body_html: html,
          template_id: t.id,
          contact_id: contact.id,
          deal_id: dealId ?? null,
          requires_signature: t.requires_signature,
          created_by: user.id,
        });
        await audit(trx, ctx, {
          action: 'documents.document.created',
          entity: 'documents.document',
          entityId: id,
          entityUuid: uuid,
          diff: { template: t.name, contact: contact.uuid },
        });
      });
      return (await docDtos([await db(DOCS).where({ uuid }).first()], true))[0];
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'documents.documents.update',
    params: uuidParam,
    body: z.object({
      title: z.string().trim().min(1).max(200).optional(),
      bodyHtml: z.string().min(1).max(500_000).optional(),
      requiresSignature: z.boolean().optional(),
    }),
    summary: 'Only drafts can be edited.',
    handler: async ({ ctx, user, params, body }) => {
      await db.transaction(async (trx) => {
        const row = await scopedDoc(user, params.uuid, trx, true);
        if (row.status !== 'draft') throw new AppError('CONFLICT', 'Only drafts can be edited');
        const patch: Record<string, unknown> = { updated_at: new Date() };
        if (body.title !== undefined) patch.title = body.title;
        if (body.bodyHtml !== undefined) patch.body_html = sanitizeDocumentHtml(body.bodyHtml);
        if (body.requiresSignature !== undefined) patch.requires_signature = body.requiresSignature;
        await trx(DOCS).where({ id: row.id }).update(patch);
        await audit(trx, ctx, {
          action: 'documents.document.updated',
          entity: 'documents.document',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: { title: body.title, body: body.bodyHtml ? '(changed)' : undefined },
        });
      });
      return (await docDtos([await db(DOCS).where({ uuid: params.uuid }).first()], true))[0];
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/share',
    permission: 'documents.documents.update',
    params: uuidParam,
    summary: 'Make a draft visible to the contact in the client portal. It cannot be edited after this.',
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const row = await scopedDoc(user, params.uuid, trx, true);
        if (row.status !== 'draft') throw new AppError('CONFLICT', 'Only drafts can be shared');
        await trx(DOCS)
          .where({ id: row.id })
          .update({ status: 'shared', shared_at: new Date(), updated_at: new Date() });
        await audit(trx, ctx, {
          action: 'documents.document.shared',
          entity: 'documents.document',
          entityId: row.id,
          entityUuid: params.uuid,
        });
      });
      await emitDoc('document.shared', params.uuid, user.id);
      return (await docDtos([await db(DOCS).where({ uuid: params.uuid }).first()], true))[0];
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/void',
    permission: 'documents.documents.delete',
    params: uuidParam,
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const row = await scopedDoc(user, params.uuid, trx, true);
        if (row.status === 'void') throw new AppError('CONFLICT', 'Already void');
        await trx(DOCS).where({ id: row.id }).update({ status: 'void', updated_at: new Date() });
        await audit(trx, ctx, {
          action: 'documents.document.voided',
          entity: 'documents.document',
          entityId: row.id,
          entityUuid: params.uuid,
        });
      });
      return (await docDtos([await db(DOCS).where({ uuid: params.uuid }).first()], true))[0];
    },
  });

const requestRoutes = defineRoutes('/m/documents/requests', ['documents'], 'documents')
  .add({
    method: 'get',
    path: '/',
    permission: 'documents.documents.view',
    query: z.object({
      contactUuid: z.uuid().optional(),
      status: z.enum(['requested', 'submitted', 'approved', 'rejected', 'cancelled', 'open']).optional(),
    }),
    summary: '`status=open` means requested or submitted (still needs something from someone).',
    handler: async ({ user, query }) => {
      const qb = db(`${REQUESTS} as r`).select(
        'r.*',
        'sc.uuid as contact_uuid',
        'sc.full_name as contact_name',
      );
      await scopeByContact(qb, user, 'r');
      if (query.contactUuid) qb.where('sc.uuid', query.contactUuid);
      if (query.status === 'open') qb.whereIn('r.status', ['requested', 'submitted']);
      else if (query.status) qb.where('r.status', query.status);
      const rows = await qb.orderBy('r.id', 'desc').limit(500);
      const dtos = await requestDtos(rows);
      return {
        data: dtos.map((d, i) => ({
          ...d,
          contact: { uuid: rows[i].contact_uuid as string, name: rows[i].contact_name as string },
        })),
      };
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'documents.documents.create',
    body: z.object({
      contactUuid: z.uuid(),
      dealUuid: z.uuid().nullish(),
      items: z
        .array(
          z.object({
            name: z.string().trim().min(1).max(200),
            description: z.string().trim().max(1000).default(''),
            dueDate: z.iso.date().nullish(),
          }),
        )
        .min(1)
        .max(30),
    }),
    status: 201,
    summary: 'Ask a contact for one or more files. They upload them in the client portal.',
    handler: async ({ ctx, user, body }) => {
      const contact = await visibleContact(user, body.contactUuid);
      const dealId = body.dealUuid ? (await getRow(recordDefs.deal, user, body.dealUuid)).id : null;
      const uuids: string[] = [];
      await db.transaction(async (trx) => {
        for (const item of body.items) {
          const uuid = newUuid();
          uuids.push(uuid);
          const [id] = await trx(REQUESTS).insert({
            uuid,
            contact_id: contact.id,
            deal_id: dealId,
            name: item.name,
            description: item.description,
            due_date: item.dueDate ?? null,
            requested_by: user.id,
          });
          await audit(trx, ctx, {
            action: 'documents.request.created',
            entity: 'documents.request',
            entityId: id,
            entityUuid: uuid,
            diff: { name: item.name, contact: contact.uuid },
          });
        }
      });
      return { data: await requestDtos(await db(REQUESTS).whereIn('uuid', uuids).orderBy('id')) };
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/review',
    permission: 'documents.documents.update',
    params: uuidParam,
    body: z.object({
      decision: z.enum(['approved', 'rejected']),
      note: z.string().trim().max(1000).nullish(),
    }),
    summary: 'Approve or reject a submitted file. A rejection asks the customer to upload again.',
    handler: async ({ ctx, user, params, body }) => {
      await db.transaction(async (trx) => {
        const row = await scopedRequest(user, params.uuid, trx, true);
        if (row.status !== 'submitted')
          throw new AppError('CONFLICT', 'Only submitted files can be reviewed');
        await trx(REQUESTS)
          .where({ id: row.id })
          .update({
            status: body.decision,
            review_note: body.note ?? null,
            reviewed_at: new Date(),
            updated_at: new Date(),
          });
        await audit(trx, ctx, {
          action: `documents.request.${body.decision}`,
          entity: 'documents.request',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: { note: body.note ?? null },
        });
      });
      await emitRequest('document_request.reviewed', params.uuid, user.id);
      return (await requestDtos([await db(REQUESTS).where({ uuid: params.uuid }).first()]))[0];
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/cancel',
    permission: 'documents.documents.delete',
    params: uuidParam,
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const row = await scopedRequest(user, params.uuid, trx, true);
        if (!['requested', 'rejected'].includes(row.status))
          throw new AppError('CONFLICT', 'Only open requests can be cancelled');
        await trx(REQUESTS).where({ id: row.id }).update({ status: 'cancelled', updated_at: new Date() });
        await audit(trx, ctx, {
          action: 'documents.request.cancelled',
          entity: 'documents.request',
          entityId: row.id,
          entityUuid: params.uuid,
        });
      });
      return (await requestDtos([await db(REQUESTS).where({ uuid: params.uuid }).first()]))[0];
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/file',
    permission: 'documents.documents.update',
    params: uuidParam,
    before: [staffCanUpload, uploadSingle()],
    status: 201,
    summary: "Upload the file on the customer's behalf (for example, received by email).",
    handler: async ({ req, ctx, user, params }) => {
      if (!req.file) throw new AppError('VALIDATION_FAILED', 'Choose a file to upload');
      await submitFile(ctx, params.uuid, req.file, (trx) => scopedRequest(user, params.uuid, trx, true));
      await emitRequest('document_request.submitted', params.uuid, user.id);
      return (await requestDtos([await db(REQUESTS).where({ uuid: params.uuid }).first()]))[0];
    },
  });

/** Uploads are parsed only after the caller is known to be allowed (multipart runs in `before`). */
async function staffCanUpload(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = req.ctx.user;
    if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    await scopedRequest(user, String(req.params.uuid));
    next();
  } catch (err) {
    next(err);
  }
}

/** Store a file against the request's contact and mark the request submitted. */
async function submitFile(
  ctx: RequestContext,
  uuid: string,
  file: { buffer: Buffer; originalname: string },
  lock: (trx: Db) => Promise<Record<string, unknown> & { id: number; status: string }>,
) {
  await db.transaction(async (trx) => {
    const row = await lock(trx);
    if (!['requested', 'rejected'].includes(row.status))
      throw new AppError('CONFLICT', 'This request is not waiting for a file');
    const stored = await storeFile(trx, ctx, {
      buffer: file.buffer,
      originalName: file.originalname,
      entity: 'contact',
      entityId: row.contact_id as number,
    });
    await trx(REQUESTS).where({ id: row.id }).update({
      status: 'submitted',
      file_id: stored.id,
      submitted_at: new Date(),
      review_note: null,
      updated_at: new Date(),
    });
    await audit(trx, ctx, {
      action: 'documents.request.submitted',
      entity: 'documents.request',
      entityId: row.id,
      entityUuid: uuid,
      diff: { file: stored.uuid },
    });
  });
}

registerModuleWidget('documents.awaiting', async (_params, user) => {
  assertCan(user, 'documents.documents.view');
  const toReview = db(`${REQUESTS} as r`).where('r.status', 'submitted');
  await scopeByContact(toReview, user, 'r');
  const toSign = db(`${DOCS} as d`).where('d.status', 'shared').where('d.requires_signature', true);
  await scopeByContact(toSign, user, 'd');
  const outstanding = db(`${REQUESTS} as r`).whereIn('r.status', ['requested', 'rejected']);
  await scopeByContact(outstanding, user, 'r');
  const count = async (qb: Knex.QueryBuilder) =>
    Number(((await qb.count({ c: '*' }).first()) as { c: number }).c);
  return {
    toReview: await count(toReview),
    awaitingSignature: await count(toSign),
    outstanding: await count(outstanding),
  };
});

// ---------- For the client portal (by contact; the portal authenticates the contact) ----------

export async function customerLibrary(contactId: number) {
  const [docs, requests] = await Promise.all([
    db(DOCS).where({ contact_id: contactId }).whereIn('status', ['shared', 'signed']).orderBy('id', 'desc'),
    db(REQUESTS).where({ contact_id: contactId }).whereNot({ status: 'cancelled' }).orderBy('id', 'desc'),
  ]);
  return {
    documents: (await docDtos(docs, false)).map(({ createdBy: _c, contact: _k, ...d }) => d),
    requests: (await requestDtos(requests)).map(({ file, ...r }) => ({ ...r, fileName: file?.name ?? null })),
  };
}

export async function customerDocument(contactId: number, uuid: string) {
  const row = await db(DOCS)
    .where({ uuid, contact_id: contactId })
    .whereIn('status', ['shared', 'signed'])
    .first();
  if (!row) throw notFound('Document');
  const [d] = await docDtos([row], true);
  const { createdBy: _c, contact: _k, ...rest } = d!;
  return rest;
}

/** The customer signs by typing their name. The content hash proves what was signed. */
export async function signAsCustomer(ctx: RequestContext, contactId: number, uuid: string, name: string) {
  const ownerId = await db.transaction(async (trx) => {
    const row = await trx(DOCS).where({ uuid, contact_id: contactId }).forUpdate().first();
    if (!row || !['shared', 'signed'].includes(row.status)) throw notFound('Document');
    if (row.status === 'signed') throw new AppError('CONFLICT', 'This document is already signed');
    if (!row.requires_signature) throw new AppError('CONFLICT', 'This document does not need a signature');
    await trx(DOCS)
      .where({ id: row.id })
      .update({
        status: 'signed',
        signed_name: name,
        signed_at: new Date(),
        signed_ip: ctx.ip?.slice(0, 64) ?? null,
        signed_hash: sha256(row.body_html as string),
        updated_at: new Date(),
      });
    await audit(trx, ctx, {
      action: 'documents.document.signed',
      entity: 'documents.document',
      entityId: row.id,
      entityUuid: uuid,
      diff: { name, hash: sha256(row.body_html as string) },
    });
    return row.created_by as number | null;
  });
  if (ownerId)
    await notify(ownerId, {
      type: 'document.signed',
      title: 'A document was signed',
      body: name,
      link: `/m/documents/${uuid}`,
      email: true,
    });
  await emitDoc('document.signed', uuid, null);
}

export async function submitFileAsCustomer(
  ctx: RequestContext,
  contactId: number,
  uuid: string,
  file: { buffer: Buffer; originalname: string },
) {
  await submitFile(ctx, uuid, file, async (trx) => {
    const row = await trx(REQUESTS).where({ uuid, contact_id: contactId }).forUpdate().first();
    if (!row) throw notFound('File request');
    return row;
  });
  const row = await db(REQUESTS).where({ uuid }).first('requested_by', 'name');
  if (row?.requested_by)
    await notify(row.requested_by as number, {
      type: 'document_request.submitted',
      title: `${row.name} was uploaded`,
      body: null,
      link: '/m/documents?tab=review',
      email: false,
    });
  await emitRequest('document_request.submitted', uuid, null);
}

/** For the portal: does this contact have an open request with this uuid? (checked before parsing uploads) */
export async function customerHasOpenRequest(contactId: number, uuid: string) {
  return !!(await db(REQUESTS)
    .where({ uuid, contact_id: contactId })
    .whereIn('status', ['requested', 'rejected'])
    .first('id'));
}

export const documents: ApiModule = {
  routes: () => [templateRoutes, docRoutes, requestRoutes],
  migrations: { '0001_documents': m0001 },
};
