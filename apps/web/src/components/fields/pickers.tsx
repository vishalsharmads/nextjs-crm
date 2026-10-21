import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { useBoot } from '@/app/session';
import { useTags, useUsersPicker } from '@/features/records/api';
import { Combobox, type ComboOption } from './combobox';

type A11y = { id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string };

export function UserPicker({
  value,
  onChange,
  placeholder,
  disabled,
  ...a11y
}: {
  value: string | null;
  onChange: (uuid: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
} & A11y) {
  const [q, setQ] = useState('');
  const { me } = useBoot();
  const users = useUsersPicker(q);
  const options = useMemo<ComboOption[]>(() => {
    const list = (users.data ?? []).map((u) => ({
      value: u.uuid,
      label: `${u.firstName} ${u.lastName}`.trim() || u.email,
      hint: u.uuid === me.uuid ? 'You' : null,
    }));
    return list.sort((a, b) => (a.value === me.uuid ? -1 : b.value === me.uuid ? 1 : 0));
  }, [users.data, me.uuid]);
  return (
    <Combobox
      {...a11y}
      value={value}
      onChange={(v) => onChange(v as string | null)}
      options={options}
      onSearch={setQ}
      loading={users.isFetching}
      placeholder={placeholder ?? 'Unassigned'}
      disabled={disabled}
    />
  );
}

/** Search-as-you-type picker for a record type (organizations, contacts, deals). */
export function RecordPicker({
  route,
  value,
  label,
  onChange,
  placeholder,
  disabled,
  ...a11y
}: {
  route: string;
  value: string | null;
  label?: string | null;
  onChange: (uuid: string | null, label?: string) => void;
  placeholder?: string;
  disabled?: boolean;
} & A11y) {
  const [q, setQ] = useState('');
  const results = useQuery({
    queryKey: ['records', route, 'picker', q],
    queryFn: () =>
      apiGet<{ data: Record<string, unknown>[] }>(`/${route}`, { q, pageSize: 20 }).then((r) => r.data),
    staleTime: 15_000,
  });
  const options = useMemo<ComboOption[]>(() => {
    const opts = (results.data ?? []).map((r) => ({
      value: r.uuid as string,
      label: (r.fullName ?? r.name ?? r.title ?? '') as string,
      hint: (r.email ?? r.domain ?? r.reference ?? null) as string | null,
    }));
    if (value && label && !opts.some((o) => o.value === value)) opts.unshift({ value, label, hint: null });
    return opts;
  }, [results.data, value, label]);
  return (
    <Combobox
      {...a11y}
      value={value}
      onChange={(v) => onChange(v as string | null, options.find((o) => o.value === v)?.label)}
      options={options}
      onSearch={setQ}
      loading={results.isFetching}
      placeholder={placeholder ?? 'Search…'}
      disabled={disabled}
    />
  );
}

export function TagsInput({
  value,
  onChange,
  disabled,
  ...a11y
}: { value: string[]; onChange: (names: string[]) => void; disabled?: boolean } & A11y) {
  const [q, setQ] = useState('');
  const tags = useTags(q);
  const options = useMemo<ComboOption[]>(() => {
    const opts = (tags.data ?? []).map((t) => ({ value: t.name, label: t.name }));
    for (const v of value) if (!opts.some((o) => o.value === v)) opts.push({ value: v, label: v });
    return opts;
  }, [tags.data, value]);
  return (
    <Combobox
      {...a11y}
      multiple
      allowCreate
      value={value}
      onChange={(v) => onChange((v as string[]) ?? [])}
      options={options}
      onSearch={setQ}
      placeholder="Add tags"
      disabled={disabled}
    />
  );
}

/** Simple select from a settings-provided list (sources, lifecycle statuses, lost reasons). */
export function ListSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  ...a11y
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
} & A11y) {
  const opts = options.map((o) => ({ value: o, label: o }));
  if (value && !options.includes(value)) opts.push({ value, label: value });
  return (
    <Combobox
      {...a11y}
      value={value}
      onChange={(v) => onChange(v as string | null)}
      options={opts}
      placeholder={placeholder ?? 'Choose…'}
      disabled={disabled}
    />
  );
}
