import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, Upload } from 'lucide-react';
import { ApiError, apiGet, apiPost, buildUrl } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useBoot, useT } from '@/app/session';
import { labelVars } from '@/lib/labels';
import { Button } from '@/components/ui/button';
import { Badge, Pane, Skeleton } from '@/components/ui/misc';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { SettingsPage } from './layout';

// ---------------- Blueprint ----------------

interface Report {
  status: string;
  created: string[];
  updated: string[];
  unchanged: number;
  conflicts: { item: string; message: string }[];
  orphaned: string[];
  warnings: string[];
  summary: string;
}

interface PresetContents {
  vocabulary: Record<string, string>;
  modules: { key: string; name: string }[];
  pipelines: { name: string; entity: string; stages: string[] }[];
  customFields: { entity: string; label: string; type: string }[];
  roles: string[];
  templates: number;
  dashboardWidgets: number;
  sampleData: boolean;
}

interface Preset {
  key: string;
  name: string;
  version: string;
  description: string;
  status: string;
  contents: PresetContents;
}

/** The workspace's current name for an entity key, e.g. "deal" → "Deals" (or the renamed label). */
function useEntityName() {
  const L = labelVars(useBoot().labels) as Record<string, string>;
  return (entity: string) => L[`${entity}Plural`] ?? entity;
}

