/**
 * Search load check: fills the TEST database with 100,000 contacts, then times global search
 * as an admin and as an own-scope user. Run: DATABASE_URL=$DATABASE_URL_TEST npx tsx scripts/search-load.ts
 * Never run it against a real instance's database.
 */
import { db } from '../apps/api/src/db/knex';
import { newUuid } from '../apps/api/src/lib/ids';
import { searchRecords } from '../apps/api/src/core/search/search.routes';
import { loadAccess } from '../apps/api/src/core/rbac/access';

const N = 100_000;
const dbName = (await db.raw('SELECT DATABASE() AS d'))[0][0].d as string;
if (!/test|load/.test(dbName)) throw new Error(`Refusing to fill ${dbName}: use a test database`);

const first = ['Ava', 'Ben', 'Cara', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivan', 'Jo'];
const last = ['Stone', 'Rivera', 'Okafor', 'Novak', 'Ito', 'Moreau', 'Kahn', 'Lund', 'Silva', 'Berg'];
const existing = Number((await db('contacts').count({ c: '*' }).first())?.c ?? 0);
if (existing < N) {
  const owner = await db('users').first('id');
  for (let i = existing; i < N; i += 2000) {
    const rows = Array.from({ length: Math.min(2000, N - i) }, (_, j) => {
      const n = i + j;
      const f = first[n % 10]!;
      const l = `${last[Math.floor(n / 10) % 10]!}${n}`;
      return {
        uuid: newUuid(),
        first_name: f,
        last_name: l,
        email: `${f}.${l}@example.test`.toLowerCase(),
        owner_id: owner.id,
      };
    });
    await db('contacts').insert(rows);
  }
}
const admin = await db('users')
  .join('user_roles as ur', 'ur.user_id', 'users.id')
  .join('roles as r', 'r.id', 'ur.role_id')
  .where('r.key', 'admin')
  .first('users.id');
const user = await loadAccess(admin.id);
for (const q of ['Stone', 'okafor5', 'ava.novak', 'zzz-none', 'Rivera12345']) {
  const t = performance.now();
  const hits = await searchRecords(user, { q, limit: 5 });
  console.log(
    `${q.padEnd(12)} ${String(hits.length).padStart(3)} hits  ${(performance.now() - t).toFixed(0)} ms`,
  );
}
await db.destroy();
