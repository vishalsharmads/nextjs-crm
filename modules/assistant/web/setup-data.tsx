import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CircleAlert,
  FileSpreadsheet,
  ListChecks,
  Sparkles,
  Upload as UploadIcon,
  Wrench,
} from 'lucide-react';
import { ApiError, api, apiGet, apiPost } from '@/lib/api';
import { useBoot } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, NativeSelect } from '@/components/ui/input';
import { Badge, Pane } from '@/components/ui/misc';

/**
 * Phase 10c: the client's spreadsheets into the CRM. The file is uploaded to the normal import,
 * the assistant maps its columns, the import's own rules check it without saving, the assistant
 * explains each problem with a fix, and the import runs when the client says so.
 */
type Entity = 'contact' | 'organization' | 'deal' | 'lead';
interface Target {
  key: string;
  label: string;
  required?: boolean;
  format?: string;
}
interface Upload {
  fileUuid: string;
  headers: string[];
  sample: string[][];
  total: number;
  targets: Target[];
  suggested: Record<string, string | null>;
}
interface Check {
  total: number;
  checked: number;
  wouldCreate: number;
  wouldUpdate: number;
  wouldSkip: number;
  failed: number;
  errors: { row: number; message: string; values: string[] }[];
  problems: { message: string; rows: number[]; count: number }[];
}
interface Job {
  status: string;
  progress: number | null;
  result: { created: number; updated: number; skipped: number; failed: number } | null;
}

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
const ENTITIES: Entity[] = ['contact', 'organization', 'deal', 'lead'];

