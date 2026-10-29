import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ReportDefinition, ReportResultDto, SavedReportDto } from '@app/shared';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertCircle, ArrowDown, ArrowUp, Blocks, Pencil, X } from 'lucide-react';
import { ApiError, apiDelete, apiGet, apiPost, apiPut } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatMoney, formatRelative } from '@/lib/format';
import { useBranding } from '@/app/branding';
import { useBoot, useCan, useT } from '@/app/session';
import { setDocumentTitle } from '@/theme/apply';
import { Button } from '@/components/ui/button';
import { PageHeader, Skeleton } from '@/components/ui/misc';
import { NativeSelect } from '@/components/ui/input';
import { ReportChart } from '@/features/reports/report-chart';
import { labelVars } from '@/lib/labels';
import { ModuleWidget } from '@/modules/loader';
import { orderWidgets } from './dashboard-layout';

interface Widget {
  key: string;
  type: string;
  title?: string;
  size: 'sm' | 'md' | 'lg';
  params: Record<string, unknown>;
}
interface Dashboard {
  uuid: string;
  name: string;
  widgets: Widget[];
  shared: boolean;
}

const SPAN: Record<Widget['size'], string> = {
  sm: 'lg:col-span-1',
  md: 'lg:col-span-2',
  lg: 'lg:col-span-3',
};

/** Widgets anyone can add; module widgets come from the shared dashboard. */
const BUILT_IN: { type: string; title: string; size: Widget['size'] }[] = [
  { type: 'pipeline_value', title: 'Pipeline', size: 'lg' },
  { type: 'tasks_due', title: 'Tasks due', size: 'sm' },
  { type: 'conversion', title: 'Conversion', size: 'sm' },
  { type: 'activity_by_user', title: 'Activity by person', size: 'md' },
];

