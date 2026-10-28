import type { Knex } from 'knex';

/** Round-robin position of each automation's `assign` action, advanced atomically per run. */
export async function up(knex: Knex) {
  await knex.schema.alterTable('automations', (t) => {
    t.integer('assign_cursor').unsigned().notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('automations', (t) => {
    t.dropColumn('assign_cursor');
  });
}
