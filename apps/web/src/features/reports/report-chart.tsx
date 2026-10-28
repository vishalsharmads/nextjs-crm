import {
  Bar,
  BarChart,
  Cell,
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
