import { PROFILE_FLOORS, floorMessage, type ComplianceProfile, type FlooredGroup } from '@app/shared';

/** Help text for a setting the active compliance profile governs, or undefined. */
export function floorHint(group: FlooredGroup, key: string, profile: ComplianceProfile): string | undefined {
  const rule = (PROFILE_FLOORS[profile][group] as Record<string, Parameters<typeof floorMessage>[0]>)[key];
  return rule ? floorMessage(rule) : undefined;
}
