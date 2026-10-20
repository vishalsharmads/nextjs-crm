import { afterAll } from 'vitest';
import { mailbox } from '../src/lib/mailer';
import { db } from '../src/db/knex';

mailbox.capture = [];

afterAll(async () => {
  await db.destroy();
});
