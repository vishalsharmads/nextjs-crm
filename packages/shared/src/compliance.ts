import { z } from 'zod';
import type { SecuritySettings } from './settings';
import { consentPurposeSchema } from './privacy';

/**
 * Compliance profiles. `privacy` covers GDPR-style laws (GDPR, UK GDPR, DPDP, CCPA/CPRA, PIPEDA, LGPD);
 * `hipaa` adds health-data safeguards on top. A profile sets enforced floors, not just defaults:
 * the server applies them on every read and rejects settings that go below them.
 */
export const COMPLIANCE_PROFILES = ['standard', 'privacy', 'hipaa'] as const;
export type ComplianceProfile = (typeof COMPLIANCE_PROFILES)[number];

export const RETENTION_CONDITIONS = ['deleted', 'inactive', 'lead_closed'] as const;
export type RetentionCondition = (typeof RETENTION_CONDITIONS)[number];

export const retentionRuleSchema = z
  .object({
    entity: z.enum(['contact', 'lead']),
    /** deleted: in the bin; inactive: not updated and no activity; lead_closed: converted or unqualified. */
    condition: z.enum(RETENTION_CONDITIONS),
    days: z.number().int().min(1).max(36500),
    action: z.enum(['anonymize', 'delete']),
  })
  .refine((r) => r.condition !== 'lead_closed' || r.entity === 'lead', {
    message: 'Only leads can be closed',
    path: ['condition'],
  });
export type RetentionRule = z.infer<typeof retentionRuleSchema>;

/** How long operational records that copy personal data are kept. */
export const housekeepingSchema = z.object({
  sessionsDays: z.number().int().min(1).max(3650).default(30),
  jobsDays: z.number().int().min(1).max(3650).default(30),
  webhookDeliveriesDays: z.number().int().min(1).max(3650).default(90),
  notificationsDays: z.number().int().min(1).max(3650).default(90),
  automationRunsDays: z.number().int().min(1).max(3650).default(180),
  deletedFilesDays: z.number().int().min(1).max(3650).default(30),
});
export type Housekeeping = z.infer<typeof housekeepingSchema>;

export const complianceSettingsSchema = z.object({
  profile: z.enum(COMPLIANCE_PROFILES).default('standard'),
  /** Sign out after this many minutes without activity. 0 = off (the security idle days still apply). */
  idleTimeoutMinutes: z.number().int().min(0).max(1440).default(0),
  /** Force a new sign-in after this many hours, active or not. 0 = off. */
  sessionMaxHours: z.number().int().min(0).max(720).default(0),
  mfaRequiredForAll: z.boolean().default(false),
  /** Role keys whose members must use two-factor authentication. */
  mfaRequiredRoles: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/))
    .max(100)
    .default([]),
  /** API keys stop working this many days after creation, and new keys must expire within it. 0 = no limit. */
  apiKeyMaxDays: z.number().int().min(0).max(3650).default(0),
  /** Record who viewed records, downloaded files, exported data and read the audit log. */
  accessLogging: z.boolean().default(false),
  /** Delete audit and access log entries older than this many days. 0 = keep forever. */
  auditRetentionDays: z.number().int().min(0).max(36500).default(0),
  /** Days to answer a privacy request (GDPR: one month; CCPA: 45 days). */
  dsarDueDays: z.number().int().min(1).max(90).default(30),
  /** What people can consent to; web forms show a checkbox per purpose they use. */
  consentPurposes: z
    .array(consentPurposeSchema)
    .max(30)
    .default([])
    .refine((list) => new Set(list.map((p) => p.key)).size === list.length, 'Purpose keys must be unique'),
  /** Records erased automatically once they meet a rule (storage limitation). */
  retentionRules: z.array(retentionRuleSchema).max(20).default([]),
  housekeeping: housekeepingSchema.default(housekeepingSchema.parse({})),
  /** Webhooks send ids and changed field names only; receivers fetch the record through the API. */
  webhookMinimal: z.boolean().default(false),
  /** Notification emails say only that something needs attention, with a link: no names or details. */
  notificationEmailMinimal: z.boolean().default(false),
  /** Encrypt uploaded files at rest with the application key ring. */
  encryptUploads: z.boolean().default(false),
  /** Shown on the sign-in screen (for example an authorized-use warning). */
  loginNotice: z.string().trim().max(2000).default(''),
});
export type ComplianceSettings = z.infer<typeof complianceSettingsSchema>;

