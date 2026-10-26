import { z } from 'zod';
import { CUSTOMIZABLE_ENTITIES } from './entities';

export const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'decimal',
  'currency',
  'date',
  'datetime',
  'boolean',
  'select',
  'multi_select',
  'url',
  'email',
  'phone',
  'user',
  'file',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Field keys become generated column names (`cf_<key>`), so the format is strict. */
export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,48}$/;
export const fieldKeySchema = z.string().regex(FIELD_KEY_RE, 'Use lowercase letters, digits and underscores');

/** Types that can get a generated column + index for filtering and sorting. */
export const FILTERABLE_TYPES: readonly FieldType[] = [
  'text',
  'number',
  'decimal',
  'currency',
  'date',
  'datetime',
  'boolean',
  'select',
  'multi_select',
  'url',
  'email',
  'phone',
  'user',
];

/**
 * Data protection class. `personal` is personal data (listed in the data map); `special` is
 * special-category or health data: encrypted at rest, masked in every response, never filterable.
 */
export const SENSITIVITY_LEVELS = ['normal', 'personal', 'special'] as const;
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];
/** Types a special field can have (stored as encrypted text). */
export const SENSITIVE_TYPES: readonly FieldType[] = ['text', 'textarea', 'email', 'phone', 'url'];
/** What responses show instead of a special field's value. Sending it back leaves the value unchanged. */
export const SENSITIVE_MASK = '••••••';

export const VISIBILITY_LEVELS = ['write', 'read', 'hidden'] as const;
export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];
export const VISIBILITY_RANK: Record<VisibilityLevel, number> = { hidden: 0, read: 1, write: 2 };

export const visibilitySchema = z.object({
  default: z.enum(VISIBILITY_LEVELS).default('write'),
  roles: z.record(z.string(), z.enum(VISIBILITY_LEVELS)).default({}),
});
export type FieldVisibility = z.infer<typeof visibilitySchema>;

export const fieldOptionSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  label: z.string().min(1).max(100),
  color: z.string().max(32).optional(),
  active: z.boolean().default(true),
});
export type FieldOption = z.infer<typeof fieldOptionSchema>;

export const fieldValidationSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(1).max(10000).optional(),
    pattern: z.string().max(200).optional(),
    scale: z.number().int().min(0).max(6).optional(),
  })
  .default({});
export type FieldValidation = z.infer<typeof fieldValidationSchema>;

export const fieldConfigSchema = z
  .object({
    options: z.array(fieldOptionSchema).optional(),
    currency: z.string().length(3).optional(),
    placeholder: z.string().max(200).optional(),
  })
  .default({});

/** Input shape for creating a definition (admin UI and blueprints). */
export const customFieldInputSchema = z.object({
  entity: z.enum(CUSTOMIZABLE_ENTITIES),
  key: fieldKeySchema,
  label: z.string().min(1).max(100),
  type: z.enum(FIELD_TYPES),
  group: z.string().max(64).nullish(),
  options: z.array(fieldOptionSchema).optional(),
  currency: z.string().length(3).optional(),
  placeholder: z.string().max(200).optional(),
  helpText: z.string().max(500).nullish(),
  required: z.boolean().default(false),
  defaultValue: z.unknown().optional(),
  validation: fieldValidationSchema.optional(),
  visibility: visibilitySchema.optional(),
  filterable: z.boolean().optional(),
  showInList: z.boolean().default(false),
  sortOrder: z.number().int().optional(),
  /** Fixed at creation: changing it would leave values encrypted (or not) inconsistently. */
  sensitivity: z.enum(SENSITIVITY_LEVELS).default('normal'),
});
export type CustomFieldInput = z.input<typeof customFieldInputSchema>;

/** Definition as returned by the API and used to build forms and validators. */
export interface CustomFieldDef {
  uuid: string;
  entity: (typeof CUSTOMIZABLE_ENTITIES)[number];
  key: string;
  label: string;
  type: FieldType;
  group: string | null;
  options: FieldOption[];
  currency: string | null;
  placeholder: string | null;
  helpText: string | null;
  required: boolean;
  defaultValue: unknown;
  validation: FieldValidation;
  visibility: FieldVisibility;
  filterable: boolean;
  showInList: boolean;
  sortOrder: number;
  active: boolean;
  sensitivity: Sensitivity;
  sourceBlueprint: string | null;
  customized: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const E164_RE = /^\+[1-9]\d{6,14}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normalize a phone number to E.164 where possible (digits only, keeps leading +). */
export function normalizePhone(input: string): string {
  const trimmed = input.trim();
  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return '';
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (trimmed.startsWith('00')) return `+${digits.slice(2)}`;
  return `+${digits}`;
}

/** Zod schema for a single field value (non-null). */
export function valueSchemaFor(
  def: Pick<CustomFieldDef, 'type' | 'options' | 'validation' | 'label'>,
): z.ZodType {
  const v = def.validation ?? {};
  const activeKeys = (def.options ?? []).filter((o) => o.active !== false).map((o) => o.key);
  switch (def.type) {
    case 'text': {
      let s = z
        .string()
        .trim()
        .max(v.maxLength ?? 255);
      if (v.minLength) s = s.min(v.minLength);
      if (v.pattern) s = s.regex(new RegExp(v.pattern), `${def.label} has an invalid format`);
      return s;
    }
    case 'textarea':
      return z.string().max(v.maxLength ?? 10000);
    case 'number': {
      let n = z.number().int();
      if (v.min !== undefined) n = n.min(v.min);
      if (v.max !== undefined) n = n.max(v.max);
      return n;
    }
    case 'decimal':
    case 'currency': {
      let n = z.number().finite();
      if (v.min !== undefined) n = n.min(v.min);
      if (v.max !== undefined) n = n.max(v.max);
      return n;
    }
    case 'date':
      return z.string().regex(DATE_RE, 'Use YYYY-MM-DD');
    case 'datetime':
      return z.iso.datetime({ offset: true });
    case 'boolean':
      return z.boolean();
    case 'select':
      return activeKeys.length ? z.enum(activeKeys as [string, ...string[]]) : z.never();
    case 'multi_select':
      return z.array(activeKeys.length ? z.enum(activeKeys as [string, ...string[]]) : z.never()).max(100);
    case 'url':
      return z.url().max(2048);
    case 'email':
      return z.email().max(255);
    case 'phone':
      return z
        .string()
        .transform(normalizePhone)
        .pipe(z.string().regex(E164_RE, 'Use international format, e.g. +44 20 7946 0958'));
    case 'user':
    case 'file':
      return z.string().regex(UUID_RE);
  }
}

export type SchemaMode = 'create' | 'patch';

/**
 * Build the validator for an entity's `custom` object from its active definitions.
 * - create: required fields must be present and non-empty
 * - patch: only sent keys are validated; required fields cannot be cleared
 * Unknown keys are rejected.
 */
export function buildCustomSchema(defs: readonly CustomFieldDef[], mode: SchemaMode) {
  const shape: Record<string, z.ZodType> = {};
  for (const def of defs) {
    if (!def.active) continue;
    const value = valueSchemaFor(def);
    if (def.required) {
      shape[def.key] = mode === 'create' ? value : value.optional();
    } else {
      shape[def.key] = value.nullable().optional();
    }
  }
  return z.strictObject(shape);
}

/** Generated column name for a custom field. */
export function generatedColumnName(key: string): string {
  if (!FIELD_KEY_RE.test(key)) throw new Error(`Invalid field key: ${key}`);
  return `cf_${key}`;
}
