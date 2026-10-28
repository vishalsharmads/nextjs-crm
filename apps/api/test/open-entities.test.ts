import { describe, expect, it } from 'vitest';
import { db } from '../src/db/knex';

describe('open entity keys', () => {
  it('accepts module entity keys in the configuration tables', async () => {
    const info = await db('information_schema.columns')
      .where({ table_schema: db.raw('DATABASE()'), column_name: 'entity' })
      .whereIn('table_name', ['custom_field_groups', 'custom_field_definitions', 'layouts', 'saved_views'])
      .select('table_name as t', 'data_type as d');
    expect(info).toHaveLength(4);
    expect(info.every((r) => (r as { d: string }).d === 'varchar')).toBe(true);

    const [id] = await db('custom_field_groups').insert({ entity: 'm_demo_thing', key: 'g', label: 'G' });
    expect(id).toBeTruthy();
    await db('custom_field_groups').where({ id }).delete();
  });
});
