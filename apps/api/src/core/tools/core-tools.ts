import { z } from 'zod';
import { ACTIVITY_TYPES, RELATED_TYPES, entityKeySchema, listQuerySchema } from '@app/shared';
import { defineTool } from './registry';
import { customizableEntities, getRecordDef, recordDefs } from '../records/registry';
import { createRecord, getRecord, getRow, listRecords, updateRecord } from '../records/service';
import { recordTimeline } from '../timeline/timeline.service';
import { searchRecords } from '../search/search.routes';
import { listPipelines } from '../pipelines/pipelines.repository';
import { can, assertCan } from '../rbac/access';
import { getLabels } from '../labels/labels.service';
import { fieldLevel, getDefinitions } from '../custom-fields/definitions';
import { getGroup } from '../settings/settings.service';

const entity = entityKeySchema.describe(
  'Record type key from describe_schema, e.g. "contact", "organization", "deal", "lead" or "activity"',
);
const uuid = z.uuid().describe('Record id (uuid)');
const data = z
  .record(z.string(), z.unknown())
  .describe('Field values, keyed as in describe_schema. Custom fields go under "custom".');

/** Record types the user may view, for every tool that takes an `entity`. */
function viewable(user: Parameters<typeof can>[0], key: string) {
  const def = getRecordDef(key);
  assertCan(user, `${def.resource}.view`);
  return def;
}

defineTool({
  name: 'describe_schema',
  title: 'Describe the data',
  description:
    'Lists the record types this person can see, with their names in this workspace, their fields (custom fields included, hidden ones left out) and the pipelines and stages for deals and leads. Call this first.',
  write: false,
  input: z.object({}),
  async handler(_input, { user }) {
    const labels = await getLabels('en');
    const { leads } = await getGroup('features');
    const types = [];
    for (const key of customizableEntities()) {
      if (key === 'lead' && !leads) continue;
      const def = getRecordDef(key);
      if (!can(user, `${def.resource}.view`)) continue;
      const custom = (await getDefinitions(key))
        .filter((d) => fieldLevel(d, user) !== 'hidden')
        .map((d) => ({
          key: d.key,
          label: d.label,
          type: d.type,
          ...(d.options.length ? { options: d.options.map((o) => o.key) } : {}),
          editable: fieldLevel(d, user) === 'write',
        }));
      types.push({
        entity: key,
        singular: labels[key]?.singular ?? key,
        plural: labels[key]?.plural ?? key,
        fields: Object.entries(def.fields).map(([k, f]) => ({
          key: k,
          kind: f.kind,
          filterable: !!f.filterable,
        })),
        inputFields: Object.keys((def.createSchema as z.ZodObject).shape ?? {}),
        customFields: custom,
        permissions: ['view', 'create', 'update', 'delete'].filter((a) => can(user, `${def.resource}.${a}`)),
      });
    }
    return { recordTypes: types };
  },
});

