import { AppError, assertSafeUrl } from '@app/api/module-api';

/** What one page of a business's website says about it, for AI setup. */
export interface WebsiteFacts {
  url: string;
  name: string | null;
  description: string | null;
  /** Absolute addresses of likely logos, best first. */
  logos: string[];
  /** Brand colours as #rrggbb, most used first (greys, black and white left out). */
  colors: string[];
  /** The page's readable text, shortened, for the assistant to learn what the business does. */
  text: string;
}

const TIMEOUT_MS = 8_000;
const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;

/** One page, fetched once: every hop is checked like any outbound address, and size is capped. */
async function fetchPage(start: string): Promise<{ url: string; html: string }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(url, 'website');
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': 'Mozilla/5.0 (compatible; setup reader)',
        },
      });
    } catch {
      throw new AppError(
        'UPSTREAM_FAILED',
        'The website could not be reached. Check the address, or skip this step.',
      );
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url).toString();
      await res.body?.cancel().catch(() => undefined);
      continue;
    }
    if (!res.ok)
      throw new AppError(
        'UPSTREAM_FAILED',
        `The website answered ${res.status}. Check the address, or skip this step.`,
      );
    if (!/html/i.test(res.headers.get('content-type') ?? ''))
      throw new AppError('VALIDATION_FAILED', 'That address is not a web page.');
    const reader = res.body?.getReader();
    if (!reader) return { url, html: '' };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
    return { url, html: Buffer.concat(chunks).toString('utf8') };
  }
  throw new AppError('UPSTREAM_FAILED', 'The website redirects too many times.');
}

const attr = (tag: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1]?.trim() ?? null;

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');

function meta(html: string, key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const k = attr(tag, 'property') ?? attr(tag, 'name');
    if (k?.toLowerCase() === key) return attr(tag, 'content');
  }
  return null;
}

/** #rgb / #rrggbb as #rrggbb, or null for greys, near-black and near-white (not brand colours). */
export function brandHex(raw: string): string | null {
  let h = raw.toLowerCase().replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 40 || max < 40 || min > 225) return null;
  return `#${h}`;
}

/** Reads the facts AI setup needs from a business's home page. */
export async function readWebsite(input: string): Promise<WebsiteFacts> {
  const start = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const { url, html } = await fetchPage(start);
  const abs = (u: string | null) => {
    if (!u) return null;
    try {
      const out = new URL(decode(u), url);
      return out.protocol === 'https:' || out.protocol === 'http:' ? out.toString() : null;
    } catch {
      return null;
    }
  };

  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const name = meta(html, 'og:site_name') ?? (title.split(/\s[|\-–—:]\s/)[0]?.trim() || null);
  const description = meta(html, 'description') ?? meta(html, 'og:description');

  // Logos: an image named like a logo, then touch icons and icons (largest first), then og:image.
  const logos: string[] = [];
  for (const img of html.match(/<img\b[^>]*>/gi) ?? [])
    if (
      /logo/i.test(
        `${attr(img, 'class') ?? ''} ${attr(img, 'id') ?? ''} ${attr(img, 'alt') ?? ''} ${attr(img, 'src') ?? ''}`,
      )
    )
      logos.push(abs(attr(img, 'src')) ?? '');
  const icons = (html.match(/<link\b[^>]*>/gi) ?? [])
    .filter((l) => /icon/i.test(attr(l, 'rel') ?? ''))
    .map((l) => ({
      href: abs(attr(l, 'href')),
      size:
        Number(/(\d+)x\d+/.exec(attr(l, 'sizes') ?? '')?.[1] ?? 0) +
        (/apple/i.test(attr(l, 'rel') ?? '') ? 1000 : 0),
    }))
    .sort((a, b) => b.size - a.size);
  logos.push(...icons.map((i) => i.href ?? ''), abs(meta(html, 'og:image')) ?? '');

  // Colours: the declared theme colour first, then the most used colours in the page's own CSS.
  const counts = new Map<string, number>();
  const theme = brandHex(meta(html, 'theme-color') ?? '');
  for (const m of html.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) ?? []) {
    const hex = brandHex(m);
    if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const colors = [
    ...new Set([
      ...(theme ? [theme] : []),
      ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h),
    ]),
  ];

  const text = decode(
    html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);

  return {
    url,
    name: name ? decode(name).slice(0, 120) : null,
    description: description ? decode(description).slice(0, 400) : null,
    logos: [...new Set(logos.filter(Boolean))].slice(0, 5),
    colors: colors.slice(0, 5),
    text,
  };
}
