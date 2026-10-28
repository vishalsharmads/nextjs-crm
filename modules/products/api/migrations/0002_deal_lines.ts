import type { Knex } from 'knex';
import { lineItemColumns } from '@app/api/module-api';

/** Products and services on a deal (Line items tab on the deal page). */
export async function up(knex: Knex) {
  await knex.schema.createTable('m_products_deal_lines', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('deal_id').unsigned().notNullable().references('id').inTable('deals').onDelete('CASCADE');
    lineItemColumns(t);
    t.index(['deal_id', 'position']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('m_products_deal_lines');
}
