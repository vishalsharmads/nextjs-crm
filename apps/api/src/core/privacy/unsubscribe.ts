import { z } from 'zod';
import type { DataSubjectEntity } from '@app/shared';
import { env } from '../../config/env';
import { hmac, safeEqual } from '../../lib/crypto';

/** Unsubscribe links never expire: a person must always be able to opt out. */
export function unsubscribeToken(entity: DataSubjectEntity, uuid: string) {
  const sig = hmac(env.UNSUBSCRIBE_SECRET ?? env.CSRF_SECRET, `unsubscribe:${entity}:${uuid}`).slice(0, 32);
  return `${entity === 'contact' ? 'c' : 'l'}.${uuid}.${sig}`;
}

export function parseUnsubscribeToken(token: string) {
  const [kind, uuid, sig] = token.split('.');
  const entity: DataSubjectEntity | null = kind === 'c' ? 'contact' : kind === 'l' ? 'lead' : null;
  if (!entity || !uuid || !sig || !z.uuid().safeParse(uuid).success) return null;
  return safeEqual(sig, unsubscribeToken(entity, uuid).split('.')[2]!) ? { entity, uuid } : null;
}
