import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every .tsx file under `dir`. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p);
    return p.endsWith('.tsx') && !p.endsWith('.test.tsx') ? [p] : [];
  });
}

const root = path.resolve(import.meta.dirname, '..');
const modulesDir = path.resolve(root, '../../../modules');
const files = [
  ...walk(root),
  ...readdirSync(modulesDir).flatMap((m) => {
    const web = path.join(modulesDir, m, 'web');
    try {
      return walk(web);
    } catch {
      return [];
    }
  }),
];

describe('data views', () => {
  it('show an error state, not "empty", when a query that has a loading state fails', () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const [, name] of src.matchAll(/const (\w+) = useQuery\(/g)) {
        if (!new RegExp(`\\b${name}\\.(isPending|isLoading) \\?`).test(src)) continue;
        if (!new RegExp(`\\b${name}\\.(isError|error)\\b`).test(src))
          missing.push(`${path.relative(root, f)}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
