import type { Knex } from 'knex';
import { auditCols, idCols } from '../helpers';

const userFk = (t: Knex.CreateTableBuilder, col: string) =>
  t.bigInteger(col).unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');

export async function up(knex: Knex) {
  await knex.schema.createTable('contacts', (t) => {
    idCols(t);
    t.string('first_name', 100).notNullable().defaultTo('');
    t.string('last_name', 100).notNullable().defaultTo('');
    t.specificType(
      'full_name',
      "VARCHAR(201) GENERATED ALWAYS AS (TRIM(CONCAT_WS(' ', first_name, last_name))) STORED",
    );
    t.string('email', 255).nullable();
    t.specificType('email_norm', 'VARCHAR(255) GENERATED ALWAYS AS (LOWER(TRIM(email))) STORED');
    t.string('phone', 50).nullable();
    t.string('phone_e164', 20).nullable();
    t.string('job_title', 150).nullable();
    userFk(t, 'owner_id');
    t.string('source', 100).nullable();
    t.string('lifecycle_status', 50).nullable();
    t.specificType('avatar_file_uuid', 'CHAR(36)').nullable();
    t.bigInteger('merged_into_id').unsigned().nullable();
    t.json('custom').nullable();
    auditCols(knex, t);
    t.index(['owner_id']);
    t.index(['email_norm']);
    t.index(['phone_e164']);
    t.index(['created_at']);
  });
  await knex.raw('ALTER TABLE contacts ADD FULLTEXT INDEX ft_contacts (full_name, email)');

  await knex.schema.createTable('organizations', (t) => {
    idCols(t);
    t.string('name', 200).notNullable();
    t.string('website', 500).nullable();
    t.string('domain', 255).nullable();
    t.string('industry', 100).nullable();
    t.string('email', 255).nullable();
    t.string('phone', 50).nullable();
    t.string('address_line1', 200).nullable();
    t.string('address_line2', 200).nullable();
    t.string('city', 100).nullable();
    t.string('region', 100).nullable();
    t.string('postal_code', 20).nullable();
    t.specificType('country', 'CHAR(2)').nullable();
    userFk(t, 'owner_id');
    t.bigInteger('merged_into_id').unsigned().nullable();
    t.json('custom').nullable();
    auditCols(knex, t);
    t.index(['owner_id']);
    t.index(['domain']);
    t.index(['name']);
  });
  await knex.raw('ALTER TABLE organizations ADD FULLTEXT INDEX ft_organizations (name, domain)');

  await knex.schema.createTable('contact_organization', (t) => {
    idCols(t);
    t.bigInteger('contact_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('contacts')
      .onDelete('CASCADE');
    t.bigInteger('organization_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    t.string('relationship_type', 50).notNullable().defaultTo('employee');
    t.string('job_title', 150).nullable();
    t.boolean('is_primary').notNullable().defaultTo(false);
    t.date('started_at').nullable();
    t.date('ended_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['contact_id', 'organization_id', 'relationship_type'], { indexName: 'contact_org_unique' });
  });

  await knex.schema.createTable('leads', (t) => {
    idCols(t);
    t.string('first_name', 100).notNullable().defaultTo('');
    t.string('last_name', 100).notNullable().defaultTo('');
    t.specificType(
      'full_name',
      "VARCHAR(201) GENERATED ALWAYS AS (TRIM(CONCAT_WS(' ', first_name, last_name))) STORED",
    );
    t.string('email', 255).nullable();
    t.specificType('email_norm', 'VARCHAR(255) GENERATED ALWAYS AS (LOWER(TRIM(email))) STORED');
    t.string('phone', 50).nullable();
    t.string('phone_e164', 20).nullable();
    t.string('company_name', 200).nullable();
    t.string('job_title', 150).nullable();
    t.string('source', 100).nullable();
    t.enum('status', ['new', 'contacted', 'qualified', 'unqualified', 'converted'])
      .notNullable()
      .defaultTo('new');
    userFk(t, 'owner_id');
    t.datetime('converted_at').nullable();
    t.bigInteger('converted_contact_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('contacts')
      .onDelete('SET NULL');
    t.bigInteger('converted_organization_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('organizations')
      .onDelete('SET NULL');
    t.bigInteger('converted_deal_id').unsigned().nullable();
    t.json('custom').nullable();
    auditCols(knex, t);
    t.index(['owner_id']);
    t.index(['status']);
    t.index(['email_norm']);
  });
  await knex.raw('ALTER TABLE leads ADD FULLTEXT INDEX ft_leads (full_name, email, company_name)');

  await knex.schema.createTable('deals', (t) => {
    idCols(t);
    t.string('reference', 40).nullable().unique();
    t.string('title', 255).notNullable();
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
    t.bigInteger('pipeline_id').unsigned().notNullable().references('id').inTable('pipelines');
    t.bigInteger('stage_id').unsigned().notNullable().references('id').inTable('pipeline_stages');
    t.decimal('value', 15, 2).notNullable().defaultTo(0);
    t.specificType('currency', 'CHAR(3)').notNullable();
    t.date('expected_close').nullable();
    t.enum('status', ['open', 'won', 'lost']).notNullable().defaultTo('open');
    t.datetime('won_at').nullable();
    t.datetime('lost_at').nullable();
    t.string('lost_reason', 255).nullable();
    userFk(t, 'owner_id');
    t.datetime('stage_entered_at').notNullable().defaultTo(knex.fn.now());
    t.decimal('position', 20, 10).notNullable().defaultTo(0);
    t.json('custom').nullable();
    auditCols(knex, t);
    t.index(['pipeline_id', 'stage_id', 'position']);
    t.index(['owner_id']);
    t.index(['expected_close']);
    t.index(['status']);
  });
  await knex.raw('ALTER TABLE deals ADD FULLTEXT INDEX ft_deals (title)');
  await knex.raw(
    'ALTER TABLE leads ADD CONSTRAINT leads_converted_deal_fk FOREIGN KEY (converted_deal_id) REFERENCES deals(id) ON DELETE SET NULL',
  );

  await knex.schema.createTable('deal_stage_history', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('deal_id').unsigned().notNullable().references('id').inTable('deals').onDelete('CASCADE');
    t.bigInteger('from_stage_id').unsigned().nullable();
    t.bigInteger('to_stage_id').unsigned().notNullable();
    userFk(t, 'changed_by');
    t.datetime('changed_at').notNullable().defaultTo(knex.fn.now());
    t.index(['deal_id', 'changed_at']);
    t.index(['to_stage_id', 'changed_at']);
  });

  await knex.schema.createTable('activities', (t) => {
    idCols(t);
    t.enum('type', ['task', 'call', 'meeting', 'note', 'email']).notNullable();
    t.string('subject', 255).notNullable().defaultTo('');
    t.text('body', 'mediumtext').nullable();
    t.datetime('due_at').nullable();
    t.datetime('start_at').nullable();
    t.datetime('end_at').nullable();
    t.boolean('all_day').notNullable().defaultTo(false);
    t.datetime('completed_at').nullable();
    t.enum('priority', ['low', 'normal', 'high']).notNullable().defaultTo('normal');
    t.string('outcome', 100).nullable();
    userFk(t, 'assignee_id');
    userFk(t, 'owner_id');
    t.enum('related_type', ['contact', 'organization', 'deal', 'lead']).nullable();
    t.bigInteger('related_id').unsigned().nullable();
    t.datetime('reminder_at').nullable();
    t.datetime('reminded_at').nullable();
    t.json('custom').nullable();
    auditCols(knex, t);
    t.index(['related_type', 'related_id']);
    t.index(['assignee_id', 'completed_at', 'due_at']);
    t.index(['reminder_at', 'reminded_at']);
    t.index(['start_at']);
  });

  await knex.schema.createTable('tags', (t) => {
    idCols(t);
    t.string('name', 64).notNullable();
    t.string('slug', 64).notNullable().unique();
    t.string('color', 32).nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('taggables', (t) => {
    t.bigInteger('tag_id').unsigned().notNullable().references('id').inTable('tags').onDelete('CASCADE');
    t.enum('taggable_type', ['contact', 'organization', 'lead', 'deal']).notNullable();
    t.bigInteger('taggable_id').unsigned().notNullable();
    t.primary(['tag_id', 'taggable_type', 'taggable_id']);
    t.index(['taggable_type', 'taggable_id']);
  });

  await knex.schema.createTable('record_follows', (t) => {
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('entity', 32).notNullable();
    t.bigInteger('entity_id').unsigned().notNullable();
    t.primary(['user_id', 'entity', 'entity_id']);
    t.index(['entity', 'entity_id']);
  });
}

export async function down(knex: Knex) {
  await knex.raw('ALTER TABLE leads DROP FOREIGN KEY leads_converted_deal_fk').catch(() => undefined);
  for (const table of [
    'record_follows',
    'taggables',
    'tags',
    'activities',
    'deal_stage_history',
    'deals',
    'leads',
    'contact_organization',
    'organizations',
    'contacts',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
