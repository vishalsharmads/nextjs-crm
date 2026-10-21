import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, FileSpreadsheet, Upload, XCircle } from 'lucide-react';
import type { CoreEntity } from '@app/shared';
import { api, apiGet, apiPost, buildUrl } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useBranding } from '@/app/branding';
import { setDocumentTitle } from '@/theme/apply';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/input';
import { ErrorState, PageHeader, Pane } from '@/components/ui/misc';
import { Combobox } from '@/components/fields/combobox';
import { TagsInput, UserPicker } from '@/components/fields/pickers';
import { useEntityConfig } from '@/features/records/entities';

const ROUTE_ENTITY: Record<string, Exclude<CoreEntity, 'activity'>> = {
  contacts: 'contact',
  organizations: 'organization',
  leads: 'lead',
  deals: 'deal',
};

interface Upload {
  fileUuid: string;
  headers: string[];
  sample: string[][];
  total: number;
  targets: { key: string; label: string; required?: boolean }[];
  suggested: Record<string, string | null>;
}

interface JobStatus {
  uuid: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;
  error: string | null;
  result: { created: number; updated: number; skipped: number; failed: number; errorCount: number } | null;
}

export function ImportPage() {
  const { route = 'contacts' } = useParams();
  const entity = ROUTE_ENTITY[route] ?? 'contact';
  const config = useEntityConfig(entity);
  const { branding } = useBranding();
  const [upload, setUpload] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [duplicates, setDuplicates] = useState<'skip' | 'update' | 'create'>('skip');
  const [owner, setOwner] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [jobUuid, setJobUuid] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(
    () => setDocumentTitle(`Import ${config.plural}`, branding.appName),
    [config.plural, branding.appName],
  );

  const send = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('entity', entity);
      fd.append('file', file);
      return api<Upload>('/imports', { method: 'POST', body: fd });
    },
    onSuccess: (u) => {
      setUpload(u);
      setMapping(u.suggested);
    },
  });
  const start = useMutation({
    mutationFn: () =>
      apiPost<{ jobUuid: string }>('/imports/start', {
        entity,
        fileUuid: upload!.fileUuid,
        mapping,
        options: { duplicates, defaultOwnerUuid: owner, tags },
      }),
    onSuccess: (r) => setJobUuid(r.jobUuid),
  });

  const mapped = new Set(Object.values(mapping).filter(Boolean));
  const missingRequired = upload?.targets.filter((t) => t.required && !mapped.has(t.key)) ?? [];
  const step = jobUuid ? 3 : upload ? 2 : 1;

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title={`Import ${config.plural.toLowerCase()}`}
        description="Bring records in from a spreadsheet. Save it as CSV first."
        actions={
          <Button variant="ghost" asChild>
            <Link to={`/${route}`}>
              <ArrowLeft className="rtl:-scale-x-100" /> Back to {config.plural.toLowerCase()}
            </Link>
          </Button>
        }
      >
        <ol className="flex gap-6 pb-3 text-sm">
          {['Upload', 'Match columns', 'Import'].map((label, i) => (
            <li
              key={label}
              className={cn(
                'flex items-center gap-2',
                step === i + 1 ? 'font-medium text-ink' : 'text-muted',
              )}
              aria-current={step === i + 1 ? 'step' : undefined}
            >
              <span
                className={cn(
                  'flex size-5 items-center justify-center rounded-full text-2xs',
                  step > i ? 'bg-primary text-primary-fg' : 'bg-subtle',
                )}
              >
                {i + 1}
              </span>
              {label}
            </li>
          ))}
        </ol>
      </PageHeader>
      <div className="mx-auto w-full max-w-4xl p-4 md:p-6">
        {step === 1 ? (
          <Pane>
            <div
              className="flex flex-col items-center gap-3 rounded-md border border-dashed border-line-strong p-10 text-center"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f) send.mutate(f);
              }}
            >
              <FileSpreadsheet className="size-8 text-faint" />
              <p className="font-medium">Drop a CSV file here</p>
              <p className="text-sm text-muted">
                The first row must contain column names. Up to 50,000 rows.
              </p>
              <input
                ref={input}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                aria-label="Choose a CSV file"
                onChange={(e) => e.target.files?.[0] && send.mutate(e.target.files[0])}
              />
              <Button variant="primary" onClick={() => input.current?.click()} loading={send.isPending}>
                <Upload /> Choose file
              </Button>
              {send.isError ? <p className="text-sm text-accent">{(send.error as Error).message}</p> : null}
            </div>
          </Pane>
        ) : null}

        {step === 2 && upload ? (
          <div className="flex flex-col gap-6">
            <Pane
              title={`Match ${upload.headers.length} columns (${upload.total.toLocaleString()} rows)`}
              padded={false}
            >
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-subtle text-xs text-muted">
                    <th className="px-4 py-2 text-start font-medium">Column in your file</th>
                    <th className="px-4 py-2 text-start font-medium">Example</th>
                    <th className="px-4 py-2 text-start font-medium">Import as</th>
                  </tr>
                </thead>
                <tbody>
                  {upload.headers.map((h, col) => (
                    <tr key={h} className="border-b border-line last:border-0">
                      <td className="px-4 py-2 font-medium">{h}</td>
                      <td className="max-w-56 truncate px-4 py-2 text-muted">
                        {upload.sample.map((r) => r[col]).find(Boolean) ?? '—'}
                      </td>
                      <td className="w-64 px-4 py-1.5">
                        <Combobox
                          value={mapping[h] ?? null}
                          onChange={(v) => setMapping({ ...mapping, [h]: (v as string) ?? null })}
                          placeholder="Don't import"
                          options={upload.targets
                            .filter((t) => !mapped.has(t.key) || mapping[h] === t.key)
                            .map((t) => ({
                              value: t.key,
                              label: t.label,
                              hint: t.required ? 'required' : null,
                            }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Pane>
            <Pane title="Options">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-xs font-medium text-muted">When a record already exists</span>
                  <NativeSelect
                    value={duplicates}
                    onChange={(e) => setDuplicates(e.target.value as typeof duplicates)}
                  >
                    <option value="skip">Skip it</option>
                    <option value="update">Update it with values from the file</option>
                    <option value="create">Create a new one anyway</option>
                  </NativeSelect>
                </label>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted">Owner when the file has none</span>
                  <UserPicker value={owner} onChange={setOwner} placeholder="Me" />
                </div>
                <div className="flex flex-col gap-1 sm:col-span-2">
                  <span className="text-xs font-medium text-muted">Tag everything imported</span>
                  <TagsInput value={tags} onChange={setTags} />
                </div>
              </div>
            </Pane>
            <div className="flex items-center justify-between gap-3">
              <Button variant="ghost" onClick={() => setUpload(null)}>
                Choose another file
              </Button>
              <div className="flex items-center gap-3">
                {missingRequired.length ? (
                  <span className="text-sm text-accent">
                    Match {missingRequired.map((t) => t.label).join(', ')} to continue
                  </span>
                ) : null}
                <Button
                  variant="primary"
                  onClick={() => start.mutate()}
                  loading={start.isPending}
                  disabled={!mapped.size || missingRequired.length > 0}
                >
                  Import {upload.total.toLocaleString()} rows
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {step === 3 && jobUuid ? (
          <ImportProgress jobUuid={jobUuid} route={route} plural={config.plural} />
        ) : null}
      </div>
    </div>
  );
}

function ImportProgress({ jobUuid, route, plural }: { jobUuid: string; route: string; plural: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const job = useQuery({
    queryKey: ['imports', jobUuid],
    queryFn: () => apiGet<JobStatus>(`/imports/${jobUuid}`),
    refetchInterval: (q) =>
      q.state.data && (q.state.data.status === 'succeeded' || q.state.data.status === 'failed')
        ? false
        : 1000,
  });
  const done = job.data?.status === 'succeeded';
  useEffect(() => {
    if (done) void qc.invalidateQueries({ queryKey: ['records'] });
  }, [done, qc]);
  if (job.isError) return <ErrorState error={job.error} />;
  const r = job.data?.result;
  return (
    <Pane>
      {job.data?.status === 'failed' ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <XCircle className="size-8 text-accent" />
          <p className="font-medium">The import stopped</p>
          <p className="text-sm text-muted">{job.data.error}</p>
        </div>
      ) : done && r ? (
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <CheckCircle2 className="size-8 text-primary" />
          <p className="text-lg font-semibold">Import finished</p>
          <dl className="grid grid-cols-4 gap-6 text-center">
            {(
              [
                ['Created', r.created],
                ['Updated', r.updated],
                ['Skipped', r.skipped],
                ['Failed', r.failed],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-muted">{k}</dt>
                <dd className={cn('text-xl font-semibold tabular', k === 'Failed' && v > 0 && 'text-accent')}>
                  {v.toLocaleString()}
                </dd>
              </div>
            ))}
          </dl>
          <div className="flex gap-2">
            {r.failed ? (
              <Button asChild>
                <a href={buildUrl(`/imports/${jobUuid}/errors.csv`)} download>
                  Download rows that failed
                </a>
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => navigate(`/${route}`)}>
              View {plural.toLowerCase()}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 py-8">
          <p className="text-center font-medium">Importing…</p>
          <div
            className="h-2 overflow-hidden rounded-full bg-subtle"
            role="progressbar"
            aria-valuenow={job.data?.progress ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${job.data?.progress ?? 2}%` }}
            />
          </div>
          <p className="text-center text-xs text-muted">You can leave this page; the import keeps running.</p>
        </div>
      )}
    </Pane>
  );
}
