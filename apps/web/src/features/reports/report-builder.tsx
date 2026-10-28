import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import {
  isCoreEntity,
  type FilterCondition,
  type ReportDefinition,
  type ReportResultDto,
  type SavedReportDto,
} from '@app/shared';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { useBoot, useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Switch } from '@/components/ui/checkbox';
import { EmptyState, ErrorState, Pane, Skeleton } from '@/components/ui/misc';
import { FilterBar } from '@/components/data/filter-bar';
import { buildConfig, type FieldConfig } from '@/features/records/entities';
import { ReportChart } from './report-chart';

const savedKey = ['reports', 'custom'] as const;
const GROUP_KINDS = new Set(['select', 'date', 'datetime', 'user']);

/** Fields a report can group by and sum: whitelisted again by the API. */
function reportFields(fields: FieldConfig[]) {
  const group = fields.filter(
    (f) =>
      f.filterable &&
      (GROUP_KINDS.has(f.kind) ||
        f.key === 'stage' ||
        f.key === 'pipeline' ||
        (f.kind === 'custom' && ['select', 'date', 'datetime', 'boolean'].includes(f.def?.type ?? ''))),
  );
  const numbers = fields.filter((f) =>
    (f.kind === 'money' || f.kind === 'number') && f.filterable !== false
      ? true
      : f.kind === 'custom' && f.def?.filterable && ['number', 'decimal', 'currency'].includes(f.def.type),
  );
  return { group, numbers };
}

const blank = (entity: string): ReportDefinition => ({
  entity,
  groupBy: entity === 'deal' ? 'stage' : 'owner',
  dateBucket: 'month',
  metric: 'count',
  metricField: null,
  filter: null,
  chart: 'bar',
});

