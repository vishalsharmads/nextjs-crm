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
/** Where in the change's input a value lives, for edits the person makes before confirming. */
export type InputPath = (string | number)[];

export interface PreviewField {
  label: string;
  value: string;
  /** The person may change this value before confirming: text, or a yes/no switch. */
  edit?: InputPath;
  kind?: 'text' | 'boolean';
  /** The value is a record type key: shown with the workspace's own name for it. */
  entity?: string;
}

/** A list in the change (widgets, fields, stages…): each item can be left out before confirming. */
export interface PreviewList {
  label: string;
  path: InputPath;
  items: { label: string; detail?: string }[];
}

export interface Preview {
  records: PreviewRecord[];
  fields: PreviewField[];
  lists?: PreviewList[];
}

/** Text fields people may edit in place before confirming. */
const EDITABLE = new Set(['name', 'title', 'label', 'subject', 'description', 'singular', 'plural']);

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
  // Link targets stay visible, so a confirmed note cannot hide where it points.
  const text = s
    .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
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
  /** A person's name, or null when it cannot be looked up. */
  person(uuid: string): Promise<string | null>;
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
  // Links set at the top level or inside the record's fields both show as records.
  const data = isObj(input.data) ? input.data : {};
  for (const [key, type] of Object.entries(LINKS)) {
    if (typeof input[key] === 'string') refs.push({ entity: type, uuid: input[key] as string });
    if (typeof data[key] === 'string') refs.push({ entity: type, uuid: data[key] as string });
  }
  // A bulk change that sets a link field names the linked record too.
  if (typeof input.field === 'string' && LINKS[input.field] && typeof input.value === 'string')
    refs.push({ entity: LINKS[input.field]!, uuid: input.value });

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
  // An owner shows by name (or by id when it cannot be looked up), never as a vague placeholder.
  for (const owner of [input.ownerUuid, data.ownerUuid])
    if (typeof owner === 'string')
      fields.push({
        label: 'Owner',
        value: (await look.person(owner).catch(() => null)) ?? `Person ${owner}`,
      });
  for (const [key, value] of Object.entries(input)) {
    if (HIDDEN.has(key) || key === 'action') continue;
    if (key === 'data' && isObj(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (k === 'custom' && isObj(v))
          for (const [ck, cv] of Object.entries(v)) fields.push({ label: humanize(ck), value: plain(cv) });
        else if (!(k in LINKS) && k !== 'ownerUuid')
          fields.push({
            label: humanize(k),
            value: plain(v),
            ...(EDITABLE.has(k) && typeof v === 'string' ? { edit: ['data', k] } : {}),
          });
      }
      continue;
    }
    fields.push({
      label: humanize(key),
      value: plain(value),
      ...(EDITABLE.has(key) && typeof value === 'string' ? { edit: [key] } : {}),
    });
  }
  return { records, fields: fields.slice(0, 30) };
}

const itemLabel = (o: Obj, i: number) =>
  [o.title, o.name, o.label, o.key].find((v): v is string => typeof v === 'string' && !!v.trim()) ??
  `Item ${i + 1}`;

/** A short description of one item in a list: its kind and settings, never its raw JSON. */
function itemDetail(o: Obj): string | undefined {
  const parts: string[] = [];
  if (typeof o.type === 'string') parts.push(o.type === 'report' ? 'Saved report' : humanize(o.type));
  const params = isObj(o.params) ? o.params : {};
  for (const [k, v] of Object.entries(params))
    if (k !== 'report' && v !== null && v !== undefined && v !== '')
      parts.push(`${humanize(k)}: ${plain(v)}`);
  if (typeof o.size === 'string') parts.push(`${humanize(o.size)} size`);
  return parts.length ? parts.join(' · ') : undefined;
}

