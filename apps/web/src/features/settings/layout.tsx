import { NavLink, Navigate, Outlet, useLocation } from 'react-router';
import { useBoot, useCan, useT } from '@/app/session';
import { cn } from '@/lib/cn';

interface SettingsLink {
  to: string;
  label: string;
  permission?: string;
}

export function useSettingsSections() {
  const t = useT();
  const can = useCan();
  const { modules } = useBoot();
  const commerceOn = ['quotes', 'invoices', 'contracts'].some((k) => modules.enabled.includes(k));
  const sections: { title: string; links: SettingsLink[] }[] = [
    { title: t('settings.account'), links: [{ to: 'profile', label: t('settings.profile') }] },
    {
      title: t('settings.workspace'),
      links: [
        { to: 'general', label: t('settings.general'), permission: 'core.settings.manage' },
        { to: 'branding', label: t('settings.branding'), permission: 'core.branding.manage' },
        { to: 'vocabulary', label: t('settings.vocabulary'), permission: 'core.labels.manage' },
        { to: 'security', label: t('settings.security'), permission: 'core.settings.manage' },
        { to: 'compliance', label: t('settings.compliance'), permission: 'core.settings.manage' },
        ...(commerceOn
          ? [{ to: 'sales-documents', label: 'Sales documents', permission: 'core.settings.manage' }]
          : []),
      ],
    },
    {
      title: t('settings.people'),
      links: [
        { to: 'users', label: t('settings.users'), permission: 'core.users.manage' },
        { to: 'teams', label: t('settings.teams'), permission: 'core.users.manage' },
        { to: 'roles', label: t('settings.roles'), permission: 'core.roles.manage' },
      ],
    },
    {
      title: t('settings.data'),
      links: [
        { to: 'fields', label: t('settings.fields'), permission: 'core.fields.manage' },
        { to: 'layouts', label: t('settings.layouts'), permission: 'core.fields.manage' },
        { to: 'pipelines', label: t('settings.pipelines'), permission: 'core.pipelines.manage' },
        { to: 'templates', label: t('settings.templates'), permission: 'core.templates.manage' },
        { to: 'automations', label: t('settings.automations'), permission: 'core.automations.manage' },
        { to: 'forms', label: t('settings.forms'), permission: 'core.forms.manage' },
      ],
    },
    {
      title: t('settings.system'),
      links: [
        { to: 'email', label: t('settings.email'), permission: 'core.email.manage' },
        { to: 'webhooks', label: t('settings.webhooks'), permission: 'core.webhooks.manage' },
        { to: 'api-keys', label: t('settings.apiKeys'), permission: 'core.api_keys.manage' },
        { to: 'modules', label: t('settings.modules'), permission: 'core.modules.manage' },
        { to: 'blueprint', label: t('settings.blueprint'), permission: 'core.blueprints.manage' },
        { to: 'audit', label: t('settings.audit'), permission: 'core.audit.view' },
        { to: 'privacy', label: t('settings.privacy'), permission: 'core.privacy.manage' },
      ],
    },
  ];
  return sections
    .map((s) => ({ ...s, links: s.links.filter((l) => !l.permission || can(l.permission)) }))
    .filter((s) => s.links.length);
}

/** Only routes that exist are linked; later phases add their pages to SETTINGS_PAGES. */
export function SettingsLayout({ available }: { available: string[] }) {
  const sections = useSettingsSections()
    .map((s) => ({ ...s, links: s.links.filter((l) => available.includes(l.to)) }))
    .filter((s) => s.links.length);
  const location = useLocation();
  if (location.pathname === '/settings' || location.pathname === '/settings/') {
    return <Navigate to={sections[1]?.links[0]?.to ?? 'profile'} replace />;
  }
  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <nav
        className="shrink-0 border-b border-line bg-surface p-3 md:w-56 md:border-e md:border-b-0"
        aria-label="Settings"
      >
        <div className="flex gap-4 overflow-x-auto md:flex-col md:gap-5">
          {sections.map((s) => (
            <div key={s.title} className="flex shrink-0 gap-1 md:flex-col md:gap-0.5">
              <p className="hidden px-2 pb-1 text-2xs font-medium text-faint md:block">{s.title}</p>
              {s.links.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  className={({ isActive }) =>
                    cn(
                      'rounded-sm px-2 py-1.5 text-sm whitespace-nowrap text-muted hover:bg-hover hover:text-ink',
                      isActive && 'bg-primary-soft font-medium text-ink',
                    )
                  }
                >
                  {l.label}
                </NavLink>
              ))}
            </div>
          ))}
        </div>
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

export function SettingsPage({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 md:px-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex gap-2">{actions}</div> : null}
      </div>
      <div className="flex flex-col gap-6">{children}</div>
    </div>
  );
}
