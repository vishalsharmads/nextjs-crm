import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.schema.createTable('m_portal_accounts', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.bigInteger('contact_id')
      .unsigned()
      .notNullable()
      .unique()
      .references('id')
      .inTable('contacts')
      .onDelete('CASCADE');
    t.string('email', 254).notNullable().unique();
    t.boolean('organization_access').notNullable().defaultTo(false);
    t.enum('status', ['active', 'disabled']).notNullable().defaultTo('active');
    t.datetime('invited_at').nullable();
    t.datetime('last_login_at').nullable();
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('m_portal_tokens', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('account_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('m_portal_accounts')
      .onDelete('CASCADE');
    t.specificType('token_hash', 'CHAR(64)').notNullable().unique();
    t.datetime('expires_at').notNullable();
    t.datetime('used_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('m_portal_sessions', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('account_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('m_portal_accounts')
      .onDelete('CASCADE');
    t.specificType('token_hash', 'CHAR(64)').notNullable().unique();
    t.datetime('expires_at').notNullable();
    t.datetime('last_seen_at').nullable();
    t.string('ip', 64).nullable();
    t.string('user_agent', 255).nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('m_portal_sessions');
  await knex.schema.dropTableIfExists('m_portal_tokens');
  await knex.schema.dropTableIfExists('m_portal_accounts');
}
