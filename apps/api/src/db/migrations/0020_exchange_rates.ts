import type { Knex } from 'knex';

/**
 * Exchange rates an admin keeps (Settings → Currencies): how many units of the workspace currency
 * one unit of `currency` is worth. Reports use them to convert; nothing else does.
 */
export async function up(knex: Knex) {
  await knex.schema.createTable('exchange_rates', (t) => {
    t.specificType('currency', 'CHAR(3)').primary();
    t.decimal('rate', 18, 8).notNullable();
    t.bigInteger('updated_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('exchange_rates');
}
