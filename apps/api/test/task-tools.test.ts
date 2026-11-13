import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { clientWithRoles, createUser, getApp, restoreSettingsAfterEach, unique } from './helpers';
import { clearSettingsCache } from '../src/core/settings/settings.service';

let seq = 1;
const call = async (token: string, name: string, args: object = {}) =>
  request(await getApp())
    .post('/api/v1/mcp')
    .set('authorization', `Bearer ${token}`)
    .send({ jsonrpc: '2.0', id: seq++, method: 'tools/call', params: { name, arguments: args } });

describe('task tools', () => {
  restoreSettingsAfterEach(['mcp']);

  it('creates a repeating task with a checklist, comments on it and reads it back', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client.patch('/settings/mcp', { enabled: true }).expect(200);
    clearSettingsCache();
    const token = (await client.post('/me/tokens', { name: unique('t'), access: 'full' }).expect(201)).body
      .secret as string;
    const colleague = await createUser({ roleKeys: ['admin'] });

    const created = await call(token, 'create_task', {
      subject: 'Prepare board pack',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      recurrence: { freq: 'monthly' },
      checklist: ['Pull figures', 'Write summary'],
    });
    const task = created.body.result.structuredContent as {
      uuid: string;
      recurrence: { freq: string };
      checklist: { total: number };
    };
    expect(task.recurrence.freq).toBe('monthly');
    expect(task.checklist.total).toBe(2);

    await call(token, 'add_checklist_item', { uuid: task.uuid, label: 'Send to chair' });
    await call(token, 'add_task_comment', {
      uuid: task.uuid,
      body: 'Draft figures are in',
      mentions: [colleague.uuid],
    });
    const updated = await call(token, 'update_task', { uuid: task.uuid, priority: 'high' });
    expect(updated.body.result.structuredContent.priority).toBe('high');

    const read = (await call(token, 'get_task', { uuid: task.uuid })).body.result.structuredContent as {
      checklistItems: { label: string }[];
      comments: { body: string; mentions: { uuid: string }[] }[];
    };
    expect(read.checklistItems.map((i) => i.label)).toEqual([
      'Pull figures',
      'Write summary',
      'Send to chair',
    ]);
    expect(read.comments[0]!.body).toBe('Draft figures are in');
    expect(read.comments[0]!.mentions.map((m) => m.uuid)).toEqual([colleague.uuid]);
  });

  it('hides write tools from read-only tokens', async () => {
    const { client } = await clientWithRoles(['admin']);
    await client.patch('/settings/mcp', { enabled: true }).expect(200);
    clearSettingsCache();
    const token = (await client.post('/me/tokens', { name: unique('t'), access: 'read' }).expect(201)).body
      .secret as string;
    const res = await call(token, 'add_task_comment', {
      uuid: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      body: 'x',
    });
    expect(res.body.result?.isError ?? !!res.body.error).toBe(true);
  });
});
