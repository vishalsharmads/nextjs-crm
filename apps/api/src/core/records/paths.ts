import type { ResourceDef } from './types';

/** Tables of a module start with `m_<key>_`, hyphens as underscores (`notes-demo` → `m_notes_demo_`). */
export const moduleTablePrefix = (moduleKey: string) => `m_${moduleKey.replace(/-/g, '_')}_`;

/** Path of a record type: `/contacts`, or `/m/<module>/<route>` for module types (API and web). */
export const recordBasePath = (def: Pick<ResourceDef, 'route' | 'moduleKey'>) =>
  def.moduleKey ? `/m/${def.moduleKey}/${def.route}` : `/${def.route}`;
