import { createElement, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Search } from 'lucide-react';
import { ApiError, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { qk } from '@/lib/query-keys';
import { bootstrapKey, useCan, useT } from '@/app/session';
import { moduleIcon } from '@/app/shell/nav';
import { Button } from '@/components/ui/button';
import {
  Badge,
  EmptyState,
  ErrorState,
  Pane,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/misc';
import { Switch } from '@/components/ui/checkbox';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { SettingsPage } from './layout';

export type ModuleCategory = 'integration' | 'industry' | 'productivity' | 'commerce';

export interface ModuleRow {
  key: string;
  name: string;
  version: string;
  description: string;
  status: 'available' | 'stub';
  category: ModuleCategory;
  icon: string;
  hasSettings: boolean;
  dependsOn: string[];
  enabled: boolean;
  installedVersion: string | null;
}

export interface CatalogEntry {
  key: string;
  name: string;
  version: string;
  description: string;
  category: ModuleCategory;
  installed: boolean;
  updateAvailable: boolean;
  command: string;
}

export interface SettingField {
  key: string;
  type: 'string' | 'secret' | 'boolean' | 'select' | 'number' | 'url';
  label: string;
  help: string;
  required: boolean;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
}

type SettingValue = string | number | boolean | null | { set: boolean };

export interface ModuleSettingsDto {
  fields: SettingField[];
  values: Record<string, SettingValue>;
  configured: boolean;
}

interface ModuleDetail {
  key: string;
  name: string;
  version: string;
  description: string;
  status: 'available' | 'stub';
  category: ModuleCategory;
  icon: string;
  enabled: boolean;
  installedVersion: string | null;
  dependsOn: { key: string; name: string; enabled: boolean }[];
  dependents: { key: string; name: string; enabled: boolean }[];
  permissions: { key: string; description: string }[];
  menuItems: { label: string; path: string }[];
  canTest: boolean;
  settings: ModuleSettingsDto;
}

const CATEGORY_LABELS: Record<ModuleCategory, string> = {
  integration: 'Integrations',
  industry: 'Industry',
  productivity: 'Productivity',
  commerce: 'Sales documents',
};

function useToggleModule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, on }: { key: string; on: boolean }) =>
      apiPost(`/modules/${key}/${on ? 'enable' : 'disable'}`),
    onSuccess: (_r, v) => {
      toast.success(v.on ? 'Turned on' : 'Turned off. Its data is kept.');
      void qc.invalidateQueries({ queryKey: qk.modules() });
      void qc.invalidateQueries({ queryKey: bootstrapKey });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not change the module'),
  });
}

// ---------------- Marketplace ----------------

