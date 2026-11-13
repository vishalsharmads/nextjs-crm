import type { Knex } from 'knex';
import { idCols, timestamps } from '../helpers';

/** Checklist items (subtasks) on a task. Each tick records who and when. */
export async function up(knex: Knex) {
  await knex.schema.createTable('activity_checklist_items', (t) => {
    idCols(t);
    t.bigInteger('activity_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('activities')
      .onDelete('CASCADE');
    t.string('label', 500).notNullable();
    t.integer('position').notNullable().defaultTo(0);
    t.datetime('done_at').nullable();
    t.bigInteger('done_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    timestamps(knex, t);
    t.index(['activity_id', 'position']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('activity_checklist_items');
}
