import type { Knex } from 'knex';

/** Monthly sales targets per person, in one currency (Reports → Quotas). */
export async function up(knex: Knex) {
  await knex.schema.createTable('sales_quotas', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.specificType('period', 'CHAR(7)').notNullable();
    t.decimal('amount', 15, 2).notNullable();
    t.specificType('currency', 'CHAR(3)').notNullable();
    t.bigInteger('updated_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['user_id', 'period']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('sales_quotas');
}
