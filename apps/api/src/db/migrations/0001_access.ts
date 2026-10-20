import type { Knex } from 'knex';
import { blueprintCols, idCols, timestamps } from '../helpers';

export async function up(knex: Knex) {
  await knex.schema.createTable('users', (t) => {
    idCols(t);
    t.string('email', 255).notNullable().unique();
    t.string('password_hash', 255).nullable();
    t.string('first_name', 100).notNullable().defaultTo('');
    t.string('last_name', 100).notNullable().defaultTo('');
    t.specificType('avatar_file_uuid', 'CHAR(36)').nullable();
    t.string('locale', 10).nullable();
    t.string('timezone', 64).nullable();
    t.enum('status', ['invited', 'active', 'disabled']).notNullable().defaultTo('active');
    t.text('totp_secret_enc').nullable();
    t.boolean('totp_enabled').notNullable().defaultTo(false);
    t.integer('failed_login_count').unsigned().notNullable().defaultTo(0);
    t.datetime('locked_until').nullable();
    t.datetime('last_login_at').nullable();
    t.datetime('password_changed_at').nullable();
    t.json('preferences').nullable();
    timestamps(knex, t);
    t.datetime('deleted_at').nullable();
  });

  await knex.schema.createTable('sessions', (t) => {
    idCols(t);
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.specificType('refresh_hash', 'CHAR(64)').notNullable().unique();
    t.specificType('family_id', 'CHAR(36)').notNullable().index();
    t.string('user_agent', 500).nullable();
    t.string('ip', 64).nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('last_used_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('expires_at').notNullable();
    t.datetime('revoked_at').nullable();
    t.index(['user_id', 'revoked_at']);
  });

  await knex.schema.createTable('auth_tokens', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.enum('purpose', ['reset', 'invite', 'mfa']).notNullable();
    t.specificType('token_hash', 'CHAR(64)').notNullable().unique();
    t.datetime('expires_at').notNullable();
    t.datetime('used_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('roles', (t) => {
    idCols(t);
    t.string('key', 64).notNullable().unique();
    t.string('name', 100).notNullable();
    t.string('description', 500).notNullable().defaultTo('');
    t.boolean('is_system').notNullable().defaultTo(false);
    blueprintCols(t);
    timestamps(knex, t);
  });

  await knex.schema.createTable('permissions', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.string('key', 150).notNullable().unique();
    t.string('module_key', 64).notNullable().index();
    t.string('description', 255).notNullable().defaultTo('');
  });

  await knex.schema.createTable('role_permissions', (t) => {
    t.bigInteger('role_id').unsigned().notNullable().references('id').inTable('roles').onDelete('CASCADE');
    t.string('pattern', 150).notNullable();
    t.primary(['role_id', 'pattern']);
  });

  await knex.schema.createTable('role_scopes', (t) => {
    t.bigInteger('role_id').unsigned().notNullable().references('id').inTable('roles').onDelete('CASCADE');
    t.string('resource', 100).notNullable();
    t.enum('scope', ['own', 'team', 'all']).notNullable();
    t.primary(['role_id', 'resource']);
  });

  await knex.schema.createTable('user_roles', (t) => {
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.bigInteger('role_id').unsigned().notNullable().references('id').inTable('roles').onDelete('CASCADE');
    t.primary(['user_id', 'role_id']);
  });

  await knex.schema.createTable('teams', (t) => {
    idCols(t);
    t.string('name', 100).notNullable().unique();
    timestamps(knex, t);
  });

  await knex.schema.createTable('team_members', (t) => {
    t.bigInteger('team_id').unsigned().notNullable().references('id').inTable('teams').onDelete('CASCADE');
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.boolean('is_lead').notNullable().defaultTo(false);
    t.primary(['team_id', 'user_id']);
  });
}

export async function down(knex: Knex) {
  for (const table of [
    'team_members',
    'teams',
    'user_roles',
    'role_scopes',
    'role_permissions',
    'permissions',
    'roles',
    'auth_tokens',
    'sessions',
    'users',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
