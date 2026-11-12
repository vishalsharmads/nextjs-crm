import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { handleDevMessage } from '../src/cli/dev-mcp';

const repoRoot = resolve(__dirname, '../../..');
let root = '';
let seq = 0;

/** A pretend checkout, so scaffolding never touches this repository. */
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dev-mcp-'));
  for (const f of [
    'brand-denylist.txt',
    'AGENTS.md',
    'docs/module-authoring.md',
    'apps/api/src/module-api.ts',
    'apps/api/src/core/events/events.ts',
  ]) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    cpSync(join(repoRoot, f), join(root, f));
  }
  mkdirSync(join(root, 'modules'), { recursive: true });
  cpSync(join(repoRoot, 'modules/notes-demo'), join(root, 'modules/notes-demo'), { recursive: true });
  mkdirSync(join(root, 'apps/api/src/modules'), { recursive: true });
  writeFileSync(
    join(root, 'apps/api/src/modules/installed.ts'),
    "import type { InstalledModuleSource } from './types';\n\nexport const installedModuleSources: InstalledModuleSource[] = [\n];\n",
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

async function rpc(method: string, params?: Record<string, unknown>) {
  const out = await handleDevMessage(root, JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }));
  return JSON.parse(out!) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
}

const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await rpc('tools/call', { name, arguments: args })).result as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content: { text: string }[];
  };

describe('developer MCP server', () => {
  it('initializes with module rules and lists its tools', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(init.result?.protocolVersion).toBe('2025-06-18');
    expect(String(init.result?.instructions)).toContain('@app/api/module-api');
    const tools = (await rpc('tools/list')).result?.tools as {
      name: string;
      annotations: { readOnlyHint: boolean };
    }[];
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'module_scaffold',
        'module_validate',
        'module_api_reference',
        'brand_check',
        'docs_read',
        'module_add',
      ]),
    );
    expect(tools.find((t) => t.name === 'module_scaffold')?.annotations.readOnlyHint).toBe(false);
    expect((await rpc('nope')).error?.code).toBe(-32601);
    expect(
      await handleDevMessage(root, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })),
    ).toBeUndefined();
  });

  it('scaffolds an integration that then validates', async () => {
    const made = await call('module_scaffold', { kind: 'integration', key: 'relay-out', name: 'Relay' });
    expect(made.isError).toBeUndefined();
    expect(existsSync(join(root, 'modules/relay-out/manifest.json'))).toBe(true);
    const check = await call('module_validate', { key: 'relay-out' });
    expect(check.structuredContent).toEqual({ ok: true, problems: [] });
    const again = await call('module_scaffold', { kind: 'integration', key: 'relay-out', name: 'Relay' });
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toContain('already exists');
  });

  it('reports problems, refuses bad keys, and reads docs and the API contract', async () => {
    const notes = await call('module_validate', { key: 'notes-demo' });
    expect(notes.structuredContent?.problems).toEqual([expect.stringContaining('installed.ts')]);
    const bad = await call('module_validate', { key: '../../etc' });
    expect(bad.isError).toBe(true);
    const ref = await call('module_api_reference');
    expect(ref.structuredContent?.events).toContain('deal.won');
    const doc = await call('docs_read', { doc: 'module-authoring' });
    expect(String(doc.structuredContent?.text)).toContain('# Writing a module');
    const resources = (await rpc('resources/read', { uri: 'docs://agents' })).result?.contents as {
      text: string;
    }[];
    expect(resources[0]!.text).toContain('AGENTS.md');
  });

  it('finds brand names in a module', async () => {
    writeFileSync(join(root, 'modules/relay-out/notes.txt'), 'Built by Bespoq');
    const hits = await call('brand_check', { key: 'relay-out' });
    expect(hits.structuredContent?.ok).toBe(false);
    rmSync(join(root, 'modules/relay-out/notes.txt'));
  });
});
