import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertCircle, Blocks } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatMoney, formatRelative } from '@/lib/format';
import { useBranding } from '@/app/branding';
import { useBoot, useT } from '@/app/session';
import { setDocumentTitle } from '@/theme/apply';
import { PageHeader, Skeleton } from '@/components/ui/misc';
import { labelVars } from '@/lib/labels';
import { ModuleWidget } from '@/modules/loader';

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

export function DashboardPage() {
  const t = useT();
  const { me } = useBoot();
  const { branding } = useBranding();
  useEffect(() => setDocumentTitle(t('nav.home'), branding.appName), [t, branding.appName]);
  const dashboards = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => apiGet<{ data: Dashboard[] }>('/dashboards').then((r) => r.data),
  });
  const dash = dashboards.data?.find((d) => !d.shared) ?? dashboards.data?.[0];
  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title={t('home.greeting', { name: me.firstName || me.email })}
        description={new Intl.DateTimeFormat(undefined, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        }).format(new Date())}
      />
      <div className="grid grid-flow-row-dense gap-4 p-4 md:p-6 lg:grid-cols-3">
        {dashboards.isPending
          ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-56 lg:col-span-1" />)
          : dash?.widgets.map((w) => (
              <section
                key={w.key}
                className={cn(
                  'flex min-h-56 flex-col rounded-md border border-line bg-surface p-4',
                  SPAN[w.size],
                )}
              >
                <h2 className="mb-3 text-sm font-semibold">{w.title ?? w.type}</h2>
                <WidgetBody widget={w} />
              </section>
            ))}
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
  if (q.isPending) return <Skeleton className="flex-1" />;
  if (q.isError) return <Muted icon={<AlertCircle />}>This could not be loaded.</Muted>;
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
  return (
    <div className="flex flex-1 flex-col gap-4">
      <dl className="flex gap-8">
        <Stat label="Open value" value={money(data.total)} />
        <Stat label="Weighted by probability" value={money(data.weighted)} />
        <Stat label="Open" value={data.count} />
      </dl>
      <div className="h-44 min-h-0 flex-1" aria-label="Value by stage">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.stages} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="name"
              tickLine={false}
              axisLine={{ stroke: 'var(--line)' }}
              tick={{ fontSize: 11, fill: 'var(--muted)' }}
              interval={0}
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
    <div className="h-48 flex-1" aria-label="Completed activities by person">
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
