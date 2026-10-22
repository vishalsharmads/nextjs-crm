import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.schema.createTable('m_tickets_tickets', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.string('number', 40).notNullable().unique();
    t.string('subject', 250).notNullable();
    t.text('description').nullable();
    t.enum('status', ['open', 'pending', 'resolved', 'closed']).notNullable().defaultTo('open');
    t.enum('priority', ['low', 'normal', 'high', 'urgent']).notNullable().defaultTo('normal');
    t.string('category', 100).notNullable().defaultTo('');
    t.enum('channel', ['staff', 'portal', 'email', 'phone']).notNullable().defaultTo('staff');
    t.bigInteger('contact_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('contacts')
      .onDelete('SET NULL');
    t.bigInteger('organization_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('organizations')
      .onDelete('SET NULL');
    t.bigInteger('assignee_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('first_response_due_at').nullable();
    t.datetime('resolve_due_at').nullable();
    t.datetime('first_responded_at').nullable();
    t.datetime('resolved_at').nullable();
    t.datetime('last_activity_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('deleted_at').nullable();
    t.index(['status', 'priority']);
    t.index(['assignee_id', 'status']);
    t.index(['contact_id']);
    t.index(['last_activity_at']);
  });
  await knex.schema.createTable('m_tickets_comments', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.bigInteger('ticket_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('m_tickets_tickets')
      .onDelete('CASCADE');
    t.bigInteger('author_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    /** Set when the customer wrote it (portal). */
    t.bigInteger('author_contact_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('contacts')
      .onDelete('SET NULL');
    t.text('body').notNullable();
    t.boolean('internal').notNullable().defaultTo(false);
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['ticket_id', 'created_at']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('m_tickets_comments');
  await knex.schema.dropTableIfExists('m_tickets_tickets');
}
