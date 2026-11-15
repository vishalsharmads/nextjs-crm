import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { ParticipantKind } from '@app/shared';
import { apiGet } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { Combobox } from '@/components/fields/combobox';
import { useUsersPicker } from '@/features/records/api';
import { useTypeName } from '@/features/search/search-hit';

export interface PickedParticipant {
  kind: ParticipantKind;
  uuid: string;
  name: string;
}

/** People, companies and colleagues taking part in a meeting or call. */
export function ParticipantsPicker({
  value,
  onChange,
}: {
  value: PickedParticipant[];
  onChange: (v: PickedParticipant[]) => void;
}) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 200);
  const typeName = useTypeName();
  const records = useQuery({
    queryKey: ['participants-search', term],
    queryFn: () =>
      apiGet<{ data: { type: string; uuid: string; title: string }[] }>('/search', {
        q: term,
        types: 'contact,lead,organization',
        limit: 8,
      }).then((r) => r.data),
    enabled: term.length >= 2,
  });
  const users = useUsersPicker(term);
  const taken = new Set(value.map((v) => `${v.kind}:${v.uuid}`));
  const options = useMemo(
    () =>
      [
        ...(records.data ?? []).map((r) => ({
          value: `${r.type}:${r.uuid}`,
          label: `${r.title} · ${typeName(r.type)}`,
        })),
        ...(users.data ?? []).map((u) => ({
          value: `user:${u.uuid}`,
          label: `${`${u.firstName} ${u.lastName}`.trim() || u.email} · colleague`,
        })),
      ].filter((o) => !taken.has(o.value)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [records.data, users.data, value],
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((p) => (
        <span
          key={`${p.kind}:${p.uuid}`}
          className="inline-flex items-center gap-1 rounded-full bg-subtle px-2 py-0.5 text-xs"
        >
          {p.name}
          <button
            type="button"
            aria-label={`Remove ${p.name}`}
            onClick={() => onChange(value.filter((v) => !(v.kind === p.kind && v.uuid === p.uuid)))}
            className="text-muted hover:text-ink"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <div className="min-w-48 flex-1">
        <Combobox
          aria-label="Add a participant"
          value={null}
          options={options}
          onSearch={setQ}
          loading={records.isFetching || users.isFetching}
          placeholder="Add people or colleagues"
          onChange={(v) => {
            const o = options.find((x) => x.value === v);
            if (!o) return;
            const [kind, uuid] = String(v).split(':') as [ParticipantKind, string];
            onChange([...value, { kind, uuid, name: o.label.split(' · ')[0]! }]);
          }}
        />
      </div>
    </div>
  );
}
