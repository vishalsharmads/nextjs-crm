import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.schema.createTable('m_products_products', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.string('sku', 64).nullable().unique();
    t.string('name', 200).notNullable();
    t.text('description').nullable();
    t.string('unit', 30).notNullable().defaultTo('');
    t.decimal('unit_price', 15, 2).notNullable().defaultTo(0);
    t.decimal('tax_rate', 6, 3).notNullable().defaultTo(0);
    t.boolean('recurring').notNullable().defaultTo(false);
    t.boolean('active').notNullable().defaultTo(true);
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['active', 'name']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('m_products_products');
}