export function BlueprintPage() {
  const t = useT();
  const qc = useQueryClient();
  const info = useQuery({
    queryKey: ['blueprints'],
    queryFn: () =>
      apiGet<{
        current: { key: string; version: string; appliedAt: string } | null;
        available: Preset[];
        history: { key: string; version: string; appliedAt: string }[];
      }>('/blueprints'),
  });
  const [report, setReport] = useState<{
    key: string;
    report: Report;
    uploaded?: unknown;
    mode?: 'primary' | 'add';
  } | null>(null);
  const [details, setDetails] = useState<Preset | null>(null);
  const [query, setQuery] = useState('');
  const file = useRef<HTMLInputElement>(null);
  // A preset other than the current one is added next to it, as the workspace's own changes.
  const modeFor = (key: string) =>
    info.data?.current && info.data.current.key !== key ? ('add' as const) : ('primary' as const);
  const preview = useMutation({
    mutationFn: (key: string) => apiPost<Report>(`/blueprints/${key}/preview?mode=${modeFor(key)}`),
    onSuccess: (r, key) => setReport({ key, report: r, mode: modeFor(key) }),
  });
  const apply = useMutation({
    mutationFn: (key: string) => apiPost<Report>(`/blueprints/${key}/apply?mode=${modeFor(key)}`),
    onSuccess: (r) => {
      toast.success(`Applied: ${r.summary}`);
      setReport(null);
      void qc.invalidateQueries();
    },
  });
  const uploadPreview = useMutation({
    mutationFn: async (f: File) => {
      const blueprint = JSON.parse(await f.text()) as unknown;
      return { blueprint, report: await apiPost<Report>('/blueprints/upload/preview', { blueprint }) };
    },
    onSuccess: ({ blueprint, report: r }) =>
      setReport({ key: (blueprint as { key: string }).key, report: r, uploaded: blueprint }),
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'That file is not a valid blueprint'),
  });
  const current = info.data?.current;
  const currentBp = info.data?.available.find((b) => b.key === current?.key);
  const upgrade = currentBp && current && currentBp.version !== current.version;
  return (
    <SettingsPage
      title={t('settings.blueprint')}
      description="The industry preset this workspace started from. Upgrades only add what is new; anything you changed here is never overwritten."
      actions={
        <>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="Blueprint file"
            onChange={(e) => e.target.files?.[0] && uploadPreview.mutate(e.target.files[0])}
          />
          <Button onClick={() => file.current?.click()} loading={uploadPreview.isPending}>
            <Upload /> Check a file
          </Button>
          <Button asChild>
            <a href={buildUrl('/blueprints/export')} download>
              <Download /> Export configuration
            </a>
          </Button>
        </>
      }
    >
      {info.isPending ? (
        <Skeleton className="h-32" />
      ) : (
        <Pane title="Current">
          {current ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium">
                  {currentBp?.name ?? current.key}{' '}
                  <span className="text-sm text-muted">v{current.version}</span>
                </p>
                <p className="text-xs text-muted">Last applied {formatDateTime(current.appliedAt)}</p>
              </div>
              {upgrade ? (
                <Button
                  variant="primary"
                  onClick={() => preview.mutate(current.key)}
                  loading={preview.isPending}
                >
                  Review upgrade to v{currentBp.version}
                </Button>
              ) : (
                <Button onClick={() => preview.mutate(current.key)} loading={preview.isPending}>
                  Check for drift
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">No blueprint applied.</p>
          )}
        </Pane>
      )}
      {info.data ? (
        <Pane
          title={`Presets (${info.data.available.length})`}
          actions={
            <Input
              aria-label="Search presets"
              placeholder="Search presets"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 w-48"
            />
          }
        >
          <p className="mb-3 text-sm text-muted">
            Each preset sets up names, fields, pipelines, roles and modules for one industry. Applying one
            only adds what is missing; your changes are kept. Preview first to see exactly what changes.
          </p>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {info.data.available
              .filter((b) =>
                `${b.name} ${b.description} ${b.contents.modules.map((m) => m.name).join(' ')}`
                  .toLowerCase()
                  .includes(query.trim().toLowerCase()),
              )
              .map((b) => (
                <PresetCard
                  key={b.key}
                  preset={b}
                  current={current?.key === b.key}
                  previewing={preview.isPending && preview.variables === b.key}
                  onDetails={() => setDetails(b)}
                  onPreview={() => preview.mutate(b.key)}
                />
              ))}
          </ul>
        </Pane>
      ) : null}
      {info.data?.history.length ? (
        <Pane title="History">
          <ul className="divide-y divide-line text-sm">
            {info.data.history.map((h) => (
              <li key={`${h.key}-${h.appliedAt}`} className="flex items-center justify-between gap-3 py-2">
                <span>
                  {info.data.available.find((b) => b.key === h.key)?.name ?? h.key}{' '}
                  <span className="text-muted">v{h.version}</span>
                </span>
                <span className="text-xs text-muted">{formatDateTime(h.appliedAt)}</span>
              </li>
            ))}
          </ul>
        </Pane>
      ) : null}
      {details ? (
        <PresetDetails
          preset={details}
          current={current?.key === details.key}
          onClose={() => setDetails(null)}
          onPreview={() => (setDetails(null), preview.mutate(details.key))}
        />
      ) : null}
      {report ? (
        <Dialog open onOpenChange={(o) => !o && setReport(null)}>
          <DialogContent
            title={
              report.uploaded
                ? `Check: ${report.key}`
                : report.mode === 'add'
                  ? `Add to this workspace: ${report.key}`
                  : `Preview: ${report.key}`
            }
            description={report.report.summary}
            footer={
              <>
                <Button onClick={() => setReport(null)}>Close</Button>
                {!report.uploaded && (report.report.created.length || report.report.updated.length) ? (
                  <Button
                    variant="primary"
                    loading={apply.isPending}
                    onClick={() => apply.mutate(report.key)}
                  >
                    {report.mode === 'add' ? 'Add' : 'Apply'}
                  </Button>
                ) : null}
              </>
            }
          >
            <ReportView report={report.report} />
          </DialogContent>
        </Dialog>
      ) : null}
    </SettingsPage>
  );
}

function PresetCard({
  preset,
  current,
  previewing,
  onDetails,
  onPreview,
}: {
  preset: Preset;
  current: boolean;
  previewing: boolean;
  onDetails: () => void;
  onPreview: () => void;
}) {
  const c = preset.contents;
  const stub = preset.status === 'stub';
  return (
    <li className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{preset.name}</p>
          <p className="text-xs text-muted">v{preset.version}</p>
        </div>
        {current ? <Badge tone="primary">Current</Badge> : stub ? <Badge>Starter</Badge> : null}
      </div>
      <p className="line-clamp-3 text-sm text-muted">{preset.description}</p>
      <ul className="flex flex-wrap gap-1 text-xs">
        <li>
          <Badge tone="outline">{c.modules.length} modules</Badge>
        </li>
        <li>
          <Badge tone="outline">{c.customFields.length} fields</Badge>
        </li>
        <li>
          <Badge tone="outline">{c.pipelines.length} pipelines</Badge>
        </li>
        <li>
          <Badge tone="outline">{c.roles.length} roles</Badge>
        </li>
        {c.sampleData ? (
          <li>
            <Badge tone="outline">Sample data</Badge>
          </li>
        ) : null}
      </ul>
      <div className="mt-auto flex gap-2">
        <Button size="sm" onClick={onDetails}>
          Details
        </Button>
        <Button
          size="sm"
          variant={current ? 'secondary' : 'primary'}
          loading={previewing}
          onClick={onPreview}
        >
          {current ? 'Check for drift' : 'Preview'}
        </Button>
      </div>
    </li>
  );
}

