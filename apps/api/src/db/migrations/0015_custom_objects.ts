import type { Knex } from 'knex';
import { blueprintCols, idCols, timestamps } from '../helpers';

/**
 * Admin-defined objects (Settings → Objects). Each object's records live in their own table,
 * `m_custom_<key>`, created when the object is created (see `core/objects/objects.ddl.ts`).
 */
export async function up(knex: Knex) {
  await knex.schema.createTable('custom_objects', (t) => {
    idCols(t);
    t.string('entity', 32).notNullable().unique();
    t.string('route', 48).notNullable().unique();
    t.string('singular', 60).notNullable();
    t.string('plural', 60).notNullable();
    t.string('icon', 32).notNullable().defaultTo('box');
    t.string('description', 500).nullable();
    t.json('links').notNullable();
    t.integer('sort_order').notNullable().defaultTo(0);
    t.datetime('archived_at').nullable();
    blueprintCols(t);
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.bigInteger('updated_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    timestamps(knex, t);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('custom_objects');
}
