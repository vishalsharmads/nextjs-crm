import type { CoreEntity, MergeFieldGroup } from '@app/shared';
import type { AuthUser } from '../../http/context';
import { can } from '../rbac/access';
import { getDefinitions, fieldLevel } from '../custom-fields/definitions';
import { getLabels } from '../labels/labels.service';

type MergeEntity = Exclude<CoreEntity, 'activity'>;

/** Record fields a template can use, by the DTO property the value comes from. */
const CORE_FIELDS: Record<MergeEntity, [path: string, label: string][]> = {
  contact: [
    ['firstName', 'First name'],
    ['lastName', 'Last name'],
    ['fullName', 'Full name'],
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['jobTitle', 'Job title'],
  ],
  lead: [
    ['firstName', 'First name'],
    ['lastName', 'Last name'],
    ['fullName', 'Full name'],
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['companyName', 'Company'],
    ['jobTitle', 'Job title'],
  ],
  organization: [
    ['name', 'Name'],
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['website', 'Website'],
    ['addressLine1', 'Address line 1'],
    ['addressLine2', 'Address line 2'],
    ['city', 'City'],
    ['region', 'Region'],
    ['postalCode', 'Postal code'],
    ['country', 'Country'],
  ],
  deal: [
    ['title', 'Title'],
    ['reference', 'Reference'],
    ['value', 'Value'],
    ['currency', 'Currency'],
    ['expectedClose', 'Expected close'],
    ['stage.name', 'Stage'],
  ],
};

/**
 * Fields a template author can insert as `{{path}}`. Custom fields the user cannot see are left
 * out, and so are special-category fields, which only ever render as a mask.
 */
export async function mergeFieldGroups(
  user: AuthUser,
  entities: MergeEntity[] = ['contact', 'organization', 'deal', 'lead'],
): Promise<MergeFieldGroup[]> {
  const labels = await getLabels('en');
  const groups: MergeFieldGroup[] = [];
  for (const entity of entities) {
    if (!can(user, `core.${entity === 'organization' ? 'organizations' : `${entity}s`}.view`)) continue;
    const defs = await getDefinitions(entity);
    groups.push({
      key: entity,
      label: labels[entity]?.singular ?? entity,
      fields: [
        ...CORE_FIELDS[entity].map(([path, label]) => ({
          path: `${entity}.${path}`,
          // A lead's company is an organization in the workspace's own words.
          label: path === 'companyName' ? (labels.organization?.singular ?? label) : label,
        })),
        ...defs
          .filter((d) => d.sensitivity !== 'special' && fieldLevel(d, user) !== 'hidden')
          .map((d) => ({ path: `${entity}.custom.${d.key}`, label: d.label })),
      ],
    });
  }
  groups.push({
    key: 'user',
    label: 'You',
    fields: [
      { path: 'user.firstName', label: 'First name' },
      { path: 'user.lastName', label: 'Last name' },
      { path: 'user.name', label: 'Full name' },
      { path: 'user.email', label: 'Email' },
    ],
  });
  groups.push({
    key: 'general',
    label: 'General',
    fields: [
      { path: 'branding.appName', label: 'Workspace name' },
      { path: 'today', label: "Today's date" },
    ],
  });
  return groups;
}
