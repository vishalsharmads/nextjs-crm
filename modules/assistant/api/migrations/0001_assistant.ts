import type { Knex } from 'knex';

export async function up(knex: Knex) {
  // One row: the provider an admin configured. The API key is encrypted (crypto:rotate covers it).
  await knex.schema.createTable('m_assistant_config', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.string('name', 60).notNullable().defaultTo('Assistant');
    t.string('provider', 32).nullable();
    t.string('base_url', 500).nullable();
    t.string('model', 200).nullable();
    t.text('api_key_enc').nullable();
    t.json('headers').notNullable();
    t.integer('monthly_token_cap').unsigned().notNullable().defaultTo(0);
    t.integer('user_daily_token_cap').unsigned().notNullable().defaultTo(0);
    t.integer('retention_days').unsigned().notNullable().defaultTo(30);
    t.json('excluded_entities').notNullable();
    t.boolean('hipaa_acknowledged').notNullable().defaultTo(false);
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('m_assistant_conversations', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('title', 200).notNullable();
    // Read results and write proposals waiting for the person's decision.
    t.json('pending').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['user_id', 'updated_at']);
  });
  await knex.schema.createTable('m_assistant_messages', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('conversation_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('m_assistant_conversations')
      .onDelete('CASCADE');
    t.string('role', 16).notNullable();
    t.json('content').notNullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['conversation_id', 'id']);
  });
  await knex.schema.createTable('m_assistant_usage', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.date('day').notNullable();
    t.integer('requests').unsigned().notNullable().defaultTo(0);
    t.bigInteger('input_tokens').unsigned().notNullable().defaultTo(0);
    t.bigInteger('output_tokens').unsigned().notNullable().defaultTo(0);
    t.unique(['user_id', 'day']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('m_assistant_usage');
  await knex.schema.dropTableIfExists('m_assistant_messages');
  await knex.schema.dropTableIfExists('m_assistant_conversations');
  await knex.schema.dropTableIfExists('m_assistant_config');
}