export function DataStep({ sessionUuid }: { sessionUuid: string }) {
  const { labels } = useBoot();
  const [entity, setEntity] = useState<Entity>('contact');
  const [upload, setUpload] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<Check | null>(null);
  const [explained, setExplained] = useState<{ explanation: string; fix: string }[]>([]);
  const [jobUuid, setJobUuid] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<'skip' | 'update' | 'create'>('skip');
  const input = useRef<HTMLInputElement>(null);
  const plural = (e: Entity) => labels[e]?.plural ?? e;

  const reset = () => {
    setUpload(null);
    setCheck(null);
    setExplained([]);
    setJobUuid(null);
    setNotes({});
  };

  const map = useMutation({
    mutationFn: (u: Upload) =>
      apiPost<{ mapping: Record<string, string | null>; notes: Record<string, string> }>(
        `/m/assistant/setup/${sessionUuid}/mapping`,
        { entity, headers: u.headers, sample: u.sample, targets: u.targets, suggested: u.suggested },
      ),
    onSuccess: (r) => {
      setMapping(r.mapping);
      setNotes(r.notes);
    },
    // Without the assistant, the import's own matching still stands.
    onError: () => toast.message('The assistant could not suggest a mapping; check the columns yourself.'),
  });

  const send = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('entity', entity);
      fd.append('file', file);
      return api<Upload>('/imports', { method: 'POST', body: fd });
    },
    onSuccess: (u) => {
      reset();
      setUpload(u);
      setMapping(u.suggested);
      map.mutate(u);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const body = () => ({ entity, fileUuid: upload!.fileUuid, mapping, options: { duplicates, tags: [] } });
  const explain = useMutation({
    mutationFn: (c: Check) =>
      apiPost<{ explanations: { explanation: string; fix: string }[] }>(
        `/m/assistant/setup/${sessionUuid}/explain`,
        {
          entity,
          problems: c.problems,
          targets: upload!.targets,
        },
      ),
    onSuccess: (r) => setExplained(r.explanations),
  });
  const runCheck = useMutation({
    mutationFn: () => apiPost<Check>('/imports/check', body()),
    onSuccess: (c) => {
      setCheck(c);
      setExplained([]);
      if (c.problems.length) explain.mutate(c);
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const start = useMutation({
    mutationFn: () => apiPost<{ jobUuid: string }>('/imports/start', body()),
    onSuccess: (r) => setJobUuid(r.jobUuid),
    onError: (err) => toast.error(errorText(err)),
  });
  const job = useQuery({
    queryKey: ['imports', jobUuid],
    queryFn: () => apiGet<Job>(`/imports/${jobUuid}`),
    enabled: !!jobUuid,
    refetchInterval: (q) =>
      q.state.data && ['succeeded', 'failed'].includes(q.state.data.status) ? false : 1000,
  });
  const done = job.data?.status === 'succeeded';

  const missing = (upload?.targets ?? []).filter(
    (t) => t.required && !Object.values(mapping).includes(t.key),
  );

  return (
    <Pane title="Bring your data">
      <p className="mb-4 text-sm text-muted">
        Upload a spreadsheet (Excel or CSV) of the people, companies or deals you already have. The assistant
        matches its columns to your fields, checks every row without saving anything, and explains anything to
        fix first.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="This file holds">
          {(f) => (
            <NativeSelect
              {...f}
              value={entity}
              onChange={(e) => {
                setEntity(e.target.value as Entity);
                reset();
              }}
            >
              {ENTITIES.map((e) => (
                <option key={e} value={e}>
                  {plural(e)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <input
          ref={input}
          type="file"
          hidden
          accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) send.mutate(f);
            e.target.value = '';
          }}
        />
        <Button
          variant={upload ? 'secondary' : 'primary'}
          onClick={() => input.current?.click()}
          loading={send.isPending}
        >
          <UploadIcon /> {upload ? 'Choose another file' : 'Choose a spreadsheet'}
        </Button>
      </div>

      {upload ? (
        <div className="anim-rise mt-5 space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <FileSpreadsheet className="size-4 text-muted" aria-hidden />
            {upload.total.toLocaleString()} rows, {upload.headers.length} columns
            {map.isPending ? <span className="ai-shimmer">· matching columns…</span> : null}
          </div>
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full text-sm">
              <thead className="bg-subtle text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 text-start font-medium">Your column</th>
                  <th className="px-3 py-2 text-start font-medium">Example</th>
                  <th className="px-3 py-2 text-start font-medium">Goes to</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {upload.headers.map((h, col) => {
                  const target = upload.targets.find((t) => t.key === mapping[h]);
                  return (
                    <tr key={h}>
                      <td className="px-3 py-2 font-medium">{h}</td>
                      <td className="max-w-48 truncate px-3 py-2 text-muted">
                        {upload.sample[0]?.[col] ?? ''}
                      </td>
                      <td className="px-3 py-2">
                        <NativeSelect
                          aria-label={`Field for ${h}`}
                          value={mapping[h] ?? ''}
                          onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value || null }))}
                        >
                          <option value="">Leave out</option>
                          {upload.targets.map((t) => (
                            <option key={t.key} value={t.key}>
                              {t.label}
                              {t.required ? ' (required)' : ''}
                            </option>
                          ))}
                        </NativeSelect>
                        {target?.format ? <p className="mt-1 text-xs text-muted">{target.format}</p> : null}
                        {notes[h] ? (
                          <p className="mt-1 flex items-start gap-1 text-xs text-muted">
                            <Sparkles className="mt-0.5 size-3 shrink-0 text-primary" aria-hidden />{' '}
                            {notes[h]}
                          </p>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {missing.length ? (
            <p className="text-sm text-muted" role="status">
              Still needed: {missing.map((t) => t.label).join(', ')}.
            </p>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Rows that already exist">
              {(f) => (
                <NativeSelect
                  {...f}
                  value={duplicates}
                  onChange={(e) => setDuplicates(e.target.value as typeof duplicates)}
                >
                  <option value="skip">Skip them</option>
                  <option value="update">Update them</option>
                  <option value="create">Add them again</option>
                </NativeSelect>
              )}
            </Field>
            <Button
              onClick={() => runCheck.mutate()}
              loading={runCheck.isPending}
              disabled={!!missing.length}
            >
              <ListChecks /> Check the file
            </Button>
          </div>
        </div>
      ) : null}

      {check ? (
        <div className="anim-rise mt-5 space-y-3">
          <ul className="flex flex-wrap gap-2 text-sm" aria-label="Check results">
            <li>
              <Badge tone="primary">{check.wouldCreate} new</Badge>
            </li>
            {check.wouldUpdate ? (
              <li>
                <Badge tone="outline">{check.wouldUpdate} to update</Badge>
              </li>
            ) : null}
            {check.wouldSkip ? (
              <li>
                <Badge tone="outline">{check.wouldSkip} already there</Badge>
              </li>
            ) : null}
            {check.failed ? (
              <li>
                <Badge tone="accent">{check.failed} with problems</Badge>
              </li>
            ) : null}
          </ul>
          {check.checked < check.total ? (
            <p className="text-xs text-muted">Checked the first {check.checked.toLocaleString()} rows.</p>
          ) : null}
          {check.problems.length ? (
            <ul className="space-y-2">
              {check.problems.map((p, i) => (
                <li key={i} className="rounded-md border border-line p-3 text-sm">
                  <p className="flex items-start gap-2 font-medium">
                    <CircleAlert className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                    {explained[i]?.explanation ?? p.message}
                  </p>
                  {explained[i] ? (
                    <p className="mt-1 flex items-start gap-2 text-muted">
                      <Wrench className="mt-0.5 size-4 shrink-0" aria-hidden /> {explained[i].fix}
                    </p>
                  ) : explain.isPending ? (
                    <p className="ai-shimmer mt-1 text-xs">Explaining…</p>
                  ) : null}
                  <p className="mt-1 text-xs text-faint">
                    {p.count} row{p.count === 1 ? '' : 's'}: {p.rows.join(', ')}
                    {p.count > p.rows.length ? '…' : ''} · {p.message}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm">Every row checked passes the import rules.</p>
          )}
          {!jobUuid ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={() => start.mutate()}
                loading={start.isPending}
                disabled={!check.wouldCreate && !check.wouldUpdate}
              >
                Import {(check.wouldCreate + check.wouldUpdate).toLocaleString()}
                {check.checked < check.total ? '+' : ''} {plural(entity).toLowerCase()}
              </Button>
              {check.failed ? (
                <span className="text-sm text-muted">
                  Rows with problems are left out; fix them and import the file again later.
                </span>
              ) : null}
            </div>
          ) : (
            <p className="text-sm" role="status">
              {done
                ? `Imported: ${job.data?.result?.created ?? 0} added, ${job.data?.result?.updated ?? 0} updated, ${job.data?.result?.skipped ?? 0} skipped, ${job.data?.result?.failed ?? 0} with problems.`
                : job.data?.status === 'failed'
                  ? 'The import stopped. Try again.'
                  : `Importing… ${Math.round(job.data?.progress ?? 0)}%`}
            </p>
          )}
        </div>
      ) : null}
    </Pane>
  );
}
