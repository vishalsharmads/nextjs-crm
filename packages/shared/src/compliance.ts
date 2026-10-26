import { z } from 'zod';
import type { SecuritySettings } from './settings';

/**
 * Compliance profiles. `privacy` covers GDPR-style laws (GDPR, UK GDPR, DPDP, CCPA/CPRA, PIPEDA, LGPD);
 * `hipaa` adds health-data safeguards on top. A profile sets enforced floors, not just defaults:
 * the server applies them on every read and rejects settings that go below them.
 */
export const COMPLIANCE_PROFILES = ['standard', 'privacy', 'hipaa'] as const;
export type ComplianceProfile = (typeof COMPLIANCE_PROFILES)[number];

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
  /** Shown on the sign-in screen (for example an authorized-use warning). */
  loginNotice: z.string().trim().max(2000).default(''),
});
export type ComplianceSettings = z.infer<typeof complianceSettingsSchema>;

export type FloorRule =
  | { kind: 'on' }
  | { kind: 'atLeast'; value: number }
  /** 0 means "unlimited" for these settings, so it counts as above the limit. */
  | { kind: 'atMost'; value: number };

interface ProfileFloors {
  security: Partial<Record<keyof SecuritySettings, FloorRule>>;
  compliance: Partial<Record<keyof ComplianceSettings, FloorRule>>;
}

export const PROFILE_FLOORS: Record<ComplianceProfile, ProfileFloors> = {
  standard: { security: {}, compliance: {} },
  privacy: { security: {}, compliance: {} },
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
