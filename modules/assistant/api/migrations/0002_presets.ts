import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.schema.alterTable('m_assistant_config', (t) => {
    // The provider picked from the list (null: set by hand).
    t.string('preset', 40).nullable();
    // Admins may let the assistant set up the workspace; off until an admin turns it on.
    t.boolean('setup_enabled').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('m_assistant_config', (t) => {
    t.dropColumn('preset');
    t.dropColumn('setup_enabled');
  });
}
