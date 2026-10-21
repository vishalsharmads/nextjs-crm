/**
 * Permission keys: `<module>.<resource>.<action>`.
 * Role patterns may use `*` (everything) or `<module>.<resource>.*`.
 */
export const RECORD_ACTIONS = [
  'view',
  'create',
  'update',
  'delete',
  'export',
  'import',
  'merge',
  'assign',
  'bulk',
] as const;
export type RecordAction = (typeof RECORD_ACTIONS)[number];

export const SCOPES = ['own', 'team', 'all'] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_RANK: Record<Scope, number> = { own: 1, team: 2, all: 3 };

export interface PermissionDef {
  key: string;
  description: string;
}

const recordResource = (resource: string, label: string, actions: readonly RecordAction[] = RECORD_ACTIONS) =>
  actions.map((a) => ({ key: `core.${resource}.${a}`, description: `${capitalize(a)} ${label}` }));

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Permissions owned by core. Modules contribute their own through manifests. */
export const CORE_PERMISSIONS: PermissionDef[] = [
  ...recordResource('contacts', 'contacts'),
  ...recordResource('organizations', 'organizations'),
  ...recordResource('leads', 'leads'),
  ...recordResource('deals', 'deals'),
  ...recordResource('activities', 'activities', ['view', 'create', 'update', 'delete', 'export', 'bulk']),
  { key: 'core.tags.view', description: 'View tags' },
  { key: 'core.tags.manage', description: 'Create, rename and delete tags' },
  { key: 'core.files.view', description: 'View files' },
  { key: 'core.files.create', description: 'Upload files' },
  { key: 'core.files.delete', description: 'Delete files' },
  { key: 'core.dashboard.view', description: 'View dashboards' },
  { key: 'core.dashboard.manage', description: 'Edit shared dashboards' },
  { key: 'core.saved_views.share', description: 'Share saved views with everyone' },
  { key: 'core.settings.manage', description: 'Manage general settings' },
  { key: 'core.branding.manage', description: 'Manage branding' },
  { key: 'core.users.manage', description: 'Manage users and teams' },
  { key: 'core.roles.manage', description: 'Manage roles and permissions' },
  { key: 'core.fields.manage', description: 'Manage custom fields and layouts' },
  { key: 'core.pipelines.manage', description: 'Manage pipelines and stages' },
  { key: 'core.labels.manage', description: 'Manage vocabulary' },
  { key: 'core.audit.view', description: 'View the audit log' },
  { key: 'core.blueprints.manage', description: 'Apply and export blueprints' },
  { key: 'core.modules.manage', description: 'Enable and disable modules' },
  { key: 'core.privacy.manage', description: 'Anonymize and hard-delete records' },
  { key: 'core.templates.manage', description: 'Manage templates' },
  { key: 'core.automations.manage', description: 'Manage workflow automations' },
  { key: 'core.webhooks.manage', description: 'Manage webhooks' },
  { key: 'core.api_keys.manage', description: 'Manage API keys' },
  { key: 'core.forms.manage', description: 'Manage web forms' },
  { key: 'core.email.use', description: 'Send and sync email' },
  { key: 'core.email.manage', description: 'Manage mail accounts' },
];

/** Resources that support record scope (own/team/all). */
export const SCOPED_RESOURCES = [
  'core.contacts',
  'core.organizations',
  'core.leads',
  'core.deals',
  'core.activities',
] as const;

/** Does a granted pattern cover a required permission key? */
export function patternMatches(pattern: string, key: string): boolean {
  if (pattern === '*') return true;
  if (pattern === key) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return key.startsWith(prefix);
  }
  return false;
}

export function hasPermission(patterns: readonly string[], key: string): boolean {
  return patterns.some((p) => patternMatches(p, key));
}

export const PERMISSION_KEY_RE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
export const PERMISSION_PATTERN_RE = /^(\*|[a-z][a-z0-9-]*\.(\*|[a-z][a-z0-9_]*\.(\*|[a-z][a-z0-9_]*)))$/;
