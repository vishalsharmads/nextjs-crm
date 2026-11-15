import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/** Address ranges an outbound request must never reach (loopback, private, link-local, metadata, ...). */
const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const)
  blocked.addSubnet(addr, prefix, 'ipv6');

/** Expands an IPv6 address to eight 16-bit groups, or undefined when it is not valid IPv6. */
function v6Groups(ip: string): number[] | undefined {
  if (!net.isIPv6(ip)) return undefined;
  let s = ip.toLowerCase().split('%')[0]!;
  // A trailing dotted IPv4 part becomes two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split('.').map(Number) as [number, number, number, number];
    s = s.slice(0, -dotted[1]!.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => parseInt(g, 16));
}

/**
 * True when `ip` is not a public internet address. IPv4-mapped and IPv4-compatible IPv6
 * forms (`::ffff:a9fe:a9fe`, `::ffff:169.254.169.254`) are judged as the IPv4 address they carry.
 * Anything that does not parse counts as private.
 */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return blocked.check(ip, 'ipv4');
  const g = v6Groups(ip);
  if (!g || g.length !== 8 || g.some((x) => Number.isNaN(x))) return true;
  const mapped = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0);
  if (mapped) return blocked.check(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`, 'ipv4');
  return blocked.check(g.map((x) => x.toString(16)).join(':'), 'ipv6');
}

/**
 * A DNS lookup for http(s).request that refuses private addresses. The connection uses the
 * address checked here, so a host that resolves differently later (DNS rebinding) cannot slip past.
 */
export const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as LookupAddress[];
    const bad = !list.length || list.some((a) => isPrivateAddress(a.address));
    if (bad) {
      const e = Object.assign(new Error('This address is not reachable from the internet'), {
        code: 'EPRIVATE',
      });
      return callback(e, '', 0);
    }
    if ((options as { all?: boolean }).all)
      return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

export interface SafePostResult {
  status: number;
}

/** POST a body to an outbound URL with the address pinned through `safeLookup`, no redirects. */
export function safePost(
  url: string,
  headers: Record<string, string>,
  body: string,
  opts: { timeoutMs?: number; allowPrivate?: boolean } = {},
): Promise<SafePostResult> {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
        lookup: opts.allowPrivate ? undefined : safeLookup,
        timeout: opts.timeoutMs ?? 10_000,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * Any HTTP request to a user-supplied address (CalDAV) with the address pinned through
 * `safeLookup`, no redirects, a time limit and a size limit on the answer.
 */
export function safeRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
  opts: { timeoutMs?: number; allowPrivate?: boolean; maxBytes?: number } = {},
): Promise<SafeResponse> {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const max = opts.maxBytes ?? 10 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method,
        headers: {
          ...headers,
          ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}),
        },
        lookup: opts.allowPrivate ? undefined : safeLookup,
        timeout: opts.timeoutMs ?? 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > max) req.destroy(new Error('The answer is too large'));
          else chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end(body);
  });
}
