import type { Knex } from 'knex';

/** Gap-free document numbering shared by commercial modules (quotes, invoices, contracts). */
export async function up(knex: Knex) {
  await knex.schema.createTable('doc_sequences', (t) => {
    t.string('key', 64).primary();
    t.integer('next_value').unsigned().notNullable().defaultTo(1);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('doc_sequences');
}
