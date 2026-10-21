import type { Knex } from 'knex';
import { coreMigrations, type Migration } from './migrations';

/** Knex migration source backed by an in-code registry, so migrations bundle with the build. */
export class RegistrySource implements Knex.MigrationSource<string> {
  constructor(private readonly migrations: Record<string, Migration>) {}
  getMigrations() {
    return Promise.resolve(Object.keys(this.migrations).sort());
  }
  getMigrationName(name: string) {
    return name;
  }
  getMigration(name: string) {
    const m = this.migrations[name];
    if (!m) throw new Error(`Unknown migration ${name}`);
    return Promise.resolve(m);
  }
}

export const coreMigrationConfig = (): Knex.MigratorConfig => ({
  migrationSource: new RegistrySource(coreMigrations),
  tableName: 'knex_migrations',
  // MySQL DDL commits implicitly; per-migration transactions give false safety.
  disableTransactions: true,
});

export async function migrateCore(knex: Knex): Promise<string[]> {
  const [, applied] = (await knex.migrate.latest(coreMigrationConfig())) as [number, string[]];
  return applied;
}

export async function rollbackCore(knex: Knex): Promise<string[]> {
  const [, rolled] = (await knex.migrate.rollback(coreMigrationConfig())) as [number, string[]];
  return rolled;
}

export async function migrateModule(knex: Knex, moduleKey: string, migrations: Record<string, Migration>) {
  const [, applied] = (await knex.migrate.latest({
    migrationSource: new RegistrySource(migrations),
    tableName: `knex_migrations_m_${moduleKey.replace(/-/g, '_')}`,
    disableTransactions: true,
  })) as [number, string[]];
  return applied;
}
