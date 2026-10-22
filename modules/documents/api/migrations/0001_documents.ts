import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.schema.createTable('m_documents_templates', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.string('name', 150).notNullable();
    t.string('description', 500).notNullable().defaultTo('');
    t.text('body', 'mediumtext').notNullable();
    t.boolean('requires_signature').notNullable().defaultTo(false);
    t.boolean('active').notNullable().defaultTo(true);
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('m_documents_documents', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.string('number', 40).notNullable().unique();
    t.string('title', 200).notNullable();
    t.text('body_html', 'mediumtext').notNullable();
    t.bigInteger('template_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('m_documents_templates')
      .onDelete('SET NULL');
    t.bigInteger('contact_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('contacts')
      .onDelete('CASCADE');
    t.bigInteger('deal_id').unsigned().nullable().references('id').inTable('deals').onDelete('SET NULL');
    t.enum('status', ['draft', 'shared', 'signed', 'void']).notNullable().defaultTo('draft');
    t.boolean('requires_signature').notNullable().defaultTo(false);
    t.datetime('shared_at').nullable();
    t.string('signed_name', 200).nullable();
    t.datetime('signed_at').nullable();
    t.string('signed_ip', 64).nullable();
    /** SHA-256 of body_html at signing, so later edits are detectable. */
    t.specificType('signed_hash', 'CHAR(64)').nullable();
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['contact_id', 'status']);
  });
  await knex.schema.createTable('m_documents_requests', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.bigInteger('contact_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('contacts')
      .onDelete('CASCADE');
    t.bigInteger('deal_id').unsigned().nullable().references('id').inTable('deals').onDelete('SET NULL');
    t.string('name', 200).notNullable();
    t.string('description', 1000).notNullable().defaultTo('');
    t.enum('status', ['requested', 'submitted', 'approved', 'rejected', 'cancelled'])
      .notNullable()
      .defaultTo('requested');
    t.date('due_date').nullable();
    t.bigInteger('file_id').unsigned().nullable().references('id').inTable('files').onDelete('SET NULL');
    t.string('review_note', 1000).nullable();
    t.bigInteger('requested_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('submitted_at').nullable();
    t.datetime('reviewed_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['contact_id', 'status']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('m_documents_requests');
  await knex.schema.dropTableIfExists('m_documents_documents');
  await knex.schema.dropTableIfExists('m_documents_templates');
}
