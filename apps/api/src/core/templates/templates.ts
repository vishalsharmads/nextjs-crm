import Handlebars from 'handlebars';
import { z } from 'zod';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { DEFAULT_EMAIL_TEMPLATES } from '../mail/templates';
import { getBranding } from '../settings/settings.service';
import { getLabels } from '../labels/labels.service';

const body = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/),
  channel: z.enum(['email', 'notification', 'document']),
  locale: z.string().min(2).max(10).default('en'),
  name: z.string().trim().min(1).max(150),
  subject: z.string().max(255).default(''),
  body: z.string().min(1).max(100_000),
});

/** Compile check: a broken template is rejected on save, not discovered when an email fails. */
function assertCompiles(...sources: string[]) {
  for (const src of sources) {
    try {
      Handlebars.precompile(src);
    } catch (err) {
      throw new AppError('VALIDATION_FAILED', `Template error: ${(err as Error).message.split('\n')[0]}`, [
        { path: 'body', message: (err as Error).message.split('\n')[0] },
      ]);
    }
  }
}

const dto = (t: Record<string, unknown>) => ({
  uuid: t.uuid,
  key: t.key,
  channel: t.channel,
  locale: t.locale,
  name: t.name,
  subject: t.subject,
  body: t.body,
  sourceBlueprint: t.source_blueprint,
  customized: !!t.customized,
  builtIn: false,
});

export const templatesRoutes = defineRoutes('/templates', ['templates'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.templates.manage',
    summary: 'Stored templates plus built-in defaults that have not been overridden',
    handler: async () => {
      const rows = (await db('templates').orderBy(['channel', 'key'])).map(dto);
      const builtIns = Object.entries(DEFAULT_EMAIL_TEMPLATES)
        .filter(([key]) => !rows.some((r) => r.key === key && r.channel === 'email'))
        .map(([key, t]) => ({
          uuid: null,
          key,
          channel: 'email',
          locale: 'en',
          name: t.name,
          subject: t.subject,
          body: t.body,
          sourceBlueprint: null,
          customized: false,
          builtIn: true,
        }));
      return { data: [...rows, ...builtIns] };
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.templates.manage',
    body,
    status: 201,
    handler: async ({ ctx, body: b }) => {
      assertCompiles(b.subject, b.body);
      if (await db('templates').where({ key: b.key, channel: b.channel, locale: b.locale }).first())
        throw new AppError('CONFLICT', 'A template with this key already exists');
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx('templates').insert({ uuid, ...b, customized: true });
        await audit(trx, ctx, {
          action: 'template.created',
          entity: 'template',
          entityId: id,
          entityUuid: uuid,
          diff: { key: b.key },
        });
      });
      return dto(await db('templates').where({ uuid }).first());
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'core.templates.manage',
    params: z.object({ uuid: z.uuid() }),
    body: body.pick({ name: true, subject: true, body: true }).partial(),
    handler: async ({ ctx, params, body: b }) => {
      const t = await db('templates').where({ uuid: params.uuid }).first();
      if (!t) throw notFound('Template');
      assertCompiles(b.subject ?? t.subject, b.body ?? t.body);
      await db.transaction(async (trx) => {
        await trx('templates')
          .where({ id: t.id })
          .update({ ...b, customized: true });
        await audit(trx, ctx, {
          action: 'template.updated',
          entity: 'template',
          entityId: t.id,
          entityUuid: params.uuid,
          diff: { key: t.key },
        });
      });
      return dto(await db('templates').where({ id: t.id }).first());
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'core.templates.manage',
    params: z.object({ uuid: z.uuid() }),
    summary: 'Delete a template (built-in keys fall back to the default)',
    handler: async ({ ctx, params }) => {
      const n = await db('templates').where({ uuid: params.uuid }).delete();
      if (!n) throw notFound('Template');
      await audit(db, ctx, { action: 'template.deleted', entity: 'template', entityUuid: params.uuid });
    },
  })
  .add({
    method: 'post',
    path: '/preview',
    permission: 'core.templates.manage',
    body: z.object({
      subject: z.string().max(255).default(''),
      body: z.string().max(100_000),
      sample: z.record(z.string(), z.unknown()).default({}),
    }),
    summary: 'Render a template with sample data, branding and vocabulary',
    handler: async ({ body: b }) => {
      assertCompiles(b.subject, b.body);
      const labels = await getLabels('en');
      const vars = {
        branding: await getBranding(),
        labels,
        user: { firstName: 'Alex' },
        link: 'https://example.invalid/link',
        record: { title: 'Sample record', fullName: 'Sam Example' },
        ...b.sample,
      };
      return { subject: Handlebars.compile(b.subject)(vars), html: Handlebars.compile(b.body)(vars) };
    },
  });
