import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { moduleCatalogSchema, type ModuleCatalogEntry } from '@app/module-sdk';
import { addToInstalled } from './scaffold';
import { checkModuleFolder } from './module-check';

/**
 * Bring one catalog module into this checkout, for review. Nothing is built, migrated or enabled:
 * the developer reviews the change, commits it, and it ships with the next release.
 */

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export async function loadCatalog(source: string, token?: string): Promise<ModuleCatalogEntry[]> {
  let text: string;
  if (/^https?:\/\//.test(source)) {
    const { readCatalog } = await import('../modules/catalog');
    return readCatalog(source, token);
  } else text = readFileSync(source, 'utf8');
  return moduleCatalogSchema.parse(JSON.parse(text)).modules;
}

/** The commit a tag points at in the remote (annotated tags are peeled). */
function remoteTagSha(repo: string): (tag: string) => string | null {
  return (tag) => {
    const out = git(process.cwd(), ['ls-remote', '--tags', repo, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
    const lines = out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'));
    const peeled = lines.find((l) => l[1]?.endsWith('^{}'));
    return (peeled ?? lines[0])?.[0] ?? null;
  };
}

export interface AddOptions {
  root: string;
  entry: ModuleCatalogEntry;
  /** Replace an existing folder (an update). */
  update?: boolean;
  /** For tests: resolve a tag without asking the remote. */
  resolveTag?: (tag: string) => string | null;
}

export function addCatalogModule(o: AddOptions): { dir: string; problems: string[] } {
  const { entry, root } = o;
  const dest = join(root, 'modules', entry.key);
  if (existsSync(dest) && !o.update)
    throw new Error(
      `modules/${entry.key} already exists. Pass --update to replace it with the catalog version.`,
    );

  const tagSha = (o.resolveTag ?? remoteTagSha(entry.repo))(entry.tag);
  if (tagSha !== entry.sha)
    throw new Error(
      `Tag ${entry.tag} points at ${tagSha ?? 'nothing'}, but the catalog pinned ${entry.sha}. Refusing: ask the catalog owner.`,
    );

  const work = mkdtempSync(join(tmpdir(), 'module-add-'));
  try {
    git(work, ['init', '-q']);
    git(work, ['remote', 'add', 'origin', entry.repo]);
    git(work, ['fetch', '-q', '--depth', '1', 'origin', entry.sha]);
    git(work, ['checkout', '-q', entry.sha]);
    const src = resolve(work, entry.path || '.');
    if (src !== work && !src.startsWith(work + sep))
      throw new Error('The catalog path leaves the repository');

    const problems = checkModuleFolder(root, src, { key: entry.key });
    if (problems.length) return { dir: dest, problems };

    if (existsSync(dest)) rmSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true, filter: (p) => !p.split(sep).includes('.git') });
    const installed = join(root, 'apps/api/src/modules/installed.ts');
    const before = readFileSync(installed, 'utf8');
    const after = addToInstalled(before, entry.key);
    if (after !== before) writeFileSync(installed, after);
    return { dir: dest, problems: [] };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
