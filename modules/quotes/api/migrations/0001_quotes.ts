import type { Knex } from 'knex';
import { documentColumns, lineItemColumns } from '@app/api/module-api';

export async function up(knex: Knex) {
  await knex.schema.createTable('m_quotes_quotes', (t) => {
    documentColumns(knex, t);
    t.enum('status', ['draft', 'sent', 'accepted', 'declined', 'expired']).notNullable().defaultTo('draft');
    t.date('issue_date').notNullable();
    t.date('valid_until').nullable();
    t.datetime('sent_at').nullable();
    t.datetime('responded_at').nullable();
    t.string('accepted_by_name', 200).nullable();
    t.string('decline_reason', 500).nullable();
    t.specificType('converted_invoice_uuid', 'CHAR(36)').nullable();
    t.index(['status', 'valid_until']);
  });
  await knex.schema.createTable('m_quotes_lines', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('quote_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('m_quotes_quotes')
      .onDelete('CASCADE');
    lineItemColumns(t);
    t.index(['quote_id', 'position']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('m_quotes_lines');
  await knex.schema.dropTableIfExists('m_quotes_quotes');
}
