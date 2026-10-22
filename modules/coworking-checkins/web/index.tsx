import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DoorOpen, LogOut, MapPin, UserCheck, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import type { WebModule } from '@app/module-sdk';
import { ApiError, apiGet, apiPost } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { labelVars } from '@/lib/labels';
import { useBoot, useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Avatar, Badge, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { RecordPicker } from '@/components/fields/pickers';

interface Ref {
  uuid: string;
  name: string;
}
interface Visit {
  uuid: string;
  kind: 'member' | 'visitor';
  member: Ref | null;
  host: Ref | null;
  visitorName: string | null;
  visitorCompany: string | null;
  purpose: string | null;
  badge: string | null;
  checkedInAt: string;
  checkedOutAt: string | null;
  hostNotified: boolean;
}

const API = '/m/coworking-checkins/visits';
const KEY = ['m', 'coworking-checkins'] as const;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function MemberDialog({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const L = labelVars(useBoot().labels);
  const [who, setWho] = useState<Ref | null>(null);
  const [badge, setBadge] = useState('');
  const checkIn = useMutation({
    mutationFn: () => apiPost(API, { kind: 'member', contactUuid: who!.uuid, badge: badge || null }),
    onSuccess: () => {
      toast.success(`${who!.name} checked in`);
      void qc.invalidateQueries({ queryKey: KEY });
      onDone();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title={`Check in ${L.contactLower}`}
        footer={
          <>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!who}
              loading={checkIn.isPending}
              onClick={() => checkIn.mutate()}
            >
              Check in
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label={L.contact} required>
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
          <Field label="Badge or card" help="Optional.">
            {(p) => (
              <Input {...p} value={badge} onChange={(e) => setBadge(e.target.value)} className="w-40" />
            )}
          </Field>
          {checkIn.error ? (
            <p role="alert" className="text-sm text-accent">
              {checkIn.error.message}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function VisitorDialog({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const L = labelVars(useBoot().labels);
  const [v, setV] = useState({
    visitorName: '',
    visitorCompany: '',
    visitorEmail: '',
    purpose: '',
    badge: '',
  });
  const [host, setHost] = useState<Ref | null>(null);
  const checkIn = useMutation({
    mutationFn: () =>
      apiPost<Visit>(API, { kind: 'visitor', ...v, hostUuid: host?.uuid ?? null, notifyHost: true }),
    onSuccess: (visit) => {
      toast.success(visit.hostNotified ? `Checked in. ${visit.host?.name} has been told.` : 'Checked in');
      void qc.invalidateQueries({ queryKey: KEY });
      onDone();
    },
  });
  const errors = checkIn.error instanceof ApiError ? checkIn.error.fieldErrors() : {};
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title="Check in a visitor"
        description={`Choose who they are visiting and we will email them that their guest has arrived.`}
        footer={
          <>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!v.visitorName.trim()}
              loading={checkIn.isPending}
              onClick={() => checkIn.mutate()}
            >
              Check in
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Visitor name" required error={errors.visitorName}>
            {(p) => (
              <Input
                {...p}
                value={v.visitorName}
                onChange={(e) => setV({ ...v, visitorName: e.target.value })}
                autoFocus
              />
            )}
          </Field>
          <Field label="Company">
            {(p) => (
              <Input
                {...p}
                value={v.visitorCompany}
                onChange={(e) => setV({ ...v, visitorCompany: e.target.value })}
              />
            )}
          </Field>
          <Field label={`Visiting (${L.contactLower})`} className="sm:col-span-2">
            {(p) => (
              <RecordPicker
                {...p}
                route="contacts"
                value={host?.uuid ?? null}
                label={host?.name}
                onChange={(uuid, name) => setHost(uuid ? { uuid, name: name ?? '' } : null)}
              />
            )}
          </Field>
          <Field label="Purpose">
            {(p) => (
              <Input {...p} value={v.purpose} onChange={(e) => setV({ ...v, purpose: e.target.value })} />
            )}
          </Field>
          <Field label="Badge">
            {(p) => <Input {...p} value={v.badge} onChange={(e) => setV({ ...v, badge: e.target.value })} />}
          </Field>
          <Field
            label="Visitor email"
            className="sm:col-span-2"
            error={errors.visitorEmail}
            help="Optional, for the visitor log."
          >
            {(p) => (
              <Input
                {...p}
                type="email"
                value={v.visitorEmail}
                onChange={(e) => setV({ ...v, visitorEmail: e.target.value })}
              />
            )}
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function VisitRow({ v, onCheckOut }: { v: Visit; onCheckOut?: () => void }) {
  const L = labelVars(useBoot().labels);
  const name = v.kind === 'member' ? (v.member?.name ?? 'Unknown') : (v.visitorName ?? 'Visitor');
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
      <Avatar name={name} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          {v.kind === 'member' && v.member ? (
            <Link to={`/contacts/${v.member.uuid}`} className="font-medium hover:underline">
              {name}
            </Link>
          ) : (
            <span className="font-medium">{name}</span>
          )}
          <Badge tone={v.kind === 'visitor' ? 'accent' : 'neutral'}>
            {v.kind === 'visitor' ? 'Visitor' : L.contact}
          </Badge>
          {v.badge ? <span className="font-mono text-xs text-muted">{v.badge}</span> : null}
        </span>
        <span className="text-xs text-muted">
          {v.visitorCompany ? `${v.visitorCompany} · ` : ''}
          {v.host ? `visiting ${v.host.name}${v.hostNotified ? ' (told)' : ''} · ` : ''}
          in at {time(v.checkedInAt)}
          {v.checkedOutAt ? ` · out at ${time(v.checkedOutAt)}` : ` · ${formatRelative(v.checkedInAt)}`}
        </span>
      </span>
      {onCheckOut ? (
        <Button size="sm" onClick={onCheckOut}>
          <LogOut /> Check out
        </Button>
      ) : null}
    </li>
  );
}

function FrontDesk() {
  const L = labelVars(useBoot().labels);
  const can = useCan();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'in' | 'today'>('in');
  const [dialog, setDialog] = useState<'member' | 'visitor' | null>(null);
  const visits = useQuery({
    queryKey: [...KEY, tab],
    queryFn: () => apiGet<{ data: Visit[] }>(API, { scope: tab }).then((r) => r.data),
    refetchInterval: 30_000,
  });
  const checkOut = useMutation({
    mutationFn: (v: Visit) => apiPost(`${API}/${v.uuid}/check-out`),
    onSuccess: () => {
      toast.success('Checked out');
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const manage = can('coworking-checkins.checkins.manage');
  const members = visits.data?.filter((v) => v.kind === 'member' && !v.checkedOutAt).length ?? 0;
  const visitors = visits.data?.filter((v) => v.kind === 'visitor' && !v.checkedOutAt).length ?? 0;
  return (
    <div>
      <PageHeader
        title="Front desk"
        description={
          tab === 'in' && visits.data
            ? `${members} ${L.contactPluralLower} and ${visitors} visitors in the building`
            : undefined
        }
        actions={
          manage ? (
            <>
              <Button size="lg" onClick={() => setDialog('visitor')}>
                <UserPlus /> Visitor
              </Button>
              <Button size="lg" variant="primary" onClick={() => setDialog('member')}>
                <UserCheck /> Check in
              </Button>
            </>
          ) : null
        }
      >
        <nav className="-mb-px flex gap-1" aria-label="Views">
          {(
            [
              ['in', 'In the building'],
              ['today', 'Today'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              aria-current={tab === k ? 'page' : undefined}
              className="border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-ink aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-ink"
            >
              {label}
            </button>
          ))}
        </nav>
      </PageHeader>
      <div className="mx-auto max-w-4xl p-4 md:p-6">
        {visits.isPending ? (
          <Skeleton className="h-48" />
        ) : visits.isError ? (
          <ErrorState error={visits.error} onRetry={() => void visits.refetch()} />
        ) : !visits.data.length ? (
          <EmptyState
            icon={<DoorOpen />}
            title={tab === 'in' ? 'Nobody is checked in' : 'No visits yet today'}
          />
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line bg-surface">
            {visits.data.map((v) => (
              <VisitRow
                key={v.uuid}
                v={v}
                onCheckOut={manage && !v.checkedOutAt ? () => checkOut.mutate(v) : undefined}
              />
            ))}
          </ul>
        )}
      </div>
      {dialog === 'member' ? <MemberDialog onDone={() => setDialog(null)} /> : null}
      {dialog === 'visitor' ? <VisitorDialog onDone={() => setDialog(null)} /> : null}
    </div>
  );
}

function TodayWidget({ data }: { data: unknown }) {
  const L = labelVars(useBoot().labels);
  const d = data as { members: number; visitors: number; today: number };
  return (
    <div className="flex flex-1 flex-col gap-3">
      <dl className="grid grid-cols-3 gap-2">
        {(
          [
            [`${L.contactPlural} in`, d.members],
            ['Visitors in', d.visitors],
            ['Visits today', d.today],
          ] as const
        ).map(([k, n]) => (
          <div key={k}>
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="text-2xl font-semibold tracking-tight tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>
      <Link
        to="/m/coworking-checkins"
        className="mt-auto inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        <MapPin className="size-4" /> Open the front desk
      </Link>
    </div>
  );
}

const checkinsModule: WebModule = {
  key: 'coworking-checkins',
  routes: [{ path: '', element: <FrontDesk /> }],
  widgets: { 'coworking-checkins.today': (p) => <TodayWidget data={p.data} /> },
};

export default checkinsModule;
