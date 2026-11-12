/** A record a tool returned, by the name people see. */
export interface RecordRef {
  entity: string;
  uuid: string;
  name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENTITY = /^[a-z][a-z0-9_]{0,63}$/;
/** Links between core records, as tools return them (`organization: { uuid, name }`). */
const LINKED = ['contact', 'organization', 'lead', 'deal'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

export function nameOf(o: Obj): string | null {
  const parts = [o.firstName, o.lastName].filter((p): p is string => typeof p === 'string' && !!p);
  const name = [o.name, o.title, o.fullName, o.subject].find(
    (v): v is string => typeof v === 'string' && !!v.trim(),
  );
  return (name ?? parts.join(' ')).trim() || null;
}

function add(out: RecordRef[], entity: unknown, o: Obj) {
  const name = nameOf(o);
  if (
    typeof entity === 'string' &&
    ENTITY.test(entity) &&
    typeof o.uuid === 'string' &&
    UUID.test(o.uuid) &&
    name
  )
    out.push({ entity, uuid: o.uuid, name });
}

/**
 * Records in one tool result: the records themselves (a list, one record or search hits) and the
 * core records they link to. `entity` is the type the tool was asked for, when it names one.
 */
export function recordsIn(result: string, entity: unknown): RecordRef[] {
  let data: unknown;
  try {
    data = JSON.parse(result) as unknown;
  } catch {
    return [];
  }
  if (!isObj(data)) return [];
  const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.results) ? data.results : [data];
  const out: RecordRef[] = [];
  for (const row of rows.slice(0, 100)) {
    if (!isObj(row)) continue;
    add(out, row.type ?? entity, row);
    for (const key of LINKED) if (isObj(row[key])) add(out, key, row[key]);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeMd = (s: string) => s.replace(/[[\]\\]/g, '\\$&');

/**
 * Links the first mention of each record by name, so it shows as a chip whatever the model wrote.
 * Links the model already wrote, and code, are left alone; longer names win over names they contain.
 */
export function linkRecords(text: string, refs: RecordRef[]): string {
  const byName = new Map<string, RecordRef>();
  for (const r of refs) if (r.name.length >= 3 && !byName.has(r.name)) byName.set(r.name, r);
  if (!byName.size) return text;
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).slice(0, 200);
  const pattern = new RegExp(`(\\[[^\\]]*\\]\\([^)]*\\)|\`[^\`]*\`)|(${names.map(escapeRe).join('|')})`, 'g');
  const linked = new Set<string>();
  return text.replace(pattern, (m, skip: string | undefined, name: string | undefined) => {
    if (skip || !name || linked.has(name)) return m;
    const ref = byName.get(name)!;
    linked.add(name);
    return `[${escapeMd(name)}](record:${ref.entity}/${ref.uuid})`;
  });
}
