import type { Knex } from 'knex';

/**
 * OAuth token families: every refresh keeps the grant's family and start time, so reusing an old
 * refresh token revokes the whole family, and a grant cannot outlive the credential age limit.
 * Tokens remember the code they came from, so a replayed code revokes them.
 */
export async function up(knex: Knex) {
  await knex.schema.alterTable('oauth_tokens', (t) => {
    t.specificType('family_id', 'CHAR(36)').nullable();
    t.datetime('granted_at').nullable();
    t.bigInteger('code_id').unsigned().nullable();
    t.index(['family_id']);
  });
  await knex('oauth_tokens').update({ family_id: knex.ref('uuid'), granted_at: knex.ref('created_at') });
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('oauth_tokens', (t) => {
    t.dropIndex(['family_id']);
    t.dropColumn('family_id');
    t.dropColumn('granted_at');
    t.dropColumn('code_id');
  });
}
