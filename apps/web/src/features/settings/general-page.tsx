import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import type {
  ComplianceSettings,
  ContactSettings,
  DealSettings,
  FeatureSettings,
  GeneralSettings,
  SecuritySettings,
  ComplianceProfile,
} from '@app/shared';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { appUrl } from '@/lib/app-url';
import { useBranding } from '@/app/branding';
import { bootstrapKey, useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Pane, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/checkbox';
import { SettingsPage } from './layout';
import { floorHint } from './compliance-floors';

interface AllSettings {
  general: GeneralSettings;
  security: SecuritySettings;
  features: FeatureSettings;
  deals: DealSettings;
  contacts: ContactSettings;
  compliance: ComplianceSettings;
}

export function useSettings() {
  return useQuery({ queryKey: ['settings', 'all'], queryFn: () => apiGet<AllSettings>('/settings') });
}

export function useSaveGroup<G extends keyof AllSettings>(group: G) {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: (v: Partial<AllSettings[G]>) => apiPatch(`/settings/${group}`, v),
    onSuccess: () => {
      toast.success(t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['settings', 'all'] });
      void qc.invalidateQueries({ queryKey: bootstrapKey });
    },
  });
}

const TIMEZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
const CURRENCIES =
  typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : ['USD', 'EUR', 'GBP'];

export function GeneralSettingsPage() {
  const t = useT();
  const q = useSettings();
  return (
    <SettingsPage
      title={t('settings.general')}
      description="Regional defaults and which features this workspace uses."
    >
      {q.data ? (
        <>
          <RegionalForm initial={q.data.general} />
          <FeaturesForm initial={q.data.features} />
          <ListSetting
            group="contacts"
            field="sources"
            title={t('settings.sources')}
            help={t('settings.sourcesHelp')}
            initial={q.data.contacts.sources}
          />
          <ListSetting
            group="contacts"
            field="lifecycleStatuses"
            title={t('settings.lifecycle')}
            help={t('settings.lifecycleHelp')}
            initial={q.data.contacts.lifecycleStatuses}
          />
          <ListSetting
            group="deals"
            field="lostReasons"
            title={t('settings.lostReasons')}
            help={t('settings.lostReasonsHelp')}
            initial={q.data.deals.lostReasons}
          />
        </>
      ) : (
        <Skeleton className="h-80" />
      )}
    </SettingsPage>
  );
}

