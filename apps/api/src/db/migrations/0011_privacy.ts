import type { Knex } from 'knex';
import { idCols, timestamps } from '../helpers';

/**
 * Data subject rights: consent ledger (append-only), privacy request tracker, and the
 * restriction / marketing opt-out flags on contacts and leads.
 */
export async function up(knex: Knex) {
  for (const table of ['contacts', 'leads']) {
    await knex.schema.alterTable(table, (t) => {
      t.boolean('processing_restricted').notNullable().defaultTo(false);
      t.boolean('marketing_opt_out').notNullable().defaultTo(false);
    });
  }

  await knex.schema.createTable('consents', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.enum('subject_type', ['contact', 'lead']).notNullable();
    t.bigInteger('subject_id').unsigned().notNullable();
    t.string('purpose_key', 50).notNullable();
    t.enum('status', ['granted', 'withdrawn']).notNullable();
    t.string('lawful_basis', 32).notNullable();
    t.string('source', 16).notNullable();
    t.text('text_snapshot').notNullable();
    t.specificType('text_hash', 'CHAR(64)').notNullable();
    t.string('note', 500).nullable();
    t.string('ip', 64).nullable();
    t.string('user_agent', 500).nullable();
    t.bigInteger('recorded_by').unsigned().nullable();
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.index(['subject_type', 'subject_id', 'purpose_key', 'id'], 'consents_subject_purpose_idx');
  });
  // Proof of consent must not change. Erasure may clear the person's IP and user agent or
  // delete the rows (with @audit_redaction, like the audit log).
  await knex.raw(`
    CREATE TRIGGER consents_no_update BEFORE UPDATE ON consents FOR EACH ROW
    BEGIN
      IF COALESCE(@audit_redaction, 0) <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'consents is append-only';
      END IF;
    END`);
  await knex.raw(`
    CREATE TRIGGER consents_no_delete BEFORE DELETE ON consents FOR EACH ROW
    BEGIN
      IF COALESCE(@audit_redaction, 0) <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'consents is append-only';
      END IF;
    END`);

  await knex.schema.createTable('privacy_requests', (t) => {
    idCols(t);
    t.string('type', 32).notNullable();
    t.string('status', 16).notNullable().defaultTo('open');
    t.enum('subject_type', ['contact', 'lead']).nullable();
    t.bigInteger('subject_id').unsigned().nullable();
    t.string('requester_name', 200).notNullable().defaultTo('');
    t.string('requester_email', 254).notNullable().defaultTo('');
    t.string('channel', 50).notNullable().defaultTo('email');
    t.date('received_at').notNullable();
    t.date('due_at').notNullable();
    t.text('notes').nullable();
    t.text('resolution').nullable();
    t.bigInteger('assignee_id').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    t.datetime('completed_at').nullable();
    t.datetime('reminded_at').nullable();
    t.bigInteger('created_by').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL');
    timestamps(knex, t);
    t.index(['status', 'due_at']);
    t.index(['subject_type', 'subject_id']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('privacy_requests');
  await knex.raw('DROP TRIGGER IF EXISTS consents_no_update');
  await knex.raw('DROP TRIGGER IF EXISTS consents_no_delete');
  await knex.schema.dropTableIfExists('consents');
  for (const table of ['contacts', 'leads']) {
    await knex.schema.alterTable(table, (t) => {
      t.dropColumn('processing_restricted');
      t.dropColumn('marketing_opt_out');
    });
  }
}
