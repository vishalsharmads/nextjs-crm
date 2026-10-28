import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ForecastDto, QuotaRowDto, VelocityDto } from '@app/shared';
import { ApiError, apiGet, apiPut } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { ReportBuilder } from './report-builder';
import { MissingRates } from './report-chart';
import { useBoot, useCan, useT } from '@/app/session';
import { Input, NativeSelect } from '@/components/ui/input';
import { Switch } from '@/components/ui/checkbox';
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Pane,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/misc';

const tooltipStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius)',
  fontSize: 12,
  color: 'var(--ink)',
};

const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });

export function ReportsPage() {
  const t = useT();
  const { pipelines } = useBoot();
  const dealPipelines = pipelines.filter((p) => p.entity === 'deal');
  const [pipelineUuid, setPipelineUuid] = useState('');
  const [convert, setConvert] = useState(false);
  return (
    <div className="flex flex-col">
      <PageHeader
        title="Reports"
        description={t('reports.description')}
        actions={
          <>
            <label className="flex items-center gap-2 text-sm text-muted">
              <Switch checked={convert} onCheckedChange={setConvert} aria-label="Convert currencies" />
              All currencies
            </label>
            {dealPipelines.length > 1 ? (
              <NativeSelect
                value={pipelineUuid}
                onChange={(e) => setPipelineUuid(e.target.value)}
                aria-label="Pipeline"
              >
                <option value="">All pipelines</option>
                {dealPipelines.map((p) => (
                  <option key={p.uuid} value={p.uuid}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
          </>
        }
      />
      <div className="p-4 md:p-6">
        <Tabs defaultValue="forecast">
          <TabsList>
            <TabsTrigger value="forecast">Forecast</TabsTrigger>
            <TabsTrigger value="quotas">Quotas</TabsTrigger>
            <TabsTrigger value="velocity">Velocity</TabsTrigger>
            <TabsTrigger value="custom">Custom</TabsTrigger>
          </TabsList>
          <TabsContent value="forecast" className="mt-4">
            <Forecast pipelineUuid={pipelineUuid} convert={convert} />
          </TabsContent>
          <TabsContent value="quotas" className="mt-4">
            <Quotas convert={convert} />
          </TabsContent>
          <TabsContent value="velocity" className="mt-4">
            <Velocity pipelineUuid={pipelineUuid} convert={convert} />
          </TabsContent>
          <TabsContent value="custom" className="mt-4">
            <ReportBuilder />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-line bg-surface p-4 shadow-raised">
      <p className="text-xs text-muted">{label}</p>
      <p className="tabular text-2xl font-semibold tracking-tight">{value}</p>
      {hint ? <p className="text-xs text-faint">{hint}</p> : null}
    </div>
  );
}

function Forecast({ pipelineUuid, convert }: { pipelineUuid: string; convert: boolean }) {
  const q = useQuery({
    queryKey: ['reports', 'forecast', pipelineUuid, convert],
    queryFn: () =>
      apiGet<ForecastDto>('/reports/forecast', {
        months: 6,
        ...(pipelineUuid ? { pipelineUuid } : {}),
        ...(convert ? { convert: true } : {}),
      }),
  });
  if (q.isPending) return <Skeleton className="h-72" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const money = (v: number) => formatMoney(v, d.currency);
  const total = d.months.reduce((s, m) => s + m.value, 0);
  const missing = <MissingRates currencies={d.missingRates} />;
  const weighted = d.months.reduce((s, m) => s + m.weighted, 0);
  return (
    <div className="flex flex-col gap-4">
      {missing}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Open, next 6 months" value={money(total)} />
        <Stat label="Weighted by stage" value={money(weighted)} />
        <Stat
          label="Overdue close dates"
          value={money(d.overdue.value)}
          hint={`${d.overdue.count} open with a past close date`}
        />
        <Stat label="No close date" value={money(d.undated.value)} hint={`${d.undated.count} open`} />
      </div>
      <Pane title="By expected close month">
        {d.months.every((m) => !m.value && !m.won) ? (
          <EmptyState
            title="Nothing to forecast yet"
            description="Set expected close dates on open records to see them here."
          />
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.months.map((m) => ({ ...m, label: monthLabel(m.month) }))}>
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={{ stroke: 'var(--line)' }}
                  tick={{ fontSize: 11, fill: 'var(--muted)' }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={72}
                  tick={{ fontSize: 11, fill: 'var(--muted)' }}
                  tickFormatter={(v: number) => money(v)}
                />
                <Tooltip
                  cursor={{ fill: 'var(--hover)' }}
                  contentStyle={tooltipStyle}
                  formatter={(v) => money(Number(v))}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar
                  dataKey="value"
                  name="Open"
                  fill="var(--line-strong)"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={36}
                />
                <Bar
                  dataKey="weighted"
                  name="Weighted"
                  fill="var(--primary)"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={36}
                />
                <Bar dataKey="won" name="Won" fill="var(--accent)" radius={[4, 4, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Pane>
    </div>
  );
}

function Quotas({ convert }: { convert: boolean }) {
  const can = useCan();
  const qc = useQueryClient();
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const q = useQuery({
    queryKey: ['reports', 'quotas', period, convert],
    queryFn: () =>
      apiGet<{ currency: string; data: QuotaRowDto[] }>('/reports/quotas', {
        period,
        ...(convert ? { convert: true } : {}),
      }),
  });
  const save = useMutation({
    mutationFn: (v: { userUuid: string; amount: number | null }) =>
      apiPut('/reports/quotas', { ...v, period }),
    onSuccess: () => {
      toast.success('Saved');
      void qc.invalidateQueries({ queryKey: ['reports', 'quotas'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the quota'),
  });
  const manage = can('core.quotas.manage');
  return (
    <Pane
      padded={false}
      title="Quota attainment"
      actions={
        <Input
          type="month"
          value={period}
          onChange={(e) => e.target.value && setPeriod(e.target.value)}
          aria-label="Month"
          className="w-40"
        />
      }
    >
      {q.isPending ? (
        <Skeleton className="m-4 h-24" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="px-4 py-2 text-start font-medium">Person</th>
                <th className="px-4 py-2 text-end font-medium">Quota</th>
                <th className="px-4 py-2 text-end font-medium">Won</th>
                <th className="w-48 px-4 py-2 text-start font-medium">Attainment</th>
                <th className="px-4 py-2 text-end font-medium">Open pipeline</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {q.data.data.map((r) => (
                <tr key={r.user.uuid}>
                  <td className="px-4 py-2">{r.user.name}</td>
                  <td className="px-4 py-2 text-end">
                    {manage ? (
                      <QuotaInput
                        value={r.quota}
                        label={`Quota for ${r.user.name}`}
                        onSave={(amount) => save.mutate({ userUuid: r.user.uuid, amount })}
                      />
                    ) : r.quota === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <span className="tabular">{formatMoney(r.quota, q.data.currency)}</span>
                    )}
                  </td>
                  <td className="tabular px-4 py-2 text-end">{formatMoney(r.won, q.data.currency)}</td>
                  <td className="px-4 py-2">
                    {r.attainment === null ? (
                      <span className="text-faint">No quota</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div
                          className="h-2 flex-1 overflow-hidden rounded-full bg-subtle"
                          role="progressbar"
                          aria-valuenow={Math.round(r.attainment * 100)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={`${r.user.name} attainment`}
                        >
                          <div
                            className="h-full bg-primary"
                            style={{ width: `${Math.min(100, r.attainment * 100)}%` }}
                          />
                        </div>
                        <span className="tabular w-12 text-end">{Math.round(r.attainment * 100)}%</span>
                      </div>
                    )}
                  </td>
                  <td className="tabular px-4 py-2 text-end">
                    {formatMoney(r.openPipeline, q.data.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Pane>
  );
}

function QuotaInput({
  value,
  label,
  onSave,
}: {
  value: number | null;
  label: string;
  onSave: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const commit = () => {
    const next = draft.trim() === '' ? null : Number(draft);
    if (next !== null && (Number.isNaN(next) || next < 0))
      return setDraft(value === null ? '' : String(value));
    if (next !== value) onSave(next);
  };
  return (
    <Input
      type="number"
      min={0}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      aria-label={label}
      className="ms-auto w-32 text-end"
    />
  );
}

function Velocity({ pipelineUuid, convert }: { pipelineUuid: string; convert: boolean }) {
  const [days, setDays] = useState(90);
  const q = useQuery({
    queryKey: ['reports', 'velocity', pipelineUuid, days, convert],
    queryFn: () =>
      apiGet<VelocityDto>('/reports/velocity', {
        days,
        ...(pipelineUuid ? { pipelineUuid } : {}),
        ...(convert ? { convert: true } : {}),
      }),
  });
  if (q.isPending) return <Skeleton className="h-72" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const money = (v: number | null) => (v === null ? '—' : formatMoney(v, d.currency));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm text-muted">
        Closed in the last
        <NativeSelect
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="Period"
          className="w-28"
        >
          {[30, 90, 180, 365].map((n) => (
            <option key={n} value={n}>
              {n} days
            </option>
          ))}
        </NativeSelect>
      </div>
      <MissingRates currencies={d.missingRates} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Win rate"
          value={d.winRate === null ? '—' : `${Math.round(d.winRate * 100)}%`}
          hint={`${d.won} won · ${d.lost} lost`}
        />
        <Stat label="Average won value" value={money(d.avgWonValue)} />
        <Stat label="Average cycle" value={d.avgCycleDays === null ? '—' : `${d.avgCycleDays} days`} />
        <Stat
          label="Velocity"
          value={d.velocityPerDay === null ? '—' : `${money(d.velocityPerDay)} / day`}
          hint={`${d.open} open`}
        />
      </div>
      <Pane title="Average time in stage" padded={false}>
        {!d.stages.length ? (
          <p className="p-4 text-sm text-muted">No stages.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="px-4 py-2 text-start font-medium">Stage</th>
                <th className="px-4 py-2 text-end font-medium">Entered</th>
                <th className="px-4 py-2 text-end font-medium">Average days</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.stages.map((s) => (
                <tr key={s.uuid}>
                  <td className="px-4 py-2">{s.name}</td>
                  <td className="tabular px-4 py-2 text-end">{s.entered}</td>
                  <td className="tabular px-4 py-2 text-end">{s.avgDays ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Pane>
    </div>
  );
}
