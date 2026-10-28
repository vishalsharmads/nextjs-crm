import type { Knex } from 'knex';

/**
 * Configuration tables used a fixed ENUM of the five core entities. Module-registered record
 * types need their own keys, so the column becomes plain text. Existing rows and unique indexes
 * are unchanged.
 */
const TABLES = ['custom_field_groups', 'custom_field_definitions', 'layouts', 'saved_views'];
const CORE = "'contact','organization','lead','deal','activity'";

export async function up(knex: Knex) {
  for (const table of TABLES) {
    await knex.raw(`ALTER TABLE \`${table}\` MODIFY \`entity\` VARCHAR(32) NOT NULL`);
  }
}

export async function down(knex: Knex) {
  for (const table of TABLES) {
    await knex.raw(`ALTER TABLE \`${table}\` MODIFY \`entity\` ENUM(${CORE}) NOT NULL`);
  }
}
