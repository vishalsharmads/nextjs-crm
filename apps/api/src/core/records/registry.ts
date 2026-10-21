import type { CoreEntity } from '@app/shared';
import type { ResourceDef } from './types';
import { contactsDef } from '../contacts/contacts.def';
import { organizationsDef } from '../organizations/organizations.def';
import { leadsDef } from '../leads/leads.def';
import { dealsDef } from '../deals/deals.def';
import { activitiesDef } from '../activities/activities.def';

export const recordDefs: Record<CoreEntity, ResourceDef> = {
  contact: contactsDef as ResourceDef,
  organization: organizationsDef as ResourceDef,
  lead: leadsDef as ResourceDef,
  deal: dealsDef as ResourceDef,
  activity: activitiesDef as ResourceDef,
};
