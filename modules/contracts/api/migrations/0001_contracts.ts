import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.schema.createTable('m_contracts_contracts', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.string('number', 40).notNullable().unique();
    t.string('title', 200).notNullable();
    t.bigInteger('contact_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('contacts')
      .onDelete('SET NULL');
    t.bigInteger('organization_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('organizations')
      .onDelete('SET NULL');
    t.bigInteger('deal_id').unsigned().nullable().references('id').inTable('deals').onDelete('SET NULL');
    t.bigInteger('owner_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.enum('status', ['draft', 'active', 'expired', 'cancelled', 'renewed']).notNullable().defaultTo('draft');
    t.date('start_date').nullable();
    t.date('end_date').nullable();
    t.date('signed_on').nullable();
    t.specificType('currency', 'CHAR(3)').notNullable();
    t.decimal('value', 15, 2).notNullable().defaultTo(0);
    t.enum('billing_cycle', ['none', 'monthly', 'quarterly', 'yearly']).notNullable().defaultTo('none');
    t.boolean('auto_renew').notNullable().defaultTo(false);
    t.integer('renewal_term_months').unsigned().notNullable().defaultTo(12);
    t.integer('notice_days').unsigned().nullable();
    t.datetime('renewal_reminded_at').nullable();
    t.bigInteger('renewed_from_id').unsigned().nullable();
    t.specificType('renewed_to_uuid', 'CHAR(36)').nullable();
    t.datetime('cancelled_at').nullable();
    t.string('cancel_reason', 500).nullable();
    t.text('description').nullable();
    t.text('terms').nullable();
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('deleted_at').nullable();
    t.index(['status', 'end_date']);
    t.index(['owner_id']);
    t.index(['organization_id']);
    t.index(['deal_id']);
    t.index(['contact_id']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('m_contracts_contracts');
}