/** A report definition in words: "Count of deals by stage", with the type named by the workspace. */
function reportFields(def: Obj, base: InputPath): PreviewField[] {
  const metric = def.metric === 'sum' ? 'Sum' : def.metric === 'avg' ? 'Average' : 'Count';
  const of =
    typeof def.metricField === 'string' && def.metric !== 'count'
      ? ` of ${humanize(def.metricField).toLowerCase()}`
      : '';
  const out: PreviewField[] = [];
  if (typeof def.entity === 'string')
    out.push({ label: 'Record type', value: def.entity, entity: def.entity });
  out.push({ label: 'Measures', value: `${metric}${of}` });
  if (typeof def.groupBy === 'string') out.push({ label: 'Grouped by', value: humanize(def.groupBy) });
  if (typeof def.groupBy2 === 'string') out.push({ label: 'Then by', value: humanize(def.groupBy2) });
  if (typeof def.chart === 'string') out.push({ label: 'Shown as', value: humanize(def.chart) });
  if (def.filter) out.push({ label: 'Filtered', value: 'Yes' });
  void base;
  return out;
}

/**
 * A configuration change's body in plain terms: its text fields (names and titles editable), report
 * definitions in words, and its lists (widgets, fields, stages) item by item, each one removable.
 */
export function configPreview(body: unknown): Pick<Preview, 'fields' | 'lists'> {
  const fields: PreviewField[] = [];
  const lists: PreviewList[] = [];
  if (!isObj(body)) return { fields: [{ label: 'Change', value: plain(body) }], lists };
  for (const [k, v] of Object.entries(body)) {
    const path: InputPath = ['body', k];
    if (k === 'definition' && isObj(v)) fields.push(...reportFields(v, path));
    else if (Array.isArray(v) && v.some(isObj))
      lists.push({
        label: humanize(k),
        path,
        items: v.map((item, i) =>
          isObj(item) ? { label: itemLabel(item, i), detail: itemDetail(item) } : { label: plain(item) },
        ),
      });
    else if (isObj(v)) fields.push({ label: humanize(k), value: plain(v) });
    else
      fields.push({
        label: humanize(k),
        value: plain(v),
        ...(typeof v === 'boolean'
          ? { edit: path, kind: 'boolean' as const }
          : EDITABLE.has(k) && typeof v === 'string'
            ? { edit: path }
            : {}),
      });
  }
  return { fields: fields.slice(0, 30), lists };
}

/** Edits the person made in the preview: new text for editable fields, items left out of lists. */
export interface Edits {
  set?: { path: InputPath; value: string | boolean }[];
  drop?: { path: InputPath; index: number }[];
}

const key = (p: InputPath) => JSON.stringify(p);

/**
 * The change's input with the person's edits, only where the preview offered them: text replaces
 * text at an editable path, and items leave a listed array. Anything else is refused.
 */
export function applyEdits(input: Obj, preview: Preview | undefined, edits: Edits): Obj {
  const editable = new Set((preview?.fields ?? []).flatMap((f) => (f.edit ? [key(f.edit)] : [])));
  const listed = new Set((preview?.lists ?? []).map((l) => key(l.path)));
  const out = JSON.parse(JSON.stringify(input)) as Obj;
  const at = (path: InputPath): { parent: Obj | unknown[]; last: string | number } => {
    let node: unknown = out;
    for (const step of path.slice(0, -1)) node = (node as Record<string | number, unknown>)?.[step];
    return { parent: node as Obj, last: path.at(-1)! };
  };
  for (const s of edits.set ?? []) {
    if (!editable.has(key(s.path))) throw new Error('This value cannot be changed here');
    const { parent, last } = at(s.path);
    // A value keeps its kind: text stays text, a yes/no stays a yes/no.
    if (typeof (parent as Record<string | number, unknown>)[last] !== typeof s.value)
      throw new Error('This value cannot be changed that way');
    (parent as Record<string | number, unknown>)[last] = s.value;
  }
  const drops = new Map<string, number[]>();
  for (const d of edits.drop ?? []) {
    if (!listed.has(key(d.path))) throw new Error('This list cannot be changed here');
    drops.set(key(d.path), [...(drops.get(key(d.path)) ?? []), d.index]);
  }
  for (const [k, indices] of drops) {
    const path = JSON.parse(k) as InputPath;
    const { parent, last } = at(path);
    const list = (parent as Record<string | number, unknown>)[last];
    if (!Array.isArray(list)) throw new Error('Not a list');
    (parent as Record<string | number, unknown>)[last] = list.filter((_, i) => !indices.includes(i));
  }
  return out;
}
