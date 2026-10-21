import { z } from 'zod';
import {
  CUSTOMIZABLE_ENTITIES,
  FILTERABLE_TYPES,
  customFieldInputSchema,
  fieldOptionSchema,
  valueSchemaFor,
  visibilitySchema,
  fieldValidationSchema,
} from '@app/shared';
import { defineRoutes } from '../../http/routes';
import { db } from '../../db/knex';
import { AppError, conflict, notFound } from '../../lib/errors';
import { newUuid } from '../../lib/ids';
import { audit } from '../audit/audit.service';
import { ENTITY_TABLE, bumpDefinitionsVersion, getDefinitions, rowToDef } from './definitions';
import { dropCustomFieldIndex, ensureCustomFieldIndexes, MAX_INDEXED_FIELDS } from './ddl.service';

const entityQuery = z.object({
  entity: z.enum(CUSTOMIZABLE_ENTITIES).optional(),
  includeArchived: z.coerce.boolean().optional(),
});
const uuidParam = z.object({ uuid: z.uuid() });

/** Default filterability: structured types yes, free text no. */
function defaultFilterable(type: string) {
  return !['textarea', 'file', 'text', 'url'].includes(type);
}

function configJson(input: { options?: unknown; currency?: string; placeholder?: string }) {
  return JSON.stringify({ options: input.options, currency: input.currency, placeholder: input.placeholder });
}

async function assertIndexCapacity(entity: (typeof CUSTOMIZABLE_ENTITIES)[number], excludingUuid?: string) {
  const q = db('custom_field_definitions').where({ entity, active: true, filterable: true });
  if (excludingUuid) q.whereNot({ uuid: excludingUuid });
  const n = Number(((await q.count({ c: '*' }).first()) as { c: number }).c);
  if (n >= MAX_INDEXED_FIELDS)
    throw conflict(`At most ${MAX_INDEXED_FIELDS} fields per record type can be filterable`);
}

/** Records with no value for a field (shown as a banner when a field becomes required). */
async function missingCount(entity: (typeof CUSTOMIZABLE_ENTITIES)[number], key: string) {
  const row = await db(ENTITY_TABLE[entity])
    .whereNull('deleted_at')
    .whereRaw('JSON_EXTRACT(custom, ?) IS NULL', [`$.${key}`])
    .count({ c: '*' })
    .first();
  return Number((row as { c: number }).c);
}

const patchSchema = customFieldInputSchema
  .omit({ entity: true, key: true, type: true })
  .partial()
  .extend({
    options: z.array(fieldOptionSchema).optional(),
    visibility: visibilitySchema.optional(),
    validation: fieldValidationSchema.optional(),
  });

