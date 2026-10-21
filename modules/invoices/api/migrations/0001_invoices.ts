import type { Knex } from 'knex';
import { documentColumns, lineItemColumns } from '@app/api/module-api';

export async function up(knex: Knex) {
  await knex.schema.createTable('m_invoices_invoices', (t) => {
    documentColumns(knex, t);
    t.enum('status', ['draft', 'issued', 'partially_paid', 'paid', 'void']).notNullable().defaultTo('draft');
    t.date('issue_date').notNullable();
    t.date('due_date').nullable();
    t.decimal('amount_paid', 15, 2).notNullable().defaultTo(0);
    t.datetime('issued_at').nullable();
    t.datetime('paid_at').nullable();
    t.datetime('voided_at').nullable();
    t.string('void_reason', 500).nullable();
    t.text('payment_instructions').nullable();
    t.specificType('source_quote_uuid', 'CHAR(36)').nullable();
    t.datetime('overdue_notified_at').nullable();
    t.index(['status', 'due_date']);
  });
  await knex.schema.createTable('m_invoices_lines', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('invoice_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('m_invoices_invoices')
      .onDelete('CASCADE');
    lineItemColumns(t);
    t.index(['invoice_id', 'position']);
  });
  await knex.schema.createTable('m_invoices_payments', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.bigInteger('invoice_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('m_invoices_invoices')
      .onDelete('CASCADE');
    t.decimal('amount', 15, 2).notNullable();
    t.date('paid_on').notNullable();
    t.enum('method', ['bank_transfer', 'card', 'cash', 'cheque', 'other'])
      .notNullable()
      .defaultTo('bank_transfer');
    t.string('reference', 200).nullable();
    t.string('note', 1000).nullable();
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['invoice_id']);
    t.index(['paid_on']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('m_invoices_payments');
  await knex.schema.dropTableIfExists('m_invoices_lines');
  await knex.schema.dropTableIfExists('m_invoices_invoices');
}
