import type { Knex } from 'knex';
import { idCols } from '../helpers';

/** Scheduling links: one public booking page per person, and the meetings booked through it. */
export async function up(knex: Knex) {
  await knex.schema.createTable('booking_pages', (t) => {
    idCols(t);
    t.bigInteger('user_id')
      .unsigned()
      .notNullable()
      .unique()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    t.string('slug', 60).notNullable().unique();
    t.string('title', 150).notNullable();
    t.text('intro').nullable();
    t.string('time_zone', 64).notNullable();
    t.json('hours').notNullable();
    t.json('meeting_types').notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('bookings', (t) => {
    t.bigIncrements('id');
    t.bigInteger('page_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('booking_pages')
      .onDelete('CASCADE');
    t.bigInteger('activity_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('activities')
      .onDelete('CASCADE');
    t.string('type_key', 40).notNullable();
    t.specificType('token_hash', 'CHAR(64)').notNullable().unique();
    t.string('visitor_name', 200).notNullable();
    t.string('visitor_email', 255).notNullable();
    t.json('answers').nullable();
    t.datetime('cancelled_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['activity_id']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('bookings');
  await knex.schema.dropTableIfExists('booking_pages');
}