defineTool({
  name: 'search_records',
  title: 'Search records',
  description: 'Full-text search across every record type the person can see. Returns ids, titles and types.',
  write: false,
  input: z.object({
    query: z.string().trim().min(1).max(200),
    types: z.array(entityKeySchema).max(20).optional().describe('Limit to these record types'),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  async handler(input, { user }) {
    return {
      results: await searchRecords(user, {
        q: input.query,
        types: input.types?.join(','),
        limit: input.limit,
      }),
    };
  },
});

defineTool({
  name: 'list_records',
  title: 'List records',
  description:
    'Lists records of one type with optional text search, filters and sort. Filters use the filter syntax {"and":[{"field":"owner","op":"eq","value":"@me"}]}; sort is a field key, "-" for descending.',
  write: false,
  input: z.object({
    entity,
    q: z.string().max(200).optional(),
    filter: z.unknown().optional(),
    sort: z.string().max(100).optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(25),
  }),
  async handler(input, { user }) {
    const def = viewable(user, input.entity);
    const query = listQuerySchema.parse({
      page: input.page,
      pageSize: input.pageSize,
      q: input.q,
      sort: input.sort,
      filter: input.filter === undefined ? undefined : JSON.stringify(input.filter),
    });
    return listRecords(def, user, query);
  },
});

defineTool({
  name: 'get_record',
  title: 'Get a record',
  description: 'Reads one record by type and id, with every field the person can see.',
  write: false,
  input: z.object({ entity, uuid }),
  async handler(input, { ctx, user }) {
    return getRecord(viewable(user, input.entity), user, input.uuid, ctx);
  },
});

defineTool({
  name: 'get_timeline',
  title: 'Get a record timeline',
  description: 'Recent history of a record: notes, tasks, calls, emails and changes, newest first.',
  write: false,
  input: z.object({ entity, uuid, limit: z.number().int().min(1).max(100).default(30) }),
  async handler(input, { user }) {
    const def = viewable(user, input.entity);
    const row = await getRow(def, user, input.uuid);
    return recordTimeline(def.entity, row, user, { limit: input.limit });
  },
});

defineTool({
  name: 'list_pipelines',
  title: 'List pipelines',
  description: 'Pipelines and their stages (ids, names, probability, won/lost), for deals and leads.',
  write: false,
  input: z.object({}),
  async handler(_input, { user }) {
    assertCan(user, `${recordDefs.deal.resource}.view`);
    return { pipelines: await listPipelines() };
  },
});

defineTool({
  name: 'create_record',
  title: 'Create a record',
  description: 'Creates a record of one type. Use describe_schema for the input fields.',
  write: true,
  input: z.object({ entity, data }),
  async handler(input, { ctx, user }) {
    return createRecord(getRecordDef(input.entity), ctx, user, input.data);
  },
});

defineTool({
  name: 'update_record',
  title: 'Update a record',
  description: 'Changes some fields of a record. Fields left out stay as they are.',
  write: true,
  input: z.object({ entity, uuid, data }),
  async handler(input, { ctx, user }) {
    return updateRecord(getRecordDef(input.entity), ctx, user, input.uuid, input.data);
  },
});

const related = z
  .object({ type: z.enum(RELATED_TYPES), uuid })
  .describe('The contact, organization, deal or lead it belongs to');

defineTool({
  name: 'add_note',
  title: 'Add a note',
  description:
    'Adds a note to a record (record type keys contact, organization, deal or lead; their names in this workspace come from describe_schema).',
  write: true,
  input: z.object({ related, body: z.string().min(1).max(20_000).describe('Plain text or simple HTML') }),
  async handler(input, { ctx, user }) {
    return createRecord(recordDefs.activity, ctx, user, {
      type: 'note',
      body: input.body,
      related: input.related,
    });
  },
});

defineTool({
  name: 'create_task',
  title: 'Create a task',
  description:
    'Creates a task, optionally due at a time and linked to a record. It is assigned to the person.',
  write: true,
  input: z.object({
    subject: z.string().trim().min(1).max(255),
    dueAt: z.iso.datetime({ offset: true }).optional(),
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
    related: related.optional(),
  }),
  async handler(input, { ctx, user }) {
    return createRecord(recordDefs.activity, ctx, user, { type: 'task', ...input });
  },
});

defineTool({
  name: 'log_activity',
  title: 'Log an activity',
  description: 'Records a call, meeting or email that already happened, linked to a record.',
  write: true,
  input: z.object({
    type: z.enum(ACTIVITY_TYPES.filter((t) => t !== 'task' && t !== 'note') as ['call', 'meeting', 'email']),
    subject: z.string().trim().min(1).max(255),
    body: z.string().max(20_000).optional(),
    outcome: z.string().max(100).optional(),
    related,
  }),
  async handler(input, { ctx, user }) {
    return createRecord(recordDefs.activity, ctx, user, { ...input, completed: true });
  },
});

defineTool({
  name: 'move_deal_stage',
  title: 'Move to another stage',
  description: 'Moves a deal to another stage of its pipeline (stage ids come from list_pipelines).',
  write: true,
  input: z.object({ dealUuid: uuid, stageUuid: z.uuid() }),
  async handler(input, { ctx, user }) {
    return updateRecord(recordDefs.deal, ctx, user, input.dealUuid, { stageUuid: input.stageUuid });
  },
});
