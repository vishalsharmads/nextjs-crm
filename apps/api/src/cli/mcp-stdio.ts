/**
 * Stdio bridge for MCP clients that launch a local command instead of calling a URL. It reads
 * JSON-RPC messages from stdin, one per line, posts them to the workspace's MCP endpoint with a
 * personal access token, and writes the responses to stdout. Logs go to stderr only.
 *
 *   MCP_URL=https://crm.example.com/api/v1/mcp MCP_TOKEN=pat_… npx tsx apps/api/src/cli/mcp-stdio.ts
 */
import { createInterface } from 'node:readline';

const url = process.env.MCP_URL;
const token = process.env.MCP_TOKEN;
if (!url || !token) {
  process.stderr.write('Set MCP_URL (…/api/v1/mcp) and MCP_TOKEN (a personal access token).\n');
  process.exit(1);
}

async function forward(line: string) {
  let id: unknown = null;
  try {
    id = (JSON.parse(line) as { id?: unknown }).id ?? null;
    const res = await fetch(url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: line,
    });
    if (res.status === 202) return;
    const text = await res.text();
    if (res.headers.get('content-type')?.includes('application/json') && text.includes('"jsonrpc"')) {
      process.stdout.write(`${text.trim()}\n`);
      return;
    }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    if (id !== null)
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: (err as Error).message } })}\n`,
      );
  }
}

const rl = createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on('line', (line) => {
  if (!line.trim()) return;
  queue = queue.then(() => forward(line));
});
rl.on('close', () => void queue.then(() => process.exit(0)));
