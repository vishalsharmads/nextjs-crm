import type { Knex } from 'knex';
import { idCols } from '../helpers';

/**
 * Calendars: a private feed per person, invitations (sequence numbers and attendee replies),
 * two-way CalDAV accounts with the events they are linked to, and busy times for scheduling.
 */
export async function up(knex: Knex) {
  await knex.schema.createTable('calendar_feeds', (t) => {
    t.bigIncrements('id');
    t.bigInteger('user_id')
      .unsigned()
      .notNullable()
      .unique()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    t.specificType('token_hash', 'CHAR(64)').notNullable().unique();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.alterTable('activities', (t) => {
    t.integer('ical_sequence').unsigned().notNullable().defaultTo(0);
    // Set inside the saving transaction, sent after commit (see core/calendar/invites.ts).
    t.boolean('invite_pending').notNullable().defaultTo(false);
  });
  await knex.schema.alterTable('activity_participants', (t) => {
    t.enum('status', ['needs_action', 'accepted', 'declined', 'tentative']).nullable();
    t.datetime('invited_at').nullable();
  });
  await knex.schema.createTable('calendar_accounts', (t) => {
    idCols(t);
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('url', 1000).notNullable();
    t.string('username', 255).notNullable();
    t.text('password_enc').notNullable();
    t.string('display_name', 150).notNullable().defaultTo('');
    t.datetime('last_sync_at').nullable();
    t.string('last_error', 1000).nullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['user_id']);
  });
  await knex.schema.createTable('calendar_links', (t) => {
    t.bigIncrements('id');
    t.bigInteger('account_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('calendar_accounts')
      .onDelete('CASCADE');
    t.bigInteger('activity_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('activities')
      .onDelete('CASCADE');
    t.string('uid', 255).notNullable();
    t.string('href', 1000).notNullable();
    t.string('etag', 255).nullable();
    t.datetime('synced_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['account_id', 'uid']);
    t.index(['activity_id']);
  });
  await knex.schema.createTable('calendar_busy', (t) => {
    t.bigIncrements('id');
    t.bigInteger('account_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('calendar_accounts')
      .onDelete('CASCADE');
    t.datetime('starts_at').notNullable();
    t.datetime('ends_at').notNullable();
    t.index(['account_id', 'starts_at']);
  });
}

export async function down(knex: Knex) {
  for (const table of ['calendar_busy', 'calendar_links', 'calendar_accounts', 'calendar_feeds'])
    await knex.schema.dropTableIfExists(table);
  await knex.schema.alterTable('activity_participants', (t) => {
    t.dropColumn('status');
    t.dropColumn('invited_at');
  });
  await knex.schema.alterTable('activities', (t) => {
    t.dropColumn('ical_sequence');
    t.dropColumn('invite_pending');
  });
}
