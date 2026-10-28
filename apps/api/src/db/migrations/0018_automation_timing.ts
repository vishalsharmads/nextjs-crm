import type { Knex } from 'knex';

/**
 * Delayed and scheduled automations. A delayed run waits in `automation_queue` (in the database, so
 * it survives restarts); a scheduled rule runs over matching records at `next_run_at`.
 * `saved_reports` holds report-builder definitions (no data).
 */
export async function up(knex: Knex) {
  await knex.schema.alterTable('automations', (t) => {
    t.integer('delay_minutes').unsigned().notNullable().defaultTo(0);
    t.json('schedule').nullable();
    t.datetime('next_run_at').nullable();
    t.index(['next_run_at']);
  });
  await knex.schema.createTable('automation_queue', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('automation_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('automations')
      .onDelete('CASCADE');
    t.string('record_uuid', 36).nullable();
    t.json('event').notNullable();
    t.datetime('run_at').notNullable();
    t.index(['run_at']);
    t.index(['record_uuid']);
  });
  await knex.schema.createTable('saved_reports', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.string('name', 150).notNullable();
    t.string('entity', 32).notNullable();
    t.json('definition').notNullable();
    t.boolean('shared').notNullable().defaultTo(false);
    t.bigInteger('owner_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['owner_id']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('saved_reports');
  await knex.schema.dropTableIfExists('automation_queue');
  await knex.schema.alterTable('automations', (t) => {
    t.dropIndex(['next_run_at']);
    t.dropColumn('delay_minutes');
    t.dropColumn('schedule');
    t.dropColumn('next_run_at');
  });
}
