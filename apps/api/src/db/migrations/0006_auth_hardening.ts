import type { Knex } from 'knex';

/** MFA attempt counting and TOTP replay protection. */
export async function up(knex: Knex) {
  await knex.schema.alterTable('auth_tokens', (t) => {
    t.integer('attempts').unsigned().notNullable().defaultTo(0);
  });
  await knex.schema.alterTable('users', (t) => {
    t.bigInteger('totp_last_step').unsigned().nullable();
  });
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('auth_tokens', (t) => t.dropColumn('attempts'));
  await knex.schema.alterTable('users', (t) => t.dropColumn('totp_last_step'));
}