function RegionalForm({ initial }: { initial: GeneralSettings }) {
  const form = useForm({ defaultValues: initial });
  const save = useSaveGroup('general');
  return (
    <Pane title="Regional">
      <form
        onSubmit={form.handleSubmit((v) =>
          save.mutate({ ...v, weekStartsOn: Number(v.weekStartsOn) as GeneralSettings['weekStartsOn'] }),
        )}
        className="grid gap-4 sm:grid-cols-2"
      >
        <Field label="Default currency">
          {(p) => (
            <NativeSelect {...p} {...form.register('currency')}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Time zone">
          {(p) => (
            <NativeSelect {...p} {...form.register('timezone')}>
              {TIMEZONES.map((z) => (
                <option key={z}>{z}</option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Date format">
          {(p) => (
            <NativeSelect {...p} {...form.register('dateFormat')}>
              {['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY'].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Week starts on">
          {(p) => (
            <NativeSelect {...p} {...form.register('weekStartsOn')}>
              <option value={1}>Monday</option>
              <option value={0}>Sunday</option>
              <option value={6}>Saturday</option>
            </NativeSelect>
          )}
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Pane>
  );
}

function FeaturesForm({ initial }: { initial: FeatureSettings }) {
  const t = useT();
  const save = useSaveGroup('features');
  const [leads, setLeads] = useState(initial.leads);
  const [leadPipeline, setLeadPipeline] = useState(initial.leadPipeline);
  const [taskPipeline, setTaskPipeline] = useState(initial.taskPipeline);
  return (
    <Pane title="Features">
      <label className="flex items-start justify-between gap-4">
        <span>
          <span className="block text-sm font-medium">{t('settings.leadsToggle')}</span>
          <span className="block text-sm text-muted">{t('settings.leadsToggleHelp')}</span>
        </span>
        <Switch
          checked={leads}
          onCheckedChange={(v) => {
            setLeads(v);
            save.mutate({ leads: v });
          }}
        />
      </label>
      {leads ? (
        <label className="mt-4 flex items-start justify-between gap-4 border-t border-line pt-4">
          <span>
            <span className="block text-sm font-medium">{t('settings.leadPipelineToggle')}</span>
            <span className="block text-sm text-muted">{t('settings.leadPipelineToggleHelp')}</span>
          </span>
          <Switch
            checked={leadPipeline}
            onCheckedChange={(v) => {
              setLeadPipeline(v);
              save.mutate({ leadPipeline: v });
            }}
          />
        </label>
      ) : null}
      <label className="mt-4 flex items-start justify-between gap-4 border-t border-line pt-4">
        <span>
          <span className="block text-sm font-medium">{t('settings.taskPipelineToggle')}</span>
          <span className="block text-sm text-muted">{t('settings.taskPipelineToggleHelp')}</span>
        </span>
        <Switch
          checked={taskPipeline}
          onCheckedChange={(v) => {
            setTaskPipeline(v);
            save.mutate({ taskPipeline: v });
          }}
        />
      </label>
    </Pane>
  );
}

function ListSetting<G extends 'contacts' | 'deals'>({
  group,
  field,
  title,
  help,
  initial,
}: {
  group: G;
  field: string;
  title: string;
  help: string;
  initial: string[];
}) {
  const [items, setItems] = useState(initial);
  const [draft, setDraft] = useState('');
  const save = useSaveGroup(group);
  const add = () => {
    const v = draft.trim();
    if (v && !items.includes(v)) setItems([...items, v]);
    setDraft('');
  };
  return (
    <Pane title={title}>
      <p className="mb-3 text-sm text-muted">{help}</p>
      <ul className="mb-3 flex flex-wrap gap-1.5">
        {items.map((i) => (
          <li
            key={i}
            className="flex h-7 items-center gap-1 rounded-sm border border-line bg-subtle ps-2 pe-1 text-sm"
          >
            {i}
            <button
              type="button"
              aria-label={`Remove ${i}`}
              className="rounded-sm p-0.5 text-muted hover:bg-hover hover:text-ink"
              onClick={() => setItems(items.filter((x) => x !== i))}
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add an option and press Enter"
          className="max-w-xs"
        />
        <Button type="button" onClick={add}>
          Add
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={() => save.mutate({ [field]: items } as never)}
          loading={save.isPending}
        >
          Save
        </Button>
      </div>
    </Pane>
  );
}

export function SecuritySettingsPage() {
  const t = useT();
  const q = useSettings();
  return (
    <SettingsPage
      title={t('settings.security')}
      description="Password rules, account lockout and two-factor authentication."
    >
      {q.data ? (
        <SecurityForm initial={q.data.security} profile={q.data.compliance.profile} />
      ) : (
        <Skeleton className="h-80" />
      )}
      <DemoIndustryPane />
      <DemoLoginPane />
    </SettingsPage>
  );
}

function SecurityForm({ initial, profile }: { initial: SecuritySettings; profile: ComplianceProfile }) {
  const form = useForm({ defaultValues: initial });
  const hint = (key: keyof SecuritySettings) => floorHint('security', key, profile);
  const save = useSaveGroup('security');
  const num = { valueAsNumber: true } as const;
  return (
    <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-6">
      <Pane title="Passwords">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Minimum length" help={hint('passwordMinLength')}>
            {(p) => (
              <Input {...p} type="number" min={8} max={128} {...form.register('passwordMinLength', num)} />
            )}
          </Field>
          <label className="flex items-center gap-3 self-end pb-1.5 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              {...form.register('passwordRequireMixed')}
            />
            Require upper and lowercase letters and a digit
            {hint('passwordRequireMixed') ? (
              <span className="text-xs text-muted">({hint('passwordRequireMixed')})</span>
            ) : null}
          </label>
        </div>
      </Pane>
      <Pane title="Lockout">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Failed attempts before lockout" help={hint('lockoutMaxAttempts')}>
            {(p) => (
              <Input {...p} type="number" min={3} max={50} {...form.register('lockoutMaxAttempts', num)} />
            )}
          </Field>
          <Field label="Lockout duration (minutes)">
            {(p) => (
              <Input {...p} type="number" min={1} max={1440} {...form.register('lockoutMinutes', num)} />
            )}
          </Field>
        </div>
      </Pane>
      <Pane title="Two-factor authentication">
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              {...form.register('totpAllowed')}
            />
            Let people turn on two-factor authentication
          </label>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              {...form.register('totpRequiredForAdmins')}
            />
            Require it for admins
          </label>
          <p className="text-xs text-muted">Require it for other roles, or for everyone, under Compliance.</p>
        </div>
      </Pane>
      <div>
        <Button type="submit" variant="primary" loading={save.isPending}>
          Save security settings
        </Button>
      </div>
    </form>
  );
}

interface DemoInfo {
  current: string | null;
  industries: { slug: string; name: string }[];
  allowed: boolean;
  reason: string | null;
}

/**
 * Lets an admin wipe the demo and install another industry with sample data. The server answers 404
 * unless DEMO_MODE=true, so the pane only appears on demo instances. Progress shows on the sign-in screen,
 * since the switch signs everyone out.
 */
export function DemoIndustryPane() {
  const q = useQuery({
    queryKey: ['settings', 'demo'],
    queryFn: () => apiGet<DemoInfo>('/settings/demo'),
    retry: false,
  });
  const [industry, setIndustry] = useState('');
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const target = industry || q.data?.current || q.data?.industries[0]?.slug || '';
  const name = (slug: string | null) => q.data?.industries.find((i) => i.slug === slug)?.name ?? slug;
  const doSwitch = useMutation({
    mutationFn: () => apiPost('/settings/demo/switch', { industry: target, confirm }),
    onSuccess: async () => {
      // The switch drops every session; sign out now so the sign-in screen can show its progress.
      await apiPost('/auth/logout').catch(() => undefined);
      window.location.assign(appUrl('/login?demoSwitch=1'));
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not switch the demo'),
  });
  if (!q.data) return null;
  return (
    <Pane title="Demo industry">
      <p className="text-sm text-muted">
        This demo shows {name(q.data.current) ?? 'no industry yet'}. Switching erases all records, users and
        uploaded files, then installs the chosen industry with sample data and demo accounts.
      </p>
      {q.data.allowed ? null : (
        <p role="status" className="mt-3 rounded-sm bg-subtle px-3 py-2 text-sm">
          {q.data.reason}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field label="Industry" className="min-w-56 flex-1">
          {(p) => (
            <NativeSelect {...p} value={target} onChange={(e) => setIndustry(e.target.value)}>
              {q.data.industries.map((i) => (
                <option key={i.slug} value={i.slug}>
                  {i.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Button
          variant="danger"
          disabled={!q.data.allowed || !target || target === q.data.current}
          onClick={() => {
            setConfirm('');
            setOpen(true);
          }}
        >
          Switch industry
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title={`Switch the demo to ${name(target)}`}
          description="Everything in this workspace is erased and everyone is signed out. This cannot be undone."
          footer={
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={confirm !== target}
                loading={doSwitch.isPending}
                onClick={() => doSwitch.mutate()}
              >
                Switch industry
              </Button>
            </>
          }
        >
          <Field label={`Type ${target} to confirm`}>
            {(p) => (
              <Input {...p} autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            )}
          </Field>
        </DialogContent>
      </Dialog>
    </Pane>
  );
}

/** Lets an admin remove demo credentials from the sign-in screen (demo instances only). */
function DemoLoginPane() {
  const { branding } = useBranding();
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => apiDelete('/settings/demo-login'),
    onSuccess: () => {
      toast.success('Demo sign-in details removed');
      void qc.invalidateQueries({ queryKey: ['public', 'branding'] });
    },
  });
  if (!branding.demoAccounts.length) return null;
  return (
    <Pane title="Demo sign-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          The sign-in screen shows {branding.demoAccounts.length} demo{' '}
          {branding.demoAccounts.length === 1 ? 'account' : 'accounts'}. Remove them before real people use
          this workspace, or set DEMO_MODE=false on the server.
        </p>
        <Button variant="danger" onClick={() => remove.mutate()} loading={remove.isPending}>
          Remove
        </Button>
      </div>
    </Pane>
  );
}
