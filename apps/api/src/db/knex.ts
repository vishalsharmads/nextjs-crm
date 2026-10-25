import knexFactory, { type Knex } from 'knex';
import { env, isTest } from '../config/env';

/** `poolMax: 1` pins every query to one connection (session variables such as FOREIGN_KEY_CHECKS). */
export function createKnex(
  url = isTest ? env.DATABASE_URL_TEST : env.DATABASE_URL,
  opts: { poolMax?: number } = {},
): Knex {
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
    pool: {
      min: 0,
      max: opts.poolMax ?? 10,
      // All DATETIME defaults (CURRENT_TIMESTAMP) must be UTC, matching what the app writes.
      afterCreate(
        conn: { query: (sql: string, cb: (err: Error | null) => void) => void },
        done: (err: Error | null, conn: unknown) => void,
      ) {
        conn.query("SET time_zone = '+00:00'", (err) => done(err, conn));
      },
    },
  });
}

export const db: Knex = createKnex();

export type Db = Knex | Knex.Transaction;

/** A connection to the database server itself (no database selected), for create/exists checks. */
function serverKnex(url: string): { admin: Knex; name: string } {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe database name: ${name}`);
  const admin = knexFactory({
    client: 'mysql2',
    connection: {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    },
  });
  return { admin, name };
}

/** Create the target database if it does not exist (install / test setup). */
export async function ensureDatabase(url: string): Promise<void> {
  const { admin, name } = serverKnex(url);
  try {
    await admin.raw(
      `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
  } finally {
    await admin.destroy();
  }
}

/** Whether the target database exists (visible to this user). */
export async function databaseExists(url: string): Promise<boolean> {
  const { admin, name } = serverKnex(url);
  try {
    const row = await admin('information_schema.schemata').where('schema_name', name).first('schema_name');
    return !!row;
  } finally {
    await admin.destroy();
  }
}
