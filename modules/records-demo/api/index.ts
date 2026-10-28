import { defineRecordType, type ApiModule } from '@app/api/module-api';
import * as m0001 from './migrations/0001_items';

/**
 * Items: a record type on the shared records engine. It gets list, detail, create, edit,
 * delete and restore, custom fields, saved views, search, import/export, bulk actions, trash,
 * automations, audit and own/team/all scope without further code.
 * Add columns here and in a new migration (committed migrations are immutable).
 */
export const demoItemType = defineRecordType({
  moduleKey: 'records-demo',
  entity: 'demo_item',
  route: 'items',
  table: 'm_records_demo_items',
  resource: 'records-demo.items',
  labels: { singular: 'Item', plural: 'Items' },
  titleColumn: 'name',
  columns: [
    { key: 'name', label: 'Name', kind: 'text', required: true, max: 200, searchable: true },
    {
      key: 'status',
      label: 'Status',
      kind: 'select',
      options: [
        { value: 'active', label: 'Active' },
        { value: 'inactive', label: 'Inactive' },
      ],
    },
    { key: 'value', label: 'Value', kind: 'money', currency: 'USD' },
    { key: 'dueOn', label: 'Due on', kind: 'date' },
    { key: 'organization', label: 'Organization', kind: 'relation', relation: 'organization' },
    { key: 'notes', label: 'Notes', kind: 'textarea' },
  ],
  defaultColumns: ['name', 'status', 'owner', 'updated_at'],
});

export const recordsDemo: ApiModule = {
  migrations: { '0001_items': m0001 },
  recordTypes: [demoItemType],
};