export const customFieldsRoutes = defineRoutes('/custom-fields', ['custom-fields'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.fields.manage',
    query: entityQuery,
    handler: async ({ query }) => {
      const entities = query.entity ? [query.entity] : CUSTOMIZABLE_ENTITIES;
      const out = [];
      for (const e of entities)
        out.push(...(await getDefinitions(e, { includeArchived: query.includeArchived })));
      return { data: out };
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'core.fields.manage',
    body: customFieldInputSchema,
    status: 201,
    handler: async ({ ctx, body }) => {
      if (await db('custom_field_definitions').where({ entity: body.entity, key: body.key }).first()) {
        throw conflict('A field with this key already exists (it may be archived)');
      }
      if ((body.type === 'select' || body.type === 'multi_select') && !body.options?.length) {
        throw new AppError('VALIDATION_FAILED', 'Add at least one option', [
          { path: 'options', message: 'Add at least one option' },
        ]);
      }
      const filterable =
        (body.filterable ?? defaultFilterable(body.type)) && FILTERABLE_TYPES.includes(body.type);
      if (filterable) await assertIndexCapacity(body.entity);
      const defaultValue =
        body.defaultValue === undefined || body.defaultValue === null || body.defaultValue === ''
          ? null
          : body.defaultValue;
      if (defaultValue !== null) {
        const ok = valueSchemaFor({
          type: body.type,
          options: (body.options ?? []).map((o) => ({ ...o, active: o.active ?? true })),
          validation: body.validation ?? {},
          label: body.label,
        }).safeParse(defaultValue);
        if (!ok.success)
          throw new AppError('VALIDATION_FAILED', 'The default value is not valid for this field', [
            { path: 'defaultValue', message: ok.error.issues[0]?.message ?? 'Invalid' },
          ]);
      }
      const max = await db('custom_field_definitions')
        .where({ entity: body.entity })
        .max({ m: 'sort_order' })
        .first();
      const uuid = newUuid();
      await db.transaction(async (trx) => {
        const [id] = await trx('custom_field_definitions').insert({
          uuid,
          entity: body.entity,
          key: body.key,
          label: body.label,
          type: body.type,
          group_key: body.group ?? null,
          config: configJson(body),
          required: body.required ?? false,
          default_value: defaultValue === null ? null : JSON.stringify(defaultValue),
          validation: body.validation ? JSON.stringify(body.validation) : null,
          visibility: body.visibility ? JSON.stringify(body.visibility) : null,
          help_text: body.helpText ?? null,
          filterable,
          show_in_list: body.showInList ?? false,
          sort_order: body.sortOrder ?? Number((max as { m: number | null })?.m ?? 0) + 10,
          customized: true,
        });
        await audit(trx, ctx, {
          action: 'custom_field.created',
          entity: 'custom_field',
          entityId: id,
          entityUuid: uuid,
          diff: body,
        });
      });
      bumpDefinitionsVersion();
      // DDL runs after the transaction: MySQL commits implicitly on ALTER TABLE.
      if (filterable) await ensureCustomFieldIndexes(body.entity);
      return rowToDef(await db('custom_field_definitions').where({ uuid }).first());
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'core.fields.manage',
    params: uuidParam,
    body: patchSchema,
    handler: async ({ ctx, params, body }) => {
      const row = await db('custom_field_definitions').where({ uuid: params.uuid }).first();
      if (!row) throw notFound('Field');
      const def = rowToDef(row);
      const filterable =
        body.filterable === undefined
          ? def.filterable
          : body.filterable && FILTERABLE_TYPES.includes(def.type);
      if (filterable && !def.filterable) await assertIndexCapacity(def.entity, def.uuid);
      if (body.options && (def.type === 'select' || def.type === 'multi_select')) {
        // Options are never removed (stored values reference their keys); archive them with active: false.
        const removed = def.options.filter((o) => !body.options!.some((n) => n.key === o.key));
        if (removed.length)
          throw new AppError(
            'VALIDATION_FAILED',
            `Archive options instead of removing them: ${removed.map((o) => o.label).join(', ')}`,
          );
      }
      const patch: Record<string, unknown> = { customized: true };
      if (body.label !== undefined) patch.label = body.label;
      if (body.group !== undefined) patch.group_key = body.group;
      if (body.helpText !== undefined) patch.help_text = body.helpText;
      if (body.required !== undefined) patch.required = body.required;
      if (body.showInList !== undefined) patch.show_in_list = body.showInList;
      if (body.sortOrder !== undefined) patch.sort_order = body.sortOrder;
      if (body.validation !== undefined) patch.validation = JSON.stringify(body.validation);
      if (body.visibility !== undefined) patch.visibility = JSON.stringify(body.visibility);
      if (body.defaultValue !== undefined)
        patch.default_value =
          body.defaultValue === null || body.defaultValue === '' ? null : JSON.stringify(body.defaultValue);
      if (body.options !== undefined || body.currency !== undefined || body.placeholder !== undefined) {
        patch.config = configJson({
          options: body.options ?? def.options,
          currency: body.currency ?? def.currency ?? undefined,
          placeholder: body.placeholder ?? def.placeholder ?? undefined,
        });
      }
      patch.filterable = filterable;
      await db.transaction(async (trx) => {
        await trx('custom_field_definitions').where({ id: row.id }).update(patch);
        await audit(trx, ctx, {
          action: 'custom_field.updated',
          entity: 'custom_field',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: body,
        });
      });
      bumpDefinitionsVersion();
      if (filterable && !def.filterable) await ensureCustomFieldIndexes(def.entity);
      const updated = rowToDef(await db('custom_field_definitions').where({ id: row.id }).first());
      return {
        ...updated,
        missingCount: updated.required ? await missingCount(updated.entity, updated.key) : 0,
      };
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/archive',
    permission: 'core.fields.manage',
    params: uuidParam,
    summary: 'Archive a field. Its values are kept; it disappears from forms, lists and filters.',
    handler: async ({ ctx, params }) => {
      const row = await db('custom_field_definitions').where({ uuid: params.uuid }).first();
      if (!row) throw notFound('Field');
      await db.transaction(async (trx) => {
        await trx('custom_field_definitions')
          .where({ id: row.id })
          .update({ active: false, customized: true });
        await audit(trx, ctx, {
          action: 'custom_field.archived',
          entity: 'custom_field',
          entityId: row.id,
          entityUuid: params.uuid,
        });
      });
      bumpDefinitionsVersion();
      return rowToDef(await db('custom_field_definitions').where({ id: row.id }).first());
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/restore',
    permission: 'core.fields.manage',
    params: uuidParam,
    handler: async ({ ctx, params }) => {
      const row = await db('custom_field_definitions').where({ uuid: params.uuid }).first();
      if (!row) throw notFound('Field');
      if (row.filterable) await assertIndexCapacity(row.entity, params.uuid);
      await db.transaction(async (trx) => {
        await trx('custom_field_definitions')
          .where({ id: row.id })
          .update({ active: true, customized: true });
        await audit(trx, ctx, {
          action: 'custom_field.restored',
          entity: 'custom_field',
          entityId: row.id,
          entityUuid: params.uuid,
        });
      });
      bumpDefinitionsVersion();
      if (row.filterable) await ensureCustomFieldIndexes(row.entity);
      return rowToDef(await db('custom_field_definitions').where({ id: row.id }).first());
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/drop-index',
    permission: 'core.fields.manage',
    params: uuidParam,
    summary: 'Remove the generated column and index of an archived field (values stay in place).',
    handler: async ({ ctx, params }) => {
      const row = await db('custom_field_definitions').where({ uuid: params.uuid }).first();
      if (!row) throw notFound('Field');
      if (row.active) throw conflict('Archive the field first');
      await dropCustomFieldIndex(row.entity, row.key);
      await audit(db, ctx, {
        action: 'custom_field.index_dropped',
        entity: 'custom_field',
        entityId: row.id,
        entityUuid: params.uuid,
      });
    },
  })
  .add({
    method: 'put',
    path: '/order',
    permission: 'core.fields.manage',
    body: z.object({ entity: z.enum(CUSTOMIZABLE_ENTITIES), uuids: z.array(z.uuid()).max(500) }),
    handler: async ({ ctx, body }) => {
      await db.transaction(async (trx) => {
        for (const [i, uuid] of body.uuids.entries()) {
          await trx('custom_field_definitions')
            .where({ uuid, entity: body.entity })
            .update({ sort_order: (i + 1) * 10, customized: true });
        }
        await audit(trx, ctx, { action: 'custom_field.reordered', entity: 'custom_field', diff: body });
      });
      bumpDefinitionsVersion();
    },
  });

const groupBody = z.object({
  entity: z.enum(CUSTOMIZABLE_ENTITIES),
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: z.string().trim().min(1).max(100),
  sortOrder: z.number().int().optional(),
  visibility: visibilitySchema.optional(),
});

export const fieldGroupsRoutes = defineRoutes('/custom-field-groups', ['custom-fields'])
  .add({
    method: 'get',
    path: '/',
    permission: 'core.fields.manage',
    handler: async () => ({
      data: (await db('custom_field_groups').orderBy(['entity', 'sort_order'])).map((g) => ({
        entity: g.entity,
        key: g.key,
        label: g.label,
        sortOrder: g.sort_order,
        visibility: g.visibility,
      })),
    }),
  })
  .add({
    method: 'put',
    path: '/',
    permission: 'core.fields.manage',
    body: groupBody,
    summary: 'Create or update a field group',
    handler: async ({ ctx, body }) => {
      await db.transaction(async (trx) => {
        await trx('custom_field_groups')
          .insert({
            entity: body.entity,
            key: body.key,
            label: body.label,
            sort_order: body.sortOrder ?? 0,
            visibility: body.visibility ? JSON.stringify(body.visibility) : null,
            customized: true,
          })
          .onConflict(['entity', 'key'])
          .merge({
            label: body.label,
            sort_order: body.sortOrder ?? 0,
            visibility: body.visibility ? JSON.stringify(body.visibility) : null,
            customized: true,
          });
        await audit(trx, ctx, {
          action: 'custom_field_group.saved',
          entity: 'custom_field_group',
          diff: body,
        });
      });
      return body;
    },
  })
  .add({
    method: 'delete',
    path: '/:entity/:key',
    permission: 'core.fields.manage',
    params: z.object({
      entity: z.enum(CUSTOMIZABLE_ENTITIES),
      key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    }),
    handler: async ({ ctx, params }) => {
      await db.transaction(async (trx) => {
        await trx('custom_field_definitions')
          .where({ entity: params.entity, group_key: params.key })
          .update({ group_key: null, customized: true });
        await trx('custom_field_groups').where(params).delete();
        await audit(trx, ctx, {
          action: 'custom_field_group.deleted',
          entity: 'custom_field_group',
          diff: params,
        });
      });
      bumpDefinitionsVersion();
    },
  });

const fieldRef = z.string().regex(/^(cf\.)?[a-z][a-z0-9_]{0,63}$/);
export const layoutsRoutes = defineRoutes('/layouts', ['custom-fields'])
  .add({
    method: 'get',
    path: '/',
    permission: 'authenticated',
    query: z.object({ entity: z.enum(CUSTOMIZABLE_ENTITIES).optional() }),
    handler: async ({ query }) => {
      const q = db('layouts').where({ is_default: true });
      if (query.entity) q.where({ entity: query.entity });
      return {
        data: (await q).map((r) => ({ entity: r.entity, context: r.context, ...(r.config as object) })),
      };
    },
  })
  .add({
    method: 'put',
    path: '/',
    permission: 'core.fields.manage',
    body: z.object({
      entity: z.enum(CUSTOMIZABLE_ENTITIES),
      context: z.enum(['form', 'detail', 'list']),
      sections: z
        .array(
          z.object({
            key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
            label: z.string().max(100),
            fields: z.array(fieldRef).max(100),
          }),
        )
        .max(30)
        .optional(),
      columns: z.array(fieldRef).max(50).optional(),
    }),
    handler: async ({ ctx, body }) => {
      const config = JSON.stringify({ sections: body.sections, columns: body.columns });
      await db.transaction(async (trx) => {
        await trx('layouts')
          .insert({
            entity: body.entity,
            context: body.context,
            name: 'default',
            config,
            is_default: true,
            customized: true,
          })
          .onConflict(['entity', 'context', 'name'])
          .merge({ config, customized: true });
        await audit(trx, ctx, { action: 'layout.saved', entity: 'layout', diff: body });
      });
      return body;
    },
  });
