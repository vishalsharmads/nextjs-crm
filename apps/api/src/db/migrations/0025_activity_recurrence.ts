import type { Knex } from 'knex';

/**
 * Recurring tasks: the rule lives on each occurrence; completing one creates the next.
 * `recurrence_parent_id` links an occurrence to the one it was created from.
 */
export async function up(knex: Knex) {
  await knex.schema.alterTable('activities', (t) => {
    t.json('recurrence').nullable();
    t.bigInteger('recurrence_parent_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('activities')
      .onDelete('SET NULL');
  });
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('activities', (t) => {
    t.dropForeign(['recurrence_parent_id']);
    t.dropColumn('recurrence_parent_id');
    t.dropColumn('recurrence');
  });
}
