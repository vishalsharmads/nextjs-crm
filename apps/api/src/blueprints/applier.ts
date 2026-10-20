import type { Knex } from 'knex';
import {
  checksum,
  compareVersions,
  loadBlueprint,
  type Blueprint,
  type BlueprintField,
  type BlueprintPipeline,
  type BlueprintRole,
} from '@app/blueprints';
import { SETTINGS_GROUPS, type SettingsGroup, type CustomizableEntity } from '@app/shared';
import { newUuid } from '../lib/ids';
import { isKnownPermissionPattern } from '../core/rbac/catalog';
import { clearAccessCache } from '../core/rbac/access';
import { clearSettingsCache } from '../core/settings/settings.service';
import { clearLabelCache } from '../core/labels/labels.service';
import { bumpDefinitionsVersion } from '../core/custom-fields/definitions';
import { ensureCustomFieldIndexes } from '../core/custom-fields/ddl.service';
import { loadModules, enableModule, getModule } from '../modules/registry';
import { seedSampleData } from './sample-data';

export interface ApplyOptions {
  dryRun?: boolean;
  force?: boolean;
  sampleData?: boolean;
  appliedBy?: number | null;
}

export interface Conflict {
  item: string;
  reason: 'customized' | 'unmanaged' | 'other_blueprint';
  message: string;
}

export interface ApplyReport {
  blueprint: string;
  version: string;
  status: 'applied' | 'unchanged' | 'dry_run';
  created: string[];
  updated: string[];
  unchanged: number;
  conflicts: Conflict[];
  orphaned: string[];
  warnings: string[];
  ddl: string[];
  summary: string;
}

class BlueprintError extends Error {}

type Trx = Knex.Transaction;

interface UpsertSpec {
  table: string;
  sourceKey: string;
  natural: Record<string, unknown>;
  values: Record<string, unknown>;
  /** Extra data included in the hash (e.g. role permissions stored in child tables). */
  hashExtra?: unknown;
  /** Hash only this instead of values + extra (settings: the blueprint's own values). */
  hashOf?: unknown;
}

class Applier {
  readonly report: ApplyReport;
  private readonly seen = new Map<string, Set<string>>();

  constructor(
    private readonly trx: Trx,
    private readonly bp: Blueprint,
  ) {
    this.report = {
      blueprint: bp.key,
      version: bp.version,
      status: 'applied',
      created: [],
      updated: [],
      unchanged: 0,
      conflicts: [],
      orphaned: [],
      warnings: [],
      ddl: [],
      summary: '',
    };
  }

  private markSeen(table: string, sourceKey: string) {
    if (!this.seen.has(table)) this.seen.set(table, new Set());
    this.seen.get(table)!.add(sourceKey);
  }

