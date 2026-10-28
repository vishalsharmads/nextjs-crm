import type { Knex } from 'knex';
import { idCols } from '../helpers';

/**
 * Personal access tokens (Profile → Access tokens) for AI clients over MCP and scripts. They act
 * as their user. Audit rows record how a change came in: `token`, `mcp` or `assistant` join the
 * existing actor types, so the column becomes plain text.
 */
export async function up(knex: Knex) {
  await knex.schema.createTable('personal_access_tokens', (t) => {
    idCols(t);
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('name', 100).notNullable();
    t.string('prefix', 16).notNullable();
    t.specificType('token_hash', 'CHAR(64)').notNullable().unique();
    t.boolean('read_only').notNullable().defaultTo(true);
    t.datetime('expires_at').notNullable();
    t.datetime('last_used_at').nullable();
    t.datetime('revoked_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['user_id']);
  });
  await knex.raw("ALTER TABLE `audit_logs` MODIFY `actor_type` VARCHAR(16) NOT NULL DEFAULT 'user'");
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('personal_access_tokens');
  await knex.raw(
    "ALTER TABLE `audit_logs` MODIFY `actor_type` ENUM('user','system','cli','api_key') NOT NULL DEFAULT 'user'",
  );
}
