import type { Knex } from 'knex';

/**
 * OAuth 2.1 for MCP clients: clients register themselves, a person approves them in the app, and
 * they get short-lived access tokens with rotating refresh tokens. Secrets are stored as hashes.
 */
export async function up(knex: Knex) {
  await knex.schema.createTable('oauth_clients', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('client_id', 'CHAR(36)').notNullable().unique();
    t.string('name', 200).notNullable();
    t.json('redirect_uris').notNullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('oauth_codes', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('code_hash', 'CHAR(64)').notNullable().unique();
    t.bigInteger('client_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('oauth_clients')
      .onDelete('CASCADE');
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('redirect_uri', 2000).notNullable();
    t.string('code_challenge', 128).notNullable();
    t.boolean('read_only').notNullable().defaultTo(true);
    t.datetime('expires_at').notNullable();
    t.datetime('used_at').nullable();
  });
  await knex.schema.createTable('oauth_tokens', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.bigInteger('client_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('oauth_clients')
      .onDelete('CASCADE');
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.specificType('access_hash', 'CHAR(64)').notNullable().unique();
    t.specificType('refresh_hash', 'CHAR(64)').notNullable().unique();
    t.boolean('read_only').notNullable().defaultTo(true);
    t.datetime('access_expires_at').notNullable();
    t.datetime('refresh_expires_at').notNullable();
    t.datetime('last_used_at').nullable();
    t.datetime('revoked_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['user_id']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('oauth_tokens');
  await knex.schema.dropTableIfExists('oauth_codes');
  await knex.schema.dropTableIfExists('oauth_clients');
}
