import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.schema.createTable('m_coworking_checkins_visits', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.specificType('uuid', 'CHAR(36)').notNullable().unique();
    t.enum('kind', ['member', 'visitor']).notNullable();
    /** The member, or (for visitors) the member hosting them. */
    t.bigInteger('contact_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('contacts')
      .onDelete('SET NULL');
    t.bigInteger('host_contact_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('contacts')
      .onDelete('SET NULL');
    t.string('visitor_name', 200).nullable();
    t.string('visitor_company', 200).nullable();
    t.string('visitor_email', 254).nullable();
    t.string('purpose', 300).nullable();
    t.string('badge', 50).nullable();
    t.datetime('checked_in_at').notNullable();
    t.datetime('checked_out_at').nullable();
    t.boolean('host_notified').notNullable().defaultTo(false);
    t.bigInteger('checked_in_by')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    t.index(['checked_out_at', 'checked_in_at']);
    t.index(['contact_id', 'checked_in_at']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('m_coworking_checkins_visits');
}
