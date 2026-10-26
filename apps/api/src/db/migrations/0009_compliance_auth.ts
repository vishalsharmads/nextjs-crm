import type { Knex } from 'knex';

/** Absolute session lifetime (compliance `sessionMaxHours`) and 2FA recovery codes. */
export async function up(knex: Knex) {
  await knex.schema.alterTable('sessions', (t) => {
    // Rotation creates a new row per refresh; this carries the first sign-in time across the family.
    t.datetime('family_started_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('UPDATE sessions SET family_started_at = created_at');

  await knex.schema.createTable('user_recovery_codes', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('code_hash', 255).notNullable();
    t.datetime('used_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['user_id', 'used_at']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('user_recovery_codes');
  await knex.schema.alterTable('sessions', (t) => t.dropColumn('family_started_at'));
}
