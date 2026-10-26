import { useState } from 'react';
import { useForm, useFieldArray, Controller, type Control, type UseFormRegister } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import {
  COMPLIANCE_PROFILES,
  LAWFUL_BASES,
  type ComplianceProfile,
  type ComplianceSettings,
  type LawfulBasis,
} from '@app/shared';
import { apiGet } from '@/lib/api';
import { useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Pane, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { SettingsPage } from './layout';
import { useSaveGroup, useSettings } from './general-page';
import { floorHint } from './compliance-floors';

const PROFILE_COPY: Record<ComplianceProfile, { label: string; help: string }> = {
  standard: {
    label: 'Standard',
    help: 'No enforced floors. You choose every setting.',
  },
  privacy: {
    label: 'Privacy (GDPR, UK GDPR, DPDP, CCPA/CPRA, PIPEDA, LGPD)',
    help: 'For workspaces holding personal data under privacy laws. Keeps audit and access logs for at least a year.',
  },
  hipaa: {
    label: 'Health data (HIPAA)',
    help: 'Everything in Privacy, plus two-factor authentication for everyone, sign-out after 15 minutes idle, sessions of at most 12 hours, a stronger password policy, access logging and six years of log retention.',
  },
};

export function ComplianceSettingsPage() {
  const t = useT();
  const q = useSettings();
  return (
    <SettingsPage
      title={t('settings.compliance')}
      description="Choose the rules this workspace must meet. A profile enforces minimum settings that nobody can lower while it is active."
    >
      {q.data ? <ComplianceForm initial={q.data.compliance} /> : <Skeleton className="h-96" />}
    </SettingsPage>
  );
}

function ComplianceForm({ initial }: { initial: ComplianceSettings }) {
  const form = useForm({ defaultValues: initial });
  const save = useSaveGroup('compliance');
  const [confirm, setConfirm] = useState<ComplianceSettings | null>(null);
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => apiGet<{ data: { key: string; name: string }[] }>('/roles').then((r) => r.data),
  });
  const profile = form.watch('profile');
  const hint = (key: keyof ComplianceSettings) => floorHint('compliance', key, profile);
  const num = { valueAsNumber: true } as const;

  const submit = form.handleSubmit((v) => {
    if (v.profile !== initial.profile) setConfirm(v);
    else save.mutate(v, { onSuccess: (next) => form.reset(next as ComplianceSettings) });
  });

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <Pane title="Profile">
        <Field label="Compliance profile" help={PROFILE_COPY[profile].help}>
          {(p) => (
            <NativeSelect {...p} {...form.register('profile')}>
              {COMPLIANCE_PROFILES.map((k) => (
                <option key={k} value={k}>
                  {PROFILE_COPY[k].label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <p className="mt-3 text-xs text-muted">
          A profile gives you the technical controls. It does not make the workspace compliant on its own: you
          still need the agreements, policies and hosting safeguards the law requires.
        </p>
      </Pane>
      <Pane title="Sessions">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Sign out after inactivity (minutes)"
            help={hint('idleTimeoutMinutes') ?? '0 turns this off.'}
          >
            {(p) => (
              <Input {...p} type="number" min={0} max={1440} {...form.register('idleTimeoutMinutes', num)} />
            )}
          </Field>
          <Field label="Maximum session length (hours)" help={hint('sessionMaxHours') ?? '0 turns this off.'}>
            {(p) => (
              <Input {...p} type="number" min={0} max={720} {...form.register('sessionMaxHours', num)} />
            )}
          </Field>
        </div>
      </Pane>
      <Pane title="Privacy requests and consent">
        <div className="flex flex-col gap-4">
          <Field
            label="Days to answer a privacy request"
            help={
              hint('dsarDueDays') ??
              'GDPR allows one month; CCPA 45 days. Requests show as overdue after this.'
            }
          >
            {(p) => (
              <Input
                {...p}
                type="number"
                min={1}
                max={90}
                className="sm:max-w-48"
                {...form.register('dsarDueDays', num)}
              />
            )}
          </Field>
          <ConsentPurposes control={form.control} register={form.register} />
        </div>
      </Pane>
      <Pane title="Audit and access logs">
        <div className="flex flex-col gap-4">
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              {...form.register('accessLogging')}
            />
            Record who views records, downloads files and exports data
            {hint('accessLogging') ? (
              <span className="text-xs text-muted">({hint('accessLogging')})</span>
            ) : null}
          </label>
          <Field
            label="Keep log entries for (days)"
            help={
              hint('auditRetentionDays') ??
              'Older entries are deleted after their day is sealed. 0 keeps them forever.'
            }
          >
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                max={36500}
                className="sm:max-w-48"
                {...form.register('auditRetentionDays', num)}
              />
            )}
          </Field>
        </div>
      </Pane>
      <Pane title="API keys">
        <Field
          label="Maximum key age (days)"
          help={
            hint('apiKeyMaxDays') ??
            'New keys must expire within this many days, and older keys stop working. 0 turns this off.'
          }
        >
          {(p) => (
            <Input
              {...p}
              type="number"
              min={0}
              max={3650}
              className="sm:max-w-48"
              {...form.register('apiKeyMaxDays', num)}
            />
          )}
        </Field>
      </Pane>
      <Pane title="Two-factor authentication">
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              {...form.register('mfaRequiredForAll')}
            />
            Require it for everyone
            {hint('mfaRequiredForAll') ? (
              <span className="text-xs text-muted">({hint('mfaRequiredForAll')})</span>
            ) : null}
          </label>
          {!form.watch('mfaRequiredForAll') ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-xs text-muted">Or require it for these roles</legend>
              {roles.isLoading ? <Skeleton className="h-16" /> : null}
              <Controller
                control={form.control}
                name="mfaRequiredRoles"
                render={({ field }) => (
                  <>
                    {(roles.data ?? []).map((r) => (
                      <label key={r.key} className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          className="size-4 accent-[var(--primary)]"
                          checked={field.value.includes(r.key)}
                          onChange={(e) =>
                            field.onChange(
                              e.target.checked
                                ? [...field.value, r.key]
                                : field.value.filter((k) => k !== r.key),
                            )
                          }
                        />
                        {r.name}
                      </label>
                    ))}
                  </>
                )}
              />
            </fieldset>
          ) : null}
        </div>
      </Pane>
      <Pane title="Sign-in notice">
        <Field
          label="Notice"
          help="Shown under the sign-in form, for example a warning that only authorized people may use this system."
        >
          {(p) => <Textarea {...p} rows={3} maxLength={2000} {...form.register('loginNotice')} />}
        </Field>
      </Pane>
      <div>
        <Button type="submit" variant="primary" loading={save.isPending}>
          Save compliance settings
        </Button>
      </div>
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent
          title={`Switch to ${confirm ? PROFILE_COPY[confirm.profile].label : ''}?`}
          description="Settings below the new profile's minimums are raised now. People may need to set up two-factor authentication or sign in again."
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>Cancel</Button>
              <Button
                variant="primary"
                loading={save.isPending}
                onClick={() =>
                  confirm &&
                  save.mutate(confirm, {
                    onSuccess: (next) => {
                      setConfirm(null);
                      form.reset(next as ComplianceSettings);
                    },
                  })
                }
              >
                Switch profile
              </Button>
            </>
          }
        />
      </Dialog>
    </form>
  );
}

