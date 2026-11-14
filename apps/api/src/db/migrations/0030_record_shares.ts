import type { Knex } from 'knex';
import { idCols } from '../helpers';

/**
 * One record opened to one more person or team, on top of role scope. `resource` is the
 * permission resource (`core.deals`, `custom.vessels`), so scope checks find shares without
 * knowing the record type. A share never grants a permission the role lacks.
 */
export async function up(knex: Knex) {
  await knex.schema.createTable('record_shares', (t) => {
    idCols(t);
    t.string('resource', 100).notNullable();
    t.bigInteger('record_id').unsigned().notNullable();
    t.bigInteger('user_id').unsigned().nullable().references('id').inTable('users').onDelete('CASCADE');
    t.bigInteger('team_id').unsigned().nullable().references('id').inTable('teams').onDelete('CASCADE');
    t.enum('level', ['view', 'edit']).notNullable().defaultTo('view');
    t.bigInteger('shared_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['resource', 'record_id']);
    t.index(['user_id']);
    t.index(['team_id']);
    t.unique(['resource', 'record_id', 'user_id', 'team_id'], { indexName: 'uq_record_shares_target' });
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('record_shares');
}
