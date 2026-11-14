import type { Knex } from 'knex';

/**
 * AI setup sessions (phase 10): what an admin told the assistant about the business, what it read
 * on their website, the interview, the approved brief and the proposal, so setup can be resumed.
 */
export async function up(knex: Knex) {
  await knex.schema.createTable('m_assistant_setup_sessions', (t) => {
    t.bigIncrements('id').primary();
    t.uuid('uuid').notNullable().unique();
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    // profile → interview → brief → proposal → built
    t.string('step', 20).notNullable().defaultTo('profile');
    t.json('profile').nullable();
    t.json('website').nullable();
    t.json('interview').nullable();
    t.json('brief').nullable();
    t.json('proposal').nullable();
    t.json('built').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['user_id', 'updated_at']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('m_assistant_setup_sessions');
}
