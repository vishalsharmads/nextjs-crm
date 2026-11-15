import type { Knex } from 'knex';
import { v7 } from 'uuid';

/**
 * Activity participants (a meeting with two people from two companies shows on every one of
 * them) and email threads. Existing messages get thread ids from their In-Reply-To headers.
 */
export async function up(knex: Knex) {
  await knex.schema.createTable('activity_participants', (t) => {
    t.bigIncrements('id');
    t.bigInteger('activity_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('activities')
      .onDelete('CASCADE');
    t.enum('kind', ['contact', 'lead', 'organization', 'user']).notNullable();
    t.bigInteger('record_id').unsigned().notNullable();
    t.enum('role', ['attendee', 'organizer', 'from', 'to', 'cc']).notNullable().defaultTo('attendee');
    t.unique(['activity_id', 'kind', 'record_id']);
    t.index(['kind', 'record_id']);
  });
  await knex.schema.alterTable('email_messages', (t) => {
    t.string('thread_id', 36).nullable();
    t.index(['thread_id']);
  });
  const rows = (await knex('email_messages')
    .orderBy([{ column: 'sent_at' }, { column: 'id' }])
    .select('id', 'message_id', 'in_reply_to')) as {
    id: number;
    message_id: string | null;
    in_reply_to: string | null;
  }[];
  const threadOf = new Map<string, string>();
  for (const r of rows) {
    const thread = (r.in_reply_to && threadOf.get(r.in_reply_to)) || v7();
    if (r.message_id) threadOf.set(r.message_id, thread);
    await knex('email_messages').where({ id: r.id }).update({ thread_id: thread });
  }
}

export async function down(knex: Knex) {
  await knex.schema.alterTable('email_messages', (t) => {
    t.dropIndex(['thread_id']);
    t.dropColumn('thread_id');
  });
  await knex.schema.dropTableIfExists('activity_participants');
}
