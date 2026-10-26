import type { Knex } from 'knex';

/**
 * Access log (who viewed, downloaded or exported what), daily integrity digests for the
 * audit and access logs, and retention deletes. Both logs stay append-only: UPDATE needs
 * @audit_redaction = 1 (privacy erasure) and DELETE needs @audit_purge = 1 (retention job).
 */
export async function up(knex: Knex) {
  await knex.schema.createTable('access_logs', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('actor_id').unsigned().nullable();
    t.string('actor_type', 16).notNullable();
    t.string('action', 32).notNullable();
    t.string('entity', 64).notNullable();
    t.bigInteger('entity_id').unsigned().nullable();
    t.specificType('entity_uuid', 'CHAR(36)').nullable();
    t.json('detail').nullable();
    t.string('ip', 64).nullable();
    t.string('user_agent', 500).nullable();
    t.string('request_id', 64).nullable();
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.index(['entity', 'entity_id', 'created_at']);
    t.index(['actor_id', 'created_at']);
    t.index(['created_at']);
  });

  await knex.schema.createTable('audit_digests', (t) => {
    t.string('source', 16).notNullable();
    t.date('day').notNullable();
    t.integer('row_count').unsigned().notNullable();
    t.bigInteger('first_id').unsigned().nullable();
    t.bigInteger('last_id').unsigned().nullable();
    t.specificType('digest', 'CHAR(64)').notNullable();
    t.specificType('chain', 'CHAR(64)').notNullable();
    t.datetime('sealed_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('purged_at').nullable();
    t.primary(['source', 'day']);
  });

  await knex.raw('DROP TRIGGER IF EXISTS audit_logs_no_delete');
  await knex.raw(`
    CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs FOR EACH ROW
    BEGIN
      IF COALESCE(@audit_purge, 0) <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';
      END IF;
    END`);
  await knex.raw(`
    CREATE TRIGGER access_logs_no_update BEFORE UPDATE ON access_logs FOR EACH ROW
    BEGIN
      IF COALESCE(@audit_redaction, 0) <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'access_logs is append-only';
      END IF;
    END`);
  await knex.raw(`
    CREATE TRIGGER access_logs_no_delete BEFORE DELETE ON access_logs FOR EACH ROW
    BEGIN
      IF COALESCE(@audit_purge, 0) <> 1 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'access_logs is append-only';
      END IF;
    END`);
}

export async function down(knex: Knex) {
  await knex.raw('DROP TRIGGER IF EXISTS access_logs_no_update');
  await knex.raw('DROP TRIGGER IF EXISTS access_logs_no_delete');
  await knex.raw('DROP TRIGGER IF EXISTS audit_logs_no_delete');
  await knex.raw(`
    CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs FOR EACH ROW
    BEGIN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';
    END`);
  await knex.schema.dropTableIfExists('audit_digests');
  await knex.schema.dropTableIfExists('access_logs');
}
