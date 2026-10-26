import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import multer from 'multer';
import { RELATED_TYPES } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { env } from '../../config/env';
import { AppError, notFound } from '../../lib/errors';
import { storage } from '../../lib/storage';
import { audit } from '../audit/audit.service';
import { logAccess } from '../audit/access-log';
import { assertCan, can } from '../rbac/access';
import { getRow } from '../records/service';
import { recordDefs } from '../records/registry';
import { userRefs } from '../records/hydrate';
import { fileDto, signFileUrl, storeFile, verifyFileToken } from './files.service';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
});
const target = z.object({ entity: z.enum(RELATED_TYPES), uuid: z.uuid() });

/** Files belong to a record; access follows the record's visibility. */
async function fileWithAccess(user: Parameters<typeof getRow>[1], uuid: string) {
  const file = await db('files').where({ uuid }).whereNull('deleted_at').first();
  if (!file || !file.entity || !(file.entity in recordDefs)) throw notFound('File');
  const def = recordDefs[file.entity as keyof typeof recordDefs];
  const parent = await db(def.table).where({ id: file.entity_id }).first('uuid');
  if (!parent) throw notFound('File');
  assertCan(user, `${def.resource}.view`);
  await getRow(def, user, parent.uuid as string);
  return file;
}

export const filesRoutes = defineRoutes('/files', ['files'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.files.view',
    query: target,
    handler: async ({ user, query }) => {
      const def = recordDefs[query.entity];
      assertCan(user, `${def.resource}.view`);
      const parent = await getRow(def, user, query.uuid);
      const rows = await db('files')
        .where({ entity: query.entity, entity_id: parent.id })
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc');
      const uploaders = await userRefs(rows.map((r) => r.uploaded_by));
      return { data: rows.map((r) => ({ ...fileDto(r), uploadedBy: uploaders.get(r.uploaded_by) ?? null })) };
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.files.create',
    before: [upload.single('file')],
    handler: async ({ req, ctx, user }) => {
      const t = target.parse(req.body);
      if (!req.file) throw new AppError('VALIDATION_FAILED', 'Choose a file to upload');
      const def = recordDefs[t.entity];
      assertCan(user, `${def.resource}.view`);
      const parent = await getRow(def, user, t.uuid);
      const stored = await db.transaction((trx) =>
        storeFile(trx, ctx, {
          buffer: req.file!.buffer,
          originalName: req.file!.originalname,
          entity: t.entity,
          entityId: parent.id,
        }),
      );
      const row = await db('files').where({ id: stored.id }).first();
      return {
        ...fileDto(row),
        uploadedBy: { uuid: user.uuid, name: `${user.firstName} ${user.lastName}`.trim() },
      };
    },
    status: 201,
  })
  .add({
    method: 'get',
    path: '/:uuid/url',
    permission: 'core.files.view',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ user, params }) => {
      await fileWithAccess(user, params.uuid);
      return { url: signFileUrl(params.uuid) };
    },
  })
  .add({
    method: 'get',
    path: '/download',
    permission: 'authenticated',
    query: z.object({ token: z.string().max(500), inline: z.coerce.boolean().optional() }),
    summary: 'Download via a short-lived signed link',
    handler: async ({ ctx, res, user, query }) => {
      const uuid = verifyFileToken(query.token);
      const file = await fileWithAccess(user, uuid);
      await logAccess(ctx, {
        action: 'download',
        entity: file.entity,
        entityId: file.entity_id,
        detail: { file: file.uuid },
      });
      const inline = query.inline && (file.mime.startsWith('image/') || file.mime === 'application/pdf');
      res.set('Content-Type', file.mime);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set(
        'Content-Security-Policy',
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      );
      res.set(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
      );
      await pipeline(storage.stream(file.storage_key), res);
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'core.files.delete',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ ctx, user, params }) => {
      const file = await fileWithAccess(user, params.uuid);
      if (
        file.uploaded_by !== user.id &&
        !can(user, `${recordDefs[file.entity as keyof typeof recordDefs].resource}.update`)
      ) {
        throw new AppError('FORBIDDEN', 'You can only delete files you uploaded');
      }
      await db.transaction(async (trx) => {
        await trx('files').where({ id: file.id }).update({ deleted_at: new Date() });
        await audit(trx, ctx, {
          action: 'file.deleted',
          entity: file.entity,
          entityId: file.entity_id,
          diff: { file: params.uuid, name: file.original_name },
        });
      });
    },
  });
