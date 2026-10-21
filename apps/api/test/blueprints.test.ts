import { describe, expect, it } from 'vitest';
import { loadBlueprint, parseBlueprint, type Blueprint } from '@app/blueprints';
import { applyBlueprint } from '../src/blueprints/applier';
import { exportBlueprint } from '../src/blueprints/exporter';
import { db } from '../src/db/knex';

const bump = (bp: Blueprint, version: string, patch: (b: Blueprint) => void = () => undefined): Blueprint => {
  const copy = structuredClone(bp);
  copy.version = version;
  patch(copy);
  return parseBlueprint(copy);
};

/** Next minor version after whatever is applied now (other test files may have applied newer ones). */
async function nextVersion() {
  const last = await db('blueprint_applications')
    .where({ blueprint_key: 'generic' })
    .orderBy('id', 'desc')
    .first();
  const [major = 1, minor = 0] = (last.version as string).split('.').map(Number);
  return `${major}.${minor + 1}.0`;
}

describe('blueprint engine', () => {
  const generic = loadBlueprint('generic');

  it('re-applying the same blueprint changes nothing', async () => {
    const bp = bump(generic, await nextVersion());
    await applyBlueprint(db, bp);
    const before = await db('blueprint_applications').count({ c: '*' }).first();
    const report = await applyBlueprint(db, bp);
    expect(report.created).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(report.status).toBe('unchanged');
    const after = await db('blueprint_applications').count({ c: '*' }).first();
    expect(after).toEqual(before);
  });

  it('never overwrites a client-edited item and reports a conflict', async () => {
    await db('custom_field_definitions')
      .where({ entity: 'contact', key: 'linkedin' })
      .update({ label: 'LinkedIn profile', customized: true });
    const next = bump(generic, await nextVersion(), (b) => {
      b.custom_fields.contact![0]!.label = 'LinkedIn URL';
      b.custom_fields.contact!.push({
        key: 'nickname',
        label: 'Nickname',
        type: 'text',
        required: false,
        filterable: false,
        show_in_list: false,
      });
      b.pipelines[0]!.stages.splice(4, 0, {
        key: 'verbal',
        name: 'Verbal yes',
        probability: 90,
        is_won: false,
        is_lost: false,
      });
    });
    const report = await applyBlueprint(db, next);
    expect(report.conflicts.map((c) => c.item)).toContain('field.contact.linkedin');
    expect(report.created).toEqual(
      expect.arrayContaining(['field.contact.nickname', 'pipeline.sales.verbal']),
    );
    const field = await db('custom_field_definitions').where({ entity: 'contact', key: 'linkedin' }).first();
    expect(field.label).toBe('LinkedIn profile');

    // Applying the same version again is a no-op.
    const again = await applyBlueprint(db, next);
    expect(again.created).toEqual([]);
    expect(again.updated).toEqual([]);
  });

  it('updates untouched items and reports removed ones as orphaned', async () => {
    const next = bump(generic, await nextVersion(), (b) => {
      b.custom_fields.contact = b.custom_fields.contact!.filter((f) => f.key !== 'birthday');
      b.roles.find((r) => r.key === 'read_only')!.name = 'Viewer';
    });
    const report = await applyBlueprint(db, next);
    expect(report.updated).toContain('role.read_only');
    expect(report.orphaned).toContain('field.contact.birthday');
    expect(
      await db('custom_field_definitions').where({ entity: 'contact', key: 'birthday' }).first(),
    ).toBeTruthy();
    expect((await db('roles').where({ key: 'read_only' }).first()).name).toBe('Viewer');
  });

  it('refuses a changed blueprint without a version bump, and downgrades', async () => {
    const last = await db('blueprint_applications').orderBy('id', 'desc').first();
    const sameVersion = bump(generic, last.version, (b) => {
      b.description = 'edited';
    });
    await expect(applyBlueprint(db, sameVersion)).rejects.toThrow(/without a version bump/);
    await expect(applyBlueprint(db, bump(generic, '0.9.0'))).rejects.toThrow(/downgrade/);
  });

  it('refuses to apply a second, different blueprint', async () => {
    await expect(applyBlueprint(db, loadBlueprint('coworking'))).rejects.toThrow(/One primary blueprint/);
  });

  it('dry-run reports without writing', async () => {
    const next = bump(generic, await nextVersion(), (b) => {
      b.vocabulary = { team: { singular: 'Squad', plural: 'Squads' } };
    });
    const report = await applyBlueprint(db, next, { dryRun: true });
    expect(report.status).toBe('dry_run');
    expect(report.created).toContain('label.team');
    expect(await db('labels').where({ entity_key: 'team', singular: 'Squad' }).first()).toBeUndefined();
  });

  it('exports the configuration as a valid, re-importable blueprint', async () => {
    const exported = await exportBlueprint(db, { key: 'generic-export', version: '1.0.0' });
    expect(parseBlueprint(exported).key).toBe('generic-export');
    expect(exported.pipelines.some((p) => p.key === 'sales')).toBe(true);
    expect(exported.custom_fields.contact?.some((f) => f.key === 'linkedin')).toBe(true);
    expect(exported.roles.some((r) => r.key === 'sales_rep')).toBe(true);
  });
});
