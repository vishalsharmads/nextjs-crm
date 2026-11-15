import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { WEEKDAYS, type BookingPageInput, type MeetingType } from '@app/shared';
import { apiGet, apiPut } from '@/lib/api';
import { appUrl } from '@/lib/app-url';
import { useBoot, useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { ErrorState, Pane, Skeleton } from '@/components/ui/misc';
import { Checkbox, Switch } from '@/components/ui/checkbox';

const DAY_NAMES: Record<(typeof WEEKDAYS)[number], string> = {
  sun: 'Sun',
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
};

interface Draft {
  slug: string;
  title: string;
  intro: string;
  timeZone: string;
  days: (typeof WEEKDAYS)[number][];
  from: string;
  to: string;
  types: (MeetingType & { question: string })[];
  active: boolean;
}

const newType = (n: number): Draft['types'][number] => ({
  key: `type-${n}`,
  name: 'Intro call',
  durationMin: 30,
  bufferMin: 10,
  noticeHours: 4,
  horizonDays: 30,
  questions: [],
  question: '',
});

/** Profile → Booking page: a public link where customers book a meeting in your free time. */
export function BookingPane() {
  const can = useCan();
  const { me, settings } = useBoot();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['booking-page'],
    queryFn: () => apiGet<{ page: BookingPageInput | null }>('/me/booking-page').then((r) => r.page),
    enabled: can('core.activities.create'),
  });
  const [d, setD] = useState<Draft | null>(null);
  useEffect(() => {
    if (q.data === undefined || d) return;
    const p = q.data;
    const firstDay = p
      ? (Object.entries(p.hours).find(([, r]) => r?.length)?.[1]?.[0] ?? ['09:00', '17:00'])
      : ['09:00', '17:00'];
    setD({
      slug:
        (p?.slug ??
          `${me.firstName}-${me.lastName}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')) ||
        'book',
      title: p?.title ?? `Book a meeting with ${me.firstName}`.trim(),
      intro: p?.intro ?? '',
      timeZone: p?.timeZone ?? settings.general.timezone,
      days: p
        ? (WEEKDAYS.filter((k) => p.hours[k]?.length) as Draft['days'])
        : ['mon', 'tue', 'wed', 'thu', 'fri'],
      from: firstDay[0]!,
      to: firstDay[1]!,
      types: (p?.meetingTypes ?? [newType(1)]).map((t) => ({ ...t, question: t.questions[0]?.label ?? '' })),
      active: p?.active ?? true,
    });
  }, [q.data, d, me, settings.general.timezone]);
  const save = useMutation({
    mutationFn: () =>
      apiPut('/me/booking-page', {
        slug: d!.slug,
        title: d!.title,
        intro: d!.intro,
        timeZone: d!.timeZone,
        hours: Object.fromEntries(d!.days.map((day) => [day, [[d!.from, d!.to]]])),
        meetingTypes: d!.types.map(({ question, ...t }) => ({
          ...t,
          questions: question.trim() ? [{ key: 'question', label: question.trim(), required: false }] : [],
        })),
        active: d!.active,
      }),
    onSuccess: () => {
      toast.success('Booking page saved');
      void qc.invalidateQueries({ queryKey: ['booking-page'] });
    },
  });
  if (!can('core.activities.create')) return null;
  const link = d ? appUrl(`/book/${d.slug}`) : '';
  const setType = (i: number, patch: Partial<Draft['types'][number]>) =>
    setD({ ...d!, types: d!.types.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  return (
    <Pane title="Booking page">
      {q.isPending || !d ? (
        q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <Skeleton className="h-40" />
        )
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <p className="text-sm text-muted">
            A public page where customers book a meeting in your free time: your working hours, minus meetings
            here and busy times in your connected calendar. Each booking becomes a meeting with an invitation.
          </p>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span className="font-medium">Page is open for bookings</span>
            <Switch
              aria-label="Page is open for bookings"
              checked={d.active}
              onCheckedChange={(v) => setD({ ...d, active: v })}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Address" help={link}>
              {(p) => (
                <Input
                  {...p}
                  value={d.slug}
                  onChange={(e) => setD({ ...d, slug: e.target.value.toLowerCase() })}
                />
              )}
            </Field>
            <Field label="Time zone">
              {(p) => (
                <Input {...p} value={d.timeZone} onChange={(e) => setD({ ...d, timeZone: e.target.value })} />
              )}
            </Field>
            <Field label="Title" className="sm:col-span-2">
              {(p) => (
                <Input {...p} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
              )}
            </Field>
            <Field label="Introduction" className="sm:col-span-2">
              {(p) => (
                <Textarea {...p} value={d.intro} onChange={(e) => setD({ ...d, intro: e.target.value })} />
              )}
            </Field>
          </div>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Working hours</legend>
            <div className="flex flex-wrap items-center gap-3">
              {WEEKDAYS.map((day) => (
                <label key={day} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={d.days.includes(day)}
                    onCheckedChange={(v) =>
                      setD({ ...d, days: v ? [...d.days, day] : d.days.filter((x) => x !== day) })
                    }
                  />
                  {DAY_NAMES[day]}
                </label>
              ))}
              <Input
                type="time"
                aria-label="From"
                value={d.from}
                onChange={(e) => setD({ ...d, from: e.target.value })}
                className="w-auto"
              />
              <span className="text-sm text-muted">to</span>
              <Input
                type="time"
                aria-label="To"
                value={d.to}
                onChange={(e) => setD({ ...d, to: e.target.value })}
                className="w-auto"
              />
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1.5 text-sm font-medium">Meeting types</legend>
            {d.types.map((t, i) => (
              <div key={i} className="grid gap-2 rounded-md border border-line p-3 sm:grid-cols-5">
                <Field label="Name" className="sm:col-span-2">
                  {(p) => (
                    <Input {...p} value={t.name} onChange={(e) => setType(i, { name: e.target.value })} />
                  )}
                </Field>
                <Field label="Minutes">
                  {(p) => (
                    <Input
                      {...p}
                      type="number"
                      min={10}
                      value={t.durationMin}
                      onChange={(e) => setType(i, { durationMin: Number(e.target.value) })}
                    />
                  )}
                </Field>
                <Field label="Gap before and after">
                  {(p) => (
                    <Input
                      {...p}
                      type="number"
                      min={0}
                      value={t.bufferMin}
                      onChange={(e) => setType(i, { bufferMin: Number(e.target.value) })}
                    />
                  )}
                </Field>
                <Field label="Hours' notice">
                  {(p) => (
                    <Input
                      {...p}
                      type="number"
                      min={0}
                      value={t.noticeHours}
                      onChange={(e) => setType(i, { noticeHours: Number(e.target.value) })}
                    />
                  )}
                </Field>
                <Field label="Question to ask (optional)" className="sm:col-span-4">
                  {(p) => (
                    <Input
                      {...p}
                      value={t.question}
                      onChange={(e) => setType(i, { question: e.target.value })}
                    />
                  )}
                </Field>
                <div className="flex items-end justify-end">
                  {d.types.length > 1 ? (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${t.name}`}
                      onClick={() => setD({ ...d, types: d.types.filter((_, j) => j !== i) })}
                    >
                      <Trash2 />
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
            <div>
              <Button
                type="button"
                size="sm"
                onClick={() => setD({ ...d, types: [...d.types, newType(d.types.length + 1)] })}
              >
                <Plus /> Add a meeting type
              </Button>
            </div>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save
            </Button>
            {q.data ? (
              <Button
                type="button"
                onClick={() =>
                  void navigator.clipboard.writeText(link).then(() => toast.success('Link copied'))
                }
              >
                <Copy /> Copy link
              </Button>
            ) : null}
          </div>
        </form>
      )}
    </Pane>
  );
}
