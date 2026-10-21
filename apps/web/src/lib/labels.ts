import { DEFAULT_LABELS } from '@app/shared';

export type Labels = Record<string, { singular: string; plural: string }>;

/** Interpolation variables for every entity label: contact, contactPlural, contactLower, contactPluralLower. */
export function labelVars(labels: Labels): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, l] of Object.entries({ ...DEFAULT_LABELS, ...labels })) {
    const k = key.replace(/[-.](\w)/g, (_, c: string) => c.toUpperCase());
    out[k] = l.singular;
    out[`${k}Plural`] = l.plural;
    out[`${k}Lower`] = l.singular.toLowerCase();
    out[`${k}PluralLower`] = l.plural.toLowerCase();
  }
  return out;
}
