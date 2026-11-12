import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.schema.alterTable('m_assistant_config', (t) => {
    // Whether the model reads images. Null: decided from the provider list for the chosen model.
    t.boolean('vision').nullable();
  });
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('m_assistant_config', (t) => {
    t.dropColumn('vision');
  });
}
