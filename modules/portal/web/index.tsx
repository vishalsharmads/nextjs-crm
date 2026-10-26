import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  FileText,
  KeyRound,
  LifeBuoy,
  LogOut,
  Mail,
  Plus,
  Printer,
  Receipt,
  UserPlus,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { CommerceSettings } from '@app/shared';
import type { WebModule } from '@app/module-sdk';
import { ApiError, api, apiGet, apiPatch, apiPost, type RequestOptions } from '@/lib/api';
import { appUrl } from '@/lib/app-url';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { labelVars } from '@/lib/labels';
import { useBranding } from '@/app/branding';
import { useBoot } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Badge, EmptyState, ErrorState, PageHeader, Pane, Skeleton } from '@/components/ui/misc';
import { RecordPicker } from '@/components/fields/pickers';
import { DocumentPaper, type RecordRef } from '@/components/commerce/document-paper';
import { DocumentBody } from '../../documents/web';
import type { LineDto } from '@/components/commerce/line-items';

// ======================= Staff: manage access =======================

interface Account {
  uuid: string;
  email: string;
  status: 'active' | 'disabled';
  organizationAccess: boolean;
  contact: { uuid: string; name: string };
  invitedAt: string | null;
  lastLoginAt: string | null;
}

const ACCOUNTS = '/m/portal/accounts';
const KEY = ['m', 'portal'] as const;

