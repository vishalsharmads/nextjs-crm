import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import type { WebModule } from '@app/module-sdk';
import { ApiError, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { labelVars } from '@/lib/labels';
import { useBoot, useCan } from '@/app/session';
import { cn } from '@/lib/cn';
import { addDaysTo, fromZonedInput, toZonedInput, zonedParts, zonedToUtc } from '@/lib/zoned';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Badge, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui/misc';
import { RecordPicker } from '@/components/fields/pickers';

interface Resource {
  uuid: string;
  name: string;
  kind: string;
  location: string;
  capacity: number | null;
  hourlyRate: number | null;
  openTime: string | null;
  closeTime: string | null;
  openDays: number[] | null;
  position: number;
  active: boolean;
}

interface Booking {
  uuid: string;
  resource: { uuid: string; name: string };
  contact: { uuid: string; name: string } | null;
  organization: { uuid: string; name: string } | null;
  title: string;
  startsAt: string;
  endsAt: string;
  attendees: number | null;
  status: 'confirmed' | 'cancelled';
  notes: string | null;
  createdBy: { uuid: string; name: string } | null;
}

const KEY = ['m', 'bookings'] as const;
const DAY_START = 7;
const DAY_END = 22;
const HOURS = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The board shows the workspace's clock, so everyone sees the same times wherever they are. */
function useZone() {
  return useBoot().settings.general.timezone;
}
const validDay = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
const time = (iso: string, timeZone: string) => zonedParts(new Date(iso), timeZone).time;
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

function useNouns() {
  const L = labelVars(useBoot().labels);
  return {
    booking: L.booking ?? 'Booking',
    bookings: L.bookingPlural ?? 'Bookings',
    resource: L.resource ?? 'Resource',
    resources: L.resourcePlural ?? 'Resources',
  };
}

function useResources(all = false) {
  return useQuery({
    queryKey: [...KEY, 'resources', all],
    queryFn: () =>
      apiGet<{ data: Resource[] }>('/m/bookings/resources', { all: String(all) }).then((r) => r.data),
  });
}

interface Draft {
  uuid?: string;
  resourceUuid: string;
  start: string;
  end: string;
  title: string;
  attendees: string;
  notes: string;
  contact: { uuid: string; name: string } | null;
}

function BookingDialog({
  draft,
  resources,
  onDone,
}: {
  draft: Draft;
  resources: Resource[];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const can = useCan();
  const nouns = useNouns();
  const L = labelVars(useBoot().labels);
  const tz = useZone();
  const [v, setV] = useState(draft);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        resourceUuid: v.resourceUuid,
        title: v.title,
        startsAt: fromZonedInput(v.start, tz).toISOString(),
        endsAt: fromZonedInput(v.end, tz).toISOString(),
        attendees: v.attendees ? Number(v.attendees) : null,
        notes: v.notes || null,
        contactUuid: v.contact?.uuid ?? null,
      };
      return v.uuid
        ? apiPatch(`/m/bookings/bookings/${v.uuid}`, body)
        : apiPost('/m/bookings/bookings', body);
    },
    onSuccess: () => {
      toast.success(v.uuid ? `${nouns.booking} saved` : `${nouns.booking} added`);
      void qc.invalidateQueries({ queryKey: KEY });
      onDone();
    },
  });
  const cancel = useMutation({
    mutationFn: () => apiPost(`/m/bookings/bookings/${v.uuid}/cancel`, {}),
    onSuccess: () => {
      toast.success(`${nouns.booking} cancelled`);
      void qc.invalidateQueries({ queryKey: KEY });
      onDone();
    },
  });
  const errors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  const resource = resources.find((r) => r.uuid === v.resourceUuid);
  const hours =
    v.start && v.end
      ? (fromZonedInput(v.end, tz).getTime() - fromZonedInput(v.start, tz).getTime()) / 3_600_000
      : 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title={v.uuid ? `Edit ${nouns.booking.toLowerCase()}` : `New ${nouns.booking.toLowerCase()}`}
        footer={
          <>
            {v.uuid && can('bookings.bookings.delete') ? (
              <Button
                variant="ghost"
                className="me-auto"
                loading={cancel.isPending}
                onClick={() => {
                  if (window.confirm(`Cancel this ${nouns.booking.toLowerCase()}?`)) cancel.mutate();
                }}
              >
                Cancel {nouns.booking.toLowerCase()}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={onDone}>
              Close
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              {v.uuid ? 'Save' : 'Book'}
            </Button>
          </>
        }
      >
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label={nouns.resource} required className="sm:col-span-2" error={errors.resourceUuid}>
            {(p) => (
              <NativeSelect
                {...p}
                value={v.resourceUuid}
                onChange={(e) => setV({ ...v, resourceUuid: e.target.value })}
              >
                {resources.map((r) => (
                  <option key={r.uuid} value={r.uuid}>
                    {r.name}
                    {r.capacity ? ` (${r.capacity})` : ''}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label="Starts" required error={errors.startsAt}>
            {(p) => (
              <Input
                {...p}
                type="datetime-local"
                step={900}
                value={v.start}
                onChange={(e) => setV({ ...v, start: e.target.value })}
              />
            )}
          </Field>
          <Field label="Ends" required error={errors.endsAt}>
            {(p) => (
              <Input
                {...p}
                type="datetime-local"
                step={900}
                value={v.end}
                onChange={(e) => setV({ ...v, end: e.target.value })}
              />
            )}
          </Field>
          <Field label={L.contact} className="sm:col-span-2">
            {(p) => (
              <RecordPicker
                {...p}
                route="contacts"
                value={v.contact?.uuid ?? null}
                label={v.contact?.name}
                onChange={(uuid, name) => setV({ ...v, contact: uuid ? { uuid, name: name ?? '' } : null })}
              />
            )}
          </Field>
          <Field label="Title">
            {(p) => <Input {...p} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} />}
          </Field>
          <Field
            label="People"
            error={errors.attendees}
            help={resource?.capacity ? `Fits ${resource.capacity}` : undefined}
          >
            {(p) => (
              <Input
                {...p}
                type="number"
                min={1}
                value={v.attendees}
                onChange={(e) => setV({ ...v, attendees: e.target.value })}
              />
            )}
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                value={v.notes}
                onChange={(e) => setV({ ...v, notes: e.target.value })}
              />
            )}
          </Field>
          {resource?.hourlyRate && hours > 0 ? (
            <p className="text-sm text-muted sm:col-span-2">
              {hours.toFixed(hours % 1 ? 2 : 0)} h × {formatMoney(resource.hourlyRate)} ={' '}
              <span className="font-medium text-ink">{formatMoney(resource.hourlyRate * hours)}</span>
            </p>
          ) : null}
          {save.error && !Object.keys(errors).length ? (
            <p role="alert" className="text-sm text-accent sm:col-span-2">
              {save.error.message}
            </p>
          ) : null}
          {save.error instanceof ApiError && save.error.code === 'CONFLICT' && Object.keys(errors).length ? (
            <p role="alert" className="text-sm text-accent sm:col-span-2">
              {save.error.message}
            </p>
          ) : null}
          <button type="submit" hidden />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DayBoard() {
  const can = useCan();
  const nouns = useNouns();
  const [params, setParams] = useSearchParams();
  const tz = useZone();
  const today = zonedParts(new Date(), tz).date;
  const day = validDay(params.get('day')) ?? today;
  const from = zonedToUtc(day, '00:00', tz);
  const to = zonedToUtc(addDaysTo(day, 1), '00:00', tz);
  const resources = useResources();
  const bookings = useQuery({
    queryKey: [...KEY, 'day', day, tz],
    queryFn: () =>
      apiGet<{ data: Booking[] }>('/m/bookings/bookings', {
        from: from.toISOString(),
        to: to.toISOString(),
      }).then((r) => r.data),
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const go = (days: number) => setParams({ day: addDaysTo(day, days) });
  const byResource = useMemo(() => {
    const m = new Map<string, Booking[]>();
    for (const b of bookings.data ?? []) m.set(b.resource.uuid, [...(m.get(b.resource.uuid) ?? []), b]);
    return m;
  }, [bookings.data]);
  const span = (DAY_END - DAY_START) * 60;
  const pos = (iso: string) => {
    const minutes = (new Date(iso).getTime() - from.getTime()) / 60_000 - DAY_START * 60;
    return Math.min(Math.max(minutes / span, 0), 1) * 100;
  };
  const create = can('bookings.bookings.create');
  const openSlot = (r: Resource, hour: number) => {
    if (!create) return;
    const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
    setDraft({
      resourceUuid: r.uuid,
      start: `${day}T${hh(hour)}`,
      end: hour + 1 < 24 ? `${day}T${hh(hour + 1)}` : `${addDaysTo(day, 1)}T00:00`,
      title: '',
      attendees: '',
      notes: '',
      contact: null,
    });
  };
  const openBooking = (b: Booking) =>
    setDraft({
      uuid: b.uuid,
      resourceUuid: b.resource.uuid,
      start: toZonedInput(b.startsAt, tz),
      end: toZonedInput(b.endsAt, tz),
      title: b.title,
      attendees: b.attendees ? String(b.attendees) : '',
      notes: b.notes ?? '',
      contact: b.contact,
    });
  const isToday = day === today;
  const nowPct = isToday ? pos(new Date().toISOString()) : null;

  return (
    <div>
      <PageHeader
        title={nouns.bookings}
        description={`${new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
          timeZone: 'UTC',
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })} · times in ${tz}`}
        actions={
          <>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" aria-label="Previous day" onClick={() => go(-1)}>
                <ChevronLeft />
              </Button>
              <Button variant={isToday ? 'subtle' : 'secondary'} onClick={() => setParams({})}>
                Today
              </Button>
              <Button variant="ghost" size="icon" aria-label="Next day" onClick={() => go(1)}>
                <ChevronRight />
              </Button>
              <Input
                type="date"
                aria-label="Go to date"
                value={day}
                onChange={(e) => e.target.value && setParams({ day: e.target.value })}
                className="w-40"
              />
            </div>
            {can('bookings.resources.manage') ? (
              <Button variant="ghost" asChild>
                <Link to="/m/bookings/resources">
                  <Settings2 /> {nouns.resources}
                </Link>
              </Button>
            ) : null}
            {create && resources.data?.length ? (
              <Button
                variant="primary"
                onClick={() =>
                  openSlot(
                    resources.data![0]!,
                    Math.min(
                      Math.max(Number(zonedParts(new Date(), tz).time.slice(0, 2)) + 1, DAY_START),
                      DAY_END - 1,
                    ),
                  )
                }
              >
                <Plus /> New {nouns.booking.toLowerCase()}
              </Button>
            ) : null}
          </>
        }
      />
      <div className="p-4 md:p-6">
        {resources.isPending || bookings.isPending ? (
          <Skeleton className="h-96" />
        ) : resources.isError ? (
          <ErrorState error={resources.error} onRetry={() => void resources.refetch()} />
        ) : !resources.data.length ? (
          <EmptyState
            icon={<CalendarDays />}
            title={`No ${nouns.resources.toLowerCase()} yet`}
            description="Add the rooms, desks and equipment people can book."
            action={
              can('bookings.resources.manage') ? (
                <Button variant="primary" asChild>
                  <Link to="/m/bookings/resources">
                    <Plus /> Add {nouns.resources.toLowerCase()}
                  </Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-surface">
            <div className="min-w-[960px]">
              <div className="grid grid-cols-[200px_1fr] border-b border-line bg-subtle text-xs text-muted">
                <div className="px-3 py-2 font-medium">{nouns.resource}</div>
                <div
                  className="relative grid"
                  style={{ gridTemplateColumns: `repeat(${HOURS.length}, minmax(0, 1fr))` }}
                >
                  {HOURS.map((h) => (
                    <div key={h} className="border-s border-line px-1 py-2">
                      {String(h).padStart(2, '0')}:00
                    </div>
                  ))}
                </div>
              </div>
              {resources.data.map((r) => {
                const closedToday = r.openDays?.length ? !r.openDays.includes(weekday(day)) : false;
                return (
                  <div key={r.uuid} className="grid grid-cols-[200px_1fr] border-b border-line last:border-0">
                    <div className="px-3 py-2">
                      <p className="truncate text-sm font-medium">{r.name}</p>
                      <p className="truncate text-xs text-muted">
                        {[r.kind, r.capacity ? `${r.capacity} people` : null, r.location || null]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    <div className={cn('relative min-h-14', closedToday && 'bg-subtle')}>
                      <div
                        className="absolute inset-0 grid"
                        style={{ gridTemplateColumns: `repeat(${HOURS.length}, minmax(0, 1fr))` }}
                      >
                        {HOURS.map((h) => {
                          const hh = `${String(h).padStart(2, '0')}:00`;
                          const shut =
                            closedToday ||
                            (r.openTime && hh < r.openTime) ||
                            (r.closeTime && hh >= r.closeTime);
                          return (
                            <button
                              key={h}
                              type="button"
                              disabled={!create || !!shut}
                              onClick={() => openSlot(r, h)}
                              aria-label={`Book ${r.name} at ${hh}`}
                              className={cn(
                                'border-s border-line transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-primary',
                                shut ? 'cursor-not-allowed bg-subtle' : 'hover:bg-primary-soft',
                              )}
                            />
                          );
                        })}
                      </div>
                      {(byResource.get(r.uuid) ?? []).map((b) => {
                        const left = pos(b.startsAt);
                        const width = Math.max(pos(b.endsAt) - left, 1.5);
                        return (
                          <button
                            key={b.uuid}
                            type="button"
                            onClick={() => openBooking(b)}
                            className="absolute inset-y-1.5 overflow-hidden rounded-sm border border-primary bg-primary-soft px-1.5 text-start text-xs text-ink shadow-sm hover:z-10 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-primary"
                            style={{ insetInlineStart: `${left}%`, width: `${width}%` }}
                            title={`${time(b.startsAt, tz)}–${time(b.endsAt, tz)} ${b.title || b.contact?.name || ''}`}
                          >
                            <span className="block truncate font-medium">
                              {b.title || b.contact?.name || nouns.booking}
                            </span>
                            <span className="block truncate text-muted">
                              {time(b.startsAt, tz)}–{time(b.endsAt, tz)}
                            </span>
                          </button>
                        );
                      })}
                      {nowPct !== null && nowPct > 0 && nowPct < 100 ? (
                        <div
                          aria-hidden
                          className="pointer-events-none absolute inset-y-0 w-px bg-accent"
                          style={{ insetInlineStart: `${nowPct}%` }}
                        />
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {draft && resources.data ? (
        <BookingDialog draft={draft} resources={resources.data} onDone={() => setDraft(null)} />
      ) : null}
    </div>
  );
}

function ResourceDialog({ resource, onDone }: { resource: Resource | null; onDone: () => void }) {
  const qc = useQueryClient();
  const nouns = useNouns();
  const [v, setV] = useState({
    name: resource?.name ?? '',
    kind: resource?.kind ?? 'room',
    location: resource?.location ?? '',
    capacity: resource?.capacity ? String(resource.capacity) : '',
    hourlyRate: resource?.hourlyRate ? String(resource.hourlyRate) : '',
    openTime: resource?.openTime ?? '',
    closeTime: resource?.closeTime ?? '',
    openDays: resource?.openDays ?? [],
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: v.name,
        kind: v.kind,
        location: v.location,
        capacity: v.capacity ? Number(v.capacity) : null,
        hourlyRate: v.hourlyRate ? Number(v.hourlyRate) : null,
        openTime: v.openTime || null,
        closeTime: v.closeTime || null,
        openDays: v.openDays.length ? v.openDays : null,
      };
      return resource
        ? apiPatch(`/m/bookings/resources/${resource.uuid}`, body)
        : apiPost('/m/bookings/resources', body);
    },
    onSuccess: () => {
      toast.success(resource ? `${nouns.resource} saved` : `${nouns.resource} added`);
      void qc.invalidateQueries({ queryKey: KEY });
      onDone();
    },
  });
  const errors = save.error instanceof ApiError ? save.error.fieldErrors() : {};
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title={resource ? `Edit ${resource.name}` : `New ${nouns.resource.toLowerCase()}`}
        footer={
          <>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={!v.name.trim()}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required className="sm:col-span-2" error={errors.name}>
            {(p) => (
              <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} autoFocus />
            )}
          </Field>
          <Field label="Type" help="For example room, desk, phone booth or projector.">
            {(p) => <Input {...p} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })} />}
          </Field>
          <Field label="Location">
            {(p) => (
              <Input {...p} value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} />
            )}
          </Field>
          <Field label="Capacity" error={errors.capacity}>
            {(p) => (
              <Input
                {...p}
                type="number"
                min={1}
                value={v.capacity}
                onChange={(e) => setV({ ...v, capacity: e.target.value })}
              />
            )}
          </Field>
          <Field label="Hourly rate" error={errors.hourlyRate}>
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                step="0.01"
                value={v.hourlyRate}
                onChange={(e) => setV({ ...v, hourlyRate: e.target.value })}
              />
            )}
          </Field>
          <Field label="Opens" error={errors.openTime} help="Leave empty for any time.">
            {(p) => (
              <Input
                {...p}
                type="time"
                value={v.openTime}
                onChange={(e) => setV({ ...v, openTime: e.target.value })}
              />
            )}
          </Field>
          <Field label="Closes" error={errors.closeTime}>
            {(p) => (
              <Input
                {...p}
                type="time"
                value={v.closeTime}
                onChange={(e) => setV({ ...v, closeTime: e.target.value })}
              />
            )}
          </Field>
          <fieldset className="sm:col-span-2">
            <legend className="text-xs font-medium text-muted">
              Open on (none selected means every day)
            </legend>
            <div className="mt-1 flex flex-wrap gap-1">
              {WEEKDAYS.map((d, i) => {
                const on = v.openDays.includes(i);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setV({
                        ...v,
                        openDays: on ? v.openDays.filter((x) => x !== i) : [...v.openDays, i].sort(),
                      })
                    }
                    className={cn(
                      'h-8 w-11 rounded-sm border text-xs transition-colors duration-150',
                      on
                        ? 'border-primary bg-primary-soft text-primary'
                        : 'border-line text-muted hover:bg-hover',
                    )}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResourcesPage() {
  const nouns = useNouns();
  const qc = useQueryClient();
  const resources = useResources(true);
  const [editing, setEditing] = useState<Resource | 'new' | null>(null);
  const toggle = useMutation({
    mutationFn: (r: Resource) => apiPatch(`/m/bookings/resources/${r.uuid}`, { active: !r.active }),
    onSuccess: (_d, r) => {
      toast.success(r.active ? 'Archived' : 'Restored');
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  return (
    <div>
      <PageHeader
        title={nouns.resources}
        description={
          <Link to="/m/bookings" className="text-primary hover:underline">
            ← {nouns.bookings}
          </Link>
        }
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus /> New {nouns.resource.toLowerCase()}
          </Button>
        }
      />
      <div className="mx-auto max-w-5xl p-4 md:p-6">
        {resources.isPending ? (
          <Skeleton className="h-48" />
        ) : resources.isError ? (
          <ErrorState error={resources.error} />
        ) : !resources.data.length ? (
          <EmptyState icon={<CalendarDays />} title={`No ${nouns.resources.toLowerCase()} yet`} />
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line bg-surface">
            {resources.data.map((r) => (
              <li key={r.uuid} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <button type="button" className="min-w-0 flex-1 text-start" onClick={() => setEditing(r)}>
                  <span className="font-medium hover:underline">{r.name}</span>
                  {!r.active ? <Badge className="ms-2">Archived</Badge> : null}
                  <span className="block text-xs text-muted">
                    {[
                      r.kind,
                      r.capacity ? `${r.capacity} people` : null,
                      r.openTime || r.closeTime
                        ? `${r.openTime ?? '00:00'}–${r.closeTime ?? '24:00'}`
                        : 'Any time',
                      r.openDays?.length ? r.openDays.map((d) => WEEKDAYS[d]).join(' ') : null,
                      r.hourlyRate ? `${formatMoney(r.hourlyRate)}/h` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
                <Button size="sm" variant="ghost" onClick={() => toggle.mutate(r)}>
                  {r.active ? 'Archive' : 'Restore'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {editing ? (
        <ResourceDialog
          key={editing === 'new' ? 'new' : editing.uuid}
          resource={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function OccupancyWidget({ data }: { data: unknown }) {
  const { inUse, total, bookingsToday } = data as { inUse: number; total: number; bookingsToday: number };
  const pct = total ? Math.round((inUse / total) * 100) : 0;
  return (
    <div className="flex flex-1 flex-col gap-3">
      <dl className="grid grid-cols-2 gap-3">
        <div>
          <dt className="text-xs text-muted">In use now</dt>
          <dd className="text-2xl font-semibold tracking-tight tabular-nums">
            {inUse}
            <span className="text-base font-normal text-muted"> / {total}</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Today</dt>
          <dd className="text-2xl font-semibold tracking-tight tabular-nums">{bookingsToday}</dd>
        </div>
      </dl>
      <div
        className="h-2 overflow-hidden rounded-full bg-subtle"
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Occupancy"
      >
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <Link to="/m/bookings" className="mt-auto text-sm text-primary hover:underline">
        Open the day board
      </Link>
    </div>
  );
}

const bookingsModule: WebModule = {
  key: 'bookings',
  routes: [
    { path: '', element: <DayBoard /> },
    { path: 'resources', element: <ResourcesPage /> },
  ],
  widgets: { 'bookings.occupancy': (p) => <OccupancyWidget data={p.data} /> },
};

export default bookingsModule;
