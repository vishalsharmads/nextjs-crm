import type { Knex } from 'knex';

/** Status is optional on the record type, so a cleared value must be storable. */
export async function up(knex: Knex) {
  await knex.raw("ALTER TABLE m_records_demo_items MODIFY status VARCHAR(32) NULL DEFAULT 'active'");
}

export async function down(knex: Knex) {
  await knex.raw("UPDATE m_records_demo_items SET status = 'active' WHERE status IS NULL");
  await knex.raw("ALTER TABLE m_records_demo_items MODIFY status VARCHAR(32) NOT NULL DEFAULT 'active'");
}
