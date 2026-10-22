import { z } from 'zod';
import { formatDocNumber, toPatch } from '@app/shared';
import {
  AppError,
  applyScope,
  assertCan,
  audit,
  db,
  defineRoutes,
  emit,
  escapeLike,
  iso,
  linkRefs,
  newUuid,
  nextDocNumber,
  notFound,
  notify,
  registerModuleWidget,
  resolveLinks,
  scopeAllows,
  userIdFromRef,
  userRefs,
  type ApiModule,
  type AuthUser,
  type Db,
  type Knex,
  type RequestContext,
} from '@app/api/module-api';
import * as m0001 from './migrations/0001_tickets';

const TICKETS = 'm_tickets_tickets';
const COMMENTS = 'm_tickets_comments';
const RESOURCE = 'tickets.tickets';
const OWNER_COLUMNS = ['assignee_id', 'created_by'];
const OPEN = ['open', 'pending'];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
type Priority = (typeof PRIORITIES)[number];

/** Response and resolution targets (hours) per priority. */
const TARGETS: Record<Priority, { respond: number; resolve: number }> = {
  urgent: { respond: 4, resolve: 24 },
  high: { respond: 8, resolve: 48 },
  normal: { respond: 24, resolve: 72 },
  low: { respond: 48, resolve: 120 },
};

const dueDates = (from: Date, priority: Priority) => ({
  first_response_due_at: new Date(from.getTime() + TARGETS[priority].respond * 3_600_000),
  resolve_due_at: new Date(from.getTime() + TARGETS[priority].resolve * 3_600_000),
});

const ticketBody = z.object({
  subject: z.string().trim().min(1).max(250),
  description: z.string().max(20000).nullish(),
  priority: z.enum(PRIORITIES).default('normal'),
  category: z.string().trim().max(100).default(''),
  channel: z.enum(['staff', 'email', 'phone']).default('staff'),
  contactUuid: z.uuid().nullish(),
  organizationUuid: z.uuid().nullish(),
  assigneeUuid: z.string().max(36).nullish(),
});

const ticketPatch = toPatch(ticketBody.omit({ channel: true })).extend({
  status: z.enum(['open', 'pending', 'resolved', 'closed']).optional(),
});

async function toDtos(rows: Record<string, unknown>[]) {
  const now = new Date();
  const [refs, users] = await Promise.all([
    linkRefs(rows),
    userRefs(rows.flatMap((r) => [r.assignee_id as number | null, r.created_by as number | null])),
  ]);
  return rows.map((r) => {
    const open = OPEN.includes(r.status as string);
    const respondDue = r.first_response_due_at ? new Date(r.first_response_due_at as string) : null;
    const resolveDue = r.resolve_due_at ? new Date(r.resolve_due_at as string) : null;
    const { contact, organization } = refs(r);
    return {
      uuid: r.uuid as string,
      number: r.number as string,
      subject: r.subject as string,
      description: (r.description as string | null) ?? null,
      status: r.status as string,
      priority: r.priority as Priority,
      category: r.category as string,
      channel: r.channel as string,
      contact,
      organization,
      assignee: users.get(r.assignee_id as number) ?? null,
      createdBy: users.get(r.created_by as number) ?? null,
      firstResponseDueAt: iso(r.first_response_due_at),
      resolveDueAt: iso(r.resolve_due_at),
      firstRespondedAt: iso(r.first_responded_at),
      resolvedAt: iso(r.resolved_at),
      responseOverdue: open && !r.first_responded_at && !!respondDue && respondDue < now,
      resolutionOverdue: open && !!resolveDue && resolveDue < now,
      lastActivityAt: iso(r.last_activity_at)!,
      createdAt: iso(r.created_at)!,
    };
  });
}

