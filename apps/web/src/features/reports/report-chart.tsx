import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ReportDefinition, ReportResultDto } from '@app/shared';
import { formatMoney } from '@/lib/format';

const tooltipStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius)',
  fontSize: 12,
  color: 'var(--ink)',
};

/** Theme tokens only: slices cycle through the brand colors. */
const SLICES = [
  'var(--primary)',
  'var(--accent)',
  'var(--secondary)',
  'var(--line-strong)',
  'var(--muted)',
  'var(--faint)',
];

export function formatReportValue(
  v: number,
  d: Pick<ReportDefinition, 'metric' | 'metricField'>,
  currency?: string,
) {
  if (d.metric !== 'count' && currency && d.metricField === 'value') return formatMoney(v, currency);
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function ReportChart({
  result,
  definition,
  currency,
  height = 260,
}: {
  result: ReportResultDto;
  definition: ReportDefinition;
  currency?: string;
  height?: number;
}) {
  const fmt = (v: number) => formatReportValue(v, definition, currency);
  if (!result.rows.length) return <p className="py-8 text-center text-sm text-muted">No records match.</p>;
  const series = result.series;
  if (series?.length) {
    if (definition.chart === 'table')
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-1.5 pe-3 text-start font-medium" />
                {series.map((c) => (
                  <th key={c.key} className="px-2 py-1.5 text-end font-medium">
                    {c.label}
                  </th>
                ))}
                <th className="py-1.5 ps-2 text-end font-medium">
                  {definition.metric === 'avg' ? 'Average' : 'Total'}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {result.rows.map((r) => (
                <tr key={r.key ?? 'none'}>
                  <td className="py-1.5 pe-3">{r.label}</td>
                  {series.map((c) => (
                    <td key={c.key} className="tabular px-2 py-1.5 text-end">
                      {r.breakdown?.[c.key] !== undefined ? fmt(r.breakdown[c.key]!) : '—'}
                    </td>
                  ))}
                  <td className="tabular py-1.5 ps-2 text-end font-medium">{fmt(r.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    // Stacked bars, one segment per series.
    const data = result.rows.map((r) => ({ label: r.label, ...(r.breakdown ?? {}) }));
    return (
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <XAxis
              dataKey="label"
              tickLine={false}
              tick={{ fontSize: 11, fill: 'var(--muted)' }}
              axisLine={{ stroke: 'var(--line)' }}
            />
            <YAxis
              tickLine={false}
              tick={{ fontSize: 11, fill: 'var(--muted)' }}
              axisLine={false}
              width={64}
              tickFormatter={fmt}
            />
            <Tooltip
              cursor={{ fill: 'var(--hover)' }}
              contentStyle={tooltipStyle}
              formatter={(v) => fmt(Number(v))}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {series.map((c, i) => (
              <Bar
                key={c.key}
                dataKey={c.key}
                name={c.label}
                stackId="s"
                fill={SLICES[i % SLICES.length]}
                maxBarSize={40}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }
  if (definition.chart === 'table')
    return (
      <table className="w-full text-sm">
        <tbody className="divide-y divide-line">
          {result.rows.map((r) => (
            <tr key={r.key ?? 'none'}>
              <td className="py-1.5 pe-3">{r.label}</td>
              <td className="tabular py-1.5 text-end">{fmt(r.value)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line-strong font-medium">
            <td className="py-1.5 pe-3">{definition.metric === 'avg' ? 'Average' : 'Total'}</td>
            <td className="tabular py-1.5 text-end">{fmt(result.total)}</td>
          </tr>
        </tfoot>
      </table>
    );
  const axis = { tickLine: false, tick: { fontSize: 11, fill: 'var(--muted)' } };
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {definition.chart === 'pie' ? (
          <PieChart>
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmt(Number(v))} />
            <Pie
              data={result.rows}
              dataKey="value"
              nameKey="label"
              innerRadius="45%"
              outerRadius="80%"
              paddingAngle={1}
            >
              {result.rows.map((r, i) => (
                <Cell key={r.key ?? i} fill={SLICES[i % SLICES.length]} stroke="var(--surface)" />
              ))}
            </Pie>
          </PieChart>
        ) : definition.chart === 'line' ? (
          <LineChart data={result.rows}>
            <XAxis dataKey="label" {...axis} axisLine={{ stroke: 'var(--line)' }} />
            <YAxis {...axis} axisLine={false} width={64} tickFormatter={fmt} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => fmt(Number(v))} />
            <Line dataKey="value" stroke="var(--primary)" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        ) : (
          <BarChart data={result.rows}>
            <XAxis dataKey="label" {...axis} axisLine={{ stroke: 'var(--line)' }} />
            <YAxis {...axis} axisLine={false} width={64} tickFormatter={fmt} />
            <Tooltip
              cursor={{ fill: 'var(--hover)' }}
              contentStyle={tooltipStyle}
              formatter={(v) => fmt(Number(v))}
            />
            <Bar dataKey="value" fill="var(--primary)" radius={[4, 4, 0, 0]} maxBarSize={40} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/** Converted reports leave out currencies without a rate; say which. */
export function MissingRates({ currencies }: { currencies?: string[] | undefined }) {
  if (!currencies?.length) return null;
  return (
    <p className="rounded-md border border-line bg-subtle px-3 py-2 text-sm text-muted" role="status">
      Not included, because they have no exchange rate: {currencies.join(', ')}. Add rates in Settings →
      Currencies.
    </p>
  );
}
