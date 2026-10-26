import { useMemo, useState, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog as D } from 'radix-ui';
import {
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sun,
  User,
  Keyboard,
} from 'lucide-react';
import { useBranding } from '@/app/branding';
import { useBoot, useT, bootstrapKey } from '@/app/session';
import { apiPost } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Avatar, Kbd } from '@/components/ui/misc';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Tooltip,
} from '@/components/ui/menu';
import { DialogContent, Dialog } from '@/components/ui/dialog';
import { buildNav, type NavItem } from './nav';
import { CommandPaletteProvider, usePalette, type PaletteCommand } from './command-palette';
import { useHotkeys } from './hotkeys';
import { IdleTimeout } from './idle-timeout';
import { NotificationsBell } from '@/features/notifications/notifications-bell';

const COLLAPSE_KEY = 'ui.sidebarCollapsed';

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function AppShell() {
  const boot = useBoot();
  const t = useT();
  const navigate = useNavigate();
  const nav = useMemo(() => buildNav(boot, t), [boot, t]);

  const commands = useMemo<PaletteCommand[]>(
    () =>
      nav.map((n) => ({
        id: `nav:${n.key}`,
        label: n.label,
        group: 'Go to',
        icon: n.icon,
        shortcut: n.shortcut,
        run: () => navigate(n.to),
      })),
    [nav, navigate],
  );

  return (
    <CommandPaletteProvider baseCommands={commands}>
      <ShellLayout nav={nav} />
    </CommandPaletteProvider>
  );
}

function ShellLayout({ nav }: { nav: NavItem[] }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const palette = usePalette();
  const navigate = useNavigate();

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !c;
    });
  };

  const hotkeys: Record<string, () => void> = {
    'mod+k': () => palette.open(),
    '/': () => palette.open(),
    '?': () => setHelpOpen(true),
    '[': toggle,
  };
  for (const n of nav) if (n.shortcut) hotkeys[n.shortcut] = () => navigate(n.to);
  useHotkeys(hotkeys);

  return (
    <div className="flex h-dvh overflow-hidden print:block print:h-auto print:overflow-visible">
      <aside
        className={cn(
          'hidden shrink-0 flex-col border-e border-line bg-surface transition-[width] duration-150 md:flex print:hidden',
          collapsed ? 'w-14' : 'w-60',
        )}
      >
        <Sidebar nav={nav} collapsed={collapsed} onToggle={toggle} />
      </aside>
      <D.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <D.Portal>
          <D.Overlay className="anim-fade fixed inset-0 z-40 bg-overlay md:hidden" />
          <D.Content
            className="anim-sheet fixed inset-y-0 start-0 z-50 flex w-72 flex-col border-e border-line bg-surface md:hidden"
            style={{ ['--sheet-from' as string]: '-16px' }}
          >
            <D.Title className="sr-only">Navigation</D.Title>
            <D.Description className="sr-only">Navigation</D.Description>
            <Sidebar nav={nav} collapsed={false} onNavigate={() => setMobileOpen(false)} />
          </D.Content>
        </D.Portal>
      </D.Root>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMobileOpen(true)} onHelp={() => setHelpOpen(true)} />
        <MfaRequiredBanner />
        <main className="min-h-0 flex-1 overflow-y-auto print:overflow-visible">
          <Outlet />
        </main>
      </div>
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} nav={nav} />
      <IdleTimeout />
    </div>
  );
}

/** When the workspace requires 2FA for this user's role, keep them on their profile until they enrol. */
function MfaRequiredBanner() {
  const { access } = useBoot();
  const location = useLocation();
  if (!access.mfaSetupRequired) return null;
  if (!location.pathname.startsWith('/settings/profile')) return <Navigate to="/settings/profile" replace />;
  return (
    <div role="status" className="border-b border-accent bg-accent-soft px-4 py-2 text-sm">
      This workspace requires two-factor authentication for your account. Turn it on below to continue.
    </div>
  );
}