export function ModulesPage() {
  const t = useT();
  const modules = useQuery({
    queryKey: qk.modules(),
    queryFn: () => apiGet<{ data: ModuleRow[] }>('/modules').then((r) => r.data),
  });
  const catalog = useQuery({
    queryKey: qk.moduleCatalog(),
    queryFn: () => apiGet<{ configured: boolean; data: CatalogEntry[] }>('/modules/catalog'),
    retry: false,
  });
  const toggle = useToggleModule();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ModuleCategory | ''>('');
  const [tab, setTab] = useState('installed');

  const matches = (m: { name: string; description: string; category: ModuleCategory }) =>
    (!category || m.category === category) &&
    `${m.name} ${m.description}`.toLowerCase().includes(query.trim().toLowerCase());

  const rows = (modules.data ?? []).filter(matches);
  const installed = rows.filter((m) => m.enabled);
  const available = rows.filter((m) => !m.enabled);
  const fromCatalog = (catalog.data?.data ?? []).filter((c) => !c.installed && matches(c));
  const updates = (catalog.data?.data ?? []).filter((c) => c.installed && c.updateAvailable && matches(c));

  const grid = (list: ModuleRow[], empty: string) =>
    list.length ? (
      <ul className="grid gap-3 sm:grid-cols-2">
        {list.map((m) => (
          <ModuleCard key={m.key} m={m} toggle={toggle} />
        ))}
      </ul>
    ) : (
      <Pane>
        <EmptyState title={empty} description="Try another search or category." />
      </Pane>
    );

  return (
    <SettingsPage
      title={t('settings.modules')}
      description="Optional features and integrations. Turning a module off hides it; its data stays until you turn it back on."
    >
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute start-2 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <Input
            className="ps-8"
            placeholder="Search modules"
            aria-label="Search modules"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <NativeSelect
          aria-label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value as ModuleCategory | '')}
        >
          <option value="">All categories</option>
          {Object.entries(CATEGORY_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </div>
      {modules.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : modules.isError ? (
        <Pane>
          <ErrorState error={modules.error} onRetry={() => void modules.refetch()} />
        </Pane>
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="installed">Turned on ({installed.length})</TabsTrigger>
            <TabsTrigger value="available">Available ({available.length + fromCatalog.length})</TabsTrigger>
            <TabsTrigger value="updates">Updates ({updates.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="installed">{grid(installed, 'No modules are turned on')}</TabsContent>
          <TabsContent value="available">
            {grid(available, 'Every module in this release is turned on')}
            {fromCatalog.length ? (
              <section className="mt-6">
                <h2 className="mb-1 text-sm font-medium">Available from the catalog</h2>
                <p className="mb-3 text-sm text-muted">
                  These are not part of this release yet. A developer adds one with the command shown, then it
                  arrives with the next update.
                </p>
                <ul className="grid gap-3 sm:grid-cols-2">
                  {fromCatalog.map((c) => (
                    <CatalogCard key={c.key} c={c} />
                  ))}
                </ul>
              </section>
            ) : null}
          </TabsContent>
          <TabsContent value="updates">
            {updates.length ? (
              <ul className="grid gap-3 sm:grid-cols-2">
                {updates.map((c) => (
                  <CatalogCard key={c.key} c={c} />
                ))}
              </ul>
            ) : (
              <Pane>
                <EmptyState
                  title="Everything is up to date"
                  description={
                    catalog.data?.configured
                      ? 'New versions in the catalog show here.'
                      : 'No module catalog is set up for this workspace, so updates arrive with releases.'
                  }
                />
              </Pane>
            )}
          </TabsContent>
        </Tabs>
      )}
    </SettingsPage>
  );
}

function ModuleCard({ m, toggle }: { m: ModuleRow; toggle: ReturnType<typeof useToggleModule> }) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4 shadow-raised">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-soft text-primary">
          {createElement(moduleIcon(m.icon), { className: 'size-5', 'aria-hidden': true })}
        </span>
        <div className="min-w-0 flex-1">
          <Link
            to={m.key}
            className="font-medium hover:underline focus-visible:underline"
            aria-label={`${m.name} details`}
          >
            {m.name}
          </Link>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <Badge tone="outline">{CATEGORY_LABELS[m.category]}</Badge>
            <span className="text-xs text-faint">v{m.version}</span>
            {m.status === 'stub' ? <Badge>Coming soon</Badge> : null}
          </div>
        </div>
        <Switch
          checked={m.enabled}
          disabled={m.status === 'stub' || toggle.isPending}
          onCheckedChange={(on) => toggle.mutate({ key: m.key, on })}
          aria-label={`${m.name} turned on`}
        />
      </div>
      <p className="line-clamp-3 text-sm text-muted">{m.description}</p>
      {m.dependsOn.length ? <p className="text-xs text-faint">Needs: {m.dependsOn.join(', ')}</p> : null}
    </li>
  );
}

