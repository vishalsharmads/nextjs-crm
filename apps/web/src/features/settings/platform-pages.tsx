import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, Upload } from 'lucide-react';
import { ApiError, apiGet, apiPost, buildUrl } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { bootstrapKey, useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Badge, Pane, Skeleton } from '@/components/ui/misc';
import { Switch } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { SettingsPage } from './layout';

// ---------------- Modules ----------------

interface ModuleRow {
  key: string;
  name: string;
  version: string;
  description: string;
  status: 'available' | 'stub';
  dependsOn: string[];
  enabled: boolean;
}

export function ModulesPage() {
  const t = useT();
  const qc = useQueryClient();
  const modules = useQuery({
    queryKey: ['modules'],
    queryFn: () => apiGet<{ data: ModuleRow[] }>('/modules').then((r) => r.data),
  });
  const toggle = useMutation({
    mutationFn: ({ key, on }: { key: string; on: boolean }) =>
      apiPost(`/modules/${key}/${on ? 'enable' : 'disable'}`),
    onSuccess: (_r, v) => {
      toast.success(v.on ? 'Module turned on' : 'Module turned off. Its data is kept.');
      void qc.invalidateQueries({ queryKey: ['modules'] });
      void qc.invalidateQueries({ queryKey: bootstrapKey });
    },
  });
  return (
    <SettingsPage
      title={t('settings.modules')}
      description="Optional features for your industry. Turning a module off hides it; its data stays until you turn it back on."
    >
      <Pane padded={false}>
        {modules.isPending ? (
          <Skeleton className="m-4 h-24" />
        ) : (
          <ul className="divide-y divide-line">
            {modules.data?.map((m) => (
              <li key={m.key} className="flex items-start gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {m.name} <span className="text-xs font-normal text-faint">v{m.version}</span>
                    {m.status === 'stub' ? <Badge>Coming soon</Badge> : null}
                  </p>
                  <p className="mt-0.5 text-sm text-muted">{m.description}</p>
                  {m.dependsOn.length ? (
                    <p className="mt-0.5 text-xs text-faint">Needs: {m.dependsOn.join(', ')}</p>
                  ) : null}
                </div>
                <Switch
                  checked={m.enabled}
                  disabled={m.status === 'stub' || toggle.isPending}
                  onCheckedChange={(on) => toggle.mutate({ key: m.key, on })}
                  aria-label={`${m.name} enabled`}
                />
              </li>
            ))}
          </ul>
        )}
      </Pane>
    </SettingsPage>
  );
}

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

export function BlueprintPage() {
  const t = useT();
  const qc = useQueryClient();
  const info = useQuery({
    queryKey: ['blueprints'],
    queryFn: () =>
      apiGet<{
        current: { key: string; version: string; appliedAt: string } | null;
        available: { key: string; name: string; version: string; description: string; status: string }[];
        history: { key: string; version: string; appliedAt: string }[];
      }>('/blueprints'),
  });
  const [report, setReport] = useState<{ key: string; report: Report; uploaded?: unknown } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const preview = useMutation({
    mutationFn: (key: string) => apiPost<Report>(`/blueprints/${key}/preview`),
    onSuccess: (r, key) => setReport({ key, report: r }),
  });
  const apply = useMutation({
    mutationFn: (key: string) => apiPost<Report>(`/blueprints/${key}/apply`),
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
      {report ? (
        <Dialog open onOpenChange={(o) => !o && setReport(null)}>
          <DialogContent
            title={report.uploaded ? `Check: ${report.key}` : `Preview: ${report.key}`}
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
                    Apply
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
        'Kept as you changed them',
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