function InviteDialog({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const L = labelVars(useBoot().labels);
  const [contact, setContact] = useState<RecordRef | null>(null);
  const [orgAccess, setOrgAccess] = useState(false);
  const invite = useMutation({
    mutationFn: () => apiPost(ACCOUNTS, { contactUuid: contact!.uuid, organizationAccess: orgAccess }),
    onSuccess: () => {
      toast.success('Invitation sent');
      void qc.invalidateQueries({ queryKey: KEY });
      onDone();
    },
  });
  const errors = invite.error instanceof ApiError ? invite.error.fieldErrors() : {};
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title="Invite to the portal"
        description="They get an email with a sign-in link. No password to remember."
        footer={
          <>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!contact}
              loading={invite.isPending}
              onClick={() => invite.mutate()}
            >
              Send invitation
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label={L.contact} required error={errors.contactUuid}>
            {(p) => (
              <RecordPicker
                {...p}
                route="contacts"
                value={contact?.uuid ?? null}
                label={contact?.name}
                onChange={(uuid, name) => setContact(uuid ? { uuid, name: name ?? '' } : null)}
              />
            )}
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={orgAccess}
              onChange={(e) => setOrgAccess(e.target.checked)}
              className="mt-0.5 size-4 accent-primary"
            />
            <span>
              Also show documents for their {L.organizationPluralLower}
              <span className="block text-xs text-muted">
                Use for billing contacts. Otherwise they only see documents addressed to them.
              </span>
            </span>
          </label>
          {invite.error && !Object.keys(errors).length ? (
            <p role="alert" className="text-sm text-accent">
              {invite.error.message}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AccountsPage() {
  const qc = useQueryClient();
  const L = labelVars(useBoot().labels);
  const [inviting, setInviting] = useState(false);
  const list = useQuery({
    queryKey: KEY,
    queryFn: () => apiGet<{ data: Account[] }>(ACCOUNTS).then((r) => r.data),
  });
  const update = useMutation({
    mutationFn: ({
      a,
      patch,
    }: {
      a: Account;
      patch: Partial<Pick<Account, 'status' | 'organizationAccess'>>;
    }) => apiPatch(`${ACCOUNTS}/${a.uuid}`, patch),
    onSuccess: (_d, { patch }) => {
      toast.success(
        patch.status === 'disabled' ? 'Access removed' : patch.status ? 'Access restored' : 'Saved',
      );
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const resend = useMutation({
    mutationFn: (a: Account) => apiPost(`${ACCOUNTS}/${a.uuid}/invite`),
    onSuccess: () => toast.success('Invitation sent'),
  });
  const inviteButton = (
    <Button variant="primary" onClick={() => setInviting(true)}>
      <UserPlus /> Invite
    </Button>
  );
  return (
    <div>
      <PageHeader
        title="Client portal"
        description={
          <>
            Customers sign in at <span className="font-mono text-xs">{appUrl('/p/portal')}</span> to see their
            quotes, invoices and contracts.
          </>
        }
        actions={inviteButton}
      />
      <div className="mx-auto max-w-5xl p-4 md:p-6">
        {list.isPending ? (
          <Skeleton className="h-48" />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.data.length ? (
          <EmptyState
            icon={<KeyRound />}
            title="Nobody has portal access yet"
            description="Invite a customer to let them view documents and accept quotes online."
            action={inviteButton}
          />
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-surface">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-line bg-subtle text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 text-start font-medium">{L.contact}</th>
                  <th className="px-4 py-2 text-start font-medium">Sees</th>
                  <th className="px-4 py-2 text-start font-medium">Last sign-in</th>
                  <th className="w-56" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {list.data.map((a) => (
                  <tr key={a.uuid} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5">
                      <Link to={`/contacts/${a.contact.uuid}`} className="font-medium hover:underline">
                        {a.contact.name}
                      </Link>
                      {a.status === 'disabled' ? <Badge className="ms-2">No access</Badge> : null}
                      <p className="text-xs text-muted">{a.email}</p>
                    </td>
                    <td className="px-4 py-2.5">
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={a.organizationAccess}
                          disabled={a.status === 'disabled'}
                          onChange={(e) =>
                            update.mutate({ a, patch: { organizationAccess: e.target.checked } })
                          }
                          className="size-4 accent-primary"
                        />
                        Their {L.organizationLower}&apos;s documents too
                      </label>
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {a.lastLoginAt ? formatDateTime(a.lastLoginAt) : 'Never'}
                    </td>
                    <td className="px-4 py-2.5 text-end">
                      {a.status === 'active' ? (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => resend.mutate(a)}>
                            <Mail /> Resend
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Remove portal access for ${a.contact.name}? They are signed out now.`,
                                )
                              )
                                update.mutate({ a, patch: { status: 'disabled' } });
                            }}
                          >
                            Remove access
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => update.mutate({ a, patch: { status: 'active' } })}
                        >
                          Restore access
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {inviting ? <InviteDialog onDone={() => setInviting(false)} /> : null}
    </div>
  );
}

// ======================= Customer pages (/p/portal) =======================

const P = '/public/portal';
const ROOT = '/p/portal';

/** Portal calls never touch the staff session (no refresh on 401). */
const portalApi = <T,>(path: string, opts: RequestOptions = {}) => api<T>(path, { ...opts, noRetry: true });

interface Me {
  name: string;
  firstName: string;
  email: string;
  business: Pick<CommerceSettings, 'legalName' | 'address' | 'taxId' | 'email' | 'phone'> & { name: string };
  features: { quotes: boolean; invoices: boolean; contracts: boolean; tickets: boolean; documents: boolean };
}

interface CustomerQuote {
  uuid: string;
  number: string;
  title: string;
  status: 'sent' | 'accepted' | 'declined' | 'expired';
  issueDate: string;
  validUntil: string | null;
  currency: string;
  total: number;
  organization: RecordRef | null;
  contact: RecordRef | null;
  acceptedByName: string | null;
  respondedAt: string | null;
  notes: string | null;
  terms: string | null;
  lines?: LineDto[];
}

interface CustomerInvoice {
  uuid: string;
  number: string;
  title: string;
  status: 'issued' | 'partially_paid' | 'paid' | 'void';
  overdue: boolean;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  total: number;
  amountPaid: number;
  balanceDue: number;
  organization: RecordRef | null;
  contact: RecordRef | null;
  notes: string | null;
  terms: string | null;
  paymentInstructions: string | null;
  lines?: LineDto[];
}

interface CustomerContract {
  uuid: string;
  number: string;
  title: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  value: number;
  currency: string;
  billingCycle: string;
  autoRenew: boolean;
}

const unauthenticated = (e: unknown) => e instanceof ApiError && e.status === 401;

function useMe() {
  return useQuery({
    queryKey: ['portal', 'me'],
    queryFn: () => portalApi<Me>(`${P}/me`),
    retry: (n, e) => !unauthenticated(e) && n < 2,
  });
}

function PortalFrame({ me, children }: { me?: Me; children: ReactNode }) {
  const { branding } = useBranding();
  const nav = useNavigate();
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => portalApi(`${P}/logout`, { method: 'POST' }),
    onSettled: () => {
      qc.removeQueries({ queryKey: ['portal'] });
      nav(`${ROOT}/login`, { replace: true });
    },
  });
  const logo = branding.assets.logoLight;
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="border-b border-line bg-surface print:hidden">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
          <Link to={ROOT} className="flex min-w-0 items-center gap-2 font-semibold">
            {logo ? <img src={logo} alt="" className="h-7 w-auto" /> : null}
            <span className="truncate">{me?.business.name ?? branding.appName}</span>
          </Link>
          {me ? (
            <div className="ms-auto flex items-center gap-2">
              <span className="hidden text-sm text-muted sm:inline">{me.email}</span>
              <Button variant="ghost" size="sm" onClick={() => logout.mutate()} loading={logout.isPending}>
                <LogOut /> Sign out
              </Button>
            </div>
          ) : null}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6 print:max-w-none print:p-0">{children}</main>
    </div>
  );
}

/** Wraps signed-in customer pages: redirects to sign-in when there is no portal session. */
function Authed({ children }: { children: (me: Me) => ReactNode }) {
  const me = useMe();
  if (me.isPending)
    return (
      <PortalFrame>
        <Skeleton className="h-64" />
      </PortalFrame>
    );
  if (me.isError)
    return unauthenticated(me.error) ? (
      <Navigate to={`${ROOT}/login`} replace />
    ) : (
      <PortalFrame>
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </PortalFrame>
    );
  return <PortalFrame me={me.data}>{children(me.data)}</PortalFrame>;
}

function LoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const login = useMutation({
    mutationFn: () => portalApi(`${P}/login`, { method: 'POST', body: { email } }),
    onSuccess: () => setSent(true),
  });
  return (
    <PortalFrame>
      <div className="mx-auto mt-10 max-w-sm rounded-lg border border-line bg-surface p-6">
        {sent ? (
          <div className="flex flex-col items-center gap-2 text-center" role="status">
            <Mail className="size-8 text-primary" />
            <h1 className="text-lg font-semibold">Check your email</h1>
            <p className="text-sm text-muted">
              If {email} has access, a sign-in link is on its way. It works for 15 minutes.
            </p>
            <Button variant="link" onClick={() => setSent(false)}>
              Use a different email
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate();
            }}
          >
            <div>
              <h1 className="text-lg font-semibold">Sign in</h1>
              <p className="mt-1 text-sm text-muted">We will email you a link. No password needed.</p>
            </div>
            <Field
              label="Email"
              error={login.error instanceof ApiError ? login.error.fieldErrors().email : undefined}
            >
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-10"
                  autoFocus
                />
              )}
            </Field>
            {login.error && !(login.error instanceof ApiError && login.error.code === 'VALIDATION_FAILED') ? (
              <p role="alert" className="text-sm text-accent">
                {login.error.message}
              </p>
            ) : null}
            <Button type="submit" variant="primary" size="lg" loading={login.isPending} disabled={!email}>
              Email me a sign-in link
            </Button>
          </form>
        )}
      </div>
    </PortalFrame>
  );
}

function VerifyPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const token = params.get('token') ?? '';
  const started = useRef(false);
  const verify = useMutation({
    mutationFn: () => portalApi(`${P}/session`, { method: 'POST', body: { token } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['portal'] });
      nav(ROOT, { replace: true });
    },
  });
  useEffect(() => {
    // One-time tokens: never send twice (React strict mode runs effects twice in development).
    if (started.current || !token) return;
    started.current = true;
    verify.mutate();
  }, [token, verify]);
  return (
    <PortalFrame>
      <div className="mx-auto mt-10 max-w-sm rounded-lg border border-line bg-surface p-6 text-center">
        {verify.isError || !token ? (
          <>
            <h1 className="text-lg font-semibold">This link no longer works</h1>
            <p className="mt-1 text-sm text-muted">
              {verify.error?.message ?? 'The link is incomplete.'} Links work once and expire after a while.
            </p>
            <Button className="mt-4" variant="primary" asChild>
              <Link to={`${ROOT}/login`}>Get a new link</Link>
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted" role="status">
            Signing you in…
          </p>
        )}
      </div>
    </PortalFrame>
  );
}

const QUOTE_STATUS: Record<CustomerQuote['status'], string> = {
  sent: 'Awaiting your answer',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
};

function invoiceBadge(i: CustomerInvoice) {
  if (i.overdue) return <Badge tone="accent">Overdue</Badge>;
  if (i.status === 'paid') return <Badge tone="primary">Paid</Badge>;
  if (i.status === 'void') return <Badge>Void</Badge>;
  if (i.status === 'partially_paid') return <Badge tone="outline">Partly paid</Badge>;
  return <Badge tone="outline">Due {formatDate(i.dueDate)}</Badge>;
}

function HomePage() {
  return (
    <Authed>
      {(me) => (
        <div className="flex flex-col gap-6">
          <Documents me={me} />
          {me.features.documents ? <LibrarySection /> : null}
          {me.features.tickets ? <SupportSection /> : null}
        </div>
      )}
    </Authed>
  );
}

// ---------- Documents and file requests ----------

interface LibraryDoc {
  uuid: string;
  number: string;
  title: string;
  status: 'shared' | 'signed';
  requiresSignature: boolean;
  sharedAt: string | null;
  signedName: string | null;
  signedAt: string | null;
  bodyHtml?: string;
}
interface LibraryRequest {
  uuid: string;
  name: string;
  description: string;
  status: 'requested' | 'submitted' | 'approved' | 'rejected';
  dueDate: string | null;
  reviewNote: string | null;
  fileName: string | null;
}

const REQUEST_STATUS: Record<LibraryRequest['status'], string> = {
  requested: 'Needed',
  submitted: 'Received, being checked',
  approved: 'Accepted',
  rejected: 'Please upload again',
};

function UploadButton({ request }: { request: LibraryRequest }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return portalApi(`${P}/requests/${request.uuid}/upload`, { method: 'POST', body: form });
    },
    onSuccess: () => {
      toast.success('Uploaded. Thank you.');
      void qc.invalidateQueries({ queryKey: ['portal', 'library'] });
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <>
      <input
        ref={input}
        type="file"
        className="sr-only"
        aria-label={`Upload ${request.name}`}
        accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload.mutate(f);
          e.target.value = '';
        }}
      />
      <Button size="sm" variant="primary" loading={upload.isPending} onClick={() => input.current?.click()}>
        Upload
      </Button>
    </>
  );
}

function LibrarySection() {
  const lib = useQuery({
    queryKey: ['portal', 'library'],
    queryFn: () => portalApi<{ documents: LibraryDoc[]; requests: LibraryRequest[] }>(`${P}/library`),
  });
  if (lib.isPending) return <Skeleton className="h-24" />;
  if (lib.isError || (!lib.data.documents.length && !lib.data.requests.length)) return null;
  const { documents, requests } = lib.data;
  return (
    <>
      {requests.length ? (
        <Pane
          title={
            <span className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:text-faint">
              <Mail /> Files we need from you
            </span>
          }
          padded={false}
        >
          <ul className="divide-y divide-line">
            {requests.map((r) => (
              <li key={r.uuid} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{r.name}</span>
                  <span className="text-xs text-muted">
                    {r.description}
                    {r.dueDate ? ` · by ${formatDate(r.dueDate)}` : ''}
                    {r.fileName ? ` · ${r.fileName}` : ''}
                  </span>
                  {r.status === 'rejected' && r.reviewNote ? (
                    <span className="block text-xs text-accent">{r.reviewNote}</span>
                  ) : null}
                </span>
                <Badge
                  tone={r.status === 'approved' ? 'primary' : r.status === 'rejected' ? 'accent' : 'neutral'}
                >
                  {REQUEST_STATUS[r.status]}
                </Badge>
                {r.status === 'requested' || r.status === 'rejected' ? <UploadButton request={r} /> : null}
              </li>
            ))}
          </ul>
        </Pane>
      ) : null}
      {documents.length ? (
        <DocList title="Documents" icon={<FileText />}>
          {documents.map((d) => (
            <DocRow
              key={d.uuid}
              to={`${ROOT}/docs/${d.uuid}`}
              number={d.number}
              title={d.title}
              badge={
                d.status === 'signed' ? (
                  <Badge tone="primary">Signed</Badge>
                ) : d.requiresSignature ? (
                  <Badge tone="accent">Please sign</Badge>
                ) : (
                  <Badge>Shared</Badge>
                )
              }
              amount=""
              date={formatDate(d.sharedAt)}
            />
          ))}
        </DocList>
      ) : null}
    </>
  );
}

function DocPage() {
  return <Authed>{(me) => <DocView me={me} />}</Authed>;
}

function DocView({ me }: { me: Me }) {
  const { uuid = '' } = useParams();
  const qc = useQueryClient();
  const [name, setName] = useState(me.name);
  const [agree, setAgree] = useState(false);
  const doc = useQuery({
    queryKey: ['portal', 'doc', uuid],
    queryFn: () => portalApi<LibraryDoc>(`${P}/docs/${uuid}`),
  });
  const sign = useMutation({
    mutationFn: () => portalApi(`${P}/docs/${uuid}/sign`, { method: 'POST', body: { name, agree: true } }),
    onSuccess: () => {
      toast.success('Signed. Thank you.');
      void qc.invalidateQueries({ queryKey: ['portal'] });
    },
  });
  if (doc.isPending) return <Skeleton className="h-96" />;
  if (doc.isError) return <ErrorState error={doc.error} />;
  const d = doc.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 print:hidden">
        <Link to={ROOT} className="text-sm text-primary hover:underline">
          ← All documents
        </Link>
        <Button className="ms-auto" variant="ghost" onClick={() => window.print()}>
          <Printer /> Print or save as PDF
        </Button>
      </div>
      <DocumentBody html={d.bodyHtml ?? ''} signedName={d.signedName} signedAt={d.signedAt} />
      {d.status === 'shared' && d.requiresSignature ? (
        <Pane title="Sign this document" className="print:hidden">
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              sign.mutate();
            }}
          >
            <Field label="Type your full name" required>
              {(p) => (
                <Input {...p} value={name} onChange={(e) => setName(e.target.value)} className="max-w-sm" />
              )}
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={agree}
                onChange={(e) => setAgree(e.target.checked)}
                className="mt-0.5 size-4 accent-primary"
              />
              I have read this document and agree to it. Typing my name counts as my signature.
            </label>
            {sign.error ? (
              <p role="alert" className="text-sm text-accent">
                {sign.error.message}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              className="self-start"
              disabled={!agree || name.trim().length < 2}
              loading={sign.isPending}
            >
              Sign document
            </Button>
          </form>
        </Pane>
      ) : null}
    </div>
  );
}

// ---------- Support tickets ----------

interface CustomerTicket {
  uuid: string;
  number: string;
  subject: string;
  status: 'open' | 'pending' | 'resolved' | 'closed';
  createdAt: string;
  lastActivityAt: string;
  description?: string | null;
  comments?: {
    uuid: string;
    body: string;
    fromCustomer: boolean;
    author: { name: string } | null;
    createdAt: string;
  }[];
}

const TICKET_STATUS: Record<CustomerTicket['status'], string> = {
  open: 'With our team',
  pending: 'Waiting for you',
  resolved: 'Resolved',
  closed: 'Closed',
};

function SupportSection() {
  const tickets = useQuery({
    queryKey: ['portal', 'tickets'],
    queryFn: () => portalApi<{ data: CustomerTicket[] }>(`${P}/tickets`).then((r) => r.data),
  });
  return (
    <Pane
      title={
        <span className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:text-faint">
          <LifeBuoy /> Support
        </span>
      }
      actions={
        <Button size="sm" variant="primary" asChild>
          <Link to={`${ROOT}/support/new`}>
            <Plus /> New request
          </Link>
        </Button>
      }
      padded={!tickets.data?.length}
    >
      {tickets.isPending ? (
        <Skeleton className="h-16" />
      ) : !tickets.data?.length ? (
        <p className="text-sm text-muted">
          Need something? Send us a request and we will reply here and by email.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {tickets.data.map((t) => (
            <li key={t.uuid}>
              <Link
                to={`${ROOT}/support/${t.uuid}`}
                className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm hover:bg-hover"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{t.subject}</span>
                  <span className="font-mono text-xs text-muted">{t.number}</span>
                </span>
                <Badge tone={t.status === 'pending' ? 'accent' : t.status === 'open' ? 'outline' : 'neutral'}>
                  {TICKET_STATUS[t.status]}
                </Badge>
                <span className="w-40 text-end text-xs text-muted">{formatDateTime(t.lastActivityAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Pane>
  );
}

function NewTicketPage() {
  return <Authed>{() => <NewTicket />}</Authed>;
}

function NewTicket() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () =>
      portalApi<CustomerTicket>(`${P}/tickets`, { method: 'POST', body: { subject, description } }),
    onSuccess: (t) => {
      toast.success('Request sent. We will get back to you soon.');
      void qc.invalidateQueries({ queryKey: ['portal', 'tickets'] });
      nav(`${ROOT}/support/${t.uuid}`, { replace: true });
    },
  });
  const errors = create.error instanceof ApiError ? create.error.fieldErrors() : {};
  return (
    <form
      className="mx-auto flex max-w-2xl flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <Link to={ROOT} className="text-sm text-primary hover:underline">
        ← Back
      </Link>
      <h1 className="text-xl font-semibold tracking-tight">New support request</h1>
      <Field label="What is it about?" required error={errors.subject}>
        {(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} autoFocus />}
      </Field>
      <Field label="Details" required error={errors.description}>
        {(p) => (
          <Textarea {...p} rows={6} value={description} onChange={(e) => setDescription(e.target.value)} />
        )}
      </Field>
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          loading={create.isPending}
          disabled={subject.trim().length < 3 || !description.trim()}
        >
          Send request
        </Button>
      </div>
    </form>
  );
}

function TicketPage() {
  return <Authed>{() => <TicketThread />}</Authed>;
}

function TicketThread() {
  const { uuid = '' } = useParams();
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const ticket = useQuery({
    queryKey: ['portal', 'ticket', uuid],
    queryFn: () => portalApi<CustomerTicket>(`${P}/tickets/${uuid}`),
  });
  const reply = useMutation({
    mutationFn: () => portalApi(`${P}/tickets/${uuid}/replies`, { method: 'POST', body: { body } }),
    onSuccess: () => {
      toast.success('Reply sent');
      setBody('');
      void qc.invalidateQueries({ queryKey: ['portal'] });
    },
  });
  if (ticket.isPending) return <Skeleton className="h-64" />;
  if (ticket.isError) return <ErrorState error={ticket.error} />;
  const t = ticket.data;
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <Link to={ROOT} className="text-sm text-primary hover:underline">
        ← Back
      </Link>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t.subject}</h1>
        <p className="text-sm text-muted">
          <span className="font-mono">{t.number}</span> · {TICKET_STATUS[t.status]}
        </p>
      </div>
      <ol className="flex flex-col gap-3">
        {t.description ? (
          <li className="rounded-md border border-line bg-surface p-3">
            <p className="mb-1 text-xs text-muted">You · {formatDateTime(t.createdAt)}</p>
            <p className="text-sm whitespace-pre-wrap">{t.description}</p>
          </li>
        ) : null}
        {(t.comments ?? []).map((c) => (
          <li
            key={c.uuid}
            className={
              c.fromCustomer
                ? 'rounded-md border border-line bg-surface p-3'
                : 'rounded-md border border-primary-soft bg-primary-soft/40 p-3'
            }
          >
            <p className="mb-1 text-xs text-muted">
              {c.fromCustomer ? 'You' : (c.author?.name ?? 'Our team')} · {formatDateTime(c.createdAt)}
            </p>
            <p className="text-sm whitespace-pre-wrap">{c.body}</p>
          </li>
        ))}
      </ol>
      {t.status !== 'closed' ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) reply.mutate();
          }}
        >
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            aria-label="Your reply"
            placeholder="Write a reply"
          />
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={!body.trim()} loading={reply.isPending}>
              Send reply
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted">This request is closed. Start a new one if you need more help.</p>
      )}
    </div>
  );
}

function Documents({ me }: { me: Me }) {
  const docs = useQuery({
    queryKey: ['portal', 'documents'],
    queryFn: () =>
      portalApi<{ quotes: CustomerQuote[]; invoices: CustomerInvoice[]; contracts: CustomerContract[] }>(
        `${P}/documents`,
      ),
  });
  if (docs.isPending) return <Skeleton className="h-64" />;
  if (docs.isError) return <ErrorState error={docs.error} onRetry={() => void docs.refetch()} />;
  const { quotes, invoices, contracts } = docs.data;
  const waiting = quotes.filter((q) => q.status === 'sent');
  const due = invoices.filter((i) => i.status === 'issued' || i.status === 'partially_paid');
  const empty = !quotes.length && !invoices.length && !contracts.length;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Hello{me.firstName ? `, ${me.firstName}` : ''}
        </h1>
        <p className="text-sm text-muted">
          {waiting.length || due.length
            ? [
                waiting.length
                  ? `${waiting.length} ${waiting.length === 1 ? 'quote needs' : 'quotes need'} your answer`
                  : '',
                due.length ? `${due.length} ${due.length === 1 ? 'invoice is' : 'invoices are'} open` : '',
              ]
                .filter(Boolean)
                .join(' · ')
            : 'You are all up to date.'}
        </p>
      </div>
      {empty ? (
        <EmptyState
          icon={<FileText />}
          title="No documents yet"
          description={`${me.business.name} has not shared anything with you yet.`}
        />
      ) : null}
      {me.features.quotes && quotes.length ? (
        <DocList title="Quotes" icon={<FileText />}>
          {quotes.map((q) => (
            <DocRow
              key={q.uuid}
              to={`${ROOT}/quotes/${q.uuid}`}
              number={q.number}
              title={q.title}
              badge={
                <Badge
                  tone={q.status === 'sent' ? 'accent' : q.status === 'accepted' ? 'primary' : 'neutral'}
                >
                  {QUOTE_STATUS[q.status]}
                </Badge>
              }
              amount={formatMoney(q.total, q.currency, true)}
              date={q.validUntil ? `Valid until ${formatDate(q.validUntil)}` : formatDate(q.issueDate)}
            />
          ))}
        </DocList>
      ) : null}
      {me.features.invoices && invoices.length ? (
        <DocList title="Invoices" icon={<Receipt />}>
          {invoices.map((i) => (
            <DocRow
              key={i.uuid}
              to={`${ROOT}/invoices/${i.uuid}`}
              number={i.number}
              title={i.title}
              badge={invoiceBadge(i)}
              amount={
                i.status === 'issued' || i.status === 'partially_paid'
                  ? `${formatMoney(i.balanceDue, i.currency, true)} due`
                  : formatMoney(i.total, i.currency, true)
              }
              date={formatDate(i.issueDate)}
            />
          ))}
        </DocList>
      ) : null}
      {me.features.contracts && contracts.length ? (
        <DocList title="Contracts" icon={<KeyRound />}>
          {contracts.map((c) => (
            <li key={c.uuid} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{c.title}</span>
                <span className="block font-mono text-xs text-muted">{c.number}</span>
              </span>
              <Badge tone={c.status === 'active' ? 'primary' : 'neutral'}>
                {c.status.charAt(0).toUpperCase() + c.status.slice(1)}
              </Badge>
              <span className="w-56 text-end text-muted">
                {formatDate(c.startDate)} – {c.endDate ? formatDate(c.endDate) : 'ongoing'}
                {c.status === 'active' && c.autoRenew ? ' · renews automatically' : ''}
              </span>
            </li>
          ))}
        </DocList>
      ) : null}
    </div>
  );
}

function DocList({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Pane
      title={
        <span className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:text-faint">
          {icon} {title}
        </span>
      }
      padded={false}
    >
      <ul className="divide-y divide-line">{children}</ul>
    </Pane>
  );
}

function DocRow(props: {
  to: string;
  number: string;
  title: string;
  badge: ReactNode;
  amount: string;
  date: string;
}) {
  return (
    <li>
      <Link to={props.to} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm hover:bg-hover">
        <span className="min-w-0 flex-1">
          <span className="font-mono font-medium">{props.number}</span>
          {props.title ? <span className="block truncate text-xs text-muted">{props.title}</span> : null}
        </span>
        {props.badge}
        <span className="hidden w-40 text-muted sm:block">{props.date}</span>
        <span className="w-32 text-end font-medium tabular-nums">{props.amount}</span>
      </Link>
    </li>
  );
}

function QuotePage() {
  return <Authed>{(me) => <QuoteView me={me} />}</Authed>;
}

function QuoteView({ me }: { me: Me }) {
  const { uuid = '' } = useParams();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'accept' | 'decline' | null>(null);
  const [name, setName] = useState(me.name);
  const [reason, setReason] = useState('');
  const quote = useQuery({
    queryKey: ['portal', 'quote', uuid],
    queryFn: () => portalApi<CustomerQuote>(`${P}/quotes/${uuid}`),
  });
  const respond = useMutation({
    mutationFn: () =>
      portalApi<CustomerQuote>(`${P}/quotes/${uuid}/${mode}`, {
        method: 'POST',
        body: mode === 'accept' ? { name } : { reason: reason || null },
      }),
    onSuccess: (q) => {
      toast.success(
        q.status === 'accepted' ? 'Thank you. Your acceptance has been sent.' : 'Your answer has been sent.',
      );
      setMode(null);
      void qc.invalidateQueries({ queryKey: ['portal'] });
    },
  });
  if (quote.isPending) return <Skeleton className="h-[600px]" />;
  if (quote.isError) return <ErrorState error={quote.error} />;
  const q = quote.data;
  const canAnswer =
    q.status === 'sent' && (!q.validUntil || q.validUntil >= new Date().toISOString().slice(0, 10));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Link to={ROOT} className="text-sm text-primary hover:underline">
          ← All documents
        </Link>
        <div className="ms-auto flex gap-2">
          <Button variant="ghost" onClick={() => window.print()}>
            <Printer /> Print or save as PDF
          </Button>
          {canAnswer ? (
            <>
              <Button onClick={() => setMode('decline')}>
                <X /> Decline
              </Button>
              <Button variant="primary" onClick={() => setMode('accept')}>
                <Check /> Accept
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {q.status === 'accepted' ? (
        <p className="rounded-md border border-line bg-primary-soft px-4 py-2 text-sm print:hidden">
          Accepted{q.acceptedByName ? ` by ${q.acceptedByName}` : ''} on {formatDate(q.respondedAt)}.
        </p>
      ) : null}
      {q.status === 'sent' && !canAnswer ? (
        <p className="rounded-md border border-line bg-subtle px-4 py-2 text-sm print:hidden">
          This quote has passed its valid-until date. Contact {me.business.name} for an updated one.
        </p>
      ) : null}
      <DocumentPaper
        kind="Quote"
        business={me.business}
        number={q.number}
        title={q.title}
        organization={q.organization}
        contact={q.contact}
        dates={[
          { label: 'Issued', value: q.issueDate },
          { label: 'Valid until', value: q.validUntil },
        ]}
        currency={q.currency}
        lines={q.lines ?? []}
        notes={q.notes}
        terms={q.terms}
      />
      {mode ? (
        <Dialog open onOpenChange={(o) => !o && setMode(null)}>
          <DialogContent
            title={mode === 'accept' ? `Accept ${q.number}` : `Decline ${q.number}`}
            description={
              mode === 'accept'
                ? `Typing your name counts as your signature. Total: ${formatMoney(q.total, q.currency, true)}.`
                : 'Let us know why, if you like. It helps us improve.'
            }
            footer={
              <>
                <Button variant="ghost" onClick={() => setMode(null)}>
                  Cancel
                </Button>
                <Button
                  variant={mode === 'accept' ? 'primary' : 'danger'}
                  loading={respond.isPending}
                  disabled={mode === 'accept' && name.trim().length < 2}
                  onClick={() => respond.mutate()}
                >
                  {mode === 'accept' ? 'Accept quote' : 'Decline quote'}
                </Button>
              </>
            }
          >
            {mode === 'accept' ? (
              <Field label="Your full name" required>
                {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
              </Field>
            ) : (
              <Field label="Reason (optional)">
                {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />}
              </Field>
            )}
            {respond.error ? (
              <p role="alert" className="mt-2 text-sm text-accent">
                {respond.error.message}
              </p>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function InvoicePage() {
  return <Authed>{(me) => <InvoiceView me={me} />}</Authed>;
}

function InvoiceView({ me }: { me: Me }) {
  const { uuid = '' } = useParams();
  const invoice = useQuery({
    queryKey: ['portal', 'invoice', uuid],
    queryFn: () => portalApi<CustomerInvoice>(`${P}/invoices/${uuid}`),
  });
  if (invoice.isPending) return <Skeleton className="h-[600px]" />;
  if (invoice.isError) return <ErrorState error={invoice.error} />;
  const i = invoice.data;
  const open = i.status === 'issued' || i.status === 'partially_paid';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 print:hidden">
        <Link to={ROOT} className="text-sm text-primary hover:underline">
          ← All documents
        </Link>
        <span className="ms-2">{invoiceBadge(i)}</span>
        <Button className="ms-auto" variant="ghost" onClick={() => window.print()}>
          <Printer /> Print or save as PDF
        </Button>
      </div>
      <DocumentPaper
        kind="Invoice"
        partyLabel="Billed to"
        business={me.business}
        number={i.number}
        title={i.title}
        organization={i.organization}
        contact={i.contact}
        dates={[
          { label: 'Issued', value: i.issueDate },
          { label: 'Due', value: i.dueDate },
        ]}
        currency={i.currency}
        lines={i.lines ?? []}
        extraTotals={
          i.status === 'void'
            ? undefined
            : [
                { label: 'Paid', value: -i.amountPaid },
                { label: 'Balance due', value: i.balanceDue, strong: true },
              ]
        }
        notes={i.notes}
        terms={i.terms}
        footer={
          open && i.paymentInstructions ? (
            <div className="sm:col-span-2">
              <p className="text-xs font-medium tracking-wide text-muted uppercase">How to pay</p>
              <p className="mt-1 whitespace-pre-line">{i.paymentInstructions}</p>
            </div>
          ) : null
        }
      />
    </div>
  );
}

const portalModule: WebModule = {
  key: 'portal',
  routes: [{ path: '', element: <AccountsPage /> }],
  publicRoutes: [
    { path: '', element: <HomePage /> },
    { path: 'login', element: <LoginPage /> },
    { path: 'verify', element: <VerifyPage /> },
    { path: 'quotes/:uuid', element: <QuotePage /> },
    { path: 'invoices/:uuid', element: <InvoicePage /> },
    { path: 'docs/:uuid', element: <DocPage /> },
    { path: 'support/new', element: <NewTicketPage /> },
    { path: 'support/:uuid', element: <TicketPage /> },
  ],
};

export default portalModule;
