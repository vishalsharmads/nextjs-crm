import { useMemo } from 'react';
import { Link } from 'react-router';
import { Keyboard } from 'lucide-react';
import { useBoot, useCan } from '@/app/session';
import { useBranding } from '@/app/branding';
import { labelVars } from '@/lib/labels';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/dialog';
import { ArticleView, interpolate } from './article-view';
import { HELP_ARTICLES, articleForPath, type HelpArticle } from './registry';

/** Vocabulary and branding for `{{var}}` in articles. */
export function useHelpVars(): Record<string, string> {
  const { labels } = useBoot();
  const { branding } = useBranding();
  return useMemo(() => ({ ...labelVars(labels), appName: branding.appName }), [labels, branding.appName]);
}

/** Articles this person may read: their permissions, and only modules that are on. */
export function useVisibleArticles(): HelpArticle[] {
  const boot = useBoot();
  const can = useCan();
  return useMemo(
    () =>
      HELP_ARTICLES.filter(
        (a) =>
          (!a.permission || (a.permission === 'admin' ? boot.access.isAdmin : can(a.permission))) &&
          (!a.module || boot.modules.enabled.includes(a.module)),
      ),
    [boot, can],
  );
}

export function HelpSheet({
  id,
  path,
  onNavigate,
  onClose,
  onShortcuts,
}: {
  id?: string | undefined;
  path: string;
  onNavigate: (id: string) => void;
  onClose: () => void;
  onShortcuts: () => void;
}) {
  const vars = useHelpVars();
  const visible = useVisibleArticles();
  const article = id ? visible.find((a) => a.id === id) : articleForPath(path, visible);
  const related = (article?.related ?? [])
    .map((r) => visible.find((a) => a.id === r))
    .filter(Boolean) as HelpArticle[];
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={article ? interpolate(article.title, vars, false) : 'Help'}
      width="max-w-xl"
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onShortcuts}>
            <Keyboard /> Keyboard shortcuts
          </Button>
          <Button size="sm" asChild className="ms-auto">
            <Link to={article ? `/help?article=${article.id}` : '/help'} onClick={onClose}>
              Open the knowledge base
            </Link>
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5 p-5">
        {article ? (
          <ArticleView article={article} vars={vars} />
        ) : (
          <p className="text-sm text-muted">
            There is no help for this page yet. The knowledge base has articles on every part of{' '}
            {vars.appName}.
          </p>
        )}
        {related.length ? (
          <section>
            <h3 className="mb-2 text-xs font-medium text-muted">Related</h3>
            <ul className="flex flex-col gap-1">
              {related.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className="text-sm text-primary hover:underline"
                    onClick={() => onNavigate(r.id)}
                  >
                    {interpolate(r.title, vars, false)}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}