async function comments(ticketId: number, includeInternal: boolean) {
  const qb = db(`${COMMENTS} as m`)
    .leftJoin('contacts as c', 'c.id', 'm.author_contact_id')
    .where('m.ticket_id', ticketId)
    .orderBy('m.created_at')
    .select('m.*', 'c.full_name as contact_name');
  if (!includeInternal) qb.where('m.internal', false);
  const rows = await qb;
  const users = await userRefs(rows.map((r) => r.author_id as number | null));
  return rows.map((r) => ({
    uuid: r.uuid as string,
    body: r.body as string,
    internal: !!r.internal,
    fromCustomer: !!r.author_contact_id,
    author: r.author_contact_id
      ? { name: (r.contact_name as string | null) ?? 'Customer' }
      : (users.get(r.author_id as number) ?? null),
    createdAt: iso(r.created_at)!,
  }));
}

async function getScoped(user: AuthUser, uuid: string, conn: Db = db, forUpdate = false) {
  const qb = conn(TICKETS).where({ uuid }).whereNull('deleted_at');
  await applyScope(qb, user, RESOURCE, OWNER_COLUMNS, conn);
  if (forUpdate) qb.forUpdate();
  const row = await qb.first();
  if (!row) throw notFound('Ticket');
  return row as Record<string, unknown> & { id: number; uuid: string };
}

async function assigneeFor(user: AuthUser, ref: string | null | undefined, conn: Db) {
  const id = await userIdFromRef(ref, user, conn);
  if (id === undefined || id === null) return id;
  if (id !== user.id && !(await scopeAllows(user, RESOURCE, [id], conn)))
    throw new AppError('FORBIDDEN', 'You can only assign tickets within your own access');
  return id;
}

type TicketEvent =
  'ticket.created' | 'ticket.updated' | 'ticket.replied' | 'ticket.resolved' | 'ticket.deleted';
async function emitTicket(type: TicketEvent, uuid: string, actorId: number | null) {
  const [record] = await toDtos([await db(TICKETS).where({ uuid }).first()]);
  await emit({ type, entity: 'ticket', uuid, record: record as unknown as Record<string, unknown>, actorId });
}

/** Create a ticket (staff or portal). Returns its uuid. */
async function insertTicket(
  trx: Db,
  ctx: RequestContext,
  data: {
    subject: string;
    description: string | null;
    priority: Priority;
    category: string;
    channel: string;
    contact_id: number | null;
    organization_id: number | null;
    assignee_id: number | null;
    created_by: number | null;
  },
) {
  const uuid = newUuid();
  const now = new Date();
  const n = await nextDocNumber(trx, 'ticket');
  const [id] = await trx(TICKETS).insert({
    uuid,
    number: formatDocNumber('T-', n, 5),
    ...data,
    ...dueDates(now, data.priority),
    last_activity_at: now,
  });
  await audit(trx, ctx, {
    action: 'tickets.ticket.created',
    entity: 'tickets.ticket',
    entityId: id,
    entityUuid: uuid,
    diff: { subject: data.subject, priority: data.priority, channel: data.channel },
  });
  return uuid;
}

const uuidParam = z.object({ uuid: z.uuid() });

