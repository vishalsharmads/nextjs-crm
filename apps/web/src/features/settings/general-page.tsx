import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import type {
  ContactSettings,
  DealSettings,
  FeatureSettings,
  GeneralSettings,
  SecuritySettings,
} from '@app/shared';
import { apiGet, apiPatch } from '@/lib/api';
import { bootstrapKey, useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Pane, Skeleton } from '@/components/ui/misc';
import { Switch } from '@/components/ui/checkbox';
import { SettingsPage } from './layout';

interface AllSettings {
  general: GeneralSettings;
  security: SecuritySettings;
  features: FeatureSettings;
  deals: DealSettings;
  contacts: ContactSettings;
}

function useSettings() {
  return useQuery({ queryKey: ['settings', 'all'], queryFn: () => apiGet<AllSettings>('/settings') });
}

function useSaveGroup<G extends keyof AllSettings>(group: G) {
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
      {q.data ? <SecurityForm initial={q.data.security} /> : <Skeleton className="h-80" />}
    </SettingsPage>
  );
}

function SecurityForm({ initial }: { initial: SecuritySettings }) {
  const form = useForm({ defaultValues: initial });
  const save = useSaveGroup('security');
  const num = { valueAsNumber: true } as const;
  return (
    <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-6">
      <Pane title="Passwords">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Minimum length">
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
          </label>
        </div>
      </Pane>
      <Pane title="Lockout">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Failed attempts before lockout">
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
