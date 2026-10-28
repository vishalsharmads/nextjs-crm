import type { Knex } from 'knex';

/**
 * Optional lead pipeline: leads can sit on a stage of a `lead` pipeline, like deals do. Every column is
 * nullable because the feature is off by default and leads keep their status either way.
 */
export async function up(knex: Knex) {
  await knex.schema.alterTable('leads', (t) => {
    t.bigInteger('pipeline_id').unsigned().nullable().references('id').inTable('pipelines');
    t.bigInteger('stage_id').unsigned().nullable().references('id').inTable('pipeline_stages');
    t.datetime('stage_entered_at').nullable();
    t.decimal('position', 20, 10).nullable();
    t.index(['pipeline_id', 'stage_id', 'position'], 'leads_pipeline_stage_position_idx');
  });
  await knex.schema.createTable('lead_stage_history', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('lead_id').unsigned().notNullable().references('id').inTable('leads').onDelete('CASCADE');
    t.bigInteger('from_stage_id').unsigned().nullable();
    t.bigInteger('to_stage_id').unsigned().notNullable();
    t.bigInteger('changed_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('changed_at').notNullable().defaultTo(knex.fn.now());
    t.index(['lead_id', 'changed_at']);
    t.index(['to_stage_id', 'changed_at']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTable('lead_stage_history');
  await knex.schema.alterTable('leads', (t) => {
    t.dropForeign(['pipeline_id']);
    t.dropForeign(['stage_id']);
    t.dropIndex(['pipeline_id', 'stage_id', 'position'], 'leads_pipeline_stage_position_idx');
    t.dropColumns('pipeline_id', 'stage_id', 'stage_entered_at', 'position');
  });
}
