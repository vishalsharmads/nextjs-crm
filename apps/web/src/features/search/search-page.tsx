import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { useDebounced } from '@/lib/use-debounced';
import { useSearch, useTypeName, type SearchHit } from './search-hit';

/** Every match for a search, grouped by record type, best first. */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const q = useDebounced(text.trim(), 250);
  useEffect(() => {
    if (q === (params.get('q') ?? '')) return;
    setParams(q ? { q } : {}, { replace: true });
  }, [q, params, setParams]);
  const res = useSearch(q, { limit: 25 });
  const typeName = useTypeName();

  const groups = new Map<string, SearchHit[]>();
  for (const h of res.data ?? []) groups.set(h.type, [...(groups.get(h.type) ?? []), h]);
  // Types whose best hit ranks highest come first.
  const ordered = [...groups.entries()].sort((a, b) => (b[1][0]?.score ?? 0) - (a[1][0]?.score ?? 0));

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader title="Search" />
      <div className="relative mt-4">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input
          autoFocus
          aria-label="Search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Names, emails, numbers, note text…"
          className="ps-9"
        />
      </div>
      <div className="mt-6" aria-live="polite">
        {q.length < 2 ? (
          <EmptyState
            icon={<Search />}
            title="Type at least two characters"
            description="Search finds names, emails, phone numbers, searchable custom fields and the text of notes, emails, calls, meetings and tasks."
          />
        ) : res.isError ? (
          <ErrorState error={res.error} onRetry={() => void res.refetch()} />
        ) : res.isPending ? (
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : !ordered.length ? (
          <EmptyState
            icon={<Search />}
            title={`Nothing matches “${q}”`}
            description="Check the spelling, or search for the start of a name, email or number."
          />
        ) : (
          <div className="space-y-6">
            {ordered.map(([type, hits]) => (
              <section key={type} aria-labelledby={`search-${type}`}>
                <h2 id={`search-${type}`} className="mb-2 text-xs font-medium text-faint">
                  {typeName(type, true)} · {hits.length}
                </h2>
                <ul className="divide-y divide-line rounded-md border border-line bg-surface">
                  {hits.map((h) => (
                    <li key={h.uuid}>
                      <HitRow hit={h} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HitRow({ hit }: { hit: SearchHit }) {
  const body = (
    <>
      <span className="truncate font-medium">{hit.title}</span>
      {hit.subtitle ? <span className="truncate text-sm text-muted">{hit.subtitle}</span> : null}
      {hit.matched ? <span className="ms-auto shrink-0 text-2xs text-faint">{hit.matched}</span> : null}
    </>
  );
  const cls = 'flex items-center gap-3 px-3 py-2.5';
  return hit.url ? (
    <Link to={hit.url} className={`${cls} hover:bg-hover focus-visible:bg-hover`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
