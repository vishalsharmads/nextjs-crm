import type { Knex } from 'knex';
import { blueprintCols, idCols, timestamps } from '../helpers';

/** Phase 2: API keys, webhooks, automations, web forms, mail accounts. */
export async function up(knex: Knex) {
  await knex.schema.createTable('api_keys', (t) => {
    idCols(t);
    t.string('name', 100).notNullable();
    t.string('prefix', 16).notNullable().unique();
    t.specificType('key_hash', 'CHAR(64)').notNullable().unique();
    t.bigInteger('role_id').unsigned().notNullable().references('id').inTable('roles');
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('last_used_at').nullable();
    t.datetime('expires_at').nullable();
    t.datetime('revoked_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('webhooks', (t) => {
    idCols(t);
    t.string('name', 100).notNullable();
    t.string('url', 2000).notNullable();
    t.json('events').notNullable();
    t.text('secret_enc').notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.integer('failure_count').unsigned().notNullable().defaultTo(0);
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    timestamps(knex, t);
  });

  await knex.schema.createTable('webhook_deliveries', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.bigInteger('webhook_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('webhooks')
      .onDelete('CASCADE');
    t.string('event', 100).notNullable();
    t.json('payload').notNullable();
    t.enum('status', ['pending', 'succeeded', 'failed']).notNullable().defaultTo('pending');
    t.integer('attempts').unsigned().notNullable().defaultTo(0);
    t.integer('response_status').nullable();
    t.string('error', 1000).nullable();
    t.datetime('next_attempt_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('delivered_at').nullable();
    t.index(['webhook_id', 'created_at']);
    t.index(['status', 'next_attempt_at']);
  });

  await knex.schema.createTable('automations', (t) => {
    idCols(t);
    t.string('name', 150).notNullable();
    t.string('description', 500).notNullable().defaultTo('');
    t.string('trigger_event', 100).notNullable();
    t.json('conditions').nullable();
    t.json('actions').notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.integer('run_count').unsigned().notNullable().defaultTo(0);
    t.datetime('last_run_at').nullable();
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    blueprintCols(t);
    timestamps(knex, t);
    t.index(['trigger_event', 'active']);
  });

  await knex.schema.createTable('automation_runs', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('automation_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('automations')
      .onDelete('CASCADE');
    t.string('event', 100).notNullable();
    t.specificType('record_uuid', 'CHAR(36)').nullable();
    t.enum('status', ['succeeded', 'skipped', 'failed']).notNullable();
    t.json('log').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['automation_id', 'created_at']);
  });

  await knex.schema.createTable('web_forms', (t) => {
    idCols(t);
    t.string('name', 150).notNullable();
    t.enum('entity', ['contact', 'lead']).notNullable();
    t.json('fields').notNullable();
    t.json('settings').notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.integer('submission_count').unsigned().notNullable().defaultTo(0);
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    timestamps(knex, t);
  });

  await knex.schema.createTable('mail_accounts', (t) => {
    idCols(t);
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('email', 255).notNullable();
    t.string('display_name', 150).notNullable().defaultTo('');
    t.json('smtp').notNullable();
    t.json('imap').nullable();
    t.text('password_enc').notNullable();
    t.bigInteger('imap_last_uid').unsigned().nullable();
    t.datetime('last_sync_at').nullable();
    t.string('last_error', 1000).nullable();
    t.boolean('active').notNullable().defaultTo(true);
    timestamps(knex, t);
    t.unique(['user_id', 'email']);
  });

  await knex.schema.createTable('email_messages', (t) => {
    idCols(t);
    t.bigInteger('activity_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('activities')
      .onDelete('CASCADE');
    t.bigInteger('mail_account_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('mail_accounts')
      .onDelete('SET NULL');
    t.enum('direction', ['outbound', 'inbound']).notNullable();
    t.string('message_id', 500).nullable();
    t.string('in_reply_to', 500).nullable();
    t.string('from_address', 255).notNullable();
    t.json('to_addresses').notNullable();
    t.json('cc_addresses').nullable();
    t.string('subject', 500).notNullable().defaultTo('');
    t.datetime('sent_at').notNullable().defaultTo(knex.fn.now());
    t.index(['message_id']);
  });
}

export async function down(knex: Knex) {
  for (const table of [
    'email_messages',
    'mail_accounts',
    'web_forms',
    'automation_runs',
    'automations',
    'webhook_deliveries',
    'webhooks',
    'api_keys',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