export type FloorRule =
  | { kind: 'on' }
  | { kind: 'atLeast'; value: number }
  /** 0 means "unlimited" for these settings, so it counts as above the limit. */
  | { kind: 'atMost'; value: number }
  /** Retention: 0 means "keep forever", which is always allowed. */
  | { kind: 'keepAtLeast'; value: number };

interface ProfileFloors {
  security: Partial<Record<keyof SecuritySettings, FloorRule>>;
  compliance: Partial<Record<keyof ComplianceSettings, FloorRule>>;
}

export const PROFILE_FLOORS: Record<ComplianceProfile, ProfileFloors> = {
  standard: { security: {}, compliance: {} },
  privacy: {
    security: {},
    compliance: {
      auditRetentionDays: { kind: 'keepAtLeast', value: 365 },
      dsarDueDays: { kind: 'atMost', value: 30 },
    },
  },
  hipaa: {
    security: {
      passwordMinLength: { kind: 'atLeast', value: 12 },
      passwordRequireMixed: { kind: 'on' },
      totpAllowed: { kind: 'on' },
      lockoutMaxAttempts: { kind: 'atMost', value: 5 },
    },
    compliance: {
      mfaRequiredForAll: { kind: 'on' },
      idleTimeoutMinutes: { kind: 'atMost', value: 15 },
      sessionMaxHours: { kind: 'atMost', value: 12 },
      apiKeyMaxDays: { kind: 'atMost', value: 365 },
      accessLogging: { kind: 'on' },
      webhookMinimal: { kind: 'on' },
      notificationEmailMinimal: { kind: 'on' },
      encryptUploads: { kind: 'on' },
      // HIPAA keeps required documentation for six years.
      auditRetentionDays: { kind: 'keepAtLeast', value: 2190 },
      dsarDueDays: { kind: 'atMost', value: 30 },
    },
  },
};

export type FlooredGroup = keyof ProfileFloors;

function enforce(value: unknown, rule: FloorRule): unknown {
  switch (rule.kind) {
    case 'on':
      return true;
    case 'atLeast':
      return typeof value === 'number' && value >= rule.value ? value : rule.value;
    case 'atMost':
      return typeof value === 'number' && value > 0 && value <= rule.value ? value : rule.value;
    case 'keepAtLeast':
      return typeof value === 'number' && (value === 0 || value >= rule.value) ? value : rule.value;
  }
}

/** Raise (or lower) every field the profile governs to its floor. */
export function applyFloors<T extends object>(group: FlooredGroup, values: T, profile: ComplianceProfile): T {
  const out = { ...values } as Record<string, unknown>;
  for (const [key, rule] of Object.entries(PROFILE_FLOORS[profile][group]) as [string, FloorRule][]) {
    out[key] = enforce(out[key], rule);
  }
  return out as T;
}

export function floorMessage(rule: FloorRule): string {
  switch (rule.kind) {
    case 'on':
      return 'Required by the compliance profile';
    case 'atLeast':
      return `The compliance profile requires at least ${rule.value}`;
    case 'atMost':
      return `The compliance profile requires a value from 1 to ${rule.value}`;
    case 'keepAtLeast':
      return `The compliance profile requires at least ${rule.value} days, or 0 to keep forever`;
  }
}

/** Fields below the profile's floor, as validation issues. */
export function floorViolations(
  group: FlooredGroup,
  values: object,
  profile: ComplianceProfile,
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const v = values as Record<string, unknown>;
  for (const [key, rule] of Object.entries(PROFILE_FLOORS[profile][group]) as [string, FloorRule][]) {
    if (enforce(v[key], rule) !== v[key]) issues.push({ path: key, message: floorMessage(rule) });
  }
  return issues;
}

/** Whether a user with these roles must use two-factor authentication. */
export function mfaRequiredFor(
  user: { isAdmin: boolean; roleKeys: string[] },
  security: Pick<SecuritySettings, 'totpAllowed' | 'totpRequiredForAdmins'>,
  compliance: Pick<ComplianceSettings, 'mfaRequiredForAll' | 'mfaRequiredRoles'>,
): boolean {
  if (!security.totpAllowed) return false;
  if (compliance.mfaRequiredForAll) return true;
  if (user.isAdmin && security.totpRequiredForAdmins) return true;
  return user.roleKeys.some((k) => compliance.mfaRequiredRoles.includes(k));
}
