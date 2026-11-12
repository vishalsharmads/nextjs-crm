/**
 * What a proposed change will do, in a form people can check before confirming: the records it
 * touches by name and its fields as plain values. Names are looked up as the person (a record they
 * cannot see stays unnamed), and nothing here decides what runs: the confirmed input does.
 */
export interface PreviewRecord {
  entity: string;
  uuid: string;
  name: string | null;
}
export interface Preview {
  records: PreviewRecord[];
  fields: { label: string; value: string }[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const UUID = /^[0-9a-f-]{36}$/;

/** Inputs that name a record of a known type. */
const LINKS: Record<string, string> = {
  contactUuid: 'contact',
  organizationUuid: 'organization',
  dealUuid: 'deal',
  leadUuid: 'lead',
};
/** Inputs that only steer the call and are shown another way (as records) or not at all. */
const HIDDEN = new Set([
  'entity',
  'uuid',
  'uuids',
  'related',
  'stageUuid',
  'ownerUuid',
  ...Object.keys(LINKS),
]);

const ACTIONS: Record<string, string> = {
  assign: 'Assign an owner',
  add_tags: 'Add tags',
  remove_tags: 'Remove tags',
  update_field: 'Set a field',
  move_stage: 'Move to a stage',
};

export const humanize = (key: string) =>
  key
    .replace(/^cf\./, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

/** A value as short plain text: HTML becomes text, dates read as dates, long text is shortened. */
export function plain(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(plain).join(', ');
  if (isObj(v))
    return Object.entries(v)
      .map(([k, x]) => `${humanize(k)}: ${plain(x)}`)
      .join('; ');
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 16).replace('T', ' ');
  }
  const text = s
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

export interface Lookups {
  /** The record's name as this person sees it, or null when it is not found or not visible. */
  record(entity: string, uuid: string): Promise<string | null>;
  /** A pipeline stage's name, or null. */
  stage(uuid: string): Promise<string | null>;
}

export async function previewOf(name: string, input: Obj, look: Lookups): Promise<Preview> {
  const refs: { entity: string; uuid: string }[] = [];
  const entity = typeof input.entity === 'string' ? input.entity : undefined;
  if (entity && typeof input.uuid === 'string') refs.push({ entity, uuid: input.uuid });
  if (name === 'complete_task' && typeof input.uuid === 'string')
    refs.push({ entity: 'activity', uuid: input.uuid });
  if (entity && Array.isArray(input.uuids))
    for (const u of input.uuids.slice(0, 10)) if (typeof u === 'string') refs.push({ entity, uuid: u });
  if (
    isObj(input.related) &&
    typeof input.related.type === 'string' &&
    typeof input.related.uuid === 'string'
  )
    refs.push({ entity: input.related.type, uuid: input.related.uuid });
  for (const [key, type] of Object.entries(LINKS))
    if (typeof input[key] === 'string') refs.push({ entity: type, uuid: input[key] as string });

  const records = await Promise.all(
    refs
      .filter((r) => UUID.test(r.uuid))
      .map(async (r) => ({ ...r, name: await look.record(r.entity, r.uuid).catch(() => null) })),
  );

  const fields: Preview['fields'] = [];
  if (typeof input.action === 'string')
    fields.push({ label: 'Change', value: ACTIONS[input.action] ?? humanize(input.action) });
  if (Array.isArray(input.uuids) && input.uuids.length > records.length)
    fields.push({ label: 'Records', value: `${input.uuids.length} in all` });
  if (typeof input.stageUuid === 'string')
    fields.push({
      label: 'Stage',
      value: (await look.stage(input.stageUuid).catch(() => null)) ?? 'The chosen stage',
    });
  if (typeof input.ownerUuid === 'string') fields.push({ label: 'Owner', value: 'The person chosen' });
  for (const [key, value] of Object.entries(input)) {
    if (HIDDEN.has(key) || key === 'action') continue;
    if (key === 'data' && isObj(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (k === 'custom' && isObj(v))
          for (const [ck, cv] of Object.entries(v)) fields.push({ label: humanize(ck), value: plain(cv) });
        else if (!(k in LINKS)) fields.push({ label: humanize(k), value: plain(v) });
      }
      continue;
    }
    fields.push({ label: humanize(key), value: plain(value) });
  }
  return { records, fields: fields.slice(0, 30) };
}
