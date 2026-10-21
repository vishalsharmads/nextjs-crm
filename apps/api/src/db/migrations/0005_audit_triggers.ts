import type { Knex } from 'knex';

/**
 * Audit log is append-only. UPDATE and DELETE are rejected unless the session sets
 * @audit_redaction = 1, which only the privacy anonymize path does (and audits itself).
 */
export async function up(knex: Knex) {
  await knex.raw(`
    CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs FOR EACH ROW
    BEGIN
      IF COALESCE(@audit_redaction, 0) <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';
      END IF;
    END`);
  await knex.raw(`
    CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs FOR EACH ROW
    BEGIN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';
    END`);
}

export async function down(knex: Knex) {
  await knex.raw('DROP TRIGGER IF EXISTS audit_logs_no_update');
  await knex.raw('DROP TRIGGER IF EXISTS audit_logs_no_delete');
}
