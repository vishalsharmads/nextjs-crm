import type { Knex } from 'knex';
import { blueprintCols, idCols, timestamps } from '../helpers';

const ENTITIES = ['contact', 'organization', 'lead', 'deal', 'activity'];

export async function up(knex: Knex) {
  await knex.schema.createTable('custom_field_groups', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.enum('entity', ENTITIES).notNullable();
    t.string('key', 64).notNullable();
    t.string('label', 100).notNullable();
    t.integer('sort_order').notNullable().defaultTo(0);
    t.json('visibility').nullable();
    blueprintCols(t);
    timestamps(knex, t);
    t.unique(['entity', 'key']);
  });

  await knex.schema.createTable('custom_field_definitions', (t) => {
    idCols(t);
    t.enum('entity', ENTITIES).notNullable();
    t.string('key', 49).notNullable();
    t.string('label', 100).notNullable();
    t.string('type', 20).notNullable();
    t.string('group_key', 64).nullable();
    t.json('config').nullable();
    t.boolean('required').notNullable().defaultTo(false);
    t.json('default_value').nullable();
    t.json('validation').nullable();
    t.json('visibility').nullable();
    t.string('help_text', 500).nullable();
    t.boolean('filterable').notNullable().defaultTo(false);
    t.boolean('show_in_list').notNullable().defaultTo(false);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    t.string('gen_column', 64).nullable();
    blueprintCols(t);
    timestamps(knex, t);
    t.unique(['entity', 'key']);
  });

  await knex.schema.createTable('layouts', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.enum('entity', ENTITIES).notNullable();
    t.enum('context', ['form', 'detail', 'list']).notNullable();
    t.string('name', 64).notNullable().defaultTo('default');
    t.json('config').notNullable();
    t.boolean('is_default').notNullable().defaultTo(true);
    blueprintCols(t);
    timestamps(knex, t);
    t.unique(['entity', 'context', 'name']);
  });

  await knex.schema.createTable('pipelines', (t) => {
    idCols(t);
    t.string('name', 100).notNullable();
    t.enum('entity', ['deal', 'lead', 'ticket']).notNullable().defaultTo('deal');
    t.boolean('is_default').notNullable().defaultTo(false);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    blueprintCols(t);
    timestamps(knex, t);
  });

  await knex.schema.createTable('pipeline_stages', (t) => {
    idCols(t);
    t.bigInteger('pipeline_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('pipelines')
      .onDelete('CASCADE');
    t.string('key', 64).notNullable();
    t.string('name', 100).notNullable();
    t.string('color', 32).nullable();
    t.integer('probability').unsigned().notNullable().defaultTo(0);
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('is_won').notNullable().defaultTo(false);
    t.boolean('is_lost').notNullable().defaultTo(false);
    t.integer('rotting_days').unsigned().nullable();
    t.boolean('active').notNullable().defaultTo(true);
    blueprintCols(t);
    timestamps(knex, t);
    t.unique(['pipeline_id', 'key']);
  });

  await knex.schema.createTable('saved_views', (t) => {
    idCols(t);
    t.enum('entity', ENTITIES).notNullable();
    t.string('name', 100).notNullable();
    t.json('filters').nullable();
    t.json('columns').nullable();
    t.json('sort').nullable();
    t.bigInteger('owner_id').unsigned().nullable().references('id').inTable('users').onDelete('CASCADE');
    t.boolean('is_shared').notNullable().defaultTo(false);
    t.boolean('is_default').notNullable().defaultTo(false);
    t.integer('sort_order').notNullable().defaultTo(0);
    blueprintCols(t);
    timestamps(knex, t);
    t.index(['entity', 'owner_id']);
  });

  await knex.schema.createTable('dashboards', (t) => {
    idCols(t);
    t.string('name', 100).notNullable();
    t.bigInteger('owner_id').unsigned().nullable().references('id').inTable('users').onDelete('CASCADE');
    t.boolean('is_default').notNullable().defaultTo(false);
    t.json('widgets').notNullable();
    blueprintCols(t);
    timestamps(knex, t);
  });
}

export async function down(knex: Knex) {
  for (const table of [
    'dashboards',
    'saved_views',
    'pipeline_stages',
    'pipelines',
    'layouts',
    'custom_field_definitions',
    'custom_field_groups',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