function CatalogCard({ c }: { c: CatalogEntry }) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-dashed border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{c.name}</span>
        <Badge tone="outline">{CATEGORY_LABELS[c.category]}</Badge>
        <span className="text-xs text-faint">v{c.version}</span>
        {c.updateAvailable ? <Badge tone="primary">Update available</Badge> : null}
      </div>
      <p className="line-clamp-3 text-sm text-muted">{c.description}</p>
      <code className="block overflow-x-auto rounded-sm bg-subtle px-2 py-1 text-xs">{c.command}</code>
    </li>
  );
}

// ---------------- Module detail ----------------

export function ModuleDetailPage() {
  const { key = '' } = useParams();
  const can = useCan();
  const toggle = useToggleModule();
  const detail = useQuery({
    queryKey: qk.module(key),
    queryFn: () => apiGet<ModuleDetail>(`/modules/${key}`),
  });
  const m = detail.data;

  if (detail.isPending)
    return (
      <SettingsPage title="Module">
        <Skeleton className="h-64" />
      </SettingsPage>
    );
  if (detail.isError || !m)
    return (
      <SettingsPage title="Module">
        <Pane>
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        </Pane>
      </SettingsPage>
    );

  const blockers = m.dependents.filter((d) => d.enabled);
  return (
    <SettingsPage
      title={m.name}
      description={m.description}
      actions={
        <Button variant="ghost" asChild>
          <Link to="..">
            <ArrowLeft className="size-4" aria-hidden /> All modules
          </Link>
        </Button>
      }
    >
      <Pane className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid size-10 place-items-center rounded-md bg-primary-soft text-primary">
            {createElement(moduleIcon(m.icon), { className: 'size-5', 'aria-hidden': true })}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-1.5 text-sm">
              <Badge tone="outline">{CATEGORY_LABELS[m.category]}</Badge>
              <span className="text-faint">v{m.version}</span>
              {m.enabled && m.settings.fields.length && !m.settings.configured ? (
                <Badge tone="accent">Needs settings</Badge>
              ) : null}
            </p>
            {m.enabled && blockers.length ? (
              <p className="mt-1 text-xs text-faint">
                To turn this off, first turn off {blockers.map((b) => b.name).join(', ')}.
              </p>
            ) : null}
          </div>
          <label className="flex items-center gap-2 text-sm">
            {m.enabled ? 'On' : 'Off'}
            <Switch
              checked={m.enabled}
              disabled={m.status === 'stub' || toggle.isPending || (m.enabled && blockers.length > 0)}
              onCheckedChange={(on) =>
                toggle.mutate({ key: m.key, on }, { onSuccess: () => void detail.refetch() })
              }
              aria-label={`${m.name} turned on`}
            />
          </label>
        </div>
      </Pane>
      <Tabs defaultValue={m.settings.fields.length ? 'settings' : 'overview'}>
        <TabsList className="mb-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {m.settings.fields.length ? <TabsTrigger value="settings">Settings</TabsTrigger> : null}
          <TabsTrigger value="permissions">Permissions</TabsTrigger>
          {can('core.audit.view') ? <TabsTrigger value="activity">Activity</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="overview">
          <Pane>
            <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted">Version</dt>
              <dd>
                {m.version}
                {m.installedVersion && m.installedVersion !== m.version
                  ? ` (installed ${m.installedVersion})`
                  : ''}
              </dd>
              <dt className="text-muted">Needs</dt>
              <dd>
                {m.dependsOn.length
                  ? m.dependsOn.map((d) => `${d.name}${d.enabled ? '' : ' (off)'}`).join(', ')
                  : 'Nothing else'}
              </dd>
              <dt className="text-muted">Used by</dt>
              <dd>{m.dependents.length ? m.dependents.map((d) => d.name).join(', ') : 'No other module'}</dd>
              <dt className="text-muted">Adds pages</dt>
              <dd>{m.menuItems.length ? m.menuItems.map((i) => i.label).join(', ') : 'None'}</dd>
            </dl>
          </Pane>
        </TabsContent>
        {m.settings.fields.length ? (
          <TabsContent value="settings">
            <ModuleSettingsForm moduleKey={m.key} settings={m.settings} canTest={m.canTest} />
          </TabsContent>
        ) : null}
        <TabsContent value="permissions">
          <Pane padded={false}>
            {m.permissions.length ? (
              <ul className="divide-y divide-line">
                {m.permissions.map((p) => (
                  <li key={p.key} className="flex flex-wrap justify-between gap-2 px-4 py-2.5 text-sm">
                    <span>{p.description}</span>
                    <code className="text-xs text-faint">{p.key}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="This module adds no permissions" />
            )}
          </Pane>
          <p className="mt-2 text-xs text-muted">
            Give these to people in{' '}
            <Link to="../../roles" className="underline">
              Roles
            </Link>
            .
          </p>
        </TabsContent>
        {can('core.audit.view') ? (
          <TabsContent value="activity">
            <ModuleActivity moduleKey={m.key} />
          </TabsContent>
        ) : null}
      </Tabs>
    </SettingsPage>
  );
}

type FormValues = Record<string, string | boolean>;

function initialValues(s: ModuleSettingsDto): FormValues {
  const out: FormValues = {};
  for (const f of s.fields) {
    const v = s.values[f.key];
    if (f.type === 'secret') out[f.key] = '';
    else if (f.type === 'boolean') out[f.key] = v === true;
    else out[f.key] = v === null || v === undefined || typeof v === 'object' ? '' : String(v);
  }
  return out;
}

/** Only changed fields are sent: an empty secret keeps the saved one, an emptied field is cleared. */
function toPatch(fields: SettingField[], values: FormValues, start: FormValues) {
  const body: Record<string, string | number | boolean | null> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.type === 'secret') {
      if (v) body[f.key] = v;
      continue;
    }
    if (v === start[f.key]) continue;
    if (f.type === 'boolean') body[f.key] = v === true;
    else if (v === '') body[f.key] = null;
    else body[f.key] = f.type === 'number' ? Number(v) : String(v);
  }
  return body;
}

export function ModuleSettingsForm({
  moduleKey,
  settings,
  canTest,
}: {
  moduleKey: string;
  settings: ModuleSettingsDto;
  canTest: boolean;
}) {
  const qc = useQueryClient();
  const start = useMemo(() => initialValues(settings), [settings]);
  const [values, setValues] = useState<FormValues>(start);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => setValues(start), [start]);

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.details) {
      const next: Record<string, string> = {};
      for (const d of (Array.isArray(err.details) ? err.details : []) as {
        path?: unknown;
        message?: string;
      }[]) {
        const path = Array.isArray(d.path) ? String(d.path[0]) : String(d.path ?? '');
        if (path) next[path] = d.message ?? 'Check this value';
      }
      setErrors(next);
    }
    toast.error(err instanceof Error ? err.message : 'Could not save');
  };

  const save = useMutation({
    mutationFn: () =>
      apiPatch<ModuleSettingsDto>(`/modules/${moduleKey}/settings`, toPatch(settings.fields, values, start)),
    onSuccess: (dto) => {
      setErrors({});
      toast.success('Settings saved');
      qc.setQueryData<ModuleDetail>(qk.module(moduleKey), (old) => (old ? { ...old, settings: dto } : old));
      void qc.invalidateQueries({ queryKey: qk.modules() });
    },
    onError: fail,
  });
  const test = useMutation({
    mutationFn: () =>
      apiPost<{ ok: boolean; message: string }>(
        `/modules/${moduleKey}/test`,
        toPatch(settings.fields, values, start),
      ),
    onSuccess: setResult,
    onError: (err) =>
      setResult({ ok: false, message: err instanceof Error ? err.message : 'The test failed' }),
  });
  const clearSecret = useMutation({
    mutationFn: (field: string) =>
      apiPatch<ModuleSettingsDto>(`/modules/${moduleKey}/settings`, { [field]: null }),
    onSuccess: (dto) => {
      toast.success('Removed');
      qc.setQueryData<ModuleDetail>(qk.module(moduleKey), (old) => (old ? { ...old, settings: dto } : old));
    },
    onError: fail,
  });

  const set = (k: string, v: string | boolean) => {
    setValues((s) => ({ ...s, [k]: v }));
    setResult(null);
  };

  return (
    <Pane>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {settings.fields.map((f) => {
          const secretSet = f.type === 'secret' && (settings.values[f.key] as { set?: boolean } | null)?.set;
          return (
            <Field
              key={f.key}
              label={f.label}
              help={f.help}
              required={f.required && f.default === undefined}
              error={errors[f.key]}
            >
              {(p) =>
                f.type === 'boolean' ? (
                  <Switch
                    id={p.id}
                    checked={values[f.key] === true}
                    onCheckedChange={(v) => set(f.key, v)}
                    aria-label={f.label}
                  />
                ) : f.type === 'select' ? (
                  <NativeSelect
                    {...p}
                    value={String(values[f.key])}
                    onChange={(e) => set(f.key, e.target.value)}
                  >
                    <option value="">Not set</option>
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <div className="flex gap-2">
                    <Input
                      {...p}
                      className="flex-1"
                      type={
                        f.type === 'secret'
                          ? 'password'
                          : f.type === 'number'
                            ? 'number'
                            : f.type === 'url'
                              ? 'url'
                              : 'text'
                      }
                      autoComplete={f.type === 'secret' ? 'new-password' : 'off'}
                      placeholder={
                        secretSet ? 'Saved. Type to replace it' : f.type === 'url' ? 'https://' : undefined
                      }
                      value={String(values[f.key])}
                      onChange={(e) => set(f.key, e.target.value)}
                    />
                    {secretSet ? (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={clearSecret.isPending}
                        onClick={() => clearSecret.mutate(f.key)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                )
              }
            </Field>
          );
        })}
        {result ? (
          <p role="status" className={result.ok ? 'text-sm text-primary' : 'text-sm text-accent'}>
            {result.message}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            Save settings
          </Button>
          {canTest ? (
            <Button type="button" variant="secondary" disabled={test.isPending} onClick={() => test.mutate()}>
              Test connection
            </Button>
          ) : null}
        </div>
      </form>
    </Pane>
  );
}

interface AuditEntry {
  id: number | string;
  action: string;
  actor: { name: string } | null;
  diff?: { key?: string } | null;
  createdAt: string;
}

const ACTIONS: Record<string, string> = {
  'module.enabled': 'Turned on',
  'module.disabled': 'Turned off',
  'module.settings_changed': 'Changed settings',
  'module.connection_tested': 'Tested the connection',
};

function ModuleActivity({ moduleKey }: { moduleKey: string }) {
  const log = useQuery({
    queryKey: qk.moduleActivity(moduleKey),
    queryFn: () =>
      apiGet<{ data: AuditEntry[] }>('/audit-logs', { entity: 'module', pageSize: 100 }).then((r) =>
        r.data.filter((e) => e.diff?.key === moduleKey),
      ),
  });
  if (log.isPending) return <Skeleton className="h-32" />;
  if (log.isError)
    return (
      <Pane>
        <ErrorState error={log.error} onRetry={() => void log.refetch()} />
      </Pane>
    );
  return (
    <Pane padded={false}>
      {log.data.length ? (
        <ul className="divide-y divide-line">
          {log.data.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
              <span className="text-faint tabular-nums">{formatDateTime(e.createdAt)}</span>
              <span className="font-medium">{e.actor?.name ?? 'System'}</span>
              <span>{ACTIONS[e.action] ?? e.action}</span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="No changes yet"
          description="Turning this module on or off and changing its settings shows here."
        />
      )}
    </Pane>
  );
}