const routes = defineRoutes('/m/tickets/tickets', ['tickets'], 'tickets')
  .add({
    method: 'get',
    path: '/',
    permission: 'tickets.tickets.view',
    query: z.object({
      q: z.string().max(100).optional(),
      status: z.enum(['open', 'pending', 'resolved', 'closed', 'active']).optional(),
      priority: z.enum(PRIORITIES).optional(),
      assignee: z.string().max(36).optional(),
      contactUuid: z.uuid().optional(),
      organizationUuid: z.uuid().optional(),
      overdue: z.enum(['true']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }),
    summary: '`status=active` means open or pending; `assignee=@me` or `assignee=none`.',
    handler: async ({ user, query }) => {
      const qb = db(TICKETS).whereNull('deleted_at');
      await applyScope(qb, user, RESOURCE, OWNER_COLUMNS);
      if (query.status === 'active') qb.whereIn('status', OPEN);
      else if (query.status) qb.where({ status: query.status });
      if (query.priority) qb.where({ priority: query.priority });
      if (query.assignee === 'none') qb.whereNull('assignee_id');
      else if (query.assignee) qb.where({ assignee_id: await userIdFromRef(query.assignee, user) });
      if (query.contactUuid)
        qb.whereIn('contact_id', db('contacts').where({ uuid: query.contactUuid }).select('id'));
      if (query.organizationUuid)
        qb.whereIn(
          'organization_id',
          db('organizations').where({ uuid: query.organizationUuid }).select('id'),
        );
      if (query.overdue) {
        const now = new Date();
        qb.whereIn('status', OPEN).where((w) =>
          w
            .where('resolve_due_at', '<', now)
            .orWhere((x) => x.whereNull('first_responded_at').where('first_response_due_at', '<', now)),
        );
      }
      if (query.q) {
        const like = `%${escapeLike(query.q)}%`;
        qb.where((w) => w.where('number', 'like', like).orWhere('subject', 'like', like));
      }
      const total = Number(((await qb.clone().count({ c: '*' }).first()) as { c: number }).c);
      // Most urgent first, then most recently active.
      const rows = await qb
        .orderByRaw("FIELD(priority, 'urgent', 'high', 'normal', 'low')")
        .orderBy('last_activity_at', 'desc')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      return { data: await toDtos(rows), meta: { page: query.page, pageSize: query.pageSize, total } };
    },
  })
  .add({
    method: 'get',
    path: '/:uuid',
    permission: 'tickets.tickets.view',
    params: uuidParam,
    handler: async ({ user, params }) => {
      const row = await getScoped(user, params.uuid);
      const [dto] = await toDtos([row]);
      return { ...dto, comments: await comments(row.id, true) };
    },
  })
  .add({
    method: 'post',
    path: '/',
    permission: 'tickets.tickets.create',
    body: ticketBody,
    status: 201,
    handler: async ({ ctx, user, body }) => {
      const uuid = await db.transaction(async (trx) => {
        const links = await resolveLinks(user, body, trx);
        const assignee = await assigneeFor(user, body.assigneeUuid, trx);
        return insertTicket(trx, ctx, {
          subject: body.subject,
          description: body.description ?? null,
          priority: body.priority,
          category: body.category,
          channel: body.channel,
          contact_id: links.contact_id ?? null,
          organization_id: links.organization_id ?? null,
          assignee_id: assignee ?? null,
          created_by: user.id,
        });
      });
      await emitTicket('ticket.created', uuid, user.id);
      const [dto] = await toDtos([await db(TICKETS).where({ uuid }).first()]);
      return dto;
    },
  })
  .add({
    method: 'patch',
    path: '/:uuid',
    permission: 'tickets.tickets.update',
    params: uuidParam,
    body: ticketPatch,
    handler: async ({ ctx, user, params, body }) => {
      let resolved = false;
      let assignedTo: number | null = null;
      await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        const patch: Record<string, unknown> = { ...(await resolveLinks(user, body, trx)) };
        if (body.subject !== undefined) patch.subject = body.subject;
        if (body.description !== undefined) patch.description = body.description;
        if (body.category !== undefined) patch.category = body.category;
        if (body.priority !== undefined && body.priority !== row.priority) {
          patch.priority = body.priority;
          // Targets restart from creation with the new priority.
          Object.assign(patch, dueDates(new Date(row.created_at as string), body.priority));
        }
        const assignee = await assigneeFor(user, body.assigneeUuid, trx);
        if (assignee !== undefined && assignee !== row.assignee_id) {
          patch.assignee_id = assignee;
          if (assignee && assignee !== user.id) assignedTo = assignee;
        }
        if (body.status !== undefined && body.status !== row.status) {
          patch.status = body.status;
          if (body.status === 'resolved' || body.status === 'closed') {
            patch.resolved_at = row.resolved_at ?? new Date();
            resolved = body.status === 'resolved';
          } else patch.resolved_at = null;
        }
        await trx(TICKETS)
          .where({ id: row.id })
          .update({ ...patch, updated_at: new Date(), last_activity_at: new Date() });
        await audit(trx, ctx, {
          action: 'tickets.ticket.updated',
          entity: 'tickets.ticket',
          entityId: row.id,
          entityUuid: params.uuid,
          diff: body,
        });
      });
      if (assignedTo) {
        const row = await db(TICKETS).where({ uuid: params.uuid }).first('number', 'subject');
        await notify(assignedTo, {
          type: 'ticket.assigned',
          title: `${row.number} was assigned to you`,
          body: row.subject,
          link: `/m/tickets/${params.uuid}`,
          email: true,
        });
      }
      await emitTicket(resolved ? 'ticket.resolved' : 'ticket.updated', params.uuid, user.id);
      const [dto] = await toDtos([await db(TICKETS).where({ uuid: params.uuid }).first()]);
      return dto;
    },
  })
  .add({
    method: 'post',
    path: '/:uuid/comments',
    permission: 'tickets.tickets.update',
    params: uuidParam,
    body: z.object({
      body: z.string().trim().min(1).max(20000),
      internal: z.boolean().default(false),
      status: z.enum(['open', 'pending', 'resolved', 'closed']).optional(),
    }),
    status: 201,
    summary:
      'Reply (visible to the customer in the portal) or add an internal note. Optionally change status.',
    handler: async ({ ctx, user, params, body }) => {
      await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        const uuid = newUuid();
        const [id] = await trx(COMMENTS).insert({
          uuid,
          ticket_id: row.id,
          author_id: user.id,
          body: body.body,
          internal: body.internal,
        });
        const patch: Record<string, unknown> = { last_activity_at: new Date(), updated_at: new Date() };
        if (!body.internal && !row.first_responded_at) patch.first_responded_at = new Date();
        if (body.status && body.status !== row.status) {
          patch.status = body.status;
          patch.resolved_at = body.status === 'resolved' || body.status === 'closed' ? new Date() : null;
        }
        await trx(TICKETS).where({ id: row.id }).update(patch);
        await audit(trx, ctx, {
          action: body.internal ? 'tickets.note.added' : 'tickets.reply.added',
          entity: 'tickets.comment',
          entityId: id,
          entityUuid: uuid,
          diff: { ticket: row.number, status: body.status },
        });
      });
      if (!body.internal) await emitTicket('ticket.replied', params.uuid, user.id);
      if (body.status === 'resolved') await emitTicket('ticket.resolved', params.uuid, user.id);
      const row = await getScoped(user, params.uuid);
      const [dto] = await toDtos([row]);
      return { ...dto, comments: await comments(row.id, true) };
    },
  })
  .add({
    method: 'delete',
    path: '/:uuid',
    permission: 'tickets.tickets.delete',
    params: uuidParam,
    handler: async ({ ctx, user, params }) => {
      await db.transaction(async (trx) => {
        const row = await getScoped(user, params.uuid, trx, true);
        await trx(TICKETS).where({ id: row.id }).update({ deleted_at: new Date() });
        await audit(trx, ctx, {
          action: 'tickets.ticket.deleted',
          entity: 'tickets.ticket',
          entityId: row.id,
          entityUuid: params.uuid,
        });
      });
      await emitTicket('ticket.deleted', params.uuid, user.id);
    },
  });

