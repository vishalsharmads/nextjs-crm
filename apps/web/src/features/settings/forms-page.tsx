import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, ExternalLink, Plus, Trash2, FileInput } from 'lucide-react';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { appUrl } from '@/lib/app-url';
import { useBoot, useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Badge, EmptyState, ErrorState, Pane, Skeleton } from '@/components/ui/misc';
import { Sheet } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/checkbox';
import { Combobox } from '@/components/fields/combobox';
import { TagsInput, UserPicker } from '@/components/fields/pickers';
import { labelVars } from '@/lib/labels';
import { SettingsPage } from './layout';

interface FormField {
  target: string;
  label: string;
  required: boolean;
  placeholder?: string;
}
interface FormRow {
  uuid: string;
  name: string;
  entity: 'contact' | 'lead';
  fields: FormField[];
  settings: Record<string, unknown> & {
    tags?: string[];
    successMessage?: string;
    redirectUrl?: string;
    title?: string;
    intro?: string;
    ownerUuid?: string | null;
    notifyOwner?: boolean;
    source?: string;
    consentText?: string;
    consentPurposes?: { key: string; required: boolean }[];
    submitLabel?: string;
  };
  active: boolean;
  submissionCount: number;
}

const CORE_FORM_FIELDS: Record<'contact' | 'lead', { target: string; label: string }[]> = {
  contact: [
    { target: 'firstName', label: 'First name' },
    { target: 'lastName', label: 'Last name' },
    { target: 'email', label: 'Email' },
    { target: 'phone', label: 'Phone' },
    { target: 'jobTitle', label: 'Job title' },
  ],
  lead: [
    { target: 'firstName', label: 'First name' },
    { target: 'lastName', label: 'Last name' },
    { target: 'email', label: 'Email' },
    { target: 'phone', label: 'Phone' },
    { target: 'companyName', label: 'Company' },
    { target: 'jobTitle', label: 'Job title' },
  ],
};

