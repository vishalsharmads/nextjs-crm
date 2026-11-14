import type { Knex } from 'knex';
import { blueprintCols, idCols, timestamps } from '../helpers';

/**
 * Duplicate rules (which fields must match for two records to be the same person or company) and
 * the pairs a scan found. Starter rules match what the app checked before rules existed.
 */
export async function up(knex: Knex) {
  await knex.schema.createTable('duplicate_rules', (t) => {
    idCols(t);
    t.string('entity', 32).notNullable();
    t.string('name', 100).notNullable();
    t.json('fields').notNullable();
    t.enum('action', ['warn', 'block']).notNullable().defaultTo('warn');
    t.boolean('active').notNullable().defaultTo(true);
    t.integer('position').notNullable().defaultTo(0);
    blueprintCols(t);
    timestamps(knex, t);
    t.index(['entity', 'active']);
  });
  await knex.schema.createTable('duplicate_pairs', (t) => {
    idCols(t);
    t.string('entity', 32).notNullable();
    t.bigInteger('a_id').unsigned().notNullable();
    t.bigInteger('b_id').unsigned().notNullable();
    t.bigInteger('rule_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('duplicate_rules')
      .onDelete('SET NULL');
    t.enum('status', ['open', 'merged', 'dismissed']).notNullable().defaultTo('open');
    t.bigInteger('resolved_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('resolved_at').nullable();
    timestamps(knex, t);
    t.unique(['entity', 'a_id', 'b_id']);
    t.index(['entity', 'status']);
  });
  const rows = [
    ['contact', 'Same email', ['email'], 1],
    ['contact', 'Same phone', ['phone'], 2],
    ['contact', 'Same name and organization', ['name', 'organization'], 3],
    ['organization', 'Same website', ['domain'], 1],
    ['organization', 'Same name', ['name'], 2],
    ['lead', 'Same email', ['email'], 1],
    ['lead', 'Same phone', ['phone'], 2],
  ] as const;
  const { v7 } = await import('uuid');
  await knex('duplicate_rules').insert(
    rows.map(([entity, name, fields, position]) => ({
      uuid: v7(),
      entity,
      name,
      fields: JSON.stringify(fields),
      position,
    })),
  );
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('duplicate_pairs');
  await knex.schema.dropTableIfExists('duplicate_rules');
}
