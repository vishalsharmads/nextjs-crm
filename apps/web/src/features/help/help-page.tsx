import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { BookOpen, Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Input } from '@/components/ui/input';
import { EmptyState, PageHeader, Pane } from '@/components/ui/misc';
import { ArticleView, interpolate } from '@/help/article-view';
import { useHelpVars, useVisibleArticles } from '@/help/help-sheet';

/** Knowledge base sections, in reading order. */
const AREAS = ['Getting started', 'Records', 'Modules', 'Reports', 'Settings', 'Integrations'];

/** Every article the person may read, searchable, grouped by area. */
export function HelpPage() {
  const articles = useVisibleArticles();
  const vars = useHelpVars();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const selectedId = params.get('article');
  const found = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return articles;
    return articles.filter((a) => {
      const hay = `${interpolate(a.title, vars, false)} ${interpolate(a.text, vars, false)}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [articles, q, vars]);
  const groups = [...new Set([...AREAS, ...found.map((a) => a.area)])]
    .map((area) => ({ area, items: found.filter((a) => a.area === area) }))
    .filter((g) => g.items.length);
  const selected = articles.find((a) => a.id === selectedId) ?? found[0];
  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Help and guides"
        description={`How to use ${vars.appName}: what each page is for, what you can do there, and what every setting means.`}
        help="getting-started"
      />
      <div className="grid flex-1 gap-4 p-4 md:p-6 lg:grid-cols-[280px_1fr]">
        <Pane padded={false} className="h-fit">
          <div className="border-b border-line p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute start-2 top-1/2 size-4 -translate-y-1/2 text-faint" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search help"
                aria-label="Search help"
                className="ps-8"
              />
            </div>
          </div>
          {groups.length ? (
            <nav aria-label="Help articles" className="max-h-[70vh] overflow-y-auto p-2">
              {groups.map((g) => (
                <div key={g.area} className="mb-3">
                  <p className="px-2 pb-1 text-2xs font-medium text-faint">{g.area}</p>
                  {g.items.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setParams({ article: a.id })}
                      className={cn(
                        'block w-full rounded-sm px-2 py-1.5 text-start text-sm hover:bg-hover',
                        selected?.id === a.id && 'bg-primary-soft font-medium',
                      )}
                    >
                      {interpolate(a.title, vars, false)}
                    </button>
                  ))}
                </div>
              ))}
            </nav>
          ) : (
            <p className="p-3 text-sm text-muted">No articles match. Try other words.</p>
          )}
        </Pane>
        <Pane>
          {selected ? (
            <article>
              <h2 className="mb-3 text-lg font-semibold">{interpolate(selected.title, vars, false)}</h2>
              <ArticleView article={selected} vars={vars} />
            </article>
          ) : (
            <EmptyState
              icon={<BookOpen />}
              title="Nothing to show"
              description="There are no articles you can read yet."
            />
          )}
        </Pane>
      </div>
    </div>
  );
}