export function FormsPage() {
  const t = useT();
  const qc = useQueryClient();
  const forms = useQuery({
    queryKey: ['web-forms'],
    queryFn: () => apiGet<{ data: FormRow[] }>('/forms').then((r) => r.data),
  });
  const [editing, setEditing] = useState<FormRow | 'new' | null>(null);
  return (
    <SettingsPage
      title={t('settings.forms')}
      description="Put a form on your website. Submissions arrive as new records, tagged and assigned, and can trigger automations."
      actions={
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus /> New form
        </Button>
      }
    >
      <Pane padded={false}>
        {forms.isPending ? (
          <Skeleton className="m-4 h-16" />
        ) : forms.isError ? (
          <ErrorState error={forms.error} onRetry={() => void forms.refetch()} />
        ) : !forms.data?.length ? (
          <EmptyState
            icon={<FileInput />}
            title="No forms yet"
            description="Create an enquiry form for your website in a minute."
          />
        ) : (
          <ul className="divide-y divide-line">
            {forms.data.map((f) => (
              <li key={f.uuid}>
                <button
                  type="button"
                  onClick={() => setEditing(f)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-start text-sm hover:bg-hover"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{f.name}</p>
                    <p className="text-xs text-muted">
                      {f.submissionCount} submissions · {f.fields.length} fields
                    </p>
                  </div>
                  {f.active ? <Badge tone="primary">Live</Badge> : <Badge>Off</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Pane>
      {editing ? (
        <FormEditor
          form={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ['web-forms'] })}
        />
      ) : null}
    </SettingsPage>
  );
}

function FormEditor({
  form,
  onClose,
  onSaved,
}: {
  form: FormRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const boot = useBoot();
  const L = labelVars(boot.labels);
  const [name, setName] = useState(form?.name ?? '');
  const [entity, setEntity] = useState<'contact' | 'lead'>(
    form?.entity ?? (boot.settings.features.leads ? 'lead' : 'contact'),
  );
  const [fields, setFields] = useState<FormField[]>(
    form?.fields ?? [
      { target: 'firstName', label: 'First name', required: true },
      { target: 'email', label: 'Email', required: true },
    ],
  );
  const [settings, setSettings] = useState<FormRow['settings']>(
    form?.settings ?? {
      successMessage: 'Thanks, we will be in touch soon.',
      tags: [],
      notifyOwner: true,
      source: 'Web form',
      submitLabel: 'Send',
    },
  );
  const [active, setActive] = useState(form?.active ?? true);
  const available = [
    ...CORE_FORM_FIELDS[entity],
    ...boot.customFields
      .filter((c) => c.entity === entity && c.type !== 'file' && c.type !== 'user')
      .map((c) => ({ target: `cf.${c.key}`, label: c.label })),
  ].filter((a) => !fields.some((f) => f.target === a.target));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        entity,
        fields,
        settings: { ...settings, ownerUuid: settings.ownerUuid || null },
        active,
      };
      return form ? apiPatch(`/forms/${form.uuid}`, body) : apiPost('/forms', body);
    },
    onSuccess: () => {
      toast.success('Form saved');
      onSaved();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => apiDelete(`/forms/${form!.uuid}`),
    onSuccess: () => (onSaved(), onClose()),
  });
  const publicUrl = form ? appUrl(`/f/${form.uuid}`) : null;
  const embed = publicUrl
    ? `<iframe src="${publicUrl}?embed=1" style="width:100%;min-height:560px;border:0" title="${name}"></iframe>`
    : '';
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={form ? form.name : 'New form'}
      width="max-w-2xl"
      footer={
        <>
          {form ? (
            <Button variant="ghost" className="me-auto text-accent" onClick={() => remove.mutate()}>
              <Trash2 /> Delete
            </Button>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!name.trim() || !fields.length}
          >
            Save form
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Creates">
            {(p) => (
              <NativeSelect
                {...p}
                value={entity}
                disabled={!!form}
                onChange={(e) => (
                  setEntity(e.target.value as 'contact' | 'lead'),
                  setFields(fields.filter((f) => !f.target.startsWith('cf.')))
                )}
              >
                {boot.settings.features.leads ? <option value="lead">{L.lead}</option> : null}
                <option value="contact">{L.contact}</option>
              </NativeSelect>
            )}
          </Field>
          <label className="flex items-center justify-between gap-3 text-sm sm:col-span-2">
            Accepting submissions <Switch checked={active} onCheckedChange={setActive} />
          </label>
        </div>
        <section>
          <h3 className="mb-2 text-sm font-semibold">Fields</h3>
          <ul className="flex flex-col gap-2">
            {fields.map((f, i) => (
              <li key={f.target} className="flex items-center gap-2">
                <Input
                  aria-label="Field label"
                  value={f.label}
                  onChange={(e) =>
                    setFields(fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                  }
                  className="flex-1"
                />
                <label className="flex items-center gap-1.5 text-xs whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={f.required}
                    onChange={(e) =>
                      setFields(fields.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))
                    }
                  />{' '}
                  Required
                </label>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${f.label}`}
                  onClick={() => setFields(fields.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
          {available.length ? (
            <div className="mt-2 w-64">
              <Combobox
                value={null}
                onChange={(v) =>
                  v &&
                  setFields([
                    ...fields,
                    {
                      target: v as string,
                      label: available.find((a) => a.target === v)!.label,
                      required: false,
                    },
                  ])
                }
                options={available.map((a) => ({ value: a.target, label: a.label }))}
                placeholder="Add a field"
              />
            </div>
          ) : null}
        </section>
        <section className="grid gap-3 sm:grid-cols-2">
          <h3 className="text-sm font-semibold sm:col-span-2">After someone submits</h3>
          <Field label="Assign to" className="sm:col-span-2">
            {(p) => (
              <UserPicker
                {...p}
                value={settings.ownerUuid ?? null}
                onChange={(v) => setSettings({ ...settings, ownerUuid: v })}
                placeholder="Me"
              />
            )}
          </Field>
          <Field label="Tags">
            {(p) => (
              <TagsInput
                {...p}
                value={settings.tags ?? []}
                onChange={(tags) => setSettings({ ...settings, tags })}
              />
            )}
          </Field>
          <Field label="Source">
            {(p) => (
              <Input
                {...p}
                value={settings.source ?? ''}
                onChange={(e) => setSettings({ ...settings, source: e.target.value })}
              />
            )}
          </Field>
          <Field label="Thank-you message" className="sm:col-span-2">
            {(p) => (
              <Textarea
                {...p}
                value={settings.successMessage ?? ''}
                onChange={(e) => setSettings({ ...settings, successMessage: e.target.value })}
                className="min-h-14"
              />
            )}
          </Field>
          <Field label="Redirect to (optional)" className="sm:col-span-2">
            {(p) => (
              <Input
                {...p}
                type="url"
                value={settings.redirectUrl ?? ''}
                onChange={(e) => setSettings({ ...settings, redirectUrl: e.target.value })}
                placeholder="https://"
              />
            )}
          </Field>
          <Field
            label="Consent text (optional)"
            className="sm:col-span-2"
            help="Shown above the button, e.g. how you will use their data."
          >
            {(p) => (
              <Textarea
                {...p}
                value={settings.consentText ?? ''}
                onChange={(e) => setSettings({ ...settings, consentText: e.target.value })}
                className="min-h-14"
              />
            )}
          </Field>
          {boot.settings.consentPurposes.length ? (
            <fieldset className="flex flex-col gap-2 text-sm sm:col-span-2">
              <legend className="mb-1 font-medium">Ask for consent</legend>
              <p className="text-xs text-muted">
                Each purpose shows as an unticked checkbox with its wording. Required ones must be ticked to
                submit.
              </p>
              {boot.settings.consentPurposes.map((p) => {
                const chosen = settings.consentPurposes?.find((c) => c.key === p.key);
                const others = (settings.consentPurposes ?? []).filter((c) => c.key !== p.key);
                return (
                  <div key={p.key} className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--primary)]"
                        checked={!!chosen}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            consentPurposes: e.target.checked
                              ? [...others, { key: p.key, required: false }]
                              : others,
                          })
                        }
                      />
                      {p.label}
                    </label>
                    {chosen ? (
                      <label className="flex items-center gap-2 text-xs text-muted">
                        <input
                          type="checkbox"
                          className="size-3.5 accent-[var(--primary)]"
                          checked={chosen.required}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              consentPurposes: [...others, { key: p.key, required: e.target.checked }],
                            })
                          }
                        />
                        Required
                      </label>
                    ) : null}
                  </div>
                );
              })}
            </fieldset>
          ) : null}
          <label className="flex items-center justify-between gap-3 text-sm sm:col-span-2">
            Notify the assignee{' '}
            <Switch
              checked={settings.notifyOwner !== false}
              onCheckedChange={(v) => setSettings({ ...settings, notifyOwner: v })}
            />
          </label>
        </section>
        {publicUrl ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Share or embed</h3>
            <div className="flex gap-2">
              <Input readOnly value={publicUrl} aria-label="Form link" className="text-xs" />
              <Button asChild>
                <a href={publicUrl} target="_blank" rel="noreferrer">
                  <ExternalLink /> Open
                </a>
              </Button>
            </div>
            <div className="flex gap-2">
              <Textarea
                readOnly
                value={embed}
                aria-label="Embed code"
                className="min-h-16 font-mono text-xs"
              />
              <Button
                onClick={() => void navigator.clipboard?.writeText(embed).then(() => toast.success('Copied'))}
                aria-label="Copy embed code"
              >
                <Copy />
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}