const BASIS_LABEL: Record<LawfulBasis, string> = {
  consent: 'Consent',
  contract: 'Contract',
  legal_obligation: 'Legal obligation',
  vital_interests: 'Vital interests',
  public_task: 'Public task',
  legitimate_interests: 'Legitimate interests',
};

/** What people can consent to. Keys are permanent: they link consent records to the purpose. */
function ConsentPurposes({
  control,
  register,
}: {
  control: Control<ComplianceSettings>;
  register: UseFormRegister<ComplianceSettings>;
}) {
  const { fields, append, remove } = useFieldArray({ control, name: 'consentPurposes' });
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-medium">Consent purposes</legend>
      <p className="text-xs text-muted">
        Web forms can show a checkbox for each purpose. The exact wording is stored with every consent, so
        edit the wording by adding a new purpose rather than changing one people have already agreed to.
      </p>
      {fields.map((f, i) => (
        <div key={f.id} className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-2">
          <Field label="Key" help="Lowercase letters, digits and underscores.">
            {(p) => <Input {...p} {...register(`consentPurposes.${i}.key`)} placeholder="newsletter" />}
          </Field>
          <Field label="Name">
            {(p) => <Input {...p} {...register(`consentPurposes.${i}.label`)} placeholder="Newsletter" />}
          </Field>
          <Field label="Checkbox wording" className="sm:col-span-2">
            {(p) => <Textarea {...p} rows={2} {...register(`consentPurposes.${i}.text`)} />}
          </Field>
          <Field label="Lawful basis">
            {(p) => (
              <NativeSelect {...p} {...register(`consentPurposes.${i}.lawfulBasis`)}>
                {LAWFUL_BASES.map((b) => (
                  <option key={b} value={b}>
                    {BASIS_LABEL[b]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <div className="flex flex-col justify-end gap-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                {...register(`consentPurposes.${i}.marketing`)}
              />
              Marketing (withdrawing it also stops marketing email)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                {...register(`consentPurposes.${i}.active`)}
              />
              In use
            </label>
          </div>
          <div className="sm:col-span-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => remove(i)}>
              Remove
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button
          type="button"
          onClick={() =>
            append({ key: '', label: '', text: '', lawfulBasis: 'consent', marketing: false, active: true })
          }
        >
          Add purpose
        </Button>
      </div>
    </fieldset>
  );
}
