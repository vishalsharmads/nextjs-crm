import { afterAll, describe, expect, it } from 'vitest';
import { clientWithRoles } from './helpers';
import { db } from '../src/db/knex';
import { onEvent, type DomainEvent } from '../src/core/events/events';

const events: DomainEvent[] = [];
onEvent(async (e) => {
  if (e.type === 'lead.stage_changed') events.push(e);
});

interface Column {
  stage: { uuid: string; name: string; color: string; isWon: boolean; isLost: boolean };
  count: number;
  leads: { uuid: string; stage: { uuid: string } | null }[];
}

afterAll(async () => {
  // Other files create leads too: leave the feature off as the factory default.
  const { client } = await clientWithRoles(['admin']);
  await client.patch('/settings/features', { leadPipeline: false }).expect(200);
});

describe('lead pipeline', () => {
  it('is off by default: no board, no stage on leads', async () => {
    const { client } = await clientWithRoles(['admin']);
    expect((await client.get('/leads/board')).status).toBe(404);
    const lead = await client.post('/leads', { firstName: 'Before', lastName: 'Switch' }).expect(201);
    expect(lead.body.stage).toBeNull();
    expect(lead.body.pipeline).toBeNull();
  });

  it('turning it on creates a starter pipeline and places existing leads by status', async () => {
    const { client } = await clientWithRoles(['admin']);
    const unq = await client
      .post('/leads', { firstName: 'Cold', lastName: 'Prospect', status: 'unqualified' })
      .expect(201);
    await client.patch('/settings/features', { leadPipeline: true }).expect(200);

    const pipelines = (await client.get('/pipelines').expect(200)).body.data as {
      entity: string;
      isDefault: boolean;
      stages: { name: string; color: string }[];
    }[];
    const leadPipeline = pipelines.find((p) => p.entity === 'lead' && p.isDefault);
    expect(leadPipeline?.stages.map((s) => s.color)).toEqual(['blue', 'teal', 'green', 'red']);

    const placed = (await client.get(`/leads/${unq.body.uuid}`).expect(200)).body;
    expect(placed.stage.isLost).toBe(true);
    expect(await db('leads').whereNull('stage_id').whereNull('deleted_at').count({ c: '*' }).first()).toEqual(
      {
        c: 0,
      },
    );

    const backfill = await db('audit_logs').where({ action: 'lead.pipeline_backfilled' }).first();
    expect(backfill).toBeTruthy();
    const unqId = (await db('leads').where({ uuid: unq.body.uuid }).first('id')).id;
    expect(await db('lead_stage_history').where({ lead_id: unqId }).first()).toBeTruthy();

    const fresh = await client.post('/leads', { firstName: 'Fresh', lastName: 'Lead' }).expect(201);
    expect(fresh.body.stage.name).toBe('New');
    expect(fresh.body.stageEnteredAt).toBeTruthy();
  });

  it('shows leads on the board and moves them, with history, audit and an event', async () => {
    const { client } = await clientWithRoles(['admin']);
    const lead = await client.post('/leads', { firstName: 'Board', lastName: 'Mover' }).expect(201);
    const board = await client.get('/leads/board').expect(200);
    const columns = board.body.columns as Column[];
    expect(columns[0]!.leads.some((l) => l.uuid === lead.body.uuid)).toBe(true);
    expect(columns[0]!.stage.color).toBe('blue');

    const contacted = columns[1]!.stage;
    const moved = await client
      .patch(`/leads/${lead.body.uuid}/stage`, { stageUuid: contacted.uuid })
      .expect(200);
    expect(moved.body.stage.uuid).toBe(contacted.uuid);

    const id = (await db('leads').where({ uuid: lead.body.uuid }).first('id')).id;
    expect(await db('lead_stage_history').where({ lead_id: id }).count({ c: '*' }).first()).toEqual({ c: 2 });
    expect(
      await db('audit_logs').where({ entity: 'lead', entity_id: id, action: 'lead.stage_changed' }).first(),
    ).toBeTruthy();
    expect(events.some((e) => e.uuid === lead.body.uuid)).toBe(true);

    const timeline = await client.get(`/leads/${lead.body.uuid}/timeline`).expect(200);
    expect(timeline.body.data.some((i: { kind: string }) => i.kind === 'stage')).toBe(true);

    // A stage from another pipeline is refused.
    const deals = await client.get('/deals/board').expect(200);
    await client
      .patch(`/leads/${lead.body.uuid}/stage`, { stageUuid: deals.body.columns[0].stage.uuid })
      .expect(422);
  });

  it('moves leads through a normal update and bulk move', async () => {
    const { client } = await clientWithRoles(['admin']);
    const columns = (await client.get('/leads/board').expect(200)).body.columns as Column[];
    const a = await client.post('/leads', { firstName: 'Bulk', lastName: 'One' }).expect(201);
    const b = await client.post('/leads', { firstName: 'Bulk', lastName: 'Two' }).expect(201);
    const patched = await client
      .patch(`/leads/${a.body.uuid}`, { stageUuid: columns[1]!.stage.uuid })
      .expect(200);
    expect(patched.body.stage.uuid).toBe(columns[1]!.stage.uuid);
    const bulk = await client
      .post('/leads/bulk', {
        action: 'move_stage',
        uuids: [a.body.uuid, b.body.uuid],
        stageUuid: columns[2]!.stage.uuid,
      })
      .expect(200);
    expect(bulk.body.affected).toBe(2);
    expect((await client.get(`/leads/${b.body.uuid}`)).body.stage.uuid).toBe(columns[2]!.stage.uuid);
  });

  it('own scope sees and moves only its own leads on the board', async () => {
    const { client: rep1 } = await clientWithRoles(['sales_rep']);
    const { client: rep2 } = await clientWithRoles(['sales_rep']);
    const mine = await rep1.post('/leads', { firstName: 'Rep', lastName: 'OneLead' }).expect(201);
    const board = (await rep2.get('/leads/board').expect(200)).body.columns as Column[];
    expect(board.flatMap((c) => c.leads).some((l) => l.uuid === mine.body.uuid)).toBe(false);
    expect(
      (await rep2.patch(`/leads/${mine.body.uuid}/stage`, { stageUuid: board[1]!.stage.uuid })).status,
    ).toBe(404);
  });

  it('removing a lead stage moves its leads', async () => {
    const { client } = await clientWithRoles(['admin']);
    const pipeline = await client.post('/pipelines', { name: 'Inbound', entity: 'lead' }).expect(201);
    const [first, second] = pipeline.body.stages;
    const lead = await client
      .post('/leads', { firstName: 'Inbound', lastName: 'Lead', pipelineUuid: pipeline.body.uuid })
      .expect(201);
    expect(lead.body.stage.uuid).toBe(first.uuid);
    await client.delete(`/pipelines/${pipeline.body.uuid}/stages/${first.uuid}`).expect(422);
    await client
      .delete(`/pipelines/${pipeline.body.uuid}/stages/${first.uuid}?moveTo=${second.uuid}`)
      .expect(200);
    expect((await client.get(`/leads/${lead.body.uuid}`)).body.stage.uuid).toBe(second.uuid);
  });

  it('converting a lead puts it on the won stage', async () => {
    const { client } = await clientWithRoles(['admin']);
    const lead = await client.post('/leads', { firstName: 'Ready', lastName: 'Convert' }).expect(201);
    await client.post(`/leads/${lead.body.uuid}/convert`, { createDeal: false }).expect(200);
    expect((await client.get(`/leads/${lead.body.uuid}`)).body.stage.isWon).toBe(true);
  });

  it('own scope cannot bulk-move other people’s leads', async () => {
    const { client: rep1 } = await clientWithRoles(['sales_rep']);
    const { client: rep2 } = await clientWithRoles(['sales_rep']);
    const mine = await rep1.post('/leads', { firstName: 'Rep', lastName: 'BulkGuard' }).expect(201);
    const columns = (await rep1.get('/leads/board').expect(200)).body.columns as Column[];
    // Refused outright (no bulk permission) or skipped as out of scope: either way the lead stays put.
    const res = await rep2.post('/leads/bulk', {
      action: 'move_stage',
      uuids: [mine.body.uuid],
      stageUuid: columns[1]!.stage.uuid,
    });
    if (res.status === 200) expect(res.body.affected).toBe(0);
    else expect(res.status).toBe(403);
    expect((await rep1.get(`/leads/${mine.body.uuid}`)).body.stage.uuid).toBe(columns[0]!.stage.uuid);
  });
});
