import type { Knex } from 'knex';

/** Open and click tracking on emails sent from the app (opt-in; see the email tracking settings). */
export async function up(knex: Knex) {
  await knex.schema.alterTable('email_messages', (t) => {
    t.string('tracking_token', 64).nullable().unique();
    t.json('tracking_links').nullable();
    t.integer('open_count').unsigned().notNullable().defaultTo(0);
    t.datetime('first_opened_at').nullable();
    t.datetime('last_opened_at').nullable();
    t.integer('click_count').unsigned().notNullable().defaultTo(0);
    t.datetime('last_clicked_at').nullable();
  });
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('email_messages', (t) => {
    t.dropUnique(['tracking_token']);
    for (const c of [
      'tracking_token',
      'tracking_links',
      'open_count',
      'first_opened_at',
      'last_opened_at',
      'click_count',
      'last_clicked_at',
    ])
      t.dropColumn(c);
  });
}
