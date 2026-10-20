import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blueprintSchema, type Blueprint } from './schema';

export * from './schema';

/** Directory holding `<key>/blueprint.json`. Overridable for packaged deployments. */
export function blueprintsDir(): string {
  if (process.env.BLUEPRINTS_DIR) return path.resolve(process.env.BLUEPRINTS_DIR);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function listBlueprintKeys(dir = blueprintsDir()): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, 'blueprint.json')))
    .map((d) => d.name)
    .sort();
}

export function parseBlueprint(json: unknown): Blueprint {
  return blueprintSchema.parse(json);
}

export function loadBlueprint(key: string, dir = blueprintsDir()): Blueprint {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(key)) throw new Error(`Invalid blueprint key: ${key}`);
  const file = path.join(dir, key, 'blueprint.json');
  if (!existsSync(file))
    throw new Error(`Blueprint "${key}" not found. Available: ${listBlueprintKeys(dir).join(', ')}`);
  const bp = parseBlueprint(JSON.parse(readFileSync(file, 'utf8')));
  if (bp.key !== key) throw new Error(`Blueprint folder "${key}" contains key "${bp.key}"`);
  return bp;
}

/** Stable JSON (sorted keys) so checksums do not depend on property order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const checksum = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
