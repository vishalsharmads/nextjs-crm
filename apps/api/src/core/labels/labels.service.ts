import { DEFAULT_LABELS, LABEL_ENTITY_KEYS, type LabelEntityKey } from '@app/shared';
import { db, type Db } from '../../db/knex';

export type LabelMap = Record<string, { singular: string; plural: string }>;

const cache = new Map<string, { value: LabelMap; at: number }>();
export const clearLabelCache = () => cache.clear();

/** Vocabulary for a locale: defaults overlaid with configured labels (and module labels). */
export async function getLabels(locale = 'en', conn: Db = db): Promise<LabelMap> {
  const hit = cache.get(locale);
  if (hit && Date.now() - hit.at < 3000) return hit.value;
  const rows = await conn('labels').whereIn('locale', [locale, 'en']).orderByRaw('locale = ? asc', [locale]);
  const out: LabelMap = { ...DEFAULT_LABELS };
  for (const r of rows)
    out[r.entity_key as string] = { singular: r.singular as string, plural: r.plural as string };
  cache.set(locale, { value: out, at: Date.now() });
  return out;
}

export const isCoreLabelKey = (key: string): key is LabelEntityKey =>
  (LABEL_ENTITY_KEYS as readonly string[]).includes(key);