export function ReportBuilder() {
  const boot = useBoot();
  const can = useCan();
  const qc = useQueryClient();
  const saved = useQuery({
    queryKey: savedKey,
    queryFn: () => apiGet<{ data: SavedReportDto[] }>('/reports/custom').then((r) => r.data),
  });
  const [current, setCurrent] = useState<SavedReportDto | null>(null);
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [def, setDef] = useState<ReportDefinition>(blank('deal'));
  const [conditions, setConditions] = useState<FilterCondition[]>([]);

  const entities = [
    ...['deal', 'contact', 'organization', 'lead', 'activity'].filter((e) => {
      if (e === 'lead' && !boot.settings.features.leads) return false;
      return can(`core.${e === 'activity' ? 'activities' : `${e}s`}.view`);
    }),
    ...boot.recordTypes.filter((t) => can(`${t.resource}.view`)).map((t) => t.entity),
  ];
  const config = useMemo(() => buildConfig(def.entity, boot), [def.entity, boot]);
  const { group, numbers } = reportFields(config.fields as FieldConfig[]);
  const definition: ReportDefinition = { ...def, filter: conditions.length ? { and: conditions } : null };
  const groupField = group.find((f) => f.key === def.groupBy);
  const isDate =
    groupField?.kind === 'date' ||
    groupField?.kind === 'datetime' ||
    ['date', 'datetime'].includes(groupField?.def?.type ?? '');

  const preview = useQuery({
    queryKey: ['reports', 'preview', definition],
    queryFn: () => apiPost<ReportResultDto>('/reports/custom/preview', definition),
    enabled: !!def.groupBy && (def.metric === 'count' || !!def.metricField),
    retry: false,
  });
  const save = useMutation({
    mutationFn: () =>
      current?.mine
        ? apiPatch<SavedReportDto>(`/reports/custom/${current.uuid}`, { name, shared, definition })
        : apiPost<SavedReportDto>('/reports/custom', { name, shared, definition }),
    onSuccess: (r) => {
      toast.success('Saved');
      setCurrent(r);
      void qc.invalidateQueries({ queryKey: savedKey });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the report'),
  });
  const remove = useMutation({
    mutationFn: (uuid: string) => apiDelete(`/reports/custom/${uuid}`),
    onSuccess: () => {
      toast.success('Deleted');
      startNew();
      void qc.invalidateQueries({ queryKey: savedKey });
    },
  });
  const open = (r: SavedReportDto) => {
    setCurrent(r);
    setName(r.name);
    setShared(r.shared);
    setDef({ ...blank(r.definition.entity), ...r.definition });
    const f = r.definition.filter;
    setConditions(f && 'and' in f ? (f.and as FilterCondition[]) : f ? [f as FilterCondition] : []);
  };
  function startNew() {
    setCurrent(null);
    setName('');
    setShared(false);
    setDef(blank(entities[0] ?? 'deal'));
    setConditions([]);
  }
  const set = (patch: Partial<ReportDefinition>) => setDef({ ...def, ...patch });
  const currency = isCoreEntity(def.entity) ? boot.settings.general.currency : undefined;

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      <Pane padded={false} className="h-fit">
        <div className="border-b border-line p-2">
          <Button size="sm" className="w-full" onClick={startNew}>
            <Plus /> New report
          </Button>
        </div>
        {saved.isPending ? (
          <Skeleton className="m-3 h-16" />
        ) : saved.isError ? (
          <ErrorState error={saved.error} onRetry={() => void saved.refetch()} />
        ) : !saved.data.length ? (
          <p className="p-3 text-sm text-muted">No saved reports yet.</p>
        ) : (
          <ul>
            {saved.data.map((r) => (
              <li key={r.uuid}>
                <button
                  type="button"
                  onClick={() => open(r)}
                  className={`w-full px-3 py-2 text-start text-sm hover:bg-subtle ${current?.uuid === r.uuid ? 'bg-subtle font-medium' : ''}`}
                >
                  {r.name}
                  {r.shared ? <span className="ms-1 text-xs text-faint">· shared</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Pane>
      <div className="flex flex-col gap-4">
        <Pane>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Records">
              {(p) => (
                <NativeSelect
                  {...p}
                  value={def.entity}
                  onChange={(e) => (setDef(blank(e.target.value)), setConditions([]))}
                >
                  {entities.map((e) => (
                    <option key={e} value={e}>
                      {boot.labels[e]?.plural ?? e}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="Group by">
              {(p) => (
                <NativeSelect {...p} value={def.groupBy} onChange={(e) => set({ groupBy: e.target.value })}>
                  {group.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            {isDate ? (
              <Field label="Period">
                {(p) => (
                  <NativeSelect
                    {...p}
                    value={def.dateBucket}
                    onChange={(e) => set({ dateBucket: e.target.value as ReportDefinition['dateBucket'] })}
                  >
                    <option value="day">Day</option>
                    <option value="week">Week</option>
                    <option value="month">Month</option>
                    <option value="quarter">Quarter</option>
                    <option value="year">Year</option>
                  </NativeSelect>
                )}
              </Field>
            ) : null}
            <Field label="Measure">
              {(p) => (
                <NativeSelect
                  {...p}
                  value={def.metric === 'count' ? 'count' : `${def.metric}:${def.metricField ?? ''}`}
                  onChange={(e) => {
                    const [metric, field] = e.target.value.split(':') as [
                      ReportDefinition['metric'],
                      string?,
                    ];
                    set({ metric, metricField: field || null });
                  }}
                >
                  <option value="count">Number of records</option>
                  {numbers.flatMap((f) => [
                    <option key={`sum:${f.key}`} value={`sum:${f.key}`}>
                      Total {f.label.toLowerCase()}
                    </option>,
                    <option key={`avg:${f.key}`} value={`avg:${f.key}`}>
                      Average {f.label.toLowerCase()}
                    </option>,
                  ])}
                </NativeSelect>
              )}
            </Field>
            <Field label="Show as">
              {(p) => (
                <NativeSelect
                  {...p}
                  value={def.chart}
                  onChange={(e) => set({ chart: e.target.value as ReportDefinition['chart'] })}
                >
                  <option value="bar">Bars</option>
                  <option value="line">Line</option>
                  <option value="pie">Pie</option>
                  <option value="table">Table</option>
                </NativeSelect>
              )}
            </Field>
          </div>
          <div className="mt-3">
            <FilterBar
              fields={config.fields as FieldConfig[]}
              conditions={conditions}
              onChange={setConditions}
            />
          </div>
        </Pane>
        <Pane title={name || 'Preview'}>
          {preview.isPending && preview.fetchStatus !== 'idle' ? (
            <Skeleton className="h-64" />
          ) : preview.isError ? (
            <ErrorState error={preview.error} />
          ) : preview.data ? (
            <ReportChart result={preview.data} definition={definition} currency={currency} />
          ) : (
            <EmptyState title="Choose what to measure" />
          )}
        </Pane>
        <Pane>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Report name" className="min-w-56 flex-1">
              {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            {can('core.saved_views.share') ? (
              <label className="flex items-center gap-2 pb-2 text-sm">
                <Switch checked={shared} onCheckedChange={setShared} /> Share with everyone
              </label>
            ) : null}
            <Button
              variant="primary"
              onClick={() => save.mutate()}
              loading={save.isPending}
              disabled={!name.trim()}
            >
              {current?.mine ? 'Save' : 'Save report'}
            </Button>
            {current?.mine ? (
              <Button variant="ghost" onClick={() => remove.mutate(current.uuid)} aria-label="Delete report">
                <Trash2 /> Delete
              </Button>
            ) : null}
          </div>
        </Pane>
      </div>
    </div>
  );
}
