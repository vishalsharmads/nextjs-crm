import type { CustomizableEntity } from '@app/shared';
import type { AuthUser, RequestContext } from '../../http/context';
import { notFound } from '../../lib/errors';
import { assertCan } from '../rbac/access';
import { getRow } from '../records/service';
import { recordDefs } from '../records/registry';
import { decryptValue, isEncryptedValue } from '../records/custom';
import { logAccess } from '../audit/access-log';
import { fieldLevel, getDefinitions } from './definitions';

/**
 * Show one sensitive value to someone allowed to see it (minimum necessary: one field, on
 * request). Every reveal is written to the access log, even when access logging is off.
 */
export async function revealField(
  ctx: RequestContext,
  user: AuthUser,
  entity: CustomizableEntity,
  uuid: string,
  key: string,
) {
  const def = recordDefs[entity];
  assertCan(user, `${def.resource}.view`);
  const row = await getRow(def, user, uuid);
  const field = (await getDefinitions(entity)).find((d) => d.key === key && d.sensitivity === 'special');
  if (!field || fieldLevel(field, user) === 'hidden') throw notFound('Field');
  const raw = (row.custom as Record<string, unknown> | null)?.[key];
  // Log first, and fail closed: no record of the reveal, no value.
  await logAccess(
    ctx,
    { action: 'reveal', entity, entityId: row.id as number, entityUuid: uuid, detail: { field: key } },
    { always: true, required: true },
  );
  return { value: isEncryptedValue(raw) ? decryptValue(raw, entity, key) : (raw ?? null) };
}
