import { toPatch } from '@app/shared';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { defineRoutes } from '../../http/routes';
import type { AuthUser } from '../../http/context';
import { isTest } from '../../config/env';
import { db } from '../../db/knex';
import { AppError, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { loadAccess } from '../rbac/access';
import { emit } from '../events/events';
import { notify } from '../notifications/notifications.service';
import { recordDefs } from '../records/registry';
import { createRecord } from '../records/service';
import { getDefinitions } from '../custom-fields/definitions';
import { getBranding } from '../settings/settings.service';

/** Core inputs a public form may collect, per target entity. */
const CORE_TARGETS: Record<'contact' | 'lead', string[]> = {
  contact: ['firstName', 'lastName', 'email', 'phone', 'jobTitle'],
  lead: ['firstName', 'lastName', 'email', 'phone', 'companyName', 'jobTitle'],
};

const formField = z.object({
  /** Core input name or `cf.<key>`. */
  target: z.string().regex(/^(cf\.[a-z][a-z0-9_]{0,48}|[a-zA-Z]{2,30})$/),
  label: z.string().trim().min(1).max(100),
  required: z.boolean().default(false),
  placeholder: z.string().max(100).optional(),
  help: z.string().max(200).optional(),
});

const settingsSchema = z.object({
  title: z.string().max(150).default(''),
  intro: z.string().max(1000).default(''),
  submitLabel: z.string().max(40).default('Send'),
  successMessage: z.string().max(500).default('Thanks, we will be in touch soon.'),
  redirectUrl: z.union([z.url().max(500), z.literal('')]).default(''),
  ownerUuid: z.uuid().nullish(),
  notifyOwner: z.boolean().default(true),
  source: z.string().max(100).default('Web form'),
  tags: z.array(z.string().min(1).max(64)).max(10).default([]),
  consentText: z.string().max(500).default(''),
});

const formBody = z.object({
  name: z.string().trim().min(1).max(150),
  entity: z.enum(['contact', 'lead']),
  fields: z.array(formField).min(1).max(30),
  settings: settingsSchema,
  active: z.boolean().default(true),
});

async function validateTargets(entity: 'contact' | 'lead', fields: z.infer<typeof formField>[]) {
  const defs = await getDefinitions(entity);
  for (const f of fields) {
    if (
      f.target.startsWith('cf.')
        ? !defs.some((d) => d.key === f.target.slice(3))
        : !CORE_TARGETS[entity].includes(f.target)
    ) {
      throw new AppError('VALIDATION_FAILED', `"${f.label}" maps to an unknown field`, [
        { path: 'fields', message: f.target },
      ]);
    }
  }
}

/** The public-facing definition: no owner, no internal ids. */
async function publicForm(f: Record<string, unknown>) {
  const s = settingsSchema.parse(f.settings);
  const defs = await getDefinitions(f.entity as 'contact' | 'lead');
  const branding = await getBranding();
  return {
    uuid: f.uuid,
    appName: branding.appName,
    title: s.title || (f.name as string),
    intro: s.intro,
    submitLabel: s.submitLabel,
    consentText: s.consentText,
    fields: (f.fields as z.infer<typeof formField>[]).map((x) => {
      const def = x.target.startsWith('cf.') ? defs.find((d) => d.key === x.target.slice(3)) : undefined;
      return {
        name: x.target,
        label: x.label,
        required: x.required,
        placeholder: x.placeholder ?? '',
        help: x.help ?? '',
        type: def ? def.type : x.target === 'email' ? 'email' : x.target === 'phone' ? 'phone' : 'text',
        options:
          def?.options.filter((o) => o.active !== false).map((o) => ({ value: o.key, label: o.label })) ?? [],
      };
    }),
  };
}

const submitLimiter = rateLimit({
  windowMs: 60_000,
  limit: isTest ? 1000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: () => {
    throw new AppError('RATE_LIMITED', 'Too many submissions. Try again in a minute.');
  },
});

export const publicFormsRoutes = defineRoutes('/public/forms', ['forms'])
  .add({
    method: 'get',
    path: '/:uuid',
    permission: 'public',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ params }) => {
      const f = await db('web_forms').where({ uuid: params.uuid, active: true }).first();
      if (!f) throw notFound('Form');
      return publicForm(f);
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/submit',
    permission: 'public',
    before: [submitLimiter],
    params: z.object({ uuid: z.uuid() }),
    body: z.record(z.string().max(60), z.unknown()),
    summary: 'Public submission (no session, no CSRF). Honeypot field: "website_url".',
    handler: async ({ ctx, params, body }) => {
      const f = await db('web_forms').where({ uuid: params.uuid, active: true }).first();
      if (!f) throw notFound('Form');
      const s = settingsSchema.parse(f.settings);
      // Bots fill every field; people never see this one.
      if (body.website_url)
        return { ok: true, message: s.successMessage, redirectUrl: s.redirectUrl || null };
      const fields = f.fields as z.infer<typeof formField>[];
      const input: Record<string, unknown> = { source: s.source, tags: s.tags };
      const custom: Record<string, unknown> = {};
      const missing: { path: string; message: string }[] = [];
      for (const field of fields) {
        const raw = body[field.target];
        const empty = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length);
        if (empty) {
          if (field.required) missing.push({ path: field.target, message: `${field.label} is required` });
          continue;
        }
        if (field.target.startsWith('cf.')) custom[field.target.slice(3)] = raw;
        else input[field.target] = typeof raw === 'string' ? raw.slice(0, 500) : raw;
      }
      if (missing.length) throw new AppError('VALIDATION_FAILED', 'Some fields need attention', missing);
      if (Object.keys(custom).length) input.custom = custom;

      // Submissions are created as the form's owner (or its creator), with that person's write rules.
      const ownerUuid =
        s.ownerUuid ??
        ((await db('users').where({ id: f.created_by }).first('uuid'))?.uuid as string | undefined);
      const owner = ownerUuid
        ? await db('users').where({ uuid: ownerUuid, status: 'active' }).whereNull('deleted_at').first()
        : null;
      if (!owner) throw new AppError('INTERNAL', 'This form is not accepting submissions right now');
      const actor: AuthUser = {
        id: owner.id,
        uuid: owner.uuid,
        email: owner.email,
        firstName: owner.first_name,
        lastName: owner.last_name,
        sessionId: null,
        ...(await loadAccess(owner.id)),
      };
      input.ownerUuid = owner.uuid;
      const def = recordDefs[f.entity as 'contact' | 'lead'];
      let record: { uuid: string; fullName?: string };
      try {
        record = (await createRecord(def, { ...ctx, user: actor }, actor, input)) as {
          uuid: string;
          fullName?: string;
        };
      } catch (err) {
        // Field-level messages are safe to show; anything else stays generic.
        if (err instanceof AppError && err.code === 'VALIDATION_FAILED') throw err;
        throw new AppError('INTERNAL', 'The form could not be submitted. Try again.');
      }
      await db('web_forms').where({ id: f.id }).increment('submission_count', 1);
      await audit(db, ctx, {
        action: 'form.submitted',
        entity: 'web_form',
        entityId: f.id,
        entityUuid: f.uuid,
        diff: { record: record.uuid },
      });
      await emit({
        type: 'form.submitted',
        entity: f.entity,
        uuid: record.uuid,
        record: record as unknown as Record<string, unknown>,
        actorId: null,
      });
      if (s.notifyOwner) {
        await notify(owner.id, {
          type: 'form.submitted',
          title: `New submission: ${f.name}`,
          body: record.fullName ?? null,
          link: `/${def.table}/${record.uuid}`,
          email: true,
        });
      }
      return { ok: true, message: s.successMessage, redirectUrl: s.redirectUrl || null };
    },
  });