function PresetDetails({
  preset,
  current,
  onClose,
  onPreview,
}: {
  preset: Preset;
  current: boolean;
  onClose: () => void;
  onPreview: () => void;
}) {
  const entityName = useEntityName();
  const c = preset.contents;
  const names = Object.entries(c.vocabulary);
  const block = (title: string, body: React.ReactNode) => (
    <section>
      <h3 className="mb-1 text-xs font-semibold text-muted">{title}</h3>
      {body}
    </section>
  );
  const chips = (items: string[]) =>
    items.length ? (
      <ul className="flex flex-wrap gap-1">
        {items.map((i) => (
          <li key={i}>
            <Badge tone="outline">{i}</Badge>
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-muted">None</p>
    );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`${preset.name} v${preset.version}`}
        description={preset.description}
        footer={
          <>
            <Button onClick={onClose}>Close</Button>
            <Button variant="primary" onClick={onPreview}>
              {current ? 'Check for drift' : 'Preview changes'}
            </Button>
          </>
        }
      >
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto text-sm">
          {block(
            'Names',
            names.length ? (
              <ul className="grid gap-1">
                {names.map(([entity, label]) => (
                  <li key={entity}>
                    {entityName(entity)} <span className="text-muted">→</span> {label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">Keeps the standard names</p>
            ),
          )}
          {block('Modules', chips(c.modules.map((m) => m.name)))}
          {block(
            'Pipelines',
            c.pipelines.length ? (
              <ul className="grid gap-2">
                {c.pipelines.map((p) => (
                  <li key={`${p.entity}-${p.name}`}>
                    <p className="font-medium">
                      {p.name} <span className="text-xs font-normal text-muted">{entityName(p.entity)}</span>
                    </p>
                    <p className="text-xs text-muted">{p.stages.join(' → ')}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">None</p>
            ),
          )}
          {block(
            'Custom fields',
            c.customFields.length ? (
              <ul className="grid gap-1">
                {c.customFields.map((f) => (
                  <li key={`${f.entity}-${f.label}`} className="flex justify-between gap-2">
                    <span>{f.label}</span>
                    <span className="text-xs text-muted">
                      {entityName(f.entity)} · {f.type}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">None</p>
            ),
          )}
          {block('Roles', chips(c.roles))}
          {block(
            'Also included',
            <p>
              {c.dashboardWidgets} dashboard widgets · {c.templates} email templates
              {c.sampleData ? ' · sample records for demos' : ''}
            </p>,
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReportView({ report }: { report: Report }) {
  const section = (title: string, items: string[], tone?: 'accent') =>
    items.length ? (
      <section>
        <h3 className={`mb-1 text-xs font-semibold ${tone === 'accent' ? 'text-accent' : 'text-muted'}`}>
          {title} ({items.length})
        </h3>
        <ul className="flex flex-wrap gap-1">
          {items.map((i) => (
            <li key={i}>
              <Badge tone={tone === 'accent' ? 'accent' : 'outline'}>{i}</Badge>
            </li>
          ))}
        </ul>
      </section>
    ) : null;
  return (
    <div className="flex flex-col gap-4 text-sm">
      {section('Will be added', report.created)}
      {section('Will be updated', report.updated)}
      {section(
        'Kept as they are',
        report.conflicts.map((c) => c.item),
        'accent',
      )}
      {section('No longer in the blueprint (kept)', report.orphaned)}
      {report.warnings.length ? (
        <ul className="list-inside list-disc text-xs text-muted">
          {report.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {!report.created.length && !report.updated.length && !report.conflicts.length ? (
        <p className="text-muted">Everything is up to date.</p>
      ) : null}
    </div>
  );
}
