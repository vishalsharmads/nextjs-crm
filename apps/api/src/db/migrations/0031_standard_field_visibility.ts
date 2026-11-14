import type { Knex } from 'knex';

/** Per-role visibility of standard fields (deal value, contact email…), like custom fields have. */
export async function up(knex: Knex) {
  await knex.schema.createTable('standard_field_visibility', (t) => {
    t.bigIncrements('id');
    t.string('entity', 32).notNullable();
    t.string('field', 64).notNullable();
    t.json('visibility').notNullable();
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['entity', 'field']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('standard_field_visibility');
}
