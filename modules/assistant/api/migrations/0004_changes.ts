import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.schema.alterTable('m_assistant_config', (t) => {
    // Whether the assistant may propose changes at all; off makes it read-only.
    t.boolean('allow_changes').notNullable().defaultTo(true);
  });
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('m_assistant_config', (t) => {
    t.dropColumn('allow_changes');
  });
}
