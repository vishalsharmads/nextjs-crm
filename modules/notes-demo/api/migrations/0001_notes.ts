import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.schema.createTable('m_notes_demo_notes', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.string('title', 200).notNullable();
    t.text('body').nullable();
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('m_notes_demo_notes');
}
