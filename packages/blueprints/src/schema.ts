import { z } from 'zod';
import {
  stageColorSchema,
  SENSITIVITY_LEVELS,
  SENSITIVE_TYPES,
  CUSTOMIZABLE_ENTITIES,
  FONT_FAMILIES,
  paletteSchema,
  FIELD_TYPES,
  PERMISSION_PATTERN_RE,
  SCOPES,
  fieldKeySchema,
  fieldOptionSchema,
  fieldValidationSchema,
  visibilitySchema,
  ENTITY_KEY_PATTERN,
  MAX_CUSTOM_OBJECTS,
  OBJECT_ICONS,
} from '@app/shared';

const itemKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'Use semantic versioning, e.g. 1.2.0');

export const blueprintFieldSchema = z
  .object({
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
    /** Set when the field is first created; later blueprint versions cannot change it. */
    sensitivity: z.enum(SENSITIVITY_LEVELS).default('normal'),
  })
  .refine(
    (f) =>
      f.sensitivity !== 'special' ||
      (SENSITIVE_TYPES.includes(f.type) && !f.filterable && f.default === undefined),
    {
      message:
        'Sensitive fields must be text, textarea, email, phone or URL, not filterable, with no default',
      path: ['sensitivity'],
    },
  );

export const blueprintGroupSchema = z.object({
  key: itemKey,
  label: z.string().min(1).max(100),
  visibility: visibilitySchema.optional(),
});

export const blueprintStageSchema = z.object({
  key: itemKey,
  name: z.string().min(1).max(100),
  probability: z.number().int().min(0).max(100).default(0),
  color: stageColorSchema.optional(),
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

/** An admin-defined object the blueprint seeds (Settings → Objects). Its fields go in `custom_fields`. */
export const blueprintObjectSchema = z.object({
  key: z.string().regex(ENTITY_KEY_PATTERN),
  singular: z.string().min(1).max(60),
  plural: z.string().min(1).max(60),
  icon: z.enum(OBJECT_ICONS).default('box'),
  description: z.string().max(500).optional(),
  links: z.array(z.string().regex(ENTITY_KEY_PATTERN)).max(6).default([]),
});

/** Custom fields and groups are keyed by a core entity, an object or a module record type. */
const fieldEntityKey = z.string().regex(ENTITY_KEY_PATTERN);

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
  objects: z.array(blueprintObjectSchema).max(MAX_CUSTOM_OBJECTS).default([]),
  custom_field_groups: z.record(fieldEntityKey, z.array(blueprintGroupSchema)).default({}),
  custom_fields: z.record(fieldEntityKey, z.array(blueprintFieldSchema)).default({}),
  pipelines: z.array(blueprintPipelineSchema).default([]),
  /**
   * Industry notes added to in-app help articles, by article id (`settings.pipelines`,
   * `module.bookings`). Markdown; raw HTML is shown as text.
   */
  help: z
    .record(z.string().regex(/^[a-z0-9][a-z0-9.-]{0,99}$/), z.string().trim().min(1).max(5000))
    .default({}),
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
      /**
       * The fictional business a demo shows: name, colors and sign-in copy. Applied only by demo resets,
       * over the factory theme, so a client install never takes on a sample brand.
       */
      branding: z
        .object({
          appName: z.string().trim().min(1).max(60),
          tagline: z.string().trim().max(140).optional(),
          loginTitle: z.string().trim().max(80).optional(),
          loginTagline: z.string().trim().max(200).optional(),
          footerText: z.string().trim().max(200).optional(),
          pdfHeader: z.string().trim().max(200).optional(),
          emailFromName: z.string().trim().max(80).optional(),
          fontFamily: z.enum(FONT_FAMILIES).optional(),
          radius: z.number().int().min(0).max(16).optional(),
          colors: z
            .object({ light: paletteSchema.partial().optional(), dark: paletteSchema.partial().optional() })
            .optional(),
        })
        .optional(),
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
export type BlueprintObject = z.output<typeof blueprintObjectSchema>;
export type BlueprintPipeline = z.output<typeof blueprintPipelineSchema>;
export type BlueprintRole = z.output<typeof blueprintRoleSchema>;
export type BlueprintLayout = z.output<typeof blueprintLayoutSchema>;
export type BlueprintWidget = z.output<typeof blueprintWidgetSchema>;
