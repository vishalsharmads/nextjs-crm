import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, FileText, Trash2, Upload } from 'lucide-react';
import type { RelatedType, UserRef } from '@app/shared';
import { api, apiDelete, apiGet } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { formatRelative } from '@/lib/format';
import { useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { EmptyState, Skeleton } from '@/components/ui/misc';

interface FileRow {
  uuid: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
  uploadedBy: UserRef | null;
}

const size = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

export function FilesPanel({ entity, uuid }: { entity: RelatedType; uuid: string }) {
  const qc = useQueryClient();
  const can = useCan();
  const input = useRef<HTMLInputElement>(null);
  const files = useQuery({
    queryKey: qk.files(entity, uuid),
    queryFn: () => apiGet<{ data: FileRow[] }>('/files', { entity, uuid }).then((r) => r.data),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.files(entity, uuid) });
    void qc.invalidateQueries({ queryKey: ['records'] });
  };
  const upload = useMutation({
    mutationFn: (f: File) => {
      const fd = new FormData();
      fd.append('entity', entity);
      fd.append('uuid', uuid);
      fd.append('file', f);
      return api('/files', { method: 'POST', body: fd });
    },
    onSuccess: () => {
      toast.success('File uploaded');
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (fileUuid: string) => apiDelete(`/files/${fileUuid}`),
    onSuccess: refresh,
  });
  const download = async (f: FileRow) => {
    const { url } = await apiGet<{ url: string }>(`/files/${f.uuid}/url`);
    window.open(url, '_blank', 'noopener');
  };
  return (
    <div className="flex flex-col gap-3">
      {can('core.files.create') ? (
        <div
          className="flex flex-col items-center gap-2 rounded-md border border-dashed border-line-strong p-5 text-center text-sm text-muted"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            for (const f of Array.from(e.dataTransfer.files)) upload.mutate(f);
          }}
        >
          <Upload className="size-5" />
          <p>Drop files here, or</p>
          <input
            ref={input}
            type="file"
            className="sr-only"
            multiple
            onChange={(e) => (
              Array.from(e.target.files ?? []).forEach((f) => upload.mutate(f)),
              (e.target.value = '')
            )}
            aria-label="Upload files"
          />
          <Button size="sm" onClick={() => input.current?.click()} loading={upload.isPending}>
            Choose files
          </Button>
        </div>
      ) : null}
      {files.isPending ? (
        <Skeleton className="h-16" />
      ) : !files.data?.length ? (
        <EmptyState
          icon={<FileText />}
          title="No files"
          description="Contracts, proposals and IDs live here."
        />
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line bg-surface">
          {files.data.map((f) => (
            <li key={f.uuid} className="flex items-center gap-3 px-3 py-2">
              <FileText className="size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{f.name}</p>
                <p className="text-xs text-muted">
                  {size(f.size)} · {f.uploadedBy?.name ?? 'Someone'} · {formatRelative(f.createdAt)}
                </p>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Download ${f.name}`}
                onClick={() => void download(f)}
              >
                <Download />
              </Button>
              {can('core.files.delete') ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Delete ${f.name}`}
                  onClick={() => remove.mutate(f.uuid)}
                >
                  <Trash2 />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
