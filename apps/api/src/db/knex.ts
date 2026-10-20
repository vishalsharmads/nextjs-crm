import knexFactory, { type Knex } from 'knex';
import { env, isTest } from '../config/env';

export function createKnex(url = isTest ? env.DATABASE_URL_TEST : env.DATABASE_URL): Knex {
  const u = new URL(url);
  return knexFactory({
    client: 'mysql2',
    connection: {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.slice(1),
      charset: 'utf8mb4',
      timezone: 'Z',
      // DATE columns stay as 'YYYY-MM-DD' strings (no timezone shifting); DATETIME are UTC Dates.
      typeCast(field: { type: string; string(): string | null }, next: () => unknown) {
        if (field.type === 'DATE') return field.string();
        return next();
      },
      decimalNumbers: true,
      supportBigNumbers: true,
      multipleStatements: false,
    },
    pool: { min: 0, max: 10 },
  });
}

export const db: Knex = createKnex();

export type Db = Knex | Knex.Transaction;

/** Create the target database if it does not exist (install / test setup). */
export async function ensureDatabase(url: string): Promise<void> {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
  u.pathname = '/';
  const admin = knexFactory({
    client: 'mysql2',
    connection: {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    },
  });
  try {
    await admin.raw(
      `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
  } finally {
    await admin.destroy();
  }
}
