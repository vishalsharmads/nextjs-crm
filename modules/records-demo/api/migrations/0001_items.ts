import type { Knex } from 'knex';

const TABLE = 'm_records_demo_items';

export async function up(knex: Knex) {
  await knex.schema.createTable(TABLE, (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.string('name', 200).notNullable();
    t.string('status', 32).notNullable().defaultTo('active');
    t.bigInteger('value').nullable();
    t.date('due_on').nullable();
    t.bigInteger('organization_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('organizations')
      .onDelete('SET NULL');
    t.text('notes').nullable();
    t.bigInteger('owner_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.json('custom').notNullable();
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.bigInteger('updated_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
    t.datetime('deleted_at').nullable();
    t.index(['owner_id']);
    t.index(['deleted_at', 'created_at']);
  });
  // Must list exactly the searchable columns of the record type, in order.
  await knex.raw(`ALTER TABLE ${TABLE} ADD FULLTEXT INDEX ft_${TABLE} (name)`);
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists(TABLE);
}