function Sidebar({
  nav,
  collapsed,
  onToggle,
  onNavigate,
}: {
  nav: NavItem[];
  collapsed: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
}) {
  const { branding } = useBranding();
  const t = useT();
  const logo = document.documentElement.classList.contains('dark')
    ? (branding.assets.logoDark ?? branding.assets.logoLight)
    : branding.assets.logoLight;
  const section = (s: NavItem['section']) => nav.filter((n) => n.section === s);

  const link = (n: NavItem) => {
    const el = (
      <NavLink
        key={n.key}
        to={n.to}
        end={n.to === '/'}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm text-muted transition-colors hover:bg-hover hover:text-ink',
            isActive && 'bg-primary-soft font-medium text-ink hover:bg-primary-soft',
            collapsed && 'justify-center px-0',
          )
        }
      >
        <n.icon className="size-4 shrink-0" />
        {collapsed ? <span className="sr-only">{n.label}</span> : <span className="truncate">{n.label}</span>}
      </NavLink>
    );
    return collapsed ? (
      <Tooltip key={n.key} content={n.label} side="right">
        {el}
      </Tooltip>
    ) : (
      el
    );
  };

  return (
    <>
      <div
        className={cn(
          'flex h-12 items-center gap-2 border-b border-line px-3',
          collapsed && 'justify-center px-0',
        )}
      >
        {logo ? (
          <img
            src={logo}
            alt={branding.appName}
            className={cn('h-6 object-contain', collapsed ? 'w-6 object-left' : 'max-w-36')}
          />
        ) : (
          <span className={cn('truncate text-sm font-semibold', collapsed && 'sr-only')}>
            {branding.appName}
          </span>
        )}
        {collapsed && !logo ? (
          <span
            aria-hidden
            className="flex size-7 items-center justify-center rounded-sm bg-primary text-xs font-semibold text-primary-fg"
          >
            {branding.appName.slice(0, 1)}
          </span>
        ) : null}
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2" aria-label="Main">
        {section('main').map(link)}
        {section('modules').length ? (
          <>
            {!collapsed ? (
              <p className="mt-4 mb-1 px-2 text-2xs font-medium text-faint">{t('nav.modules')}</p>
            ) : (
              <div className="my-2 h-px bg-line" />
            )}
            {section('modules').map(link)}
          </>
        ) : null}
      </nav>
      <div className="flex flex-col gap-0.5 border-t border-line p-2">
        {section('footer').map(link)}
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            className={cn(
              'flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm text-muted hover:bg-hover hover:text-ink',
              collapsed && 'justify-center px-0',
            )}
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4 rtl:-scale-x-100" />
            ) : (
              <PanelLeftClose className="size-4 rtl:-scale-x-100" />
            )}
            {collapsed ? null : <span>{t('nav.collapse')}</span>}
          </button>
        ) : null}
      </div>
    </>
  );
}

function TopBar({ onMenu, onHelp }: { onMenu: () => void; onHelp: () => void }) {
  const t = useT();
  const palette = usePalette();
  const { me } = useBoot();
  const { mode, setMode } = useBranding();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const name = `${me.firstName} ${me.lastName}`.trim() || me.email;
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  const signOut = async () => {
    await apiPost('/auth/logout').catch(() => undefined);
    qc.setQueryData(bootstrapKey, null);
    qc.clear();
    navigate('/login');
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 md:px-4 print:hidden">
      <Button variant="ghost" size="icon" className="md:hidden" onClick={onMenu} aria-label="Open navigation">
        <MenuIcon />
      </Button>
      <button
        type="button"
        onClick={() => palette.open()}
        className="flex h-8 w-full max-w-md items-center gap-2 rounded-sm border border-line bg-canvas px-2.5 text-sm text-faint transition-colors hover:border-line-strong"
      >
        <Search className="size-4" />
        <span className="truncate">{t('nav.search')}</span>
        <span className="ms-auto hidden gap-0.5 sm:flex">
          <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <div className="ms-auto flex items-center gap-1">
        <NotificationsBell />
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 rounded-sm p-1 hover:bg-hover"
              aria-label={t('nav.profile')}
            >
              <Avatar name={name} />
            </button>
          </MenuTrigger>
          <MenuContent>
            <MenuLabel>
              <span className="block truncate font-medium text-ink">{name}</span>
              <span className="block truncate">{me.email}</span>
            </MenuLabel>
            <MenuSeparator />
            <MenuItem onSelect={() => navigate('/settings/profile')}>
              <User /> {t('nav.profile')}
            </MenuItem>
            <MenuItem onSelect={onHelp}>
              <Keyboard /> {t('nav.shortcuts')}
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>{t('nav.theme')}</MenuLabel>
            {(
              [
                ['light', Sun, t('nav.themeLight')],
                ['dark', Moon, t('nav.themeDark')],
                ['system', Monitor, t('nav.themeSystem')],
              ] as const
            ).map(([m, Icon, label]) => (
              <MenuItem key={m} onSelect={() => setMode(m)}>
                <Icon /> {label}
                {mode === m ? <span className="ms-auto text-xs text-primary">●</span> : null}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onSelect={signOut}>
              <LogOut /> {t('nav.signOut')}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </header>
  );
}

function ShortcutsDialog({
  open,
  onOpenChange,
  nav,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  nav: NavItem[];
}) {
  const t = useT();
  const rows: [string, ReactNode][] = [
    ['⌘K / Ctrl K', t('nav.search')],
    ['/', t('nav.search')],
    ['c', `${t('common.create')}…`],
    ['j / k', 'Move down / up in lists'],
    ['Enter', t('common.open')],
    ['e', t('common.edit')],
    ['[', t('nav.collapse')],
    ['?', t('nav.shortcuts')],
    ...nav.filter((n) => n.shortcut).map((n) => [n.shortcut!, n.label] as [string, ReactNode]),
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('nav.shortcuts')}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          {rows.map(([k, label]) => (
            <div key={k} className="contents">
              <dt className="flex gap-1">
                {k.split(' ').map((p, i) => (
                  <Kbd key={i}>{p}</Kbd>
                ))}
              </dt>
              <dd className="text-muted">{label}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