  /** Core rule: create missing, update untouched, never overwrite client edits. Returns the row id. */
  async upsert(
    spec: UpsertSpec,
  ): Promise<{ id: number; action: 'created' | 'updated' | 'unchanged' | 'conflict' }> {
    const { trx, bp } = this;
    this.markSeen(spec.table, spec.sourceKey);
    const hash = checksum(
      spec.hashOf !== undefined ? spec.hashOf : { values: spec.values, extra: spec.hashExtra ?? null },
    );
    const bpCols = {
      source_blueprint: bp.key,
      source_key: spec.sourceKey,
      source_version: bp.version,
      source_hash: hash,
    };

    const existing =
      (await trx(spec.table).where({ source_blueprint: bp.key, source_key: spec.sourceKey }).first()) ??
      (await trx(spec.table).where(spec.natural).first());

    if (!existing) {
      const values =
        spec.table === 'custom_field_definitions' ||
        spec.table === 'pipelines' ||
        spec.table === 'pipeline_stages' ||
        spec.table === 'roles' ||
        spec.table === 'templates' ||
        spec.table === 'dashboards'
          ? { uuid: newUuid(), ...spec.values }
          : spec.values;
      const [id] = await trx(spec.table).insert({ ...spec.natural, ...values, ...bpCols, customized: false });
      this.report.created.push(spec.sourceKey);
      return { id: id!, action: 'created' };
    }
    const id = existing.id as number;
    if (existing.source_blueprint && existing.source_blueprint !== bp.key) {
      this.report.conflicts.push({
        item: spec.sourceKey,
        reason: 'other_blueprint',
        message: `Owned by blueprint "${existing.source_blueprint}"`,
      });
      return { id, action: 'conflict' };
    }
    if (!existing.source_blueprint && existing.customized) {
      this.report.conflicts.push({
        item: spec.sourceKey,
        reason: 'unmanaged',
        message: 'An item with the same key was created on this instance',
      });
      return { id, action: 'conflict' };
    }
    if (existing.customized) {
      if (existing.source_hash !== hash) {
        this.report.conflicts.push({
          item: spec.sourceKey,
          reason: 'customized',
          message: 'Edited on this instance; blueprint change not applied',
        });
        return { id, action: 'conflict' };
      }
      this.report.unchanged++;
      return { id, action: 'unchanged' };
    }
    if (existing.source_hash === hash && existing.source_blueprint === bp.key) {
      this.report.unchanged++;
      return { id, action: 'unchanged' };
    }
    if (!existing.source_blueprint) {
      // Unmanaged and never edited (e.g. install defaults): adopt it.
      await trx(spec.table)
        .where({ id })
        .update({ ...spec.values, ...bpCols, customized: false });
      this.report.updated.push(spec.sourceKey);
      return { id, action: 'updated' };
    }
    await trx(spec.table)
      .where({ id })
      .update({ ...spec.values, ...bpCols });
    this.report.updated.push(spec.sourceKey);
    return { id, action: 'updated' };
  }

  async settings() {
    for (const [group, value] of Object.entries(this.bp.settings)) {
      if (!(group in SETTINGS_GROUPS)) {
        this.report.warnings.push(`Unknown settings group "${group}" ignored`);
        continue;
      }
      const row = await this.trx('settings').where({ key: group }).first();
      const current = (row?.value as Record<string, unknown>) ?? {};
      const merged = SETTINGS_GROUPS[group as SettingsGroup].parse({ ...current, ...(value as object) });
      await this.upsert({
        table: 'settings',
        sourceKey: `settings.${group}`,
        natural: { key: group },
        values: { group, value: JSON.stringify(merged) },
        hashOf: value,
      });
    }
  }

  async vocabulary() {
    for (const [entityKey, l] of Object.entries(this.bp.vocabulary)) {
      await this.upsert({
        table: 'labels',
        sourceKey: `label.${entityKey}`,
        natural: { entity_key: entityKey, locale: 'en' },
        values: { singular: l.singular, plural: l.plural },
      });
    }
  }

  async modules() {
    loadModules();
    for (const key of this.bp.modules) {
      const mod = getModule(key);
      if (!mod) {
        this.report.warnings.push(`Module "${key}" is not installed in this build`);
        continue;
      }
      if (mod.manifest.status === 'stub') {
        this.report.warnings.push(
          `Module "${key}" is not available yet (stub); it will be enabled when released`,
        );
        await this.trx('module_states')
          .insert({ module_key: key, enabled: false })
          .onConflict('module_key')
          .ignore();
      }
    }
  }

  async role(role: BlueprintRole) {
    const unknown = role.permissions.filter((p) => !isKnownPermissionPattern(p));
    if (unknown.length)
      throw new BlueprintError(`Role "${role.key}" uses unknown permissions: ${unknown.join(', ')}`);
    if (role.key === 'admin') {
      this.report.warnings.push('The Admin role is managed by the system and was not changed');
      return;
    }
    const res = await this.upsert({
      table: 'roles',
      sourceKey: `role.${role.key}`,
      natural: { key: role.key },
      values: { name: role.name, description: role.description },
      hashExtra: { permissions: [...role.permissions].sort(), scopes: role.scopes },
    });
    if (res.action === 'created' || res.action === 'updated') {
      await this.trx('role_permissions').where({ role_id: res.id }).delete();
      if (role.permissions.length) {
        await this.trx('role_permissions').insert(
          [...new Set(role.permissions)].map((pattern) => ({ role_id: res.id, pattern })),
        );
      }
      await this.trx('role_scopes').where({ role_id: res.id }).delete();
      const scopes = Object.entries(role.scopes);
      if (scopes.length)
        await this.trx('role_scopes').insert(
          scopes.map(([resource, scope]) => ({ role_id: res.id, resource, scope })),
        );
    }
  }

