import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.schema.createTable('m_assets_assets', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.string('tag', 64).notNullable().unique();
    t.string('name', 200).notNullable();
    t.string('category', 100).notNullable().defaultTo('');
    t.string('serial', 120).notNullable().defaultTo('');
    t.string('location', 150).notNullable().defaultTo('');
    t.enum('status', ['available', 'assigned', 'maintenance', 'retired'])
      .notNullable()
      .defaultTo('available');
    t.bigInteger('contact_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('contacts')
      .onDelete('SET NULL');
    t.datetime('assigned_at').nullable();
    t.date('due_back').nullable();
    t.date('purchased_on').nullable();
    t.decimal('purchase_cost', 15, 2).nullable();
    t.text('notes').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['status', 'category']);
    t.index(['contact_id']);
  });
  await knex.schema.createTable('m_assets_events', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('asset_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('m_assets_assets')
      .onDelete('CASCADE');
    t.enum('kind', [
      'created',
      'assigned',
      'returned',
      'maintenance',
      'available',
      'retired',
      'note',
    ]).notNullable();
    t.bigInteger('contact_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('contacts')
      .onDelete('SET NULL');
    t.string('note', 1000).nullable();
    t.bigInteger('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['asset_id', 'created_at']);
  });
  await knex.schema.createTable('m_assets_stock', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.string('sku', 64).nullable().unique();
    t.string('name', 200).notNullable();
    t.string('unit', 30).notNullable().defaultTo('');
    t.string('location', 150).notNullable().defaultTo('');
    t.decimal('quantity', 14, 3).notNullable().defaultTo(0);
    t.decimal('reorder_level', 14, 3).nullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.datetime('low_notified_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('m_assets_movements', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('stock_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('m_assets_stock')
      .onDelete('CASCADE');
    t.enum('kind', ['in', 'out', 'adjust']).notNullable();
    t.decimal('quantity', 14, 3).notNullable();
    t.decimal('balance_after', 14, 3).notNullable();
    t.string('reason', 500).nullable();
    t.bigInteger('user_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['stock_id', 'created_at']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('m_assets_movements');
  await knex.schema.dropTableIfExists('m_assets_stock');
  await knex.schema.dropTableIfExists('m_assets_events');
  await knex.schema.dropTableIfExists('m_assets_assets');
}
