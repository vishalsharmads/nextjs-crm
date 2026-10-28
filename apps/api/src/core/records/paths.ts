import { recordTypePath } from '@app/shared';
import type { ResourceDef } from './types';

/** Tables of a module start with `m_<key>_`, hyphens as underscores (`notes-demo` → `m_notes_demo_`). */
export const moduleTablePrefix = (moduleKey: string) => `m_${moduleKey.replace(/-/g, '_')}_`;

/** Path of a record type: `/contacts`, `/m/<module>/<route>` for module types, `/o/<route>` for objects. */
export const recordBasePath = (def: Pick<ResourceDef, 'route' | 'moduleKey'>) =>
  def.moduleKey ? `/${recordTypePath({ moduleKey: def.moduleKey, route: def.route })}` : `/${def.route}`;