  async fieldGroups() {
    for (const [entity, groups] of Object.entries(this.bp.custom_field_groups)) {
      for (const [i, g] of (groups ?? []).entries()) {
        await this.upsert({
          table: 'custom_field_groups',
          sourceKey: `group.${entity}.${g.key}`,
          natural: { entity, key: g.key },
          values: {
            label: g.label,
            sort_order: i * 10,
            visibility: g.visibility ? JSON.stringify(g.visibility) : null,
          },
        });
      }
    }
  }

  async field(entity: CustomizableEntity, f: BlueprintField, index: number) {
    await this.upsert({
      table: 'custom_field_definitions',
      sourceKey: `field.${entity}.${f.key}`,
      natural: { entity, key: f.key },
      values: {
        label: f.label,
        type: f.type,
        group_key: f.group ?? null,
        config: JSON.stringify({ options: f.options, currency: f.currency, placeholder: f.placeholder }),
        required: f.required,
        default_value: f.default === undefined ? null : JSON.stringify(f.default),
        validation: f.validation ? JSON.stringify(f.validation) : null,
        visibility: f.visibility ? JSON.stringify(f.visibility) : null,
        help_text: f.help_text ?? null,
        filterable: f.filterable,
        show_in_list: f.show_in_list,
        sort_order: index * 10,
        active: true,
      },
    });
  }

  async pipeline(p: BlueprintPipeline, index: number) {
    const res = await this.upsert({
      table: 'pipelines',
      sourceKey: `pipeline.${p.key}`,
      natural: { name: p.name, entity: p.entity },
      values: { name: p.name, entity: p.entity, is_default: p.is_default, sort_order: index * 10 },
    });
    if (res.action === 'conflict') return;
    if (p.is_default) {
      const otherDefault = await this.trx('pipelines')
        .where({ entity: p.entity, is_default: true })
        .whereNot({ id: res.id })
        .first();
      if (otherDefault && res.action === 'created')
        await this.trx('pipelines').where({ id: res.id }).update({ is_default: false });
    }
    for (const [i, s] of p.stages.entries()) {
      await this.upsert({
        table: 'pipeline_stages',
        sourceKey: `pipeline.${p.key}.${s.key}`,
        natural: { pipeline_id: res.id, key: s.key },
        values: {
          name: s.name,
          probability: s.is_won ? 100 : s.is_lost ? 0 : s.probability,
          color: s.color ?? null,
          is_won: s.is_won,
          is_lost: s.is_lost,
          rotting_days: s.rotting_days ?? null,
          sort_order: i * 10,
        },
      });
    }
  }

  async layouts() {
    for (const l of this.bp.layouts) {
      await this.upsert({
        table: 'layouts',
        sourceKey: `layout.${l.entity}.${l.context}`,
        natural: { entity: l.entity, context: l.context, name: 'default' },
        values: { config: JSON.stringify({ sections: l.sections, columns: l.columns }), is_default: true },
      });
    }
  }

  async dashboard() {
    if (!this.bp.dashboard) return;
    await this.upsert({
      table: 'dashboards',
      sourceKey: 'dashboard.default',
      natural: { owner_id: null, is_default: true },
      values: { name: this.bp.dashboard.name, widgets: JSON.stringify(this.bp.dashboard.widgets) },
    });
  }

  async templates() {
    for (const t of this.bp.templates) {
      await this.upsert({
        table: 'templates',
        sourceKey: `template.${t.key}.${t.channel}.${t.locale}`,
        natural: { key: t.key, channel: t.channel, locale: t.locale },
        values: { name: t.name, subject: t.subject, body: t.body },
      });
    }
  }

  /** Items this blueprint created before but no longer lists. Reported, never deleted. */
  async orphans() {
    for (const table of [
      'labels',
      'roles',
      'custom_field_groups',
      'custom_field_definitions',
      'pipelines',
      'pipeline_stages',
      'layouts',
      'dashboards',
      'templates',
    ]) {
      const rows = await this.trx(table).where({ source_blueprint: this.bp.key }).select('source_key');
      const seen = this.seen.get(table) ?? new Set();
      for (const r of rows) if (!seen.has(r.source_key)) this.report.orphaned.push(r.source_key as string);
    }
  }

