import knexFactory from 'knex';

/** Fresh test database per run: drop, create, migrate, install core + generic blueprint. */
export default async function setup() {
  process.env.NODE_ENV = 'test';
  const url = new URL(process.env.DATABASE_URL_TEST ?? 'mysql://root@127.0.0.1:3306/crm_test');
  const name = url.pathname.slice(1);
  if (!/^[A-Za-z0-9_]*test[A-Za-z0-9_]*$/.test(name))
    throw new Error(`Refusing to reset non-test database "${name}"`);
  const admin = knexFactory({
    client: 'mysql2',
    connection: {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    },
  });
  await admin.raw(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.raw(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await admin.destroy();

  const { createKnex } = await import('../src/db/knex');
  const { migrateCore } = await import('../src/db/migrate');
  const { installCore, markInstalled } = await import('../src/cli/install');
  const { applyBlueprintByKey } = await import('../src/blueprints/applier');
  const knex = createKnex(url.toString());
  try {
    await migrateCore(knex);
    await installCore(knex, {
      adminEmail: 'root-admin@example.test',
      adminPassword: 'RootAdmin123!',
      appName: 'Test CRM',
    });
    await applyBlueprintByKey(knex, 'generic');
    await markInstalled(knex, 'generic');
  } finally {
    await knex.destroy();
    const { db } = await import('../src/db/knex');
    await db.destroy();
  }
}
