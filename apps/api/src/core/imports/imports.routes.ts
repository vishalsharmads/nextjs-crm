import { z } from 'zod';
import multer from 'multer';
import { stringify } from 'csv-stringify/sync';
import { ENTITY_ROUTE } from '@app/shared';
import { defineRoutes, type RouteGroup } from '../../http/routes';
import { db } from '../../db/knex';
import { env } from '../../config/env';
import { AppError, notFound } from '../../lib/errors';
import { assertCan } from '../rbac/access';
import { storeFile } from '../files/files.service';
import { recordDefs } from '../records/registry';
import { runBulk } from '../bulk/bulk.service';
import {
  exportCsv,
  exportQuerySchema,
  importStartSchema,
  importTargets,
  parseCsv,
  startImport,
  suggestMapping,
} from './import-export';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
});
const IMPORTABLE = ['contact', 'organization', 'lead', 'deal'] as const;

export const importsRoutes = defineRoutes('/imports', ['import-export'])
  .add({
    method: 'post',
    path: '/',
    permission: 'authenticated',
    before: [upload.single('file')],
    summary: 'Upload a CSV and get headers, a sample and suggested column mapping',
    status: 201,
    handler: async ({ req, ctx, user }) => {
      const entity = z.enum(IMPORTABLE).parse(req.body?.entity);
      const def = recordDefs[entity];
      assertCan(user, `${def.resource}.import`);
      if (!req.file) throw new AppError('VALIDATION_FAILED', 'Choose a CSV file');
      const { headers, rows } = parseCsv(req.file.buffer);
      const stored = await db.transaction((trx) =>
        storeFile(trx, ctx, {
          buffer: req.file!.buffer,
          originalName: req.file!.originalname,
          entity: 'import',
        }),
      );
      const targets = await importTargets(entity, user);
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

/** /<entity>/export and /<entity>/bulk — registered before /<entity>/:uuid so they are not read as ids. */
export function entityCollectionRoutes(): RouteGroup[] {
  return (['contact', 'organization', 'lead', 'deal', 'activity'] as const).map((entity) => {
    const def = recordDefs[entity];
    const group = defineRoutes(`/${ENTITY_ROUTE[entity]}`, ['import-export']).add({
      method: 'post',
      path: '/bulk',
      permission: `${def.resource}.bulk`,
      body: z.record(z.string(), z.unknown()),
      handler: ({ ctx, user, body }) => runBulk(def, ctx, user, body),
    });
    if (entity !== 'activity') {
      group.add({
        method: 'get',
        path: '/export',
        permission: `${def.resource}.export`,
        query: exportQuerySchema,
        handler: ({ res, ctx, user, query }) => exportCsv(entity, ctx, user, query, res),
      });
    }
    return group;
  });
}
