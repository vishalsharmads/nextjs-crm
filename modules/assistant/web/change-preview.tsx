import { Fragment } from 'react';
import { appUrl } from '@/lib/app-url';
import { cn } from '@/lib/cn';
import { Input } from '@/components/ui/input';
import { Checkbox, Switch } from '@/components/ui/checkbox';
import type { RecordPath } from './markdown';

/** Record type names, as the workspace calls them. */
type Labels = Record<string, { singular: string; plural: string } | undefined>;

export type InputPath = (string | number)[];
/** What a change will do, from the server: records by name, plain values, lists item by item. */
export interface ChangePreviewDto {
  records: { entity: string; uuid: string; name: string | null }[];
  fields: { label: string; value: string; edit?: InputPath; kind?: 'text' | 'boolean'; entity?: string }[];
  lists?: { label: string; path: InputPath; items: { label: string; detail?: string }[] }[];
}
/** The person's edits to one change before confirming. */
export interface ChangeEdits {
  set?: { path: InputPath; value: string | boolean }[];
  drop?: { path: InputPath; index: number }[];
}

export const pathKey = (p: InputPath) => JSON.stringify(p);

/** The exact change, for people who want to see it, out of the way of everyone else. */
export function Details({ input }: { input: Record<string, unknown> }) {
  return (
    <details className="mt-2 text-xs text-muted">
      <summary className="cursor-pointer select-none">Details</summary>
      <pre className="mt-1 max-h-48 overflow-auto rounded bg-subtle p-2">
        {JSON.stringify(input, null, 2)}
      </pre>
    </details>
  );
}

/**
 * A proposed change people can check at a glance: the records it touches by name (each opens in a
 * new tab), its values in plain words with names and titles editable, its lists as tick boxes, the
 * assistant's own note labelled as such, and the exact change one click away.
 */
export function ChangePreview({
  preview,
  input,
  labels,
  recordPath,
  texts,
  onText,
  dropped,
  onToggle,
  note,
}: {
  preview: ChangePreviewDto;
  input: Record<string, unknown>;
  labels: Labels;
  recordPath: RecordPath;
  texts: Record<string, string | boolean>;
  onText: (key: string, value: string | boolean) => void;
  dropped: Record<string, number[]>;
  onToggle: (key: string, index: number, keep: boolean) => void;
  note?: string;
}) {
  return (
    <div className="mt-2 space-y-2.5">
      {preview.records.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Records it changes">
          {preview.records.map((r) => {
            const type = labels[r.entity]?.singular ?? 'Record';
            const to = recordPath(r.entity, r.uuid);
            const name = r.name ?? 'A record you cannot see';
            return (
              <li key={`${r.entity}:${r.uuid}`}>
                {to ? (
                  <a href={appUrl(`/${to}`)} target="_blank" rel="noopener noreferrer" className="ai-chip">
                    <span className="text-faint">{type}:</span> {name}
                  </a>
                ) : (
                  <span className="ai-chip">
                    <span className="text-faint">{type}:</span> {name}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {preview.fields.length ? (
        <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] items-center gap-x-3 gap-y-1.5 text-sm">
          {preview.fields.map((f, i) => {
            const k = f.edit ? pathKey(f.edit) : '';
            return (
              <Fragment key={i}>
                <dt className="text-muted">{f.label}</dt>
                <dd className="min-w-0 break-words text-ink">
                  {f.edit && f.kind === 'boolean' ? (
                    <Switch
                      checked={(texts[k] as boolean | undefined) ?? f.value === 'Yes'}
                      onCheckedChange={(v) => onText(k, v)}
                      aria-label={f.label}
                    />
                  ) : f.edit ? (
                    <Input
                      value={(texts[k] as string | undefined) ?? f.value}
                      onChange={(e) => onText(k, e.target.value)}
                      aria-label={f.label}
                      className="h-8"
                    />
                  ) : f.entity ? (
                    (labels[f.entity]?.plural ?? f.value)
                  ) : (
                    f.value
                  )}
                </dd>
              </Fragment>
            );
          })}
        </dl>
      ) : null}
      {(preview.lists ?? []).map((l) => {
        const k = pathKey(l.path);
        const out = dropped[k] ?? [];
        return (
          <fieldset key={k}>
            <legend className="mb-1 text-xs font-medium text-muted">
              {l.label} · {l.items.length - out.length} of {l.items.length} kept
            </legend>
            <ul className="divide-y divide-line rounded-md border border-line">
              {l.items.map((item, i) => (
                <li key={i}>
                  <label className="flex cursor-pointer items-start gap-2 px-2.5 py-1.5">
                    <Checkbox
                      className="mt-0.5"
                      checked={!out.includes(i)}
                      onCheckedChange={(v) => onToggle(k, i, !!v)}
                    />
                    <span className={cn('min-w-0', out.includes(i) && 'text-faint line-through')}>
                      <span className="block">{item.label}</span>
                      {item.detail ? <span className="block text-xs text-muted">{item.detail}</span> : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        );
      })}
      {note ? <p className="text-xs text-muted">Assistant&apos;s note: {note}</p> : null}
      <Details input={input} />
    </div>
  );
}
