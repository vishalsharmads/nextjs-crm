import { describe, expect, it } from 'vitest';
import { clientWithRoles, restoreSettingsAfterEach } from './helpers';
import { db } from '../src/db/knex';
import { clearSettingsCache } from '../src/core/settings/settings.service';

describe('task statuses', () => {
  restoreSettingsAfterEach(['features']);

  it('stays hidden until turned on, then places tasks and keeps stage and completion in step', async () => {
    const { client } = await clientWithRoles(['admin']);
    const open = await client.post('/activities', { type: 'task', subject: 'Open before' }).expect(201);
    const done = await client.post('/activities', { type: 'task', subject: 'Done before' }).expect(201);
    await client.post(`/activities/${done.body.uuid}/complete`).expect(200);
    const note = await client.post('/activities', { type: 'note', body: '<p>n</p>' }).expect(201);
    expect((await client.get('/activities/board')).status).toBe(404);

    await client.patch('/settings/features', { taskPipeline: true }).expect(200);
    clearSettingsCache();
    const board = (await client.get('/activities/board').expect(200)).body;
    expect(board.columns.map((c: { stage: { name: string } }) => c.stage.name)).toEqual([
      'To do',
      'In progress',
      'Waiting',
      'Done',
    ]);
    const col = (name: string) =>
      board.columns.find((c: { stage: { name: string } }) => c.stage.name === name);
    expect(col('To do').records.some((r: { uuid: string }) => r.uuid === open.body.uuid)).toBe(true);
    expect(col('Done').records.some((r: { uuid: string }) => r.uuid === done.body.uuid)).toBe(true);
    expect((await client.get(`/activities/${note.body.uuid}`)).body.stage).toBeNull();

    // Moving to Done completes; moving back reopens.
    const doneStage = col('Done').stage.uuid;
    const progress = col('In progress').stage.uuid;
    const moved = await client
      .patch(`/activities/${open.body.uuid}/stage`, { stageUuid: doneStage })
      .expect(200);
    expect(moved.body.completedAt).not.toBeNull();
    const back = await client
      .patch(`/activities/${open.body.uuid}/stage`, { stageUuid: progress })
      .expect(200);
    expect(back.body.completedAt).toBeNull();
    expect(back.body.stage.name).toBe('In progress');

    // Completing moves to Done; reopening moves to the first open stage.
    const completed = await client.post(`/activities/${open.body.uuid}/complete`).expect(200);
    expect(completed.body.stage.name).toBe('Done');
    const reopened = await client.post(`/activities/${open.body.uuid}/reopen`).expect(200);
    expect(reopened.body.stage.name).toBe('To do');

    // New tasks start on the first stage; an edit with a stage moves them.
    const fresh = await client.post('/activities', { type: 'task', subject: 'Fresh' }).expect(201);
    expect(fresh.body.stage.name).toBe('To do');
    const edited = await client.patch(`/activities/${fresh.body.uuid}`, { stageUuid: doneStage }).expect(200);
    expect(edited.body.completedAt).not.toBeNull();

    const history = await db('activity_stage_history')
      .join('activities', 'activities.id', 'activity_stage_history.activity_id')
      .where('activities.uuid', open.body.uuid)
      .count('* as n')
      .first();
    expect(Number(history?.n)).toBeGreaterThanOrEqual(5);
    const timeline = (await client.get(`/activities/${open.body.uuid}/timeline`)).body.data;
    expect(timeline.some((i: { kind: string }) => i.kind === 'stage')).toBe(true);
  });

  it('completing a recurring task by moving it to Done creates the next one', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client.patch('/settings/features', { taskPipeline: true }).expect(200);
    clearSettingsCache();
    const task = await client
      .post('/activities', {
        type: 'task',
        subject: 'Repeats on board',
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        recurrence: { freq: 'daily' },
      })
      .expect(201);
    const board = (await client.get('/activities/board').expect(200)).body;
    const doneStage = board.columns.find((c: { stage: { isWon: boolean } }) => c.stage.isWon).stage.uuid;
    await client.patch(`/activities/${task.body.uuid}/stage`, { stageUuid: doneStage }).expect(200);
    const parent = await db('activities').where({ uuid: task.body.uuid }).first('id');
    const next = await db('activities').where({ recurrence_parent_id: parent.id }).first();
    expect(next).toBeTruthy();
    // The next occurrence starts open, on the first stage.
    expect((await client.get(`/activities/${next.uuid}`)).body.stage.name).toBe('To do');
  });
});
