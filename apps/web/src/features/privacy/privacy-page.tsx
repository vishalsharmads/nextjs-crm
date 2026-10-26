import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, Plus } from 'lucide-react';
import {
  PRIVACY_REQUEST_STATUSES,
  PRIVACY_REQUEST_TYPES,
  type ConsentSummaryDto,
  type DataSubjectEntity,
  type ErasureReportDto,
  type PrivacyRequestDto,
  type PrivacyRequestStatus,
  type PrivacyRequestType,
} from '@app/shared';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, buildUrl } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { formatDate } from '@/lib/format';
import { useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import {
  Badge,
  EmptyState,
  ErrorState,
  Pane,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui/misc';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { RecordPicker } from '@/components/fields/pickers';
import { useEntityConfig } from '@/features/records/entities';
import { SettingsPage } from '@/features/settings/layout';

export const REQUEST_TYPE_LABEL: Record<PrivacyRequestType, string> = {
  access: 'Access (copy of data)',
  portability: 'Portability (data to take elsewhere)',
  rectification: 'Correction',
  erasure: 'Erasure',
  restriction: 'Restrict processing',
  objection: 'Objection',
  opt_out_sale_share: 'Do not sell or share',
};
const STATUS_LABEL: Record<PrivacyRequestStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  completed: 'Completed',
  rejected: 'Rejected',
};

type Filter = 'active' | 'overdue' | 'all';

export function PrivacyPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>('active');
  const [creating, setCreating] = useState(false);
  const openUuid = params.get('request');
  const query = {
    status: filter === 'active' ? 'active' : undefined,
    overdue: filter === 'overdue' || undefined,
  };
  const q = useQuery({
    queryKey: qk.privacyRequests(query),
    queryFn: () => apiGet<{ data: PrivacyRequestDto[] }>('/privacy/requests', query).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const open = (uuid: string | null) =>
    setParams((p) => {
      if (uuid) p.set('request', uuid);
      else p.delete('request');
      return p;
    });

  return (
    <SettingsPage
      title={t('settings.privacy')}
      description="Track requests from people about their personal data, and act on them. Every action is recorded in the audit log."
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus /> New request
        </Button>
      }
    >
      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList>
          <TabsTrigger value="active">Open</TabsTrigger>
          <TabsTrigger value="overdue">Overdue</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>
      <Pane padded={false}>
        {q.isPending ? (
          <Skeleton className="m-4 h-32" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data.length ? (
          <EmptyState
            title={filter === 'overdue' ? 'Nothing overdue' : 'No requests'}
            description="Log a request as soon as it arrives: the due date starts from the day you received it."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                New request
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {q.data.map((r) => (
              <li key={r.uuid}>
                <button
                  type="button"
                  onClick={() => open(r.uuid)}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-start text-sm hover:bg-hover"
                >
                  <span className="min-w-44 font-medium">{REQUEST_TYPE_LABEL[r.type]}</span>
                  <span className="min-w-36 text-muted">
                    {r.subject?.name ?? (r.requesterName || r.requesterEmail || '—')}
                  </span>
                  <Badge tone={r.status === 'completed' ? 'primary' : 'outline'}>
                    {STATUS_LABEL[r.status]}
                  </Badge>
                  <span className={`ms-auto text-xs ${r.overdue ? 'font-medium text-accent' : 'text-muted'}`}>
                    {r.overdue ? 'Overdue · ' : ''}Due {formatDate(r.dueAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Pane>
      <FindPersonPane />
      <RetentionPane />
      {creating ? (
        <NewRequestDialog onClose={() => setCreating(false)} onCreated={(uuid) => open(uuid)} />
      ) : null}
      {openUuid ? <RequestDialog uuid={openUuid} onClose={() => open(null)} /> : null}
    </SettingsPage>
  );
}

function SubjectPicker({
  entity,
  setEntity,
  uuid,
  setUuid,
}: {
  entity: DataSubjectEntity;
  setEntity: (e: DataSubjectEntity) => void;
  uuid: string | null;
  setUuid: (u: string | null) => void;
}) {
  const contact = useEntityConfig('contact');
  const lead = useEntityConfig('lead');
  const config = entity === 'contact' ? contact : lead;
  return (
    <div className="flex flex-wrap gap-2">
      <div className="flex rounded-sm border border-line p-0.5">
        {(['contact', 'lead'] as const).map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => (setEntity(e), setUuid(null))}
            className={`rounded-[3px] px-2.5 py-1 text-xs ${entity === e ? 'bg-primary-soft font-medium' : 'text-muted'}`}
          >
            {e === 'contact' ? contact.plural : lead.plural}
          </button>
        ))}
      </div>
      <div className="min-w-64 flex-1">
        <RecordPicker route={config.route} value={uuid} onChange={setUuid} placeholder={config.plural} />
      </div>
    </div>
  );
}

function FindPersonPane() {
  const [entity, setEntity] = useState<DataSubjectEntity>('contact');
  const [uuid, setUuid] = useState<string | null>(null);
  return (
    <Pane title="Act on a person">
      <SubjectPicker entity={entity} setEntity={setEntity} uuid={uuid} setUuid={setUuid} />
      {uuid ? (
        <div className="mt-4">
          <PersonActions entity={entity} uuid={uuid} onErased={() => setUuid(null)} />
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted">
          Pick someone to export, restrict, erase or delete their data.
        </p>
      )}
    </Pane>
  );
}

function NewRequestDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (uuid: string) => void;
}) {
  const qc = useQueryClient();
  const [type, setType] = useState<PrivacyRequestType>('access');
  const [entity, setEntity] = useState<DataSubjectEntity>('contact');
  const [subject, setSubject] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [channel, setChannel] = useState('email');
  const [receivedAt, setReceivedAt] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const create = useMutation({
    mutationFn: () =>
      apiPost<PrivacyRequestDto>('/privacy/requests', {
        type,
        subjectEntity: subject ? entity : undefined,
        subjectUuid: subject ?? undefined,
        requesterName: name,
        requesterEmail: email,
        channel,
        receivedAt,
        notes,
      }),
    onSuccess: (r) => {
      toast.success('Request logged');
      void qc.invalidateQueries({ queryKey: qk.privacyRequests() });
      onClose();
      onCreated(r.uuid);
    },
  });
  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors() : {};
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="New privacy request"
        description="The due date is set from the date you received it."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
              Log request
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Request">
            {(p) => (
              <NativeSelect
                {...p}
                value={type}
                onChange={(e) => setType(e.target.value as PrivacyRequestType)}
              >
                {PRIVACY_REQUEST_TYPES.map((k) => (
                  <option key={k} value={k}>
                    {REQUEST_TYPE_LABEL[k]}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Person (if they are in the CRM)</span>
            <SubjectPicker entity={entity} setEntity={setEntity} uuid={subject} setUuid={setSubject} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Requester name">
              {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Field label="Requester email" error={fieldErrors.requesterEmail}>
              {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            <Field label="Received on">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={receivedAt}
                  onChange={(e) => setReceivedAt(e.target.value)}
                />
              )}
            </Field>
            <Field label="Received by">
              {(p) => (
                <NativeSelect {...p} value={channel} onChange={(e) => setChannel(e.target.value)}>
                  {['email', 'phone', 'letter', 'web form', 'in person'].map((c) => (
                    <option key={c} value={c}>
                      {c[0]!.toUpperCase() + c.slice(1)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>
          <Field label="Notes" help="Include how you verified the person's identity.">
            {(p) => <Textarea {...p} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RequestDialog({ uuid, onClose }: { uuid: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['privacy', 'request', uuid],
    queryFn: () => apiGet<PrivacyRequestDto>(`/privacy/requests/${uuid}`),
  });
  const [status, setStatus] = useState<PrivacyRequestStatus | null>(null);
  const [resolution, setResolution] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      apiPatch<PrivacyRequestDto>(`/privacy/requests/${uuid}`, {
        status: status ?? undefined,
        resolution: resolution ?? undefined,
      }),
    onSuccess: (r) => {
      toast.success('Request updated');
      qc.setQueryData(['privacy', 'request', uuid], r);
      void qc.invalidateQueries({ queryKey: qk.privacyRequests() });
      setStatus(null);
      setResolution(null);
    },
  });
  const r = q.data;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={r ? REQUEST_TYPE_LABEL[r.type] : 'Privacy request'}
        description={
          r ? `Received ${formatDate(r.receivedAt)} by ${r.channel} · due ${formatDate(r.dueAt)}` : undefined
        }
        className="max-w-2xl"
        footer={
          <>
            <Button onClick={onClose}>Close</Button>
            <Button
              variant="primary"
              disabled={status === null && resolution === null}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
          </>
        }
      >
        {q.isPending ? (
          <Skeleton className="h-40" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            {r!.overdue ? (
              <p role="status" className="rounded-sm bg-accent-soft px-3 py-2 text-accent">
                This request is past its due date.
              </p>
            ) : null}
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted">Person</dt>
              <dd>{r!.subject?.name ?? 'Not linked to a record'}</dd>
              <dt className="text-muted">Requester</dt>
              <dd>{[r!.requesterName, r!.requesterEmail].filter(Boolean).join(' · ') || '—'}</dd>
              {r!.notes ? (
                <>
                  <dt className="text-muted">Notes</dt>
                  <dd className="whitespace-pre-line">{r!.notes}</dd>
                </>
              ) : null}
            </dl>
            {r!.subject ? (
              <PersonActions entity={r!.subject.entity} uuid={r!.subject.uuid} highlight={r!.type} />
            ) : null}
            <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
              <Field label="Status">
                {(p) => (
                  <NativeSelect
                    {...p}
                    value={status ?? r!.status}
                    onChange={(e) => setStatus(e.target.value as PrivacyRequestStatus)}
                  >
                    {PRIVACY_REQUEST_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Resolution" help="What you did and when you told the person.">
                {(p) => (
                  <Textarea
                    {...p}
                    rows={3}
                    value={resolution ?? r!.resolution}
                    onChange={(e) => setResolution(e.target.value)}
                  />
                )}
              </Field>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Export, restrict, erase or delete one person's data. */
function PersonActions({
  entity,
  uuid,
  highlight,
  onErased,
}: {
  entity: DataSubjectEntity;
  uuid: string;
  highlight?: PrivacyRequestType;
  onErased?: () => void;
}) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<'anonymize' | 'delete' | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [report, setReport] = useState<ErasureReportDto | null>(null);
  const summary = useQuery({
    queryKey: qk.consents(entity, uuid),
    queryFn: () => apiGet<ConsentSummaryDto>(`/privacy/${entity}/${uuid}/consents`),
  });
  const restricted = summary.data?.processingRestricted ?? false;
  const restrict = useMutation({
    mutationFn: () => apiPost(`/privacy/${entity}/${uuid}/restriction`, { restricted: !restricted }),
    onSuccess: () => {
      toast.success(restricted ? 'Restriction lifted' : 'Processing restricted');
      void qc.invalidateQueries({ queryKey: qk.consents(entity, uuid) });
      void qc.invalidateQueries({ queryKey: ['records'] });
    },
  });
  const erased = (r: ErasureReportDto) => {
    setConfirm(null);
    setCode(null);
    setTyped('');
    setReport(r);
    void qc.invalidateQueries({ queryKey: ['records'] });
  };
  const anonymize = useMutation({
    mutationFn: () => apiPost<ErasureReportDto>(`/privacy/${entity}/${uuid}/anonymize`),
    onSuccess: (r) => {
      toast.success('Personal data erased');
      erased(r);
    },
  });
  const hardDelete = useMutation({
    mutationFn: (confirmCode?: string) =>
      apiDelete<ErasureReportDto>(
        `/privacy/${entity}/${uuid}${confirmCode ? `?confirm=${confirmCode}` : ''}`,
      ),
    onSuccess: (r) => {
      toast.success('Deleted permanently');
      erased(r);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED')
        setCode(err.fieldErrors().confirm ?? null);
    },
  });
  const primary = (t: PrivacyRequestType[]) => (highlight && t.includes(highlight) ? 'primary' : 'secondary');

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button asChild variant={primary(['access', 'portability'])}>
          <a href={buildUrl(`/privacy/${entity}/${uuid}/export`)} download>
            <Download /> Download their data
          </a>
        </Button>
        <Button
          variant={primary(['restriction', 'objection'])}
          loading={restrict.isPending}
          disabled={summary.isPending}
          onClick={() => restrict.mutate()}
        >
          {restricted ? 'Lift restriction' : 'Restrict processing'}
        </Button>
        <Button variant={primary(['erasure'])} onClick={() => setConfirm('anonymize')}>
          Erase personal data
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            setConfirm('delete');
            setCode(null);
            hardDelete.mutate(undefined);
          }}
        >
          Delete permanently
        </Button>
      </div>
      <p className="text-xs text-muted">
        Erasing keeps the record for reports but removes personal details everywhere, including emails, files,
        webhook copies and module data. Records the law requires you to keep, such as invoices, are listed in
        the report.
      </p>
      {confirm ? (
        <Dialog open onOpenChange={(o) => !o && setConfirm(null)}>
          <DialogContent
            title={confirm === 'anonymize' ? 'Erase personal data?' : 'Delete permanently?'}
            description="This cannot be undone."
            footer={
              <>
                <Button onClick={() => setConfirm(null)}>Cancel</Button>
                {confirm === 'anonymize' ? (
                  <Button variant="danger" loading={anonymize.isPending} onClick={() => anonymize.mutate()}>
                    Erase
                  </Button>
                ) : (
                  <Button
                    variant="danger"
                    disabled={!code || typed !== code}
                    loading={hardDelete.isPending}
                    onClick={() => hardDelete.mutate(code!)}
                  >
                    Delete permanently
                  </Button>
                )}
              </>
            }
          >
            {confirm === 'delete' && code ? (
              <label className="flex flex-col gap-1.5 text-sm">
                Type <code className="rounded-sm bg-subtle px-1 font-mono">{code}</code> to confirm
                <Input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className="font-mono"
                  autoFocus
                />
              </label>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
      {report ? (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setReport(null);
              onErased?.();
            }
          }}
        >
          <DialogContent
            title={report.mode === 'delete' ? 'Deleted' : 'Personal data erased'}
            description="Save this report with the request as proof of what was done."
            footer={
              <Button
                variant="primary"
                onClick={() => {
                  setReport(null);
                  onErased?.();
                }}
              >
                Done
              </Button>
            }
          >
            <ErasureReport report={report} />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

const AREA_LABEL: Record<string, string> = {
  files: 'Files',
  activities: 'Activities and notes',
  emailMessages: 'Email copies',
  webhookDeliveries: 'Webhook payloads',
  jobs: 'Background jobs',
  automationRuns: 'Automation logs',
  notifications: 'Notifications',
  consents: 'Consent records',
};

export function ErasureReport({ report }: { report: ErasureReportDto }) {
  const cleared = Object.entries(report.cleared).filter(([, n]) => n > 0);
  return (
    <div className="flex flex-col gap-3 text-sm">
      {cleared.length ? (
        <ul className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
          {cleared.map(([k, n]) => (
            <li key={k} className="contents">
              <span>{AREA_LABEL[k] ?? k.replace('.', ' · ')}</span>
              <span className="text-end tabular">{n}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">No other copies of their data were found.</p>
      )}
      {report.retained.length ? (
        <div>
          <p className="font-medium">Kept</p>
          <ul className="list-disc ps-5 text-muted">
            {report.retained.map((r, i) => (
              <li key={i}>
                {r.area}: {r.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const HOUSEKEEPING_LABEL: Record<string, string> = {
  sessionsDays: 'Ended sessions',
  jobsDays: 'Finished jobs',
  webhookDeliveriesDays: 'Webhook deliveries',
  notificationsDays: 'Read notifications',
  automationRunsDays: 'Automation logs',
  deletedFilesDays: 'Deleted files',
};

interface RetentionPreview {
  rules: {
    rule: { entity: DataSubjectEntity; condition: string; days: number; action: string };
    matches: number;
  }[];
  housekeeping: Record<string, number>;
}

function RetentionPane() {
  const qc = useQueryClient();
  const contact = useEntityConfig('contact');
  const lead = useEntityConfig('lead');
  const q = useQuery({
    queryKey: ['privacy', 'retention'],
    queryFn: () => apiGet<RetentionPreview>('/privacy/retention/preview'),
  });
  const run = useMutation({
    mutationFn: () => apiPost('/privacy/retention/run'),
    onSuccess: () => {
      toast.success('Retention applied');
      void qc.invalidateQueries({ queryKey: ['privacy', 'retention'] });
      void qc.invalidateQueries({ queryKey: ['records'] });
    },
  });
  const pending = q.data
    ? q.data.rules.reduce((n, r) => n + r.matches, 0) +
      Object.values(q.data.housekeeping).reduce((n, v) => n + v, 0)
    : 0;
  return (
    <Pane
      title="Retention"
      actions={
        <Button disabled={!pending} loading={run.isPending} onClick={() => run.mutate()}>
          Run now
        </Button>
      }
    >
      {q.isPending ? (
        <Skeleton className="h-20" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          {q.data.rules.length ? (
            <ul className="flex flex-col gap-1">
              {q.data.rules.map(({ rule, matches }, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span>
                    {rule.action === 'delete' ? 'Delete' : 'Erase'}{' '}
                    {(rule.entity === 'contact' ? contact : lead).plural.toLowerCase()} (
                    {rule.condition.replace('_', ' ')}, {rule.days} days)
                  </span>
                  <span className="tabular">{matches} now</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">No retention rules yet. Add them under Settings → Compliance.</p>
          )}
          <p className="text-xs text-muted">
            Housekeeping due now:{' '}
            {Object.entries(q.data.housekeeping)
              .map(([k, n]) => `${HOUSEKEEPING_LABEL[k] ?? k} ${n}`)
              .join(' · ')}
          </p>
        </div>
      )}
    </Pane>
  );
}