const dto = (f: Record<string, unknown>) => ({
  uuid: f.uuid,
  name: f.name,
  entity: f.entity,
  fields: f.fields,
  settings: f.settings,
  active: !!f.active,
  submissionCount: f.submission_count,
  createdAt: new Date(f.created_at as string).toISOString(),
});

export const formsRoutes = defineRoutes('/forms', ['forms'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.forms.manage',
    handler: async () => ({ data: (await db('web_forms').orderBy('id', 'desc')).map(dto) }),
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.forms.manage',
    body: formBody,
    status: 201,
    handler: async ({ ctx, user, body }) => {
      await validateTargets(body.entity, body.fields);
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx('web_forms').insert({
          uuid,
          name: body.name,
          entity: body.entity,
          fields: JSON.stringify(body.fields),
          settings: JSON.stringify(body.settings),
          active: body.active,
          created_by: user.id,
        });
        await audit(trx, ctx, {
          action: 'form.created',
          entity: 'web_form',
          entityId: id,
          entityUuid: uuid,
          diff: { name: body.name },
        });
      });
      return dto(await db('web_forms').where({ uuid }).first());
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'core.forms.manage',
    params: z.object({ uuid: z.uuid() }),
    body: toPatch(formBody),
    handler: async ({ ctx, params, body }) => {
      const f = await db('web_forms').where({ uuid: params.uuid }).first();
      if (!f) throw notFound('Form');
      if (body.fields) await validateTargets(body.entity ?? f.entity, body.fields);
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.entity !== undefined) patch.entity = body.entity;
      if (body.fields !== undefined) patch.fields = JSON.stringify(body.fields);
      if (body.settings !== undefined) patch.settings = JSON.stringify(body.settings);
      if (body.active !== undefined) patch.active = body.active;
      await db.transaction(async (trx) => {
        await trx('web_forms').where({ id: f.id }).update(patch);
        await audit(trx, ctx, {
          action: 'form.updated',
          entity: 'web_form',
          entityId: f.id,
          entityUuid: params.uuid,
          diff: body,
        });
      });
      return dto(await db('web_forms').where({ id: f.id }).first());
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'core.forms.manage',
    params: z.object({ uuid: z.uuid() }),
    handler: async ({ ctx, params }) => {
      const n = await db('web_forms').where({ uuid: params.uuid }).delete();
      if (!n) throw notFound('Form');
      await audit(db, ctx, { action: 'form.deleted', entity: 'web_form', entityUuid: params.uuid });
    },
  });
