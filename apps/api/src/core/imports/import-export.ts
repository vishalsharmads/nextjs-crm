import type { Knex } from 'knex';
import type { Response } from 'express';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify';
import { z } from 'zod';
import {
  SENSITIVE_MASK,
  filterSchema,
  normalizePhone,
  entityKeySchema,
  type CoreEntity,
  type CustomFieldDef,
} from '@app/shared';
import { db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import { parseTable } from './table';
import { enqueue, registerJob } from '../../lib/jobs';
import type { AuthUser, RequestContext } from '../../http/context';
import { logAccess } from '../audit/access-log';
import { readStoredFile } from '../files/files.service';
import { csvSafe } from '../../lib/csv';
import { audit } from '../audit/audit.service';
import { assertCan, loadAccess } from '../rbac/access';
import { customContext } from '../records/common';
import { applyListCriteria, createRecord, scopedQuery, updateRecord } from '../records/service';
import { getRecordDef, recordDefs } from '../records/registry';
import type { IoColumn, ResourceDef } from '../records/types';
import { applySort } from '../records/filters';
import { getGroup } from '../settings/settings.service';

export const MAX_ROWS = 50_000;

// ---------------- Columns ----------------

type Dto = Record<string, unknown> & { custom: Record<string, unknown> };

type CoreColumn = Omit<IoColumn, 'get'> & { get: (d: Dto) => unknown };

const owner = (d: Dto) => (d.owner as { name?: string } | null)?.name ?? '';
const tags = (d: Dto) => ((d.tags as { name: string }[]) ?? []).map((t) => t.name).join('; ');

export const CORE_COLUMNS: Record<Exclude<CoreEntity, 'activity'>, CoreColumn[]> = {
  contact: [
    { key: 'firstName', header: 'First name', get: (d) => d.firstName, importable: true },
    { key: 'lastName', header: 'Last name', get: (d) => d.lastName, importable: true },
    { key: 'email', header: 'Email', get: (d) => d.email, importable: true },
    { key: 'phone', header: 'Phone', get: (d) => d.phone, importable: true },
    { key: 'jobTitle', header: 'Job title', get: (d) => d.jobTitle, importable: true },
    {
      key: 'organizationName',
      header: 'Organization',
      get: (d) => (d.organizations as { organization: { name: string } }[])?.[0]?.organization.name ?? '',
      importable: true,
    },
    { key: 'source', header: 'Source', get: (d) => d.source, importable: true },
    { key: 'lifecycleStatus', header: 'Lifecycle status', get: (d) => d.lifecycleStatus, importable: true },
    { key: 'ownerEmail', header: 'Owner', get: owner, importable: true },
    { key: 'tags', header: 'Tags', get: tags, importable: true },
    { key: 'createdAt', header: 'Created', get: (d) => d.createdAt },
  ],
  organization: [
    { key: 'name', header: 'Name', get: (d) => d.name, importable: true },
    { key: 'website', header: 'Website', get: (d) => d.website, importable: true },
    { key: 'industry', header: 'Industry', get: (d) => d.industry, importable: true },
    { key: 'email', header: 'Email', get: (d) => d.email, importable: true },
    { key: 'phone', header: 'Phone', get: (d) => d.phone, importable: true },
    { key: 'addressLine1', header: 'Address', get: (d) => d.addressLine1, importable: true },
    { key: 'city', header: 'City', get: (d) => d.city, importable: true },
    { key: 'region', header: 'Region', get: (d) => d.region, importable: true },
    { key: 'postalCode', header: 'Postal code', get: (d) => d.postalCode, importable: true },
    { key: 'country', header: 'Country', get: (d) => d.country, importable: true },
    { key: 'ownerEmail', header: 'Owner', get: owner, importable: true },
    { key: 'tags', header: 'Tags', get: tags, importable: true },
    { key: 'createdAt', header: 'Created', get: (d) => d.createdAt },
  ],
  lead: [
    { key: 'firstName', header: 'First name', get: (d) => d.firstName, importable: true },
    { key: 'lastName', header: 'Last name', get: (d) => d.lastName, importable: true },
    { key: 'companyName', header: 'Company', get: (d) => d.companyName, importable: true },
    { key: 'email', header: 'Email', get: (d) => d.email, importable: true },
    { key: 'phone', header: 'Phone', get: (d) => d.phone, importable: true },
    { key: 'jobTitle', header: 'Job title', get: (d) => d.jobTitle, importable: true },
    { key: 'source', header: 'Source', get: (d) => d.source, importable: true },
    { key: 'status', header: 'Status', get: (d) => d.status, importable: true },
    { key: 'ownerEmail', header: 'Owner', get: owner, importable: true },
    { key: 'tags', header: 'Tags', get: tags, importable: true },
    { key: 'createdAt', header: 'Created', get: (d) => d.createdAt },
  ],
  deal: [
    { key: 'reference', header: 'Reference', get: (d) => d.reference },
    { key: 'title', header: 'Title', get: (d) => d.title, importable: true },
    { key: 'value', header: 'Value', get: (d) => d.value, importable: true },
    { key: 'currency', header: 'Currency', get: (d) => d.currency, importable: true },
    { key: 'stageName', header: 'Stage', get: (d) => (d.stage as { name: string }).name, importable: true },
    {
      key: 'pipelineName',
      header: 'Pipeline',
      get: (d) => (d.pipeline as { name: string }).name,
      importable: true,
    },
    {
      key: 'contactEmail',
      header: 'Contact',
      get: (d) => (d.contact as { name: string } | null)?.name ?? '',
      importable: true,
    },
    {
      key: 'organizationName',
      header: 'Organization',
      get: (d) => (d.organization as { name: string } | null)?.name ?? '',
      importable: true,
    },
    { key: 'expectedClose', header: 'Expected close', get: (d) => d.expectedClose, importable: true },
    { key: 'status', header: 'Status', get: (d) => d.status },
    { key: 'lostReason', header: 'Lost reason', get: (d) => d.lostReason },
    { key: 'ownerEmail', header: 'Owner', get: owner, importable: true },
    { key: 'tags', header: 'Tags', get: tags, importable: true },
    { key: 'createdAt', header: 'Created', get: (d) => d.createdAt },
  ],
};

/** Record types CSV import and export work on: core entities except activities, and module types. */
export function ioDef(entity: string): ResourceDef {
  const def = getRecordDef(entity);
  if (def.entity === 'activity')
    throw new AppError('VALIDATION_FAILED', 'This record type cannot be imported or exported');
  return def;
}

function ioColumns(def: ResourceDef): CoreColumn[] {
  // Every DTO carries `custom`, so a module column getter accepts it as well.
  if (def.ioColumns) return def.ioColumns;
  return CORE_COLUMNS[def.entity as Exclude<CoreEntity, 'activity'>];
}

const REQUIRED_CORE: Record<string, string> = { organization: 'name', deal: 'title' };

function exportValue(def: CustomFieldDef, v: unknown): string {
  if (v === null || v === undefined) return '';
  const label = (k: unknown) => def.options.find((o) => o.key === k)?.label ?? String(k);
  if (def.type === 'select') return label(v);
  if (def.type === 'multi_select') return (v as unknown[]).map(label).join('; ');
  if (def.type === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

// ---------------- Export ----------------

export const exportQuerySchema = z.object({
  filter: z.string().max(8000).optional(),
  q: z.string().max(200).optional(),
  view: z.uuid().optional(),
  sort: z.string().max(200).optional(),
  uuids: z.string().max(200_000).optional(),
});

/** Stream a CSV of everything the user can see in the current list (visible custom fields only). */
export async function exportCsv(
  def: ResourceDef,
  ctx: RequestContext,
  user: AuthUser,
  query: z.infer<typeof exportQuerySchema>,
  res: Response,
) {
  const entity = def.entity;
  assertCan(user, `${def.resource}.export`);
  const { defs, levels } = await customContext(entity, user);
  const visible = defs.filter((d) => levels[d.key] !== 'hidden');
  const columns = ioColumns(def);
  const { qb } = await scopedQuery(def, user, db);
  const filter = query.filter ? filterSchema.parse(JSON.parse(query.filter)) : undefined;
  const fc = await applyListCriteria(qb, def, user, { filter, q: query.q, view: query.view });
  if (query.uuids) qb.whereIn(`${def.table}.uuid`, query.uuids.split(',').slice(0, 10_000));
  applySort(qb, query.sort, fc);

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${def.table}-${stamp}.csv"`);
  const csv = stringify({
    header: true,
    columns: [...columns.map((c) => c.header), ...visible.map((d) => d.label)],
    bom: true,
  });
  csv.pipe(res);
  let count = 0;
  const batch = 500;
  for (let offset = 0; ; offset += batch) {
    const rows = await qb.clone().select(`${def.table}.*`).limit(batch).offset(offset);
    if (!rows.length) break;
    const dtos = (await def.toDtos(rows, { user, conn: db })) as Dto[];
    for (const d of dtos) {
      csv.write(
        [...columns.map((c) => c.get(d) ?? ''), ...visible.map((f) => exportValue(f, d.custom[f.key]))].map(
          csvSafe,
        ),
      );
      count++;
    }
    if (rows.length < batch) break;
  }
  await audit(db, ctx, {
    action: `${entity}.exported`,
    entity,
    diff: { count, filter: query.filter ?? null, q: query.q ?? null },
  });
  await logAccess(ctx, { action: 'export', entity, detail: { count } });
  // Recorded before the response ends, so the client never has a file the log does not show.
  await new Promise<void>((resolve) => {
    res.once('finish', resolve);
    res.once('close', resolve);
    csv.end();
  });
}

// ---------------- Import ----------------

export interface ImportTarget {
  key: string;
  label: string;
  required?: boolean;
}

export async function importTargets(def: ResourceDef, user: AuthUser): Promise<ImportTarget[]> {
  const { defs, levels } = await customContext(def.entity, user);
  const core = ioColumns(def)
    .filter((c) => c.importable)
    .map((c) => ({
      key: c.key,
      label: c.header,
      required: c.required ?? REQUIRED_CORE[def.entity] === c.key,
    }));
  return [
    ...core,
    ...defs
      .filter((d) => levels[d.key] === 'write')
      .map((d) => ({ key: `custom.${d.key}`, label: d.label, required: d.required })),
  ];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function suggestMapping(headers: string[], targets: ImportTarget[]): Record<string, string | null> {
  const aliases: Record<string, string> = {
    firstname: 'firstName',
    givenname: 'firstName',
    lastname: 'lastName',
    surname: 'lastName',
    emailaddress: 'email',
    mail: 'email',
    mobile: 'phone',
    telephone: 'phone',
    company: 'organizationName',
    companyname: 'organizationName',
    organisation: 'organizationName',
    owner: 'ownerEmail',
    amount: 'value',
    stage: 'stageName',
    closedate: 'expectedClose',
    url: 'website',
  };
  const out: Record<string, string | null> = {};
  const used = new Set<string>();
  for (const h of headers) {
    const n = norm(h);
    const match =
      targets.find(
        (t) => !used.has(t.key) && (norm(t.label) === n || norm(t.key.replace(/^custom\./, '')) === n),
      ) ?? targets.find((t) => !used.has(t.key) && aliases[n] === t.key);
    out[h] = match ? match.key : null;
    if (match) used.add(match.key);
  }
  return out;
}

export function parseCsv(buf: Buffer): { headers: string[]; rows: string[][] } {
  let records: string[][];
  try {
    records = parse(buf, { bom: true, skip_empty_lines: true, relax_column_count: true, trim: true });
  } catch (err) {
    throw new AppError('VALIDATION_FAILED', `This file could not be read as CSV: ${(err as Error).message}`);
  }
  const [headers, ...rows] = records;
  if (!headers?.length) throw new AppError('VALIDATION_FAILED', 'The file has no header row');
  if (rows.length > MAX_ROWS)
    throw new AppError('VALIDATION_FAILED', `Import up to ${MAX_ROWS.toLocaleString()} rows at a time`);
  return { headers, rows };
}

/** Convert a CSV cell to the stored format of a custom field. Throws with a readable message. */
export function coerceCustom(def: CustomFieldDef, raw: string, dateFormat: string): unknown {
  const v = raw.trim();
  if (!v) return null;
  const option = (s: string) => {
    const o = def.options.find((x) => x.key === s || x.label.toLowerCase() === s.toLowerCase());
    if (!o) throw new Error(`"${s}" is not an option for ${def.label}`);
    return o.key;
  };
  switch (def.type) {
    case 'number':
    case 'decimal':
    case 'currency': {
      const n = Number(v.replace(/[,\s]/g, '').replace(/^[^\d-]+/, ''));
      if (!Number.isFinite(n)) throw new Error(`${def.label} must be a number`);
      return def.type === 'number' ? Math.round(n) : n;
    }
    case 'boolean':
      if (/^(yes|y|true|1|x)$/i.test(v)) return true;
      if (/^(no|n|false|0)$/i.test(v)) return false;
      throw new Error(`${def.label} must be yes or no`);
    case 'select':
      return option(v);
    case 'multi_select':
      return v
        .split(/[;|,]/)
        .map((s) => option(s.trim()))
        .filter(Boolean);
    case 'date':
      return parseDate(v, dateFormat, def.label);
    case 'datetime': {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new Error(`${def.label} must be a date and time`);
      return d.toISOString();
    }
    case 'phone':
      return normalizePhone(v);
    default:
      return v;
  }
}

/** CSV cells of module record type columns, converted to their input types. */
function coerceModuleColumns(columns: IoColumn[], core: Record<string, unknown>, dateFormat: string) {
  for (const c of columns) {
    const raw = core[c.key];
    if (typeof raw !== 'string') continue;
    if (c.kind === 'number' || c.kind === 'money') {
      const cleaned = raw.replace(/[,\s]/g, '').replace(/^[^\d-]+/, '');
      const n = Number(cleaned);
      if (!cleaned || !Number.isFinite(n)) throw new Error(`${c.header} must be a number`);
      core[c.key] = n;
    } else if (c.kind === 'boolean') {
      if (/^(yes|y|true|1|x)$/i.test(raw)) core[c.key] = true;
      else if (/^(no|n|false|0)$/i.test(raw)) core[c.key] = false;
      else throw new Error(`${c.header} must be yes or no`);
    } else if (c.kind === 'date') core[c.key] = parseDate(raw, dateFormat, c.header);
    else if (c.kind === 'datetime') {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) throw new Error(`${c.header} must be a date and time`);
      core[c.key] = d.toISOString();
    }
  }
}

export function parseDate(v: string, format: string, label: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (m) {
    const [a, b, y] = [m[1]!, m[2]!, m[3]!];
    const [d, mo] = format.startsWith('MM') ? [b, a] : [a, b];
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  throw new Error(`${label} must be a date (YYYY-MM-DD)`);
}

export const importStartSchema = z.object({
  entity: entityKeySchema,
  fileUuid: z.uuid(),
  mapping: z.record(z.string().max(200), z.string().max(80).nullable()),
  options: z
    .object({
      duplicates: z.enum(['skip', 'update', 'create']).default('skip'),
      defaultOwnerUuid: z.uuid().nullish(),
      tags: z.array(z.string().max(64)).max(10).default([]),
    })
    .default({ duplicates: 'skip', tags: [] }),
});

type StartInput = z.infer<typeof importStartSchema>;

export async function startImport(ctx: RequestContext, user: AuthUser, input: StartInput) {
  const def = ioDef(input.entity);
  assertCan(user, `${def.resource}.import`);
  assertCan(user, `${def.resource}.create`);
  const file = await db('files')
    .where({ uuid: input.fileUuid, entity: 'import', uploaded_by: user.id })
    .whereNull('deleted_at')
    .first();
  if (!file) throw new AppError('NOT_FOUND', 'Upload the file again');
  const targets = new Set((await importTargets(def, user)).map((t) => t.key));
  for (const target of Object.values(input.mapping)) {
    if (target && !targets.has(target)) throw new AppError('VALIDATION_FAILED', `Unknown field: ${target}`);
  }
  const jobUuid = await enqueue(
    'import',
    { ...input, userId: user.id, requestId: ctx.requestId },
    { createdBy: user.id },
  );
  await audit(db, ctx, {
    action: `${input.entity}.import_started`,
    entity: input.entity,
    diff: { job: jobUuid, file: input.fileUuid },
  });
  return jobUuid;
}

/** Find an existing record to dedupe against. */
async function findExisting(def: ResourceDef, user: AuthUser, row: Record<string, unknown>) {
  const entity = def.entity;
  if (def.moduleKey) return null;
  const { qb } = await scopedQuery(def, user, db);
  if ((entity === 'contact' || entity === 'lead') && row.email)
    qb.where(`${def.table}.email_norm`, String(row.email).toLowerCase());
  else if (entity === 'organization' && row.name) qb.where(`${def.table}.name`, String(row.name));
  else return null;
  return (await qb.first(`${def.table}.uuid`)) as { uuid: string } | undefined;
}

/**
 * What one import needs, once: the file's rows, field definitions, the date format and users by
 * email, plus a function that imports one row. The import job runs it for real; the check runs it
 * inside a transaction that is rolled back (`conn`), so both apply exactly the same rules.
 */
async function importRunner(input: StartInput, user: AuthUser, ctx: RequestContext) {
  const def = ioDef(input.entity);
  const { defs } = await customContext(input.entity, user);
  const { dateFormat } = await getGroup('general');
  const users = new Map(
    (await db('users').whereNull('deleted_at').select('uuid', 'email')).map((x) => [
      String(x.email).toLowerCase(),
      x.uuid as string,
    ]),
  );
  const file = await db('files').where({ uuid: input.fileUuid }).first();
  const { headers, rows } = await parseTable(await readStoredFile(file));
  // Columns mapped to sensitive fields: never echo their values back in error reports.
  const sensitiveCols = new Set(
    headers.flatMap((h, col) => {
      const target = input.mapping[h];
      return target?.startsWith('custom.') &&
        defs.some((d) => d.key === target.slice(7) && d.sensitivity === 'special')
        ? [col]
        : [];
    }),
  );

  /** Imports one row; with `conn`, inside that (rolled-back) transaction. */
  async function importRow(
    cells: string[],
    conn?: Knex.Transaction,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const core: Record<string, unknown> = {};
    const custom: Record<string, unknown> = {};
    headers.forEach((h, col) => {
      const target = input.mapping[h];
      const raw = (cells[col] ?? '').trim();
      if (!target || raw === '') return;
      if (target.startsWith('custom.')) {
        const fd = defs.find((d) => d.key === target.slice(7));
        if (fd) custom[fd.key] = coerceCustom(fd, raw, dateFormat);
      } else core[target] = raw;
    });
    // Relations and lookups by human-readable values.
    if (core.ownerEmail) {
      const ownerUuid = users.get(String(core.ownerEmail).toLowerCase());
      if (!ownerUuid) throw new Error(`No user with email ${String(core.ownerEmail)}`);
      core.ownerUuid = ownerUuid;
    } else if (input.options.defaultOwnerUuid) core.ownerUuid = input.options.defaultOwnerUuid;
    delete core.ownerEmail;
    if (core.tags || input.options.tags.length)
      core.tags = [
        ...String(core.tags ?? '')
          .split(/[;,]/)
          .map((t) => t.trim())
          .filter(Boolean),
        ...input.options.tags,
      ];
    if (def.ioColumns) coerceModuleColumns(def.ioColumns, core, dateFormat);
    if (core.value !== undefined && !def.moduleKey)
      core.value = Number(String(core.value).replace(/[^\d.-]/g, ''));
    if (core.expectedClose)
      core.expectedClose = parseDate(String(core.expectedClose), dateFormat, 'Expected close');
    if (core.organizationName) {
      const name = String(core.organizationName);
      let org = await db('organizations').where({ name }).whereNull('deleted_at').first('uuid');
      if (!org)
        org = {
          uuid: ((await createRecord(recordDefs.organization, ctx, user, { name }, conn)) as { uuid: string })
            .uuid,
        };
      core.organizationUuid = org.uuid;
    }
    delete core.organizationName;
    if (core.contactEmail) {
      const c = await db('contacts')
        .where({ email_norm: String(core.contactEmail).toLowerCase() })
        .whereNull('deleted_at')
        .first('uuid');
      if (c) core.contactUuid = c.uuid;
    }
    delete core.contactEmail;
    if (core.stageName) {
      const stage = await db('pipeline_stages as s')
        .join('pipelines as p', 'p.id', 's.pipeline_id')
        .where('s.name', String(core.stageName))
        .where('s.active', true)
        .first('s.uuid', 'p.uuid as pipeline_uuid');
      if (!stage) throw new Error(`Unknown stage "${String(core.stageName)}"`);
      core.stageUuid = stage.uuid;
      core.pipelineUuid = stage.pipeline_uuid;
    }
    delete core.stageName;
    delete core.pipelineName;
    if (Object.keys(custom).length) core.custom = custom;

    const existing = input.options.duplicates === 'create' ? null : await findExisting(def, user, core);
    if (existing && input.options.duplicates === 'skip') return 'skipped';
    if (existing) {
      // A check cannot run an update without making it: it counts it instead.
      if (!conn) await updateRecord(def, ctx, user, existing.uuid, core);
      return 'updated';
    }
    await createRecord(def, ctx, user, core, conn);
    return 'created';
  }

  /** A failed row as the error report shows it (sensitive columns masked). */
  function failure(i: number, cells: string[], err: unknown) {
    const details = (err as AppError).details as { path: string; message: string }[] | undefined;
    return {
      row: i + 2,
      message: details?.length
        ? details.map((d) => `${d.path}: ${d.message}`).join('; ')
        : (err as Error).message,
      values: cells.map((c, col) => (sensitiveCols.has(col) && c ? SENSITIVE_MASK : c)),
    };
  }
  return { def, headers, rows, importRow, failure };
}

/** Rows a check runs through; larger files are checked on their first rows. */
const CHECK_ROWS = 5_000;
class Rollback extends Error {}

export interface ImportCheck {
  total: number;
  checked: number;
  wouldCreate: number;
  wouldUpdate: number;
  wouldSkip: number;
  failed: number;
  /** The first problems, row by row. */
  errors: { row: number; message: string; values: string[] }[];
  /** The same problems grouped by what went wrong, most common first. */
  problems: { message: string; rows: number[]; count: number }[];
}

/**
 * Runs the import's own rules over the file without saving anything: each row is imported inside
 * a transaction that is always rolled back (a savepoint per row, so one bad row does not spoil the
 * rest). Updates of existing records are counted, not run.
 */
export async function checkImport(
  ctx: RequestContext,
  user: AuthUser,
  input: StartInput,
): Promise<ImportCheck> {
  const def = ioDef(input.entity);
  assertCan(user, `${def.resource}.import`);
  assertCan(user, `${def.resource}.create`);
  const file = await db('files')
    .where({ uuid: input.fileUuid, entity: 'import', uploaded_by: user.id })
    .whereNull('deleted_at')
    .first();
  if (!file) throw new AppError('NOT_FOUND', 'Upload the file again');
  const targets = new Set((await importTargets(def, user)).map((t) => t.key));
  for (const target of Object.values(input.mapping))
    if (target && !targets.has(target)) throw new AppError('VALIDATION_FAILED', `Unknown field: ${target}`);

  const { rows, importRow, failure } = await importRunner(input, user, ctx);
  const out: ImportCheck = {
    total: rows.length,
    checked: Math.min(rows.length, CHECK_ROWS),
    wouldCreate: 0,
    wouldUpdate: 0,
    wouldSkip: 0,
    failed: 0,
    errors: [],
    problems: [],
  };
  const all: { row: number; message: string }[] = [];
  const seen = { created: 'wouldCreate', updated: 'wouldUpdate', skipped: 'wouldSkip' } as const;
  await db
    .transaction(async (trx) => {
      for (const [i, cells] of rows.slice(0, CHECK_ROWS).entries()) {
        try {
          out[seen[await trx.transaction((sp) => importRow(cells, sp))]]++;
        } catch (err) {
          out.failed++;
          const f = failure(i, cells, err);
          all.push({ row: f.row, message: f.message });
          if (out.errors.length < 200) out.errors.push(f);
        }
      }
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
  // Group by the message with quoted values taken out, so "Unknown stage "A"" and "…"B"" group.
  const groups = new Map<string, number[]>();
  for (const e of all) {
    const k = e.message.replace(/"[^"]*"/g, '"…"').replace(/\b\d+(\.\d+)?\b/g, '#');
    groups.set(k, [...(groups.get(k) ?? []), e.row]);
  }
  out.problems = [...groups.entries()]
    .map(([_key, r]) => ({
      message: all.find((e) => e.row === r[0])!.message,
      rows: r.slice(0, 20),
      count: r.length,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);
  return out;
}

registerJob('import', async (job, progress) => {
  const input = importStartSchema.parse(job.payload);
  const userId = job.payload.userId as number;
  const u = await db('users').where({ id: userId }).first();
  const access = await loadAccess(userId);
  const user: AuthUser = {
    id: u.id,
    uuid: u.uuid,
    email: u.email,
    firstName: u.first_name,
    lastName: u.last_name,
    sessionId: null,
    ...access,
  };
  const ctx: RequestContext = { requestId: `job:${job.uuid}`, ip: null, userAgent: null, user };
  const { headers, rows, importRow, failure } = await importRunner(input, user, ctx);
  const result = {
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [] as { row: number; message: string; values: string[] }[],
  };
  for (const [i, cells] of rows.entries()) {
    try {
      result[await importRow(cells)]++;
    } catch (err) {
      result.failed++;
      if (result.errors.length < 1000) result.errors.push(failure(i, cells, err));
    }
    if (i % 25 === 0) await progress(((i + 1) / rows.length) * 100);
  }
  await audit(db, ctx, {
    action: `${input.entity}.imported`,
    entity: input.entity,
    diff: {
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
    },
  });
  return { ...result, headers };
});
