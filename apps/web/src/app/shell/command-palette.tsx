import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Command } from 'cmdk';
import { Dialog as D } from 'radix-ui';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Search, CornerDownLeft, type LucideIcon } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { useT } from '@/app/session';
import { Kbd } from '@/components/ui/misc';

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  icon?: LucideIcon;
  keywords?: string[];
  shortcut?: string;
  run: () => void;
}

interface PaletteContextValue {
  open: (initial?: string) => void;
  register: (commands: PaletteCommand[]) => () => void;
}

const PaletteContext = createContext<PaletteContextValue | null>(null);

interface SearchHit {
  type: string;
  uuid: string;
  title: string;
  subtitle: string | null;
  url: string;
}

export function CommandPaletteProvider({
  children,
  baseCommands,
}: {
  children: ReactNode;
  baseCommands: PaletteCommand[];
}) {
  const [isOpen, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [extra, setExtra] = useState<PaletteCommand[][]>([]);
  const navigate = useNavigate();
  const t = useT();

  const register = useCallback((commands: PaletteCommand[]) => {
    setExtra((prev) => [...prev, commands]);
    return () => setExtra((prev) => prev.filter((c) => c !== commands));
  }, []);

  const value = useMemo(
    () => ({
      open: (initial = '') => {
        setSearch(initial);
        setOpen(true);
      },
      register,
    }),
    [register],
  );

  const q = search.trim();
  const hits = useQuery({
    queryKey: ['search', q],
    queryFn: () => apiGet<{ data: SearchHit[] }>(`/search?q=${encodeURIComponent(q)}`).then((r) => r.data),
    enabled: isOpen && q.length >= 2,
    staleTime: 10_000,
  });

  const all = [...baseCommands, ...extra.flat()];
  const groups = [...new Set(all.map((c) => c.group))];
  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <PaletteContext.Provider value={value}>
      {children}
      <D.Root open={isOpen} onOpenChange={setOpen}>
        <D.Portal>
          <D.Overlay className="anim-fade fixed inset-0 z-40 bg-overlay" />
          <D.Content className="anim-pop fixed inset-x-0 top-[14vh] z-50 mx-auto w-[calc(100vw-2rem)] max-w-xl overflow-hidden rounded-lg border border-line bg-surface shadow-2xl">
            <D.Title className="sr-only">{t('nav.search')}</D.Title>
            <D.Description className="sr-only">{t('nav.search')}</D.Description>
            <Command label={t('nav.search')} shouldFilter loop>
              <div className="flex items-center gap-2 border-b border-line px-3">
                <Search className="size-4 text-muted" />
                <Command.Input
                  value={search}
                  onValueChange={setSearch}
                  placeholder={t('nav.search')}
                  className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-faint"
                />
                <Kbd>Esc</Kbd>
              </div>
              <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
                <Command.Empty className="px-3 py-8 text-center text-sm text-muted">
                  {hits.isFetching ? t('common.loading') : 'No results'}
                </Command.Empty>
                {hits.data?.length ? (
                  <Command.Group
                    heading="Records"
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint"
                  >
                    {hits.data.map((h) => (
                      <Item
                        key={`${h.type}:${h.uuid}`}
                        value={`${h.title} ${h.subtitle ?? ''} ${h.uuid}`}
                        onSelect={() => run(() => navigate(h.url))}
                      >
                        <span className="truncate">{h.title}</span>
                        {h.subtitle ? (
                          <span className="truncate text-xs text-muted">{h.subtitle}</span>
                        ) : null}
                        <span className="ms-auto text-2xs text-faint">{h.type}</span>
                      </Item>
                    ))}
                  </Command.Group>
                ) : null}
                {groups.map((g) => (
                  <Command.Group
                    key={g}
                    heading={g}
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint"
                  >
                    {all
                      .filter((c) => c.group === g)
                      .map((c) => (
                        <Item
                          key={c.id}
                          value={`${c.label} ${(c.keywords ?? []).join(' ')}`}
                          onSelect={() => run(c.run)}
                        >
                          {c.icon ? <c.icon className="size-4 text-muted" /> : null}
                          <span>{c.label}</span>
                          {c.shortcut ? (
                            <span className="ms-auto flex gap-1">
                              {c.shortcut.split(' ').map((k) => (
                                <Kbd key={k}>{k}</Kbd>
                              ))}
                            </span>
                          ) : null}
                        </Item>
                      ))}
                  </Command.Group>
                ))}
              </Command.List>
              <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-2xs text-faint">
                <span className="flex items-center gap-1">
                  <CornerDownLeft className="size-3" /> {t('common.open')}
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd>
                </span>
              </div>
            </Command>
          </D.Content>
        </D.Portal>
      </D.Root>
    </PaletteContext.Provider>
  );
}

function Item({ children, value, onSelect }: { children: ReactNode; value: string; onSelect: () => void }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-default items-center gap-2 rounded-sm px-2 py-2 text-sm data-[selected=true]:bg-hover"
    >
      {children}
    </Command.Item>
  );
}

export function usePalette() {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error('usePalette outside CommandPaletteProvider');
  return ctx;
}

/** Register page-specific commands while a component is mounted. */
export function usePaletteCommands(commands: PaletteCommand[]) {
  const { register } = usePalette();
  useEffect(() => register(commands), [register, commands]);
}
