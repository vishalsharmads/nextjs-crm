import type { Knex } from 'knex';
import { blueprintCols, idCols, timestamps } from '../helpers';

export async function up(knex: Knex) {
  await knex.schema.createTable('settings', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.string('key', 100).notNullable().unique();
    t.string('group', 50).notNullable().index();
    t.json('value').notNullable();
    t.boolean('is_public').notNullable().defaultTo(false);
    t.datetime('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
    t.bigInteger('updated_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    blueprintCols(t);
  });

  await knex.schema.createTable('labels', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.string('entity_key', 64).notNullable();
    t.string('locale', 10).notNullable().defaultTo('en');
    t.string('singular', 60).notNullable();
    t.string('plural', 60).notNullable();
    blueprintCols(t);
    timestamps(knex, t);
    t.unique(['entity_key', 'locale']);
  });

  await knex.schema.createTable('templates', (t) => {
    idCols(t);
    t.string('key', 100).notNullable();
    t.enum('channel', ['email', 'notification', 'document']).notNullable();
    t.string('locale', 10).notNullable().defaultTo('en');
    t.string('name', 150).notNullable().defaultTo('');
    t.string('subject', 255).notNullable().defaultTo('');
    t.text('body', 'mediumtext').notNullable();
    blueprintCols(t);
    timestamps(knex, t);
    t.unique(['key', 'channel', 'locale']);
  });

  await knex.schema.createTable('sequences', (t) => {
    t.string('key', 64).primary();
    t.string('prefix', 20).notNullable().defaultTo('');
    t.integer('padding').unsigned().notNullable().defaultTo(4);
    t.bigInteger('next_value').unsigned().notNullable().defaultTo(1);
  });

  await knex.schema.createTable('files', (t) => {
    idCols(t);
    t.string('entity', 64).nullable();
    t.bigInteger('entity_id').unsigned().nullable();
    t.string('original_name', 255).notNullable();
    t.string('storage_key', 255).notNullable().unique();
    t.string('mime', 150).notNullable();
    t.bigInteger('size').unsigned().notNullable();
    t.specificType('sha256', 'CHAR(64)').notNullable();
    t.boolean('is_public').notNullable().defaultTo(false);
    t.bigInteger('uploaded_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('deleted_at').nullable();
    t.index(['entity', 'entity_id']);
  });

  await knex.schema.createTable('audit_logs', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('actor_id').unsigned().nullable();
    t.enum('actor_type', ['user', 'system', 'cli', 'api_key']).notNullable().defaultTo('user');
    t.string('action', 64).notNullable();
    t.string('entity', 64).notNullable();
    t.bigInteger('entity_id').unsigned().nullable();
    t.specificType('entity_uuid', 'CHAR(36)').nullable();
    t.json('diff').nullable();
    t.string('ip', 64).nullable();
    t.string('user_agent', 500).nullable();
    t.string('request_id', 64).nullable();
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.index(['entity', 'entity_id', 'created_at']);
    t.index(['actor_id', 'created_at']);
    t.index(['created_at']);
  });

  await knex.schema.createTable('blueprint_applications', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.string('blueprint_key', 64).notNullable();
    t.string('version', 20).notNullable();
    t.specificType('checksum', 'CHAR(64)').notNullable();
    t.bigInteger('applied_by').unsigned().nullable();
    t.json('report').nullable();
    t.datetime('applied_at').notNullable().defaultTo(knex.fn.now());
    t.index(['blueprint_key', 'applied_at']);
  });

  await knex.schema.createTable('module_states', (t) => {
    t.string('module_key', 64).primary();
    t.boolean('enabled').notNullable().defaultTo(false);
    t.string('installed_version', 20).nullable();
    t.json('settings').nullable();
    t.datetime('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
  });

  await knex.schema.createTable('notifications', (t) => {
    idCols(t);
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('type', 64).notNullable();
    t.string('title', 255).notNullable();
    t.text('body').nullable();
    t.json('data').nullable();
    t.string('link', 500).nullable();
    t.datetime('read_at').nullable();
    t.datetime('emailed_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['user_id', 'read_at', 'created_at']);
  });

  await knex.schema.createTable('jobs', (t) => {
    idCols(t);
    t.string('type', 64).notNullable();
    t.json('payload').notNullable();
    t.enum('status', ['queued', 'running', 'succeeded', 'failed']).notNullable().defaultTo('queued');
    t.integer('progress').unsigned().notNullable().defaultTo(0);
    t.json('result').nullable();
    t.text('error').nullable();
    t.integer('attempts').unsigned().notNullable().defaultTo(0);
    t.bigInteger('created_by').unsigned().nullable();
    t.datetime('run_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('started_at').nullable();
    t.datetime('finished_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['status', 'run_at']);
  });
}

export async function down(knex: Knex) {
  for (const table of [
    'jobs',
    'notifications',
    'module_states',
    'blueprint_applications',
    'audit_logs',
    'files',
    'sequences',
    'templates',
    'labels',
    'settings',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
