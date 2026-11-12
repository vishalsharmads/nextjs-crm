#!/usr/bin/env node
// White-label guard: fails if any denylisted string appears in built output, templates, blueprints or locale files.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const deny = readFileSync(path.join(root, 'brand-denylist.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const targets = [
  'apps/web/dist',
  'apps/api/dist',
  'apps/web/src/i18n',
  'apps/web/index.html',
  'apps/api/src/core/mail',
  'packages/blueprints',
  'modules',
];
// Third-party names an admin chooses from (the AI provider list). Read at run time and never bundled,
// so the build output is still checked in full. Keep this list to data files that name other companies.
const allowedFiles = new Set(['modules/assistant/providers.json']);
const exts = new Set(['.js', '.css', '.html', '.json', '.ts', '.tsx', '.hbs', '.txt', '.webmanifest']);
const skipDirs = new Set(['node_modules', '.git']);

function* walk(p) {
  if (!existsSync(p)) return;
  const st = statSync(p);
  if (st.isFile()) {
    yield p;
    return;
  }
  for (const entry of readdirSync(p)) {
    if (skipDirs.has(entry)) continue;
    yield* walk(path.join(p, entry));
  }
}

const hits = [];
for (const t of targets) {
  for (const file of walk(path.join(root, t))) {
    if (!exts.has(path.extname(file)) || file.endsWith('.map')) continue;
    if (allowedFiles.has(path.relative(root, file).split(path.sep).join('/'))) continue;
    const text = readFileSync(file, 'utf8').toLowerCase();
    for (const word of deny) {
      const idx = text.indexOf(word.toLowerCase());
      if (idx !== -1) hits.push(`${path.relative(root, file)}: "${word}"`);
    }
  }
}

if (hits.length) {
  console.error(`Forbidden brand strings found:\n  ${hits.join('\n  ')}`);
  process.exit(1);
}
console.log(`Brand check passed (${deny.length} terms).`);