registerModuleWidget('tickets.open_count', async (_params, user) => {
  assertCan(user, 'tickets.tickets.view');
  const now = new Date();
  const qb = db(TICKETS).whereNull('deleted_at').whereIn('status', OPEN);
  await applyScope(qb, user, RESOURCE, OWNER_COLUMNS);
  const rows = await qb.select(
    'assignee_id',
    'priority',
    'resolve_due_at',
    'first_response_due_at',
    'first_responded_at',
  );
  return {
    open: rows.length,
    mine: rows.filter((r) => r.assignee_id === user.id).length,
    unassigned: rows.filter((r) => !r.assignee_id).length,
    urgent: rows.filter((r) => r.priority === 'urgent').length,
    overdue: rows.filter(
      (r) =>
        (r.resolve_due_at && new Date(r.resolve_due_at) < now) ||
        (!r.first_responded_at && r.first_response_due_at && new Date(r.first_response_due_at) < now),
    ).length,
  };
});

// ---------- For the client portal ----------

type Match = (qb: Knex.QueryBuilder) => void;

/** Tickets a customer may see, without internal fields; with public comments for one ticket. */
export async function customerTickets(match: Match, uuid?: string) {
  const qb = db(TICKETS).whereNull('deleted_at');
  match(qb);
  if (uuid) qb.where({ uuid });
  const rows = await qb.orderBy('last_activity_at', 'desc').limit(uuid ? 1 : 100);
  const out = [];
  for (const r of rows) {
    out.push({
      uuid: r.uuid as string,
      number: r.number as string,
      subject: r.subject as string,
      status: r.status as string,
      createdAt: iso(r.created_at)!,
      lastActivityAt: iso(r.last_activity_at)!,
      ...(uuid
        ? {
            description: (r.description as string | null) ?? null,
            comments: await comments(r.id as number, false),
          }
        : {}),
    });
  }
  return out;
}