  async run() {
    await this.settings();
    await this.vocabulary();
    await this.modules();
    for (const role of this.bp.roles) await this.role(role);
    await this.fieldGroups();
    for (const [entity, fields] of Object.entries(this.bp.custom_fields)) {
      for (const [i, f] of (fields ?? []).entries()) await this.field(entity as CustomizableEntity, f, i);
    }
    for (const [i, p] of this.bp.pipelines.entries()) await this.pipeline(p, i);
    await this.layouts();
    await this.dashboard();
    await this.templates();
    await this.orphans();
  }
}

export async function applyBlueprint(
  knex: Knex,
  bp: Blueprint,
  opts: ApplyOptions = {},
): Promise<ApplyReport> {
  if (bp.status === 'stub' && !opts.force) {
    throw new BlueprintError(`Blueprint "${bp.key}" is a stub and cannot be applied yet`);
  }
  const sum = checksum(bp);
  const last = await knex('blueprint_applications').orderBy('id', 'desc').first();
  if (last && last.blueprint_key !== bp.key && !opts.force) {
    throw new BlueprintError(
      `This instance uses blueprint "${last.blueprint_key}". One primary blueprint per instance.`,
    );
  }
  if (last && last.blueprint_key === bp.key) {
    const cmp = compareVersions(bp.version, last.version);
    if (cmp < 0 && !opts.force)
      throw new BlueprintError(`Refusing to downgrade from ${last.version} to ${bp.version}`);
    if (cmp === 0 && last.checksum !== sum && !opts.force) {
      throw new BlueprintError(
        `Blueprint ${bp.key}@${bp.version} changed without a version bump. Bump "version" and re-apply.`,
      );
    }
  }

  loadModules();
  let report: ApplyReport;
  const DRY = Symbol('dry-run');
  try {
    report = await knex.transaction(async (trx) => {
      const applier = new Applier(trx, bp);
      await applier.run();
      if (opts.dryRun) {
        applier.report.status = 'dry_run';
        throw Object.assign(new Error('dry run'), { [DRY]: applier.report });
      }
      return applier.report;
    });
  } catch (err) {
    if (err && typeof err === 'object' && DRY in err)
      return finalize((err as Record<symbol, ApplyReport>)[DRY]!);
    throw err;
  }

  // Phase B (outside the transaction: DDL commits implicitly). Idempotent and safe to re-run.
  for (const key of bp.modules) {
    const mod = getModule(key);
    if (mod && mod.manifest.status !== 'stub') {
      await enableModule(key);
    }
  }
  report.ddl = await ensureCustomFieldIndexes();

  if (opts.sampleData && bp.sample_data && !last) {
    const n = await seedSampleData(knex, bp);
    report.warnings.push(`Seeded ${n} sample records`);
  }

  const nothingChanged = !report.created.length && !report.updated.length && !report.ddl.length;
  if (nothingChanged && last?.checksum === sum) report.status = 'unchanged';
  if (!(nothingChanged && last?.checksum === sum)) {
    await knex('blueprint_applications').insert({
      blueprint_key: bp.key,
      version: bp.version,
      checksum: sum,
      applied_by: opts.appliedBy ?? null,
      report: JSON.stringify(report),
    });
  }
  clearSettingsCache();
  clearLabelCache();
  clearAccessCache();
  bumpDefinitionsVersion();
  return finalize(report);
}

function finalize(report: ApplyReport): ApplyReport {
  report.summary = [
    `${report.created.length} created`,
    `${report.updated.length} updated`,
    `${report.unchanged} unchanged`,
    `${report.conflicts.length} conflicts`,
    report.orphaned.length ? `${report.orphaned.length} orphaned` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return report;
}

export async function applyBlueprintByKey(knex: Knex, key: string, opts: ApplyOptions = {}) {
  return applyBlueprint(knex, loadBlueprint(key), opts);
}

export { BlueprintError };
