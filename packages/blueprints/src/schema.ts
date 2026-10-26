import { z } from 'zod';
import {
  CUSTOMIZABLE_ENTITIES,
  FIELD_TYPES,
  PERMISSION_PATTERN_RE,
  SCOPES,
  fieldKeySchema,
  fieldOptionSchema,
  fieldValidationSchema,
  visibilitySchema,
} from '@app/shared';

const itemKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'Use semantic versioning, e.g. 1.2.0');

export const blueprintFieldSchema = z.object({
  key: fieldKeySchema,
  label: z.string().min(1).max(100),
  type: z.enum(FIELD_TYPES),
  group: z.string().max(64).optional(),
  options: z.array(fieldOptionSchema).optional(),
  currency: z.string().length(3).optional(),
  placeholder: z.string().max(200).optional(),
  help_text: z.string().max(500).optional(),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  validation: fieldValidationSchema.optional(),
  visibility: visibilitySchema.optional(),
  filterable: z.boolean().default(false),
  show_in_list: z.boolean().default(false),
});

export const blueprintGroupSchema = z.object({
  key: itemKey,
  label: z.string().min(1).max(100),
  visibility: visibilitySchema.optional(),
});

export const blueprintStageSchema = z.object({
  key: itemKey,
  name: z.string().min(1).max(100),
  probability: z.number().int().min(0).max(100).default(0),
  color: z.string().max(32).optional(),
  is_won: z.boolean().default(false),
  is_lost: z.boolean().default(false),
  rotting_days: z.number().int().min(1).max(3650).optional(),
});

export const blueprintPipelineSchema = z
  .object({
    key: itemKey,
    name: z.string().min(1).max(100),
    entity: z.enum(['deal', 'lead']).default('deal'),
    is_default: z.boolean().default(false),
    stages: z.array(blueprintStageSchema).min(2).max(30),
  })
  .refine(
    (p) => p.stages.filter((s) => s.is_won).length <= 1 && p.stages.filter((s) => s.is_lost).length <= 1,
    {
      message: 'A pipeline can have at most one won stage and one lost stage',
    },
  );

export const blueprintRoleSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(''),
  permissions: z.array(z.string().regex(PERMISSION_PATTERN_RE)).max(500),
  scopes: z.record(z.string().max(100), z.enum(SCOPES)).default({}),
});

const layoutFieldRef = z.string().regex(/^(cf\.)?[a-z][a-z0-9_]{0,63}$/);
export const blueprintLayoutSchema = z.object({
  entity: z.enum(CUSTOMIZABLE_ENTITIES),
  context: z.enum(['form', 'detail', 'list']),
  sections: z
    .array(z.object({ key: itemKey, label: z.string().max(100), fields: z.array(layoutFieldRef).max(100) }))
    .optional(),
  columns: z.array(layoutFieldRef).max(50).optional(),
});

export const blueprintWidgetSchema = z.object({
  key: itemKey,
  type: z.string().regex(/^([a-z][a-z0-9-]*:)?[a-z][a-z0-9_.-]*$/),
  title: z.string().max(100).optional(),
  size: z.enum(['sm', 'md', 'lg']).default('md'),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const blueprintTemplateSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/),
  channel: z.enum(['email', 'notification', 'document']),
  locale: z.string().max(10).default('en'),
  name: z.string().max(150).default(''),
  subject: z.string().max(255).default(''),
  body: z.string().max(100_000),
});

export const blueprintSchema = z.object({
  $schema: z.string().optional(),
  key: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  name: z.string().min(1).max(100),
  version: semver,
  description: z.string().max(1000).default(''),
  status: z.enum(['ready', 'stub']).default('ready'),
  settings: z.record(z.string(), z.unknown()).default({}),
  vocabulary: z
    .record(z.string(), z.object({ singular: z.string().min(1).max(60), plural: z.string().min(1).max(60) }))
    .default({}),
  modules: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/)).default([]),
  custom_field_groups: z
    .partialRecord(z.enum(CUSTOMIZABLE_ENTITIES), z.array(blueprintGroupSchema))
    .default({}),
  custom_fields: z.partialRecord(z.enum(CUSTOMIZABLE_ENTITIES), z.array(blueprintFieldSchema)).default({}),
  pipelines: z.array(blueprintPipelineSchema).default([]),
  roles: z.array(blueprintRoleSchema).default([]),
  layouts: z.array(blueprintLayoutSchema).default([]),
  dashboard: z
    .object({ name: z.string().max(100).default('Overview'), widgets: z.array(blueprintWidgetSchema) })
    .optional(),
  templates: z.array(blueprintTemplateSchema).default([]),
  sample_data: z
    .object({
      organizations: z.array(z.record(z.string(), z.unknown())).default([]),
      contacts: z.array(z.record(z.string(), z.unknown())).default([]),
      deals: z.array(z.record(z.string(), z.unknown())).default([]),
      leads: z.array(z.record(z.string(), z.unknown())).default([]),
      /** Notes, tasks, calls and meetings, backdated by `days` and linked by `related: "deal:<ref>"`. */
      activities: z.array(z.record(z.string(), z.unknown())).default([]),
      /**
       * Module records created through the app's own API as the demo admin, in order, so numbering,
       * totals and status rules apply. `{{contact:<ref>}}`-style placeholders become record uuids,
       * `{{date:+7}}` a date relative to today. Runs only for demo resets.
       */
      requests: z
        .array(
          z.object({
            ref: z
              .string()
              .regex(/^[a-z][a-z0-9_]*$/)
              .optional(),
            method: z.enum(['post', 'patch', 'put']),
            path: z
              .string()
              .regex(/^\/[A-Za-z0-9/_{}:+.-]+$/)
              .refine((p) => !p.split('/').some((seg) => seg === '.' || seg === '..'), 'No . or .. segments'),
            body: z.record(z.string(), z.unknown()).default({}),
          }),
        )
        .default([]),
    })
    .optional(),
});

export type Blueprint = z.output<typeof blueprintSchema>;
export type BlueprintInput = z.input<typeof blueprintSchema>;
export type BlueprintField = z.output<typeof blueprintFieldSchema>;
export type BlueprintPipeline = z.output<typeof blueprintPipelineSchema>;
export type BlueprintRole = z.output<typeof blueprintRoleSchema>;
export type BlueprintLayout = z.output<typeof blueprintLayoutSchema>;
export type BlueprintWidget = z.output<typeof blueprintWidgetSchema>;
