import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.schema.createTable('m_bookings_resources', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.string('name', 150).notNullable();
    t.string('kind', 50).notNullable().defaultTo('room');
    t.string('location', 150).notNullable().defaultTo('');
    t.integer('capacity').unsigned().nullable();
    t.decimal('hourly_rate', 15, 2).nullable();
    /** Opening hours in the workspace time zone: "HH:MM", weekdays 0 (Sun)–6. Null = always open. */
    t.string('open_time', 5).nullable();
    t.string('close_time', 5).nullable();
    t.json('open_days').nullable();
    t.integer('position').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('m_bookings_bookings', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.bigInteger('resource_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('m_bookings_resources')
      .onDelete('CASCADE');
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
    t.string('title', 200).notNullable().defaultTo('');
    t.datetime('starts_at').notNullable();
    t.datetime('ends_at').notNullable();
    t.integer('attendees').unsigned().nullable();
    t.enum('status', ['confirmed', 'cancelled']).notNullable().defaultTo('confirmed');
    t.string('cancel_reason', 500).nullable();
    t.text('notes').nullable();
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['resource_id', 'status', 'starts_at', 'ends_at'], 'm_bookings_overlap_idx');
    t.index(['starts_at']);
    t.index(['contact_id']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('m_bookings_bookings');
  await knex.schema.dropTableIfExists('m_bookings_resources');
}
