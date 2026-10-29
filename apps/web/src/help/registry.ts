import { marked } from 'marked';

/**
 * In-app help articles. Each page's help is a Markdown file next to the code that owns it:
 * `src/help/articles/*.md` for core pages and `modules/<key>/help/*.md` for module pages. A
 * drift test fails the build when a page has no article, so help ships with the feature.
 *
 * Front matter (one `key: value` per line):
 *   id          unique id, e.g. `settings.security`
 *   title       shown in the sheet and the knowledge base (may use vocabulary: `'{{dealPlural}}'`, quoted)
 *   area        knowledge base section: Records, Settings, Modules, Integrations, Getting started
 *   route       pages it explains, comma separated (`/settings/security`, `/deals/:uuid`, `/o/*`)
 *   permission  hidden from people without it (`admin` for admin-only pages)
 *   module      the module key, for module help (hidden while the module is off)
 *   related     other article ids, comma separated
 *
 * Body: Markdown. `{{var}}` is filled with vocabulary and branding when shown, and
 * `<!-- generated:<kind>:<arg> -->` is replaced with a table built from the code (settings,
 * permissions, tools), so parameter documentation cannot go stale.
 */
export interface HelpArticle {
  id: string;
  title: string;
  area: string;
  routes: string[];
  permission?: string;
  module?: string;
  related: string[];
  /** Rendered HTML, with `{{var}}` placeholders and generated-section markers still in place. */
  html: string;
  /** Plain text for search. */
  text: string;
}

const core = import.meta.glob<string>('./articles/*.md', { query: '?raw', import: 'default', eager: true });
const modules = import.meta.glob<string>('../../../../modules/*/help/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export function parseArticle(raw: string, path: string, moduleKey?: string): HelpArticle {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`Help article ${path} has no front matter`);
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':');
    // Values may be quoted (Prettier formats front matter as YAML, which needs quotes around `{{`).
    if (i > 0)
      meta[line.slice(0, i).trim()] = line
        .slice(i + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2');
  }
  if (!meta.id || !meta.title) throw new Error(`Help article ${path} needs an id and a title`);
  const list = (v?: string) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const body = m[2]!;
  return {
    id: meta.id,
    title: meta.title,
    area: meta.area ?? (moduleKey ? 'Modules' : 'Settings'),
    routes: list(meta.route),
    permission: meta.permission || undefined,
    module: meta.module ?? moduleKey,
    related: list(meta.related),
    html: marked.parse(body, { async: false, gfm: true }),
    text: body.replace(/<!--[\s\S]*?-->/g, '').replace(/[#*_`>[\]()|-]/g, ' '),
  };
}

function load(): HelpArticle[] {
  const out: HelpArticle[] = [];
  for (const [path, raw] of Object.entries(core)) out.push(parseArticle(raw, path));
  for (const [path, raw] of Object.entries(modules)) {
    const key = path.split('/modules/')[1]!.split('/')[0]!;
    out.push(parseArticle(raw, path, key));
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export const HELP_ARTICLES: HelpArticle[] = load();

export const findArticle = (id: string) => HELP_ARTICLES.find((a) => a.id === id);

/** `/deals/:uuid` and `/o/*` style patterns against a path (no base path, no query). */
export function routeMatches(pattern: string, path: string): boolean {
  const p = pattern.replace(/\/$/, '') || '/';
  const target = path.replace(/\/$/, '') || '/';
  if (p.endsWith('/*')) return target === p.slice(0, -2) || target.startsWith(`${p.slice(0, -2)}/`);
  const a = p.split('/');
  const b = target.split('/');
  return a.length === b.length && a.every((seg, i) => seg.startsWith(':') || seg === b[i]);
}

/** The article for a page: exact patterns beat parameters, which beat wildcards. */
export function articleForPath(path: string, articles = HELP_ARTICLES): HelpArticle | undefined {
  const score = (pattern: string) => (pattern.endsWith('/*') ? 0 : pattern.includes(':') ? 1 : 2);
  let best: { article: HelpArticle; score: number; length: number } | undefined;
  for (const article of articles)
    for (const pattern of article.routes) {
      if (!routeMatches(pattern, path)) continue;
      const s = score(pattern);
      if (!best || s > best.score || (s === best.score && pattern.length > best.length))
        best = { article, score: s, length: pattern.length };
    }
  return best?.article;
}
