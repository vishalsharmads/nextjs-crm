import type { Knex } from 'knex';
import { idCols, timestamps } from '../helpers';

/**
 * Comments on tasks, calls and meetings. They cascade with the activity, so erasing a person's
 * activities removes the discussion too. `mentions` holds the user ids that were notified.
 */
export async function up(knex: Knex) {
  await knex.schema.createTable('activity_comments', (t) => {
    idCols(t);
    t.bigInteger('activity_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('activities')
      .onDelete('CASCADE');
    t.bigInteger('author_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.text('body', 'mediumtext').notNullable();
    t.json('mentions').nullable();
    t.datetime('edited_at').nullable();
    t.datetime('deleted_at').nullable();
    timestamps(knex, t);
    t.index(['activity_id', 'created_at']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('activity_comments');
}
