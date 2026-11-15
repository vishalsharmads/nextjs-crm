import type { Knex } from 'knex';

/**
 * Two-way mailboxes: sign-in through an OAuth provider the operator configures (tokens encrypted,
 * re-encrypted by crypto:rotate), per-folder sync state (INBOX and Sent), and short-lived OAuth
 * sign-in states.
 */
export async function up(knex: Knex) {
  await knex.schema.alterTable('mail_accounts', (t) => {
    t.text('password_enc').nullable().alter();
    t.enum('auth_type', ['password', 'oauth']).notNullable().defaultTo('password');
    t.string('oauth_provider', 64).nullable();
    t.text('access_token_enc').nullable();
    t.text('refresh_token_enc').nullable();
    t.datetime('token_expires_at').nullable();
    t.json('imap_state').nullable();
    t.boolean('sync_sent').notNullable().defaultTo(true);
  });
  await knex.schema.createTable('mail_oauth_states', (t) => {
    t.specificType('state', 'CHAR(64)').primary();
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('provider', 64).notNullable();
    t.string('code_verifier', 128).notNullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('mail_oauth_states');
  await knex.schema.alterTable('mail_accounts', (t) => {
    for (const c of [
      'auth_type',
      'oauth_provider',
      'access_token_enc',
      'refresh_token_enc',
      'token_expires_at',
      'imap_state',
      'sync_sent',
    ])
      t.dropColumn(c);
  });
}
