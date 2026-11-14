import type { Knex } from 'knex';
import { idCols, timestamps } from '../helpers';

/**
 * Comments on any record type (contacts, organizations, leads, deals, module record types and
 * admin-defined objects), keyed by entity like taggables. Task comments stay in activity_comments.
 * `mentions` holds the user ids that were notified. Rows are deleted outright (no soft delete):
 * a removed comment must not linger as personal data.
 */
export async function up(knex: Knex) {
  await knex.schema.createTable('record_comments', (t) => {
    idCols(t);
    t.string('entity', 64).notNullable();
    t.bigInteger('record_id').unsigned().notNullable();
    t.bigInteger('author_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.text('body', 'mediumtext').notNullable();
    t.json('mentions').nullable();
    t.datetime('edited_at').nullable();
    timestamps(knex, t);
    t.index(['entity', 'record_id', 'created_at'], 'idx_record_comments_record');
  });
  await knex.raw('ALTER TABLE record_comments ADD FULLTEXT INDEX ft_record_comments (body)');
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('record_comments');
}
