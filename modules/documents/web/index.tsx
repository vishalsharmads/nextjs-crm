import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  Check,
  Download,
  FilePlus2,
  FileText,
  Pencil,
  Plus,
  Printer,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { WebModule } from '@app/module-sdk';
import { ApiError, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { labelVars } from '@/lib/labels';
import { useBoot, useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Badge, EmptyState, ErrorState, PageHeader, Pane, Skeleton } from '@/components/ui/misc';
import { RecordPicker } from '@/components/fields/pickers';

interface Ref {
  uuid: string;
  name: string;
}
interface Template {
  uuid: string;
  name: string;
  description: string;
  body: string;
  requiresSignature: boolean;
  active: boolean;
}
interface Doc {
  uuid: string;
  number: string;
  title: string;
  status: 'draft' | 'shared' | 'signed' | 'void';
  requiresSignature: boolean;
  contact: Ref | null;
  sharedAt: string | null;
  signedName: string | null;
  signedAt: string | null;
  createdBy: Ref | null;
  createdAt: string;
  bodyHtml?: string;
}
interface FileRequest {
  uuid: string;
  name: string;
  description: string;
  status: 'requested' | 'submitted' | 'approved' | 'rejected' | 'cancelled';
  dueDate: string | null;
  file: { uuid: string; name: string; mime: string; size: number } | null;
  reviewNote: string | null;
  submittedAt: string | null;
  contact?: Ref;
}

const ROOT = '/m/documents';
const API = '/m/documents';
const KEY = ['m', 'documents'] as const;

const DOC_STATUS: Record<Doc['status'], string> = {
  draft: 'Draft',
  shared: 'Shared',
  signed: 'Signed',
  void: 'Void',
};
const REQ_STATUS: Record<FileRequest['status'], string> = {
  requested: 'Waiting for upload',
  submitted: 'To review',
  approved: 'Approved',
  rejected: 'Re-upload requested',
  cancelled: 'Cancelled',
};

function useNouns() {
  const L = labelVars(useBoot().labels);
  return {
    doc: L.document ?? 'Document',
    docs: L.documentPlural ?? 'Documents',
    req: L.documentRequest ?? 'File request',
    reqs: L.documentRequestPlural ?? 'File requests',
    contact: L.contact ?? 'Contact',
  };
}

function DocStatus({ d }: { d: Pick<Doc, 'status' | 'requiresSignature'> }) {
  if (d.status === 'shared' && d.requiresSignature) return <Badge tone="accent">Awaiting signature</Badge>;
  return (
    <Badge tone={d.status === 'signed' ? 'primary' : d.status === 'shared' ? 'outline' : 'neutral'}>
      {DOC_STATUS[d.status]}
    </Badge>
  );
}

async function openFile(uuid: string) {
  const { url } = await apiGet<{ url: string }>(`/files/${uuid}/url`);
  window.open(url, '_blank', 'noopener');
}

// ---------- Generate ----------

function GenerateDialog({ onDone, contact }: { onDone: (uuid?: string) => void; contact?: Ref | null }) {
  const nouns = useNouns();
  const qc = useQueryClient();
  const templates = useQuery({
    queryKey: [...KEY, 'templates'],
    queryFn: () =>
      apiGet<{ data: Template[] }>(`${API}/templates`).then((r) => r.data.filter((t) => t.active)),
  });
  const [templateUuid, setTemplate] = useState('');
  const [who, setWho] = useState<Ref | null>(contact ?? null);
  const create = useMutation({
    mutationFn: () => apiPost<Doc>(`${API}/documents`, { templateUuid, contactUuid: who!.uuid }),
    onSuccess: (d) => {
      toast.success('Draft created');
      void qc.invalidateQueries({ queryKey: KEY });
      onDone(d.uuid);
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title={`New ${nouns.doc.toLowerCase()}`}
        description="Pick a template. Placeholders are filled in from the record; you can edit the draft before sharing it."
        footer={
          <>
            <Button variant="ghost" onClick={() => onDone()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!templateUuid || !who}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Create draft
            </Button>
          </>
        }
      >
        {templates.data && !templates.data.length ? (
          <p className="text-sm text-muted">
            There are no templates yet.{' '}
            <Link
              to={`${ROOT}?tab=templates`}
              className="text-primary hover:underline"
              onClick={() => onDone()}
            >
              Create one first
            </Link>
            .
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <Field label="Template" required>
              {(p) => (
                <NativeSelect {...p} value={templateUuid} onChange={(e) => setTemplate(e.target.value)}>
                  <option value="">Choose…</option>
                  {(templates.data ?? []).map((t) => (
                    <option key={t.uuid} value={t.uuid}>
                      {t.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label={nouns.contact} required>
              {(p) => (
                <RecordPicker
                  {...p}
                  route="contacts"
                  value={who?.uuid ?? null}
                  label={who?.name}
                  onChange={(uuid, name) => setWho(uuid ? { uuid, name: name ?? '' } : null)}
                />
              )}
            </Field>
            {create.error ? (
              <p role="alert" className="text-sm text-accent">
                {create.error.message}
              </p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RequestDialog({ onDone }: { onDone: () => void }) {
  const nouns = useNouns();
  const qc = useQueryClient();
  const [who, setWho] = useState<Ref | null>(null);
  const [items, setItems] = useState([{ name: '', description: '', dueDate: '' }]);
  const create = useMutation({
    mutationFn: () =>
      apiPost(`${API}/requests`, {
        contactUuid: who!.uuid,
        items: items.filter((i) => i.name.trim()).map((i) => ({ ...i, dueDate: i.dueDate || null })),
      }),
    onSuccess: () => {
      toast.success('Requested. They can upload in the client portal.');
      void qc.invalidateQueries({ queryKey: KEY });
      onDone();
    },
  });
  const set = (i: number, patch: Partial<(typeof items)[number]>) =>
    setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title="Request files"
        description="The customer sees the list in the client portal and uploads each file there."
        className="max-w-xl"
        footer={
          <>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!who || !items.some((i) => i.name.trim())}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Send request
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label={nouns.contact} required>
            {(p) => (
              <RecordPicker
                {...p}
                route="contacts"
                value={who?.uuid ?? null}
                label={who?.name}
                onChange={(uuid, name) => setWho(uuid ? { uuid, name: name ?? '' } : null)}
              />
            )}
          </Field>
          {items.map((item, i) => (
            <div
              key={i}
              className="grid gap-2 rounded-md border border-line p-3 sm:grid-cols-[1fr_150px_auto]"
            >
              <Input
                value={item.name}
                onChange={(e) => set(i, { name: e.target.value })}
                placeholder="What do you need? e.g. Passport copy"
                aria-label={`File ${i + 1}`}
              />
              <Input
                type="date"
                value={item.dueDate}
                onChange={(e) => set(i, { dueDate: e.target.value })}
                aria-label={`Due date for file ${i + 1}`}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove file ${i + 1}`}
                disabled={items.length === 1}
                onClick={() => setItems(items.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
              <Input
                value={item.description}
                onChange={(e) => set(i, { description: e.target.value })}
                placeholder="Instructions (optional)"
                aria-label={`Instructions for file ${i + 1}`}
                className="sm:col-span-3"
              />
            </div>
          ))}
          <Button
            type="button"
            className="self-start"
            onClick={() => setItems([...items, { name: '', description: '', dueDate: '' }])}
          >
            <Plus /> Add another
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Tabs ----------

function DocumentsTab() {
  const nouns = useNouns();
  const docs = useQuery({
    queryKey: [...KEY, 'docs'],
    queryFn: () => apiGet<{ data: Doc[] }>(`${API}/documents`, { pageSize: 100 }).then((r) => r.data),
  });
  if (docs.isPending) return <Skeleton className="h-48" />;
  if (docs.isError) return <ErrorState error={docs.error} onRetry={() => void docs.refetch()} />;
  if (!docs.data.length)
    return (
      <EmptyState
        icon={<FileText />}
        title={`No ${nouns.docs.toLowerCase()} yet`}
        description="Generate one from a template."
      />
    );
  return (
    <ul className="divide-y divide-line rounded-md border border-line bg-surface">
      {docs.data.map((d) => (
        <li key={d.uuid}>
          <Link
            to={`${ROOT}/${d.uuid}`}
            className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm hover:bg-hover"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{d.title}</span>
              <span className="text-xs text-muted">
                <span className="font-mono">{d.number}</span> · {d.contact?.name ?? '—'}
              </span>
            </span>
            <DocStatus d={d} />
            <span className="w-28 text-end text-xs text-muted">{formatDate(d.createdAt)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function RequestsTab() {
  const nouns = useNouns();
  const can = useCan();
  const qc = useQueryClient();
  const [status, setStatus] = useState('open');
  const reqs = useQuery({
    queryKey: [...KEY, 'requests', status],
    queryFn: () =>
      apiGet<{ data: FileRequest[] }>(`${API}/requests`, { status: status || undefined }).then((r) => r.data),
  });
  const review = useMutation({
    mutationFn: ({
      r,
      decision,
      note,
    }: {
      r: FileRequest;
      decision: 'approved' | 'rejected';
      note?: string;
    }) => apiPost(`${API}/requests/${r.uuid}/review`, { decision, note: note ?? null }),
    onSuccess: (_d, v) => {
      toast.success(v.decision === 'approved' ? 'Approved' : 'Re-upload requested');
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const cancel = useMutation({
    mutationFn: (r: FileRequest) => apiPost(`${API}/requests/${r.uuid}/cancel`),
    onSuccess: () => {
      toast.success('Cancelled');
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  return (
    <div className="flex flex-col gap-3">
      <NativeSelect
        value={status}
        onChange={(e) => setStatus(e.target.value)}
        aria-label="Show"
        className="w-48"
      >
        <option value="open">Open</option>
        <option value="submitted">To review</option>
        <option value="approved">Approved</option>
        <option value="">All</option>
      </NativeSelect>
      {reqs.isPending ? (
        <Skeleton className="h-48" />
      ) : reqs.isError ? (
        <ErrorState error={reqs.error} />
      ) : !reqs.data.length ? (
        <EmptyState icon={<FilePlus2 />} title={`No ${nouns.reqs.toLowerCase()} here`} />
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line bg-surface">
          {reqs.data.map((r) => (
            <li key={r.uuid} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{r.name}</span>
                <span className="text-xs text-muted">
                  {r.contact ? (
                    <Link to={`/contacts/${r.contact.uuid}`} className="hover:underline">
                      {r.contact.name}
                    </Link>
                  ) : null}
                  {r.dueDate ? ` · due ${formatDate(r.dueDate)}` : ''}
                  {r.reviewNote ? ` · “${r.reviewNote}”` : ''}
                </span>
              </span>
              <Badge
                tone={r.status === 'submitted' ? 'accent' : r.status === 'approved' ? 'primary' : 'neutral'}
              >
                {REQ_STATUS[r.status]}
              </Badge>
              {r.file ? (
                <Button size="sm" variant="ghost" onClick={() => void openFile(r.file!.uuid)}>
                  <Download /> {r.file.name}
                </Button>
              ) : null}
              {r.status === 'submitted' && can('documents.documents.update') ? (
                <>
                  <Button
                    size="sm"
                    onClick={() => {
                      const note = window.prompt('What should they fix? (shown to the customer)');
                      if (note !== null) review.mutate({ r, decision: 'rejected', note });
                    }}
                  >
                    <X /> Reject
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => review.mutate({ r, decision: 'approved' })}
                  >
                    <Check /> Approve
                  </Button>
                </>
              ) : null}
              {(r.status === 'requested' || r.status === 'rejected') && can('documents.documents.delete') ? (
                <Button size="sm" variant="ghost" onClick={() => cancel.mutate(r)}>
                  Cancel
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const PLACEHOLDERS = [
  '{{contact.firstName}}',
  '{{contact.fullName}}',
  '{{contact.email}}',
  '{{contact.custom.<field>}}',
  '{{organization.name}}',
  '{{business.name}}',
  '{{business.address}}',
  '{{user.name}}',
  '{{today}}',
];

function TemplateDialog({ template, onDone }: { template: Template | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({
    name: template?.name ?? '',
    description: template?.description ?? '',
    body:
      template?.body ??
      '<h1>Title</h1>\n<p>Dear {{contact.firstName}},</p>\n<p></p>\n<p>{{user.name}}<br>{{business.name}}</p>',
    requiresSignature: template?.requiresSignature ?? false,
  });
  const save = useMutation({
    mutationFn: () =>
      template ? apiPatch(`${API}/templates/${template.uuid}`, v) : apiPost(`${API}/templates`, v),
    onSuccess: () => {
      toast.success('Template saved');
      void qc.invalidateQueries({ queryKey: KEY });
      onDone();
    },
  });
  const errors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title={template ? `Edit ${template.name}` : 'New template'}
        className="max-w-3xl"
        footer={
          <>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!v.name.trim() || !v.body.trim()}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save template
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Name" required error={errors.name}>
            {(p) => <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />}
          </Field>
          <Field
            label="Content"
            required
            error={errors.body}
            help="HTML with placeholders. Scripts and styles are removed."
          >
            {(p) => (
              <Textarea
                {...p}
                rows={14}
                value={v.body}
                onChange={(e) => setV({ ...v, body: e.target.value })}
                className="font-mono text-xs"
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-1">
            {PLACEHOLDERS.map((ph) => (
              <button
                key={ph}
                type="button"
                className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-2xs text-muted hover:bg-hover"
                onClick={() => setV({ ...v, body: `${v.body}${ph}` })}
              >
                {ph}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={v.requiresSignature}
              onChange={(e) => setV({ ...v, requiresSignature: e.target.checked })}
              className="size-4 accent-primary"
            />
            The customer signs this in the client portal
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TemplatesTab() {
  const can = useCan();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const templates = useQuery({
    queryKey: [...KEY, 'templates', 'all'],
    queryFn: () => apiGet<{ data: Template[] }>(`${API}/templates`).then((r) => r.data),
  });
  const toggle = useMutation({
    mutationFn: (t: Template) => apiPatch(`${API}/templates/${t.uuid}`, { active: !t.active }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
  const manage = can('documents.templates.manage');
  return (
    <div className="flex flex-col gap-3">
      {manage ? (
        <Button className="self-start" onClick={() => setEditing('new')}>
          <Plus /> New template
        </Button>
      ) : null}
      {templates.isPending ? (
        <Skeleton className="h-32" />
      ) : !templates.data?.length ? (
        <EmptyState
          icon={<FileText />}
          title="No templates yet"
          description="Welcome letters, agreements, checklists: write them once, fill them in for each customer."
        />
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line bg-surface">
          {templates.data.map((t) => (
            <li key={t.uuid} className="flex items-center gap-3 px-4 py-3 text-sm">
              <button
                type="button"
                disabled={!manage}
                className="min-w-0 flex-1 text-start"
                onClick={() => setEditing(t)}
              >
                <span className="font-medium hover:underline">{t.name}</span>
                {t.requiresSignature ? <Badge className="ms-2">Needs signature</Badge> : null}
                {!t.active ? <Badge className="ms-2">Archived</Badge> : null}
              </button>
              {manage ? (
                <Button size="sm" variant="ghost" onClick={() => toggle.mutate(t)}>
                  {t.active ? 'Archive' : 'Restore'}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <TemplateDialog
          key={editing === 'new' ? 'new' : editing.uuid}
          template={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

const TABS = [
  ['documents', 'Documents'],
  ['requests', 'File requests'],
  ['templates', 'Templates'],
] as const;

function DocumentsHome() {
  const can = useCan();
  const nav = useNavigate();
  const nouns = useNouns();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'documents';
  const [dialog, setDialog] = useState<'doc' | 'req' | null>(null);
  const create = can('documents.documents.create');
  return (
    <div>
      <PageHeader
        title={nouns.docs}
        actions={
          create ? (
            <>
              <Button onClick={() => setDialog('req')}>
                <FilePlus2 /> Request files
              </Button>
              <Button variant="primary" onClick={() => setDialog('doc')}>
                <Plus /> New {nouns.doc.toLowerCase()}
              </Button>
            </>
          ) : null
        }
      >
        <nav className="-mb-px flex gap-1" aria-label="Sections">
          {TABS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setParams(k === 'documents' ? {} : { tab: k })}
              aria-current={tab === k ? 'page' : undefined}
              className="border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-ink aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-ink"
            >
              {label}
            </button>
          ))}
        </nav>
      </PageHeader>
      <div className="mx-auto max-w-5xl p-4 md:p-6">
        {tab === 'documents' ? <DocumentsTab /> : tab === 'requests' ? <RequestsTab /> : <TemplatesTab />}
      </div>
      {dialog === 'doc' ? (
        <GenerateDialog onDone={(uuid) => (setDialog(null), uuid && nav(`${ROOT}/${uuid}`))} />
      ) : null}
      {dialog === 'req' ? <RequestDialog onDone={() => setDialog(null)} /> : null}
    </div>
  );
}

// ---------- One document ----------

function DocumentPage() {
  const { uuid = '' } = useParams();
  const can = useCan();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: '', bodyHtml: '' });
  const doc = useQuery({
    queryKey: [...KEY, 'doc', uuid],
    queryFn: () => apiGet<Doc>(`${API}/documents/${uuid}`),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const save = useMutation({
    mutationFn: () => apiPatch(`${API}/documents/${uuid}`, draft),
    onSuccess: () => {
      toast.success('Saved');
      setEditing(false);
      refresh();
    },
  });
  const share = useMutation({
    mutationFn: () => apiPost(`${API}/documents/${uuid}/share`),
    onSuccess: () => {
      toast.success('Shared in the client portal');
      refresh();
    },
  });
  const voidIt = useMutation({
    mutationFn: () => apiPost(`${API}/documents/${uuid}/void`),
    onSuccess: () => {
      toast.success('Voided');
      refresh();
    },
  });
  if (doc.isPending)
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Skeleton className="h-96" />
      </div>
    );
  if (doc.isError) return <ErrorState error={doc.error} onRetry={() => void doc.refetch()} />;
  const d = doc.data;
  const update = can('documents.documents.update');
  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {d.title} <DocStatus d={d} />
          </span>
        }
        description={
          <span>
            <span className="font-mono">{d.number}</span>
            {d.contact ? (
              <>
                {' · '}
                <Link to={`/contacts/${d.contact.uuid}`} className="text-primary hover:underline">
                  {d.contact.name}
                </Link>
              </>
            ) : null}
          </span>
        }
        actions={
          <>
            {update && d.status === 'draft' && !editing ? (
              <>
                <Button
                  onClick={() => (setDraft({ title: d.title, bodyHtml: d.bodyHtml ?? '' }), setEditing(true))}
                >
                  <Pencil /> Edit
                </Button>
                <Button variant="primary" loading={share.isPending} onClick={() => share.mutate()}>
                  <Send /> Share with customer
                </Button>
              </>
            ) : null}
            <Button variant="ghost" onClick={() => window.print()}>
              <Printer /> Print
            </Button>
            {can('documents.documents.delete') && d.status !== 'void' && d.status !== 'signed' ? (
              <Button
                variant="ghost"
                onClick={() => {
                  if (window.confirm('Void this document? The customer will no longer see it.'))
                    voidIt.mutate();
                }}
              >
                <Ban /> Void
              </Button>
            ) : null}
          </>
        }
      />
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 md:p-6 print:p-0">
        {d.status === 'signed' ? (
          <p className="rounded-md border border-line bg-primary-soft px-4 py-2 text-sm print:hidden">
            Signed by {d.signedName} on {formatDateTime(d.signedAt)}.
          </p>
        ) : d.status === 'shared' ? (
          <p className="rounded-md border border-line bg-subtle px-4 py-2 text-sm print:hidden">
            Shared in the client portal {formatDateTime(d.sharedAt)}
            {d.requiresSignature ? '. Waiting for the customer to sign.' : '.'}
          </p>
        ) : null}
        {editing ? (
          <Pane title="Edit draft">
            <div className="flex flex-col gap-3">
              <Field label="Title">
                {(p) => (
                  <Input
                    {...p}
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Content (HTML)">
                {(p) => (
                  <Textarea
                    {...p}
                    rows={16}
                    value={draft.bodyHtml}
                    onChange={(e) => setDraft({ ...draft, bodyHtml: e.target.value })}
                    className="font-mono text-xs"
                  />
                )}
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                  Save draft
                </Button>
              </div>
            </div>
          </Pane>
        ) : (
          <DocumentBody html={d.bodyHtml ?? ''} signedName={d.signedName} signedAt={d.signedAt} />
        )}
      </div>
    </div>
  );
}

/** Content is sanitized on the server (allow-listed tags, no scripts, styles or handlers). */
export function DocumentBody({
  html,
  signedName,
  signedAt,
}: {
  html: string;
  signedName?: string | null;
  signedAt?: string | null;
}) {
  return (
    <article className="rounded-md border border-line bg-surface p-6 md:p-10 print:border-0 print:p-0">
      <div
        className="text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_h1]:mb-4 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-semibold [&_li]:ms-5 [&_ol]:my-2 [&_ol]:list-decimal [&_p]:my-2 [&_table]:my-3 [&_table]:w-full [&_td]:border [&_td]:border-line [&_td]:p-1.5 [&_th]:border [&_th]:border-line [&_th]:p-1.5 [&_th]:text-start [&_ul]:my-2 [&_ul]:list-disc"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {signedName ? (
        <div className="mt-10 border-t border-line pt-4 text-sm">
          <p className="text-xs tracking-wide text-muted uppercase">Signed</p>
          <p className="mt-1 text-lg italic">{signedName}</p>
          <p className="text-xs text-muted">{formatDateTime(signedAt)}</p>
        </div>
      ) : null}
    </article>
  );
}

function AwaitingWidget({ data }: { data: unknown }) {
  const d = data as { toReview: number; awaitingSignature: number; outstanding: number };
  const stats: [string, number, string][] = [
    ['Files to review', d.toReview, '?tab=requests'],
    ['Awaiting signature', d.awaitingSignature, ''],
    ['Files not yet sent', d.outstanding, '?tab=requests'],
  ];
  return (
    <dl className="grid flex-1 grid-cols-3 gap-3">
      {stats.map(([label, n, to]) => (
        <Link key={label} to={`${ROOT}${to}`} className="rounded-md p-1 hover:bg-hover">
          <dt className="text-xs text-muted">{label}</dt>
          <dd className="text-2xl font-semibold tracking-tight tabular-nums">{n}</dd>
        </Link>
      ))}
    </dl>
  );
}

const documentsModule: WebModule = {
  key: 'documents',
  routes: [
    { path: '', element: <DocumentsHome /> },
    { path: ':uuid', element: <DocumentPage /> },
  ],
  widgets: { 'documents.awaiting': (p) => <AwaitingWidget data={p.data} /> },
};

export default documentsModule;
