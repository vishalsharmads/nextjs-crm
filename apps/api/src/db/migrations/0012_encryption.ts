import type { Knex } from 'knex';

/** Sensitive custom fields (special category / health data) and encrypted uploads. */
export async function up(knex: Knex) {
  await knex.schema.alterTable('custom_field_definitions', (t) => {
    // normal | personal | special. Special values are encrypted, masked and never indexed.
    t.string('sensitivity', 16).notNullable().defaultTo('normal');
  });
  await knex.schema.alterTable('files', (t) => {
    // Key id the stored bytes are encrypted with; null = stored as uploaded.
    t.string('enc_kid', 16).nullable();
  });
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('files', (t) => t.dropColumn('enc_kid'));
  await knex.schema.alterTable('custom_field_definitions', (t) => t.dropColumn('sensitivity'));
}
