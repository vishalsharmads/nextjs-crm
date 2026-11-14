import { z } from 'zod';
import {
  ACTIVITY_TYPES,
  RELATED_TYPES,
  entityKeySchema,
  listQuerySchema,
  recurrenceSchema,
  reportDefinitionSchema,
} from '@app/shared';
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
import { runReport } from '../reports/builder';
import { runBulk } from '../bulk/bulk.service';
import { searchText, textSearchSchema } from '../search/text-search';
import { addComment, listComments } from '../activities/comments';
import { addChecklistItem, listChecklist } from '../activities/checklist';

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
  async handler(input, { user, ctx }) {
    const def = viewable(user, input.entity);
    const row = await getRow(def, user, input.uuid);
    return recordTimeline(def.entity, row, user, { limit: input.limit }, ctx);
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

const taskFields = {
  dueAt: z.iso.datetime({ offset: true }).nullish().describe('When it is due (ISO 8601 with offset)'),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  assigneeUuid: z.uuid().nullish().describe('Person to assign (user id); defaults to the caller'),
  reminderAt: z.iso
    .datetime({ offset: true })
    .nullish()
    .describe('When to remind the assignee, usually some time before dueAt'),
  recurrence: recurrenceSchema
    .nullish()
    .describe(
      'Repeat rule, e.g. {"freq":"weekly","byWeekday":[1]} for every Monday. Completing it creates the next one. null stops repeating.',
    ),
};

defineTool({
  name: 'create_task',
  title: 'Create a task',
  description:
    'Creates a task, optionally due at a time, linked to a record, with a reminder, a repeat rule and checklist items. It is assigned to the person unless assigneeUuid says otherwise.',
  write: true,
  input: z.object({
    subject: z.string().trim().min(1).max(255),
    ...taskFields,
    related: related.optional(),
    checklist: z
      .array(z.string().trim().min(1).max(500))
      .max(50)
      .optional()
      .describe('Checklist items, in order'),
  }),
  async handler({ checklist, ...input }, { ctx, user }) {
    const task = (await createRecord(recordDefs.activity, ctx, user, { type: 'task', ...input })) as {
      uuid: string;
    };
    for (const label of checklist ?? []) await addChecklistItem(ctx, user, task.uuid, label);
    return checklist?.length ? getRecord(recordDefs.activity, user, task.uuid) : task;
  },
});

defineTool({
  name: 'update_task',
  title: 'Change a task',
  description:
    'Changes a task, call or meeting: subject, due date, priority, assignee, reminder, repeat rule or status (stageUuid, when task statuses are on; stage ids come from list_pipelines).',
  write: true,
  input: z.object({
    uuid,
    subject: z.string().trim().min(1).max(255).optional(),
    ...taskFields,
    stageUuid: z.uuid().optional(),
  }),
  async handler({ uuid: id, ...input }, { ctx, user }) {
    return updateRecord(recordDefs.activity, ctx, user, id, input);
  },
});

defineTool({
  name: 'get_task',
  title: 'Read a task',
  description: 'Returns a task with its checklist and comments.',
  write: false,
  input: z.object({ uuid }),
  async handler(input, { ctx, user }) {
    const task = await getRecord(recordDefs.activity, user, input.uuid, ctx);
    const [checklist, comments] = await Promise.all([
      listChecklist(user, input.uuid),
      listComments(user, input.uuid),
    ]);
    return { ...(task as object), checklistItems: checklist, comments };
  },
});

defineTool({
  name: 'add_task_comment',
  title: 'Comment on a task',
  description:
    'Adds a comment to a task. Mention people by user id to notify them; only people who can see the task are notified.',
  write: true,
  input: z.object({
    uuid,
    body: z.string().trim().min(1).max(20_000).describe('Plain text or simple HTML'),
    mentions: z.array(z.uuid()).max(20).default([]),
  }),
  async handler(input, { ctx, user }) {
    assertCan(user, 'core.activities.update');
    return addComment(ctx, user, input.uuid, { body: input.body, mentions: input.mentions });
  },
});

defineTool({
  name: 'add_checklist_item',
  title: 'Add a checklist item',
  description: 'Adds an item to the end of a task’s checklist.',
  write: true,
  input: z.object({ uuid, label: z.string().trim().min(1).max(500) }),
  async handler(input, { ctx, user }) {
    assertCan(user, 'core.activities.update');
    return addChecklistItem(ctx, user, input.uuid, input.label);
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

defineTool({
  name: 'run_report',
  title: 'Run a report',
  description:
    'Counts, sums or averages records of one type, grouped by a field: for example deals by stage (count), deal value by owner (sum of "value"), or contacts created per month (groupBy "created_at", dateBucket "month"). Optional second grouping and filter (the list filter syntax). Use this for any number, total or chart instead of adding up listed records. Results respect what this person may see.',
  write: false,
  input: reportDefinitionSchema.omit({ chart: true }),
  async handler(input, { user }) {
    // The same permission as the report builder, plus viewing the record type.
    assertCan(user, 'core.reports.view');
    viewable(user, input.entity);
    return runReport(input, user);
  },
});

defineTool({
  name: 'complete_task',
  title: 'Complete a task',
  description: 'Marks a task as done (or not done again with completed false).',
  write: true,
  input: z.object({ uuid, completed: z.boolean().default(true) }),
  async handler(input, { ctx, user }) {
    return updateRecord(recordDefs.activity, ctx, user, input.uuid, { completed: input.completed });
  },
});

defineTool({
  name: 'change_records',
  title: 'Change several records',
  description:
    'Changes up to 50 records of one type at once: assign an owner (ownerUuid), add or remove tags (tags), set one field (field and value) or move deals or leads to a stage (stageUuid). Never deletes.',
  write: true,
  input: z.object({
    entity,
    uuids: z.array(z.uuid()).min(1).max(50),
    action: z.enum(['assign', 'add_tags', 'remove_tags', 'update_field', 'move_stage']),
    ownerUuid: z.uuid().optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
    field: z.string().max(80).optional(),
    value: z.unknown().optional(),
    stageUuid: z.uuid().optional(),
  }),
  async handler({ entity: key, ...input }, { ctx, user }) {
    return runBulk(getRecordDef(key), ctx, user, input);
  },
});

defineTool({
  name: 'search_text',
  title: 'Search notes and emails',
  description:
    'Full-text search over what people wrote: notes, emails, calls, meetings and tasks (subject and text) and comments on them, ranked by relevance. Use it for "what did we discuss / agree / promise", quotes, or anything in conversation history. Each hit gives a snippet, the kind, the date and the record it belongs to. Quote a phrase for exact words; narrow by kind, by one record or by date.',
  write: false,
  input: textSearchSchema,
  async handler(input, { ctx, user }) {
    return searchText(user, ctx, input);
  },
});
