import type { Knex } from 'knex';

/**
 * Web push: the workspace's VAPID key pair (private key encrypted, rotated by crypto:rotate) and
 * each person's browser subscriptions. Subscriptions go with the person (deleted on sign-out
 * everywhere, deactivation and erasure).
 */
export async function up(knex: Knex) {
  await knex.schema.createTable('push_vapid', (t) => {
    t.bigIncrements('id');
    t.string('public_key', 200).notNullable();
    t.text('private_key_enc').notNullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable('push_subscriptions', (t) => {
    t.bigIncrements('id');
    t.bigInteger('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.text('endpoint').notNullable();
    t.specificType('endpoint_hash', 'CHAR(64)').notNullable().unique();
    t.string('p256dh', 200).notNullable();
    t.string('auth', 100).notNullable();
    t.string('user_agent', 255).nullable();
    t.datetime('created_at').notNullable().defaultTo(knex.fn.now());
    t.datetime('last_used_at').nullable();
    t.index(['user_id']);
  });
}

export async function down(knex: Knex) {
  await knex.schema.dropTableIfExists('push_subscriptions');
  await knex.schema.dropTableIfExists('push_vapid');
}
