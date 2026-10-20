import type { Knex } from 'knex';

export function idCols(t: Knex.CreateTableBuilder, withUuid = true) {
  t.bigIncrements('id').unsigned().primary();
  if (withUuid) t.specificType('uuid', 'CHAR(36)').notNullable().unique();
}

export function timestamps(knex: Knex, t: Knex.CreateTableBuilder) {
  t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  t.datetime('updated_at').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

/** created/updated by + soft delete, for business entities. */
export function auditCols(knex: Knex, t: Knex.CreateTableBuilder) {
  timestamps(knex, t);
  t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
  t.bigInteger('updated_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
  t.datetime('deleted_at').nullable().index();
}

/** Provenance columns for config rows that a blueprint may seed. */
export function blueprintCols(t: Knex.CreateTableBuilder) {
  t.string('source_blueprint', 64).nullable();
  t.string('source_key', 150).nullable();
  t.string('source_version', 20).nullable();
  t.specificType('source_hash', 'CHAR(64)').nullable();
  t.boolean('customized').notNullable().defaultTo(false);
  t.unique(['source_blueprint', 'source_key']);
}
