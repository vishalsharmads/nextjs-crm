import { z } from 'zod';
import multer from 'multer';
import { stringify } from 'csv-stringify/sync';
import { entityKeySchema } from '@app/shared';
import { defineRoutes, type RouteGroup } from '../../http/routes';
import { db } from '../../db/knex';
import { env } from '../../config/env';
import { AppError, notFound } from '../../lib/errors';
import { assertCan } from '../rbac/access';
import { storeFile } from '../files/files.service';
import { recordDefs } from '../records/registry';
import { recordBasePath } from '../records/paths';
import type { ResourceDef } from '../records/types';
import { runBulk } from '../bulk/bulk.service';
import {
  exportCsv,
  exportQuerySchema,
  importStartSchema,
  importTargets,
  ioDef,
  startImport,
  suggestMapping,
} from './import-export';
import { parseTable } from './table';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
});

export const importsRoutes = defineRoutes('/imports', ['import-export'])
  .add({
    method: 'post',
    path: '/',
    permission: 'authenticated',
    before: [upload.single('file')],
    summary: 'Upload a CSV or Excel file and get headers, a sample and suggested column mapping',
    status: 201,
    handler: async ({ req, ctx, user }) => {
      const entity = entityKeySchema.parse(req.body?.entity);
      const def = ioDef(entity);
      assertCan(user, `${def.resource}.import`);
      if (!req.file) throw new AppError('VALIDATION_FAILED', 'Choose a CSV or Excel file');
      const { headers, rows } = await parseTable(req.file.buffer);
      const stored = await db.transaction((trx) =>
        storeFile(trx, ctx, {
          buffer: req.file!.buffer,
          originalName: req.file!.originalname,
          entity: 'import',
        }),
      );
      const targets = await importTargets(def, user);
      return {
        fileUuid: stored.uuid,
        entity,
        headers,
        sample: rows.slice(0, 5),
        total: rows.length,
        targets,
        suggested: suggestMapping(headers, targets),
      };
    },
  })
  .add({
    method: 'post',
    path: '/start',
    permission: 'authenticated',
    body: importStartSchema,
    handler: async ({ ctx, user, body }) => ({ jobUuid: await startImport(ctx, user, body) }),
  })
  .add({
    method: 'get',
    path: '/:uuid',
    permission: 'authenticated',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ user, params }) => {
      const job = await db('jobs').where({ uuid: params.uuid, type: 'import', created_by: user.id }).first();
      if (!job) throw notFound('Import');
      const result = job.result as {
        created: number;
        updated: number;
        skipped: number;
        failed: number;
        errors: unknown[];
      } | null;
      return {
        uuid: job.uuid,
        status: job.status,
        progress: job.progress,
        error: job.error,
        result: result
          ? {
              created: result.created,
              updated: result.updated,
              skipped: result.skipped,
              failed: result.failed,
              errorCount: result.errors.length,
            }
          : null,
      };
    },
  })
  .add({
    method: 'get',
    path: '/:uuid/errors.csv',
    permission: 'authenticated',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ res, user, params }) => {
      const job = await db('jobs').where({ uuid: params.uuid, type: 'import', created_by: user.id }).first();
      const result = job?.result as {
        headers: string[];
        errors: { row: number; message: string; values: string[] }[];
      } | null;
      if (!result) throw notFound('Import');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="import-errors.csv"');
      res.send(
        stringify(
          [
            ['Row', 'Problem', ...result.headers],
            ...result.errors.map((e) => [e.row, e.message, ...e.values]),
          ],
          { bom: true },
        ),
      );
    },
  });

/** /<entity>/bulk and /<entity>/export of one record type, registered before /<entity>/:uuid. */
export function collectionRoutes(def: ResourceDef): RouteGroup {
  const group = defineRoutes(recordBasePath(def), ['import-export'], def.moduleKey).add({
    method: 'post',
    path: '/bulk',
    permission: `${def.resource}.bulk`,
    body: z.record(z.string(), z.unknown()),
    handler: ({ ctx, user, body }) => runBulk(def, ctx, user, body),
  });
  if (def.entity !== 'activity') {
    group.add({
      method: 'get',
      path: '/export',
      permission: `${def.resource}.export`,
      query: exportQuerySchema,
      handler: ({ res, ctx, user, query }) => exportCsv(def, ctx, user, query, res),
    });
  }
  return group;
}

/** Collection routes of the core entities. */
export function entityCollectionRoutes(): RouteGroup[] {
  return Object.values(recordDefs).map(collectionRoutes);
}
