import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarCheck, CheckCircle2 } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useBranding } from '@/app/branding';
import { setDocumentTitle } from '@/theme/apply';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';

interface PublicPage {
  title: string;
  intro: string;
  host: string;
  timeZone: string;
  meetingTypes: {
    key: string;
    name: string;
    durationMin: number;
    questions: { key: string; label: string; required: boolean }[];
  }[];
}

/** The visitor's own time zone: times are shown as they will see them in their calendar. */
const visitorZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayLabel = (d: Date) =>
  d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: visitorZone });
const timeLabel = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: visitorZone });

/** Public: pick a meeting type, a time and book (no sign-in). */
export function PublicBookingPage() {
  const { slug = '' } = useParams();
  const { branding } = useBranding();
  const page = useQuery({
    queryKey: ['public-booking', slug],
    queryFn: () => apiGet<PublicPage>(`/public/book/${slug}`),
    retry: false,
  });
  const [typeKey, setTypeKey] = useState<string | null>(null);
  const type =
    page.data?.meetingTypes.find((t) => t.key === typeKey) ??
    (page.data?.meetingTypes.length === 1 ? page.data.meetingTypes[0] : undefined);
  const slots = useQuery({
    queryKey: ['public-booking-slots', slug, type?.key],
    queryFn: () =>
      apiGet<{ slots: string[] }>(`/public/book/${slug}/slots`, { type: type!.key }).then((r) =>
        r.slots.map((s) => new Date(s)),
      ),
    enabled: !!type,
  });
  const [chosen, setChosen] = useState<Date | null>(null);
  const [form, setForm] = useState({ name: '', email: '', website: '' });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (page.data) setDocumentTitle(page.data.title, branding.appName);
  }, [page.data, branding.appName]);

  const days = useMemo(() => {
    const map = new Map<string, Date[]>();
    for (const s of slots.data ?? []) {
      const k = dayLabel(s);
      map.set(k, [...(map.get(k) ?? []), s]);
    }
    return [...map.entries()].slice(0, 14);
  }, [slots.data]);

  const book = useMutation({
    mutationFn: async () => {
      // Public endpoint: no session and no CSRF token by design.
      const res = await fetch(`/api/v1/public/book/${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type!.key, start: chosen!.toISOString(), ...form, answers }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? 'The booking could not be made. Try again.');
      return body;
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'The booking could not be made.');
      void slots.refetch();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    book.mutate();
  };

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      {page.isPending ? (
        <Skeleton className="h-64" />
      ) : page.isError ? (
        <EmptyState
          icon={<CalendarCheck />}
          title="This booking page is not available"
          description="Check the link, or ask for a new one."
        />
      ) : book.isSuccess ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center" role="status">
          <CheckCircle2 className="size-10 text-primary" />
          <h1 className="text-xl font-semibold">You are booked</h1>
          <p className="text-muted">
            {type?.name} with {page.data.host}, {chosen ? `${dayLabel(chosen)} at ${timeLabel(chosen)}` : ''}.
            An invitation is on its way to your inbox, with a link to cancel if you need to.
          </p>
        </div>
      ) : (
        <>
          <h1 className="text-title font-semibold">{page.data.title}</h1>
          <p className="mt-1 text-sm text-muted">With {page.data.host}</p>
          {page.data.intro ? <p className="mt-3 whitespace-pre-line">{page.data.intro}</p> : null}
          {page.data.meetingTypes.length > 1 ? (
            <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Meeting type">
              {page.data.meetingTypes.map((t) => (
                <Button
                  key={t.key}
                  variant={type?.key === t.key ? 'primary' : 'secondary'}
                  aria-pressed={type?.key === t.key}
                  onClick={() => {
                    setTypeKey(t.key);
                    setChosen(null);
                  }}
                >
                  {t.name} · {t.durationMin} min
                </Button>
              ))}
            </div>
          ) : null}
          {type ? (
            <section className="mt-6" aria-label="Times">
              <p className="mb-2 text-xs text-muted">Times are shown in your time zone ({visitorZone}).</p>
              {slots.isPending ? (
                <Skeleton className="h-40" />
              ) : slots.isError ? (
                <ErrorState error={slots.error} onRetry={() => void slots.refetch()} />
              ) : !days.length ? (
                <EmptyState
                  title="No free times"
                  description="There is nothing free in the coming weeks. Try again later."
                />
              ) : (
                <div className="flex flex-col gap-4">
                  {days.map(([day, times]) => (
                    <div key={day}>
                      <h2 className="mb-1.5 text-sm font-medium">{day}</h2>
                      <div className="flex flex-wrap gap-1.5">
                        {times.map((t) => (
                          <button
                            key={t.toISOString()}
                            type="button"
                            aria-pressed={chosen?.getTime() === t.getTime()}
                            onClick={() => setChosen(t)}
                            className={cn(
                              'rounded-sm border px-2.5 py-1 text-sm tabular pointer-coarse:py-2',
                              chosen?.getTime() === t.getTime()
                                ? 'border-primary bg-primary text-primary-fg'
                                : 'border-line hover:bg-hover',
                            )}
                          >
                            {timeLabel(t)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : null}
          {type && chosen ? (
            <form className="mt-8 flex flex-col gap-3 border-t border-line pt-6" onSubmit={submit}>
              <p className="font-medium">
                {type.name}, {dayLabel(chosen)} at {timeLabel(chosen)}
              </p>
              <Field label="Your name" required>
                {(p) => (
                  <Input
                    {...p}
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Email" required>
                {(p) => (
                  <Input
                    {...p}
                    type="email"
                    required
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                )}
              </Field>
              {type.questions.map((q) => (
                <Field key={q.key} label={q.label} required={q.required}>
                  {(p) => (
                    <Textarea
                      {...p}
                      required={q.required}
                      value={answers[q.key] ?? ''}
                      onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })}
                    />
                  )}
                </Field>
              ))}
              {/* Left empty by people; bots fill it in. */}
              <input
                type="text"
                name="website"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                className="sr-only"
                value={form.website}
                onChange={(e) => setForm({ ...form, website: e.target.value })}
              />
              {error ? (
                <p role="alert" className="text-sm text-accent">
                  {error}
                </p>
              ) : null}
              <div>
                <Button type="submit" variant="primary" loading={book.isPending}>
                  Book
                </Button>
              </div>
            </form>
          ) : null}
        </>
      )}
    </main>
  );
}

interface ManagedBooking {
  title: string;
  slug: string;
  type: string;
  start: string;
  end: string | null;
  cancelled: boolean;
}

/** Public: the visitor's own booking, from the link in their invitation, with Cancel. */
export function ManageBookingPage() {
  const { token = '' } = useParams();
  const q = useQuery({
    queryKey: ['public-booking-manage', token],
    queryFn: () => apiGet<ManagedBooking>(`/public/book/manage/${token}`),
    retry: false,
  });
  const cancel = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v1/public/book/manage/${token}/cancel`, { method: 'POST' });
      if (!res.ok) throw new Error('The booking could not be cancelled. It may have been cancelled already.');
    },
    onSuccess: () => void q.refetch(),
  });
  return (
    <main className="mx-auto w-full max-w-lg px-4 py-10">
      {q.isPending ? (
        <Skeleton className="h-32" />
      ) : q.isError ? (
        <EmptyState
          icon={<CalendarCheck />}
          title="This booking was not found"
          description="Check the link in your invitation."
        />
      ) : (
        <div className="flex flex-col gap-3">
          <h1 className="text-xl font-semibold">{q.data.title}</h1>
          <p>
            {q.data.type}, {dayLabel(new Date(q.data.start))} at {timeLabel(new Date(q.data.start))}
          </p>
          {q.data.cancelled ? (
            <p role="status" className="text-muted">
              This booking is cancelled.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" onClick={() => cancel.mutate()} loading={cancel.isPending}>
                Cancel booking
              </Button>
              <Button asChild>
                <Link to={`/book/${q.data.slug}`}>Book another time</Link>
              </Button>
            </div>
          )}
          {cancel.isError ? (
            <p role="alert" className="text-sm text-accent">
              {cancel.error.message}
            </p>
          ) : null}
        </div>
      )}
    </main>
  );
}
