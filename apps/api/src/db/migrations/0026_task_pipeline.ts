import type { Knex } from 'knex';

/**
 * Optional status pipeline for tasks (features.taskPipeline): activities can sit on a pipeline
 * stage like leads, with a stage history. `completed_at` stays the source of truth for done.
 */
export async function up(knex: Knex) {
  await knex.raw(
    "ALTER TABLE pipelines MODIFY entity ENUM('deal','lead','ticket','activity') NOT NULL DEFAULT 'deal'",
  );
  await knex.schema.alterTable('activities', (t) => {
    t.bigInteger('pipeline_id').unsigned().nullable().references('id').inTable('pipelines');
    t.bigInteger('stage_id').unsigned().nullable().references('id').inTable('pipeline_stages');
    t.datetime('stage_entered_at').nullable();
    t.decimal('position', 20, 10).nullable();
    t.index(['pipeline_id', 'stage_id', 'position'], 'activities_pipeline_stage_position_idx');
  });
  await knex.schema.createTable('activity_stage_history', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('activity_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('activities')
      .onDelete('CASCADE');
    t.bigInteger('from_stage_id').unsigned().nullable();
    t.bigInteger('to_stage_id').unsigned().notNullable();
    t.bigInteger('changed_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('changed_at').notNullable().defaultTo(knex.fn.now());
    t.index(['activity_id', 'changed_at']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('activity_stage_history');
  await knex.schema.alterTable('activities', (t) => {
    t.dropForeign(['pipeline_id']);
    t.dropForeign(['stage_id']);
    t.dropIndex(['pipeline_id', 'stage_id', 'position'], 'activities_pipeline_stage_position_idx');
    t.dropColumn('pipeline_id');
    t.dropColumn('stage_id');
    t.dropColumn('stage_entered_at');
    t.dropColumn('position');
  });
  await knex('pipelines').where({ entity: 'activity' }).delete();
  await knex.raw("ALTER TABLE pipelines MODIFY entity ENUM('deal','lead','ticket') NOT NULL DEFAULT 'deal'");
}