export async function createTicketAsCustomer(
  ctx: RequestContext,
  contactId: number,
  input: { subject: string; description: string },
) {
  const uuid = await db.transaction(async (trx) => {
    const org = await trx('contact_organization')
      .where({ contact_id: contactId, is_primary: true })
      .whereNull('ended_at')
      .first('organization_id');
    // Route it to whoever owns the contact, so own-scope agents see it and get reply notifications.
    const owner = await trx('contacts').where({ id: contactId }).first('owner_id');
    return insertTicket(trx, ctx, {
      subject: input.subject,
      description: input.description,
      priority: 'normal',
      category: '',
      channel: 'portal',
      contact_id: contactId,
      organization_id: (org?.organization_id as number | undefined) ?? null,
      assignee_id: (owner?.owner_id as number | null) ?? null,
      created_by: null,
    });
  });
  await emitTicket('ticket.created', uuid, null);
  return uuid;
}

/** A customer reply reopens a pending or resolved ticket and tells the assignee. */
export async function replyAsCustomer(
  ctx: RequestContext,
  match: Match,
  contactId: number,
  uuid: string,
  body: string,
) {
  const assignee = await db.transaction(async (trx) => {
    const qb = trx(TICKETS).where({ uuid }).whereNull('deleted_at').forUpdate();
    match(qb);
    const row = await qb.first();
    if (!row) throw notFound('Ticket');
    if (row.status === 'closed')
      throw new AppError('CONFLICT', 'This ticket is closed. Open a new one instead.');
    const cuuid = newUuid();
    const [id] = await trx(COMMENTS).insert({
      uuid: cuuid,
      ticket_id: row.id,
      author_contact_id: contactId,
      body,
    });
    await trx(TICKETS)
      .where({ id: row.id })
      .update({ status: 'open', resolved_at: null, last_activity_at: new Date(), updated_at: new Date() });
    await audit(trx, ctx, {
      action: 'tickets.reply.added',
      entity: 'tickets.comment',
      entityId: id,
      entityUuid: cuuid,
      diff: { ticket: row.number, via: 'portal' },
    });
    return row.assignee_id ? { id: row.assignee_id as number, number: row.number as string } : null;
  });
  if (assignee)
    await notify(assignee.id, {
      type: 'ticket.replied',
      title: `New reply on ${assignee.number}`,
      body: body.slice(0, 200),
      link: `/m/tickets/${uuid}`,
      email: true,
    });
  await emitTicket('ticket.replied', uuid, null);
}

export const tickets: ApiModule = {
  routes: () => [routes],
  migrations: { '0001_tickets': m0001 },
};
