import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { logger } from '@app/api/module-api';
import { WIRE_FORMATS } from './providers';

const presetSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  name: z.string().min(1).max(60),
  format: z.enum(WIRE_FORMATS),
  baseUrl: z.url({ protocol: /^https$/ }),
  headers: z.record(z.string(), z.string()).default({}),
  keyUrl: z.url({ protocol: /^https$/ }).optional(),
  keyPrefix: z.string().max(20).optional(),
  tier: z.enum(['free', 'free_tier', 'paid']),
  note: z.string().max(200).default(''),
  recommended: z.array(z.string().min(1).max(200)).default([]),
});
export type ProviderPreset = z.infer<typeof presetSchema>;

/** A starting point for "Other compatible API": fills in the address, which stays editable. */
const compatibleSchema = z.object({
  name: z.string().min(1).max(60),
  baseUrl: z.url({ protocol: /^https?$/ }),
  local: z.boolean().default(false),
  note: z.string().max(200).default(''),
});
export type CompatibleServer = z.infer<typeof compatibleSchema>;

/**
 * The provider list ships as data next to the module and is read at run time, so provider names
 * never end up in the built app. A missing or broken file leaves only the custom option.
 */
function catalogFile(): string | undefined {
  if (process.env.ASSISTANT_PROVIDERS_FILE) return path.resolve(process.env.ASSISTANT_PROVIDERS_FILE);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(here, '../providers.json'),
    path.resolve(process.cwd(), 'modules/assistant/providers.json'),
    path.resolve(process.cwd(), '../../modules/assistant/providers.json'),
  ].find((f) => existsSync(f));
}

let cached: { providers: ProviderPreset[]; compatible: CompatibleServer[] } | undefined;

function catalog() {
  if (cached) return cached;
  const file = catalogFile();
  try {
    cached = file
      ? z
          .object({
            providers: z.array(presetSchema),
            compatible: z.array(compatibleSchema).default([]),
          })
          .parse(JSON.parse(readFileSync(file, 'utf8')) as unknown)
      : { providers: [], compatible: [] };
  } catch (err) {
    logger.error({ err }, 'assistant provider list could not be read');
    cached = { providers: [], compatible: [] };
  }
  return cached;
}

export const providerPresets = (): ProviderPreset[] => catalog().providers;
export const compatibleServers = (): CompatibleServer[] => catalog().compatible;

export const findPreset = (id: string | null | undefined) =>
  id ? providerPresets().find((p) => p.id === id) : undefined;

/**
 * The provider's models, best first: the preset's recommendations (exact ids, then id prefixes or
 * fragments such as ":free") lead, the rest follow alphabetically.
 */
export function rankModels(ids: string[], recommended: string[]) {
  const picked: string[] = [];
  for (const want of recommended) {
    const hit =
      ids.find((id) => id === want) ??
      ids.filter((id) => id.startsWith(want) || id.includes(want)).sort((a, b) => a.length - b.length)[0];
    if (hit && !picked.includes(hit)) picked.push(hit);
  }
  return [
    ...picked.map((id, i) => ({ id, recommended: true, best: i === 0 })),
    ...ids.filter((id) => !picked.includes(id)).map((id) => ({ id, recommended: false, best: false })),
  ];
}