export function DashboardPage() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const { me } = useBoot();
  const { branding } = useBranding();
  useEffect(() => setDocumentTitle(t('nav.home'), branding.appName), [t, branding.appName]);
  const dashboards = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => apiGet<{ data: Dashboard[] }>('/dashboards').then((r) => r.data),
  });
  const personal = dashboards.data?.find((d) => !d.shared);
  const dash = personal ?? dashboards.data?.[0];
  const [draft, setDraft] = useState<Widget[] | null>(null);
  const reports = useQuery({
    queryKey: ['reports', 'custom'],
    queryFn: () => apiGet<{ data: SavedReportDto[] }>('/reports/custom').then((r) => r.data),
    enabled: !!draft && can('core.reports.view'),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['dashboards'] });
  const save = useMutation({
    mutationFn: (widgets: Widget[]) =>
      personal
        ? apiPut(`/dashboards/${personal.uuid}`, { widgets })
        : apiPost('/dashboards', { name: 'My dashboard', widgets }),
    onSuccess: () => {
      toast.success('Saved');
      setDraft(null);
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the dashboard'),
  });
  const reset = useMutation({
    mutationFn: () => apiDelete(`/dashboards/${personal!.uuid}`),
    onSuccess: () => {
      toast.success('Reset');
      setDraft(null);
      refresh();
    },
  });
  const editing = draft !== null;
  const shown = editing ? draft : orderWidgets(dash?.widgets ?? []);
  const update = (i: number, w: Widget | null) =>
    setDraft((cur) =>
      cur ? (w ? cur.map((x, j) => (j === i ? w : x)) : cur.filter((_, j) => j !== i)) : cur,
    );
  const move = (i: number, d: -1 | 1) =>
    setDraft((cur) => {
      if (!cur || !cur[i + d]) return cur;
      const next = [...cur];
      [next[i], next[i + d]] = [next[i + d]!, next[i]!];
      return next;
    });
  const add = (value: string) => {
    if (!value || !draft) return;
    const key = `w_${Date.now().toString(36)}`;
    if (value.startsWith('report:')) {
      const r = reports.data?.find((x) => x.uuid === value.slice(7));
      if (r)
        setDraft([...draft, { key, type: 'report', title: r.name, size: 'md', params: { report: r.uuid } }]);
      return;
    }
    const b = BUILT_IN.find((x) => x.type === value);
    if (b) setDraft([...draft, { key, type: b.type, title: b.title, size: b.size, params: {} }]);
  };
  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title={t('home.greeting', { name: me.firstName || me.email })}
        description={new Intl.DateTimeFormat(undefined, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        }).format(new Date())}
        actions={
          editing ? (
            <>
              <NativeSelect
                aria-label="Add widget"
                value=""
                onChange={(e) => add(e.target.value)}
                className="w-48"
              >
                <option value="">Add a widget…</option>
                {BUILT_IN.map((b) => (
                  <option key={b.type} value={b.type}>
                    {b.title}
                  </option>
                ))}
                {reports.data?.map((r) => (
                  <option key={r.uuid} value={`report:${r.uuid}`}>
                    Report: {r.name}
                  </option>
                ))}
              </NativeSelect>
              {personal ? (
                <Button variant="ghost" onClick={() => reset.mutate()} loading={reset.isPending}>
                  Reset to shared
                </Button>
              ) : null}
              <Button onClick={() => setDraft(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => save.mutate(draft)} loading={save.isPending}>
                Save
              </Button>
            </>
          ) : dash ? (
            <Button data-tour="dashboard-edit" onClick={() => setDraft(dash.widgets)}>
              <Pencil /> Edit dashboard
            </Button>
          ) : null
        }
      />
      {/* Rows are as tall as their content needs (no fixed minimum), so short widgets stop leaving dead space. */}
      <div className="grid grid-flow-row-dense gap-4 p-4 md:p-6 lg:grid-cols-3">
        {dashboards.isPending
          ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-40 lg:col-span-1" />)
          : shown.map((w, i) => (
              <section
                key={w.key}
                className={cn(
                  'flex min-h-32 flex-col rounded-md border border-line bg-surface p-4',
                  w.type === 'pipeline_value' && 'shadow-raised',
                  editing && 'border-dashed border-line-strong',
                  SPAN[w.size],
                )}
              >
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{w.title ?? w.type}</h2>
                  {editing ? (
                    <div className="flex items-center gap-1">
                      <NativeSelect
                        aria-label={`Size of ${w.title ?? w.type}`}
                        value={w.size}
                        onChange={(e) => update(i, { ...w, size: e.target.value as Widget['size'] })}
                        className="h-7 w-24 text-xs"
                      >
                        <option value="sm">Small</option>
                        <option value="md">Medium</option>
                        <option value="lg">Wide</option>
                      </NativeSelect>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Move earlier"
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Move later"
                        disabled={i === shown.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${w.title ?? w.type}`}
                        onClick={() => update(i, null)}
                      >
                        <X />
                      </Button>
                    </div>
                  ) : null}
                </div>
                <WidgetBody widget={w} />
              </section>
            ))}
        {editing && !shown.length ? (
          <p className="text-sm text-muted lg:col-span-3">No widgets. Add one from the menu above.</p>
        ) : null}
      </div>
    </div>
  );
}

function useWidget<T>(w: Widget) {
  return useQuery({
    queryKey: ['widget', w.type, w.params],
    queryFn: () =>
      apiGet<T & { unavailable?: boolean; reason?: string }>(`/dashboards/widgets/${w.type}/data`, {
        params: JSON.stringify(w.params),
      }),
    staleTime: 60_000,
  });
}

function WidgetBody({ widget }: { widget: Widget }) {
  const q = useWidget<Record<string, unknown>>(widget);
  if (q.isPending) return <Skeleton className="h-24 flex-1" />;
  if (q.isError)
    return (
      <Muted icon={<AlertCircle />}>
        Could not load this widget.
        <Button size="sm" onClick={() => void q.refetch()}>
          Try again
        </Button>
      </Muted>
    );
  if (q.data.unavailable) {
    return (
      <Muted icon={<Blocks />}>
        {q.data.reason === 'module_disabled' || q.data.reason === 'module_not_available'
          ? 'Available when this module is turned on.'
          : 'Not available for your role.'}
      </Muted>
    );
  }
  switch (widget.type) {
    case 'pipeline_value':
      return <PipelineValue data={q.data as never} />;
    case 'tasks_due':
      return <TasksDue data={q.data as never} />;
    case 'conversion':
      return <Conversion data={q.data as never} />;
    case 'activity_by_user':
      return <ActivityByUser data={q.data as never} />;
    case 'date_window':
      return <DateWindow data={q.data as never} />;
    case 'report': {
      const r = q.data as unknown as { definition: ReportDefinition; result: ReportResultDto };
      return <ReportChart result={r.result} definition={r.definition} height={200} />;
    }
    default:
      if (widget.type.startsWith('module:'))
        return <ModuleWidget type={widget.type.slice(7)} data={q.data} />;
      return <Muted>Unknown widget</Muted>;
  }
}

function Muted({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted [&_svg]:size-5 [&_svg]:text-faint">
      {icon}
      {children}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'accent' }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn('text-2xl font-semibold tracking-tight tabular', tone === 'accent' && 'text-accent')}>
        {value}
      </dd>
    </div>
  );
}

const tooltipStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius)',
  fontSize: 12,
  color: 'var(--ink)',
};

function PipelineValue({
  data,
}: {
  data: {
    stages: { name: string; value: number; count: number; probability: number }[];
    total: number;
    weighted: number;
    count: number;
  };
}) {
  const { settings } = useBoot();
  const money = (v: number) => formatMoney(v, settings.general.currency);
  // Stage names collide when each gets less than about 96px, so they are tilted instead of overlapping.
  const [chartWidth, setChartWidth] = useState(0);
  const crowded = chartWidth > 0 && chartWidth / Math.max(1, data.stages.length) < 96;
  return (
    <div className="flex flex-1 flex-col gap-4">
      <dl className="flex gap-8">
        <Stat label="Open value" value={money(data.total)} />
        <Stat label="Weighted by probability" value={money(data.weighted)} />
        <Stat label="Open" value={data.count} />
      </dl>
      <div className="h-44 shrink-0 grow" aria-label="Value by stage">
        <ResponsiveContainer width="100%" height="100%" onResize={(w) => setChartWidth(w)}>
          <BarChart data={data.stages} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="name"
              tickLine={false}
              axisLine={{ stroke: 'var(--line)' }}
              tick={{ fontSize: 11, fill: 'var(--muted)' }}
              interval={0}
              angle={crowded ? -35 : 0}
              textAnchor={crowded ? 'end' : 'middle'}
              height={crowded ? 56 : 30}
              tickMargin={crowded ? 8 : 2}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={64}
              tick={{ fontSize: 11, fill: 'var(--muted)' }}
              tickFormatter={(v: number) => money(v)}
            />
            <Tooltip
              cursor={{ fill: 'var(--hover)' }}
              contentStyle={tooltipStyle}
              formatter={(v, _n, item) => [
                `${money(Number(v))} · ${(item.payload as { count: number }).count} open`,
                'Value',
              ]}
            />
            <Bar dataKey="value" fill="var(--primary)" radius={[4, 4, 0, 0]} maxBarSize={40} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function TasksDue({
  data,
}: {
  data: {
    overdue: number;
    upcoming: number;
    next: { uuid: string; subject: string; dueAt: string; overdue: boolean }[];
  };
}) {
  return (
    <div className="flex flex-1 flex-col gap-3">
      <dl className="flex gap-8">
        <Stat label="Overdue" value={data.overdue} tone={data.overdue ? 'accent' : undefined} />
        <Stat label="Due this week" value={data.upcoming} />
      </dl>
      {data.next.length ? (
        <ul className="flex flex-col divide-y divide-line text-sm">
          {data.next.map((n) => (
            <li key={n.uuid} className="flex items-center justify-between gap-3 py-1.5">
              <span className="truncate">{n.subject}</span>
              <span className={cn('shrink-0 text-xs', n.overdue ? 'text-accent' : 'text-muted')}>
                {formatRelative(n.dueAt)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Muted>Nothing due. Nice.</Muted>
      )}
      <Link to="/tasks" className="mt-auto text-xs text-primary hover:underline">
        Open my tasks
      </Link>
    </div>
  );
}

function Conversion({
  data,
}: {
  data: {
    days: number;
    won: number;
    lost: number;
    created: number;
    winRate: number | null;
    wonValue: number;
  };
}) {
  const { settings, labels } = useBoot();
  const L = labelVars(labels);
  return (
    <dl className="grid flex-1 grid-cols-2 content-start gap-4">
      <Stat
        label={`Win rate, last ${data.days} days`}
        value={data.winRate === null ? '—' : `${data.winRate}%`}
      />
      <Stat label="Won value" value={formatMoney(data.wonValue, settings.general.currency)} />
      <Stat label={`${L.dealPlural} won`} value={data.won} />
      <Stat label="Lost" value={data.lost} />
    </dl>
  );
}

function ActivityByUser({ data }: { data: { days: number; users: { name: string; total: number }[] } }) {
  if (!data.users.length) return <Muted>No completed activities in the last {data.days} days.</Muted>;
  return (
    <div className="h-48 shrink-0 grow" aria-label="Completed activities by person">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data.users} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
          <XAxis type="number" hide allowDecimals={false} />
          <YAxis
            type="category"
            dataKey="name"
            width={110}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: 'var(--ink)' }}
          />
          <Tooltip
            cursor={{ fill: 'var(--hover)' }}
            contentStyle={tooltipStyle}
            formatter={(v) => [Number(v), 'Completed']}
          />
          <Bar
            dataKey="total"
            fill="var(--primary)"
            radius={[0, 4, 4, 0]}
            maxBarSize={18}
            label={{ position: 'right', fontSize: 11, fill: 'var(--muted)' }}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function DateWindow({
  data,
}: {
  data: {
    days: number;
    total: number;
    items: { uuid: string; title: string; date: string }[];
    route: string;
  };
}) {
  const route =
    { deal: 'deals', contact: 'contacts', organization: 'organizations', lead: 'leads' }[data.route] ??
    'deals';
  return (
    <div className="flex flex-1 flex-col gap-3">
      <dl>
        <Stat label={`In the next ${data.days} days`} value={data.total} />
      </dl>
      {data.items.length ? (
        <ul className="flex flex-col divide-y divide-line text-sm">
          {data.items.map((i) => (
            <li key={i.uuid} className="flex items-center justify-between gap-3 py-1.5">
              <Link to={`/${route}/${i.uuid}`} className="truncate hover:underline">
                {i.title}
              </Link>
              <span className="shrink-0 text-xs text-muted">{formatDate(i.date)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Muted>Nothing coming up.</Muted>
      )}
    </div>
  );
}
