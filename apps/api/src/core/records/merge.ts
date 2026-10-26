import type { Knex } from 'knex';
import { normalizePhone, type DuplicateCandidate } from '@app/shared';
import { db } from '../../db/knex';
import { AppError } from '../../lib/errors';
import type { AuthUser, RequestContext } from '../../http/context';
import { audit } from '../audit/audit.service';
import { applyScope, assertCan } from '../rbac/access';
import { customContext } from './common';
import { getRow } from './service';
import type { ResourceDef } from './types';

// ---------- Duplicate detection ----------

interface ContactProbe {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  excludeUuid?: string;
}

/** Likely duplicates of a contact, within the caller's scope. Exact email/phone score highest. */
export async function findContactDuplicates(
  user: AuthUser,
  probe: ContactProbe,
  limit = 10,
): Promise<DuplicateCandidate[]> {
  const email = probe.email?.trim().toLowerCase() || null;
  const phone = probe.phone ? normalizePhone(probe.phone) || null : null;
  const name = `${probe.firstName ?? ''} ${probe.lastName ?? ''}`.trim();
  if (!email && !phone && name.length < 3) return [];
  const qb = db('contacts').whereNull('deleted_at');
  await applyScope(qb, user, 'core.contacts', ['contacts.owner_id']);
  if (probe.excludeUuid) qb.whereNot('uuid', probe.excludeUuid);
  qb.where((w) => {
    if (email) w.orWhere('email_norm', email);
    if (phone) w.orWhere('phone_e164', phone);
    if (name.length >= 3) w.orWhere('full_name', name);
  });
  const rows = await qb
    .limit(limit * 3)
    .select('uuid', 'full_name', 'email', 'email_norm', 'phone_e164', 'first_name', 'last_name');
  return rows
    .map((r) => {
      const reasons: string[] = [];
      let score = 0;
      if (email && r.email_norm === email) {
        reasons.push('Same email');
        score += 60;
      }
      if (phone && r.phone_e164 === phone) {
        reasons.push('Same phone');
        score += 40;
      }
      if (name && r.full_name?.toLowerCase() === name.toLowerCase()) {
        reasons.push('Same name');
        score += 20;
      }
      return { uuid: r.uuid, title: r.full_name || r.email || '', subtitle: r.email, reasons, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function findOrganizationDuplicates(
  user: AuthUser,
  probe: { name?: string | null; domain?: string | null; excludeUuid?: string },
  limit = 10,
): Promise<DuplicateCandidate[]> {
  const name = probe.name?.trim() || null;
  const domain = probe.domain?.trim().toLowerCase() || null;
  if (!name && !domain) return [];
  const qb = db('organizations').whereNull('deleted_at');
  await applyScope(qb, user, 'core.organizations', ['organizations.owner_id']);
  if (probe.excludeUuid) qb.whereNot('uuid', probe.excludeUuid);
  qb.where((w) => {
    if (domain) w.orWhere('domain', domain);
    if (name) w.orWhere('name', name);
  });
  const rows = await qb.limit(limit * 3).select('uuid', 'name', 'domain');
  return rows
    .map((r) => {
      const reasons: string[] = [];
      let score = 0;
      if (domain && r.domain === domain) {
        reasons.push('Same website');
        score += 60;
      }
      if (name && r.name?.toLowerCase() === name.toLowerCase()) {
        reasons.push('Same name');
        score += 40;
      }
      return { uuid: r.uuid, title: r.name, subtitle: r.domain, reasons, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------- Merge ----------

export interface MergeInput {
  primaryUuid: string;
  secondaryUuids: string[];
  /** Column → uuid of the record whose value wins (defaults to primary). Custom fields use `custom.<key>`. */
  pick?: Record<string, string>;
}

const MERGEABLE: Record<'contact' | 'organization', string[]> = {
  contact: [
    'first_name',
    'last_name',
    'email',
    'phone',
    'phone_e164',
    'job_title',
    'source',
    'lifecycle_status',
    'owner_id',
  ],
  organization: [
    'name',
    'website',
    'domain',
    'industry',
    'email',
    'phone',
    'address_line1',
    'address_line2',
    'city',
    'region',
    'postal_code',
    'country',
    'owner_id',
  ],
};

/** Re-point everything that references the secondary records to the primary. */
async function repoint(
  trx: Knex.Transaction,
  entity: 'contact' | 'organization',
  primaryId: number,
  secondaryIds: number[],
) {
  const col = entity === 'contact' ? 'contact_id' : 'organization_id';
  await trx('deals')
    .whereIn(col, secondaryIds)
    .update({ [col]: primaryId });
  await trx('activities')
    .where({ related_type: entity })
    .whereIn('related_id', secondaryIds)
    .update({ related_id: primaryId });
  await trx('files').where({ entity }).whereIn('entity_id', secondaryIds).update({ entity_id: primaryId });
  if (entity === 'contact') {
    await trx('leads')
      .whereIn('converted_contact_id', secondaryIds)
      .update({ converted_contact_id: primaryId });
    await trx('privacy_requests')
      .where({ subject_type: 'contact' })
      .whereIn('subject_id', secondaryIds)
      .update({ subject_id: primaryId });
    // Consent proof is append-only; re-linking it to the surviving record is the one sanctioned change.
    await trx.raw('SET @audit_redaction = 1');
    try {
      await trx('consents')
        .where({ subject_type: 'contact' })
        .whereIn('subject_id', secondaryIds)
        .update({ subject_id: primaryId });
    } finally {
      await trx.raw('SET @audit_redaction = 0');
    }
  } else
    await trx('leads')
      .whereIn('converted_organization_id', secondaryIds)
      .update({ converted_organization_id: primaryId });

  // Links and tags: union, skipping ones the primary already has.
  const links = await trx('contact_organization').whereIn(col, secondaryIds);
  for (const l of links) {
    const other =
      entity === 'contact'
        ? { contact_id: primaryId, organization_id: l.organization_id }
        : { contact_id: l.contact_id, organization_id: primaryId };
    const exists = await trx('contact_organization')
      .where({ ...other, relationship_type: l.relationship_type })
      .first();
    if (exists) await trx('contact_organization').where({ id: l.id }).delete();
    else
      await trx('contact_organization')
        .where({ id: l.id })
        .update({ ...other, is_primary: entity === 'contact' ? false : l.is_primary });
  }
  const tags = await trx('taggables').where({ taggable_type: entity }).whereIn('taggable_id', secondaryIds);
  for (const t of tags) {
    await trx('taggables')
      .insert({ tag_id: t.tag_id, taggable_type: entity, taggable_id: primaryId })
      .onConflict(['tag_id', 'taggable_type', 'taggable_id'])
      .ignore();
  }
  await trx('taggables').where({ taggable_type: entity }).whereIn('taggable_id', secondaryIds).delete();
  const follows = await trx('record_follows').where({ entity }).whereIn('entity_id', secondaryIds);
  for (const f of follows) {
    await trx('record_follows')
      .insert({ user_id: f.user_id, entity, entity_id: primaryId })
      .onConflict(['user_id', 'entity', 'entity_id'])
      .ignore();
  }
  await trx('record_follows').where({ entity }).whereIn('entity_id', secondaryIds).delete();
}

export async function mergeRecords(def: ResourceDef, ctx: RequestContext, user: AuthUser, input: MergeInput) {
  const entity = def.entity as 'contact' | 'organization';
  assertCan(user, `${def.resource}.merge`);
  if (input.secondaryUuids.includes(input.primaryUuid))
    throw new AppError('VALIDATION_FAILED', 'A record cannot be merged into itself');
  const { defs, levels } = await customContext(entity, user);
  return db.transaction(async (trx) => {
    // Every record must be in the caller's scope (404 otherwise).
    const primary = await getRow(def, user, input.primaryUuid, trx, { forUpdate: true });
    const secondaries = [];
    for (const uuid of input.secondaryUuids)
      secondaries.push(await getRow(def, user, uuid, trx, { forUpdate: true }));
    const all = [primary, ...secondaries];
    const byUuid = new Map(all.map((r) => [r.uuid as string, r]));

    const patch: Record<string, unknown> = {};
    for (const col of MERGEABLE[entity]) {
      const source = input.pick?.[col] ? byUuid.get(input.pick[col]) : undefined;
      if (input.pick?.[col] && !source) throw new AppError('VALIDATION_FAILED', `Unknown source for ${col}`);
      // Default: keep the primary's value, fill blanks from the others in order.
      const value = source
        ? source[col]
        : (primary[col] ??
          secondaries.map((s) => s[col]).find((v) => v !== null && v !== '' && v !== undefined) ??
          null);
      if (value !== primary[col]) patch[col] = value;
    }
    if ('phone' in patch && entity === 'contact')
      patch.phone_e164 = patch.phone ? normalizePhone(String(patch.phone)) : null;

    const custom = { ...((primary.custom as Record<string, unknown>) ?? {}) };
    for (const d of defs) {
      if (levels[d.key] !== 'write') continue;
      const pickUuid = input.pick?.[`custom.${d.key}`];
      const source = pickUuid ? byUuid.get(pickUuid) : undefined;
      const fromSource = source ? (source.custom as Record<string, unknown> | null)?.[d.key] : undefined;
      if (source) {
        // undefined is dropped by JSON.stringify, which clears the value.
        if (fromSource === undefined || fromSource === null) custom[d.key] = undefined;
        else custom[d.key] = fromSource;
      } else if (custom[d.key] === undefined) {
        const filled = secondaries
          .map((s) => (s.custom as Record<string, unknown> | null)?.[d.key])
          .find((v) => v !== undefined && v !== null);
        if (filled !== undefined) custom[d.key] = filled;
      }
    }
    patch.custom = JSON.stringify(custom);
    patch.updated_by = user.id;
    await trx(def.table).where({ id: primary.id }).update(patch);

    const secondaryIds = secondaries.map((s) => s.id as number);
    await repoint(trx, entity, primary.id as number, secondaryIds);
    await trx(def.table)
      .whereIn('id', secondaryIds)
      .update({ merged_into_id: primary.id, deleted_at: new Date(), updated_by: user.id });

    await audit(trx, ctx, {
      action: `${entity}.merged`,
      entity,
      entityId: primary.id as number,
      entityUuid: primary.uuid as string,
      diff: { merged: input.secondaryUuids },
    });
    for (const s of secondaries) {
      await audit(trx, ctx, {
        action: `${entity}.merged_into`,
        entity,
        entityId: s.id as number,
        entityUuid: s.uuid as string,
        diff: { into: primary.uuid },
      });
    }
    return primary.uuid as string;
  });
}
