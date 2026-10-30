import { marked } from 'marked';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** Where a record opens in the app (`deals/<uuid>`), or null when it has no page of its own. */
export type RecordPath = (entity: string, uuid: string) => string | null;

const RECORD_LINK = /^record:([a-z][a-z0-9_]{0,63})\/([0-9a-f-]{36})$/;

/**
 * A reply from the model as formatted HTML. Model text can carry anything a record or a prompt put
 * into it, so HTML is escaped first, images are dropped (a picture loads by itself, which could send
 * data away) and links keep web addresses only, opening in a new tab. Record links the model writes
 * as `[Name](record:<entity>/<uuid>)` become chips that open the record in the app.
 */
export function replyHtml(text: string, recordPath?: RecordPath): string {
  const safe = text.replace(/[&<>]/g, (c) => ESCAPES[c]!);
  const html = marked.parse(safe, { async: false, gfm: true, breaks: true });
  return html
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, url: string, label: string) => {
      const record = RECORD_LINK.exec(url);
      if (record) {
        const to = recordPath?.(record[1]!, record[2]!);
        return to
          ? `<a href="#" data-to="/${to}" class="ai-chip">${label}</a>`
          : `<span class="ai-chip">${label}</span>`;
      }
      return /^https?:/i.test(url.replace(/&#?\w+;/g, '').trim())
        ? `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`
        : label;
    });
}

/**
 * Splits off the follow-ups the model offers on its last line (`Next: a | b | c`), so they show as
 * buttons. While a reply streams in, a half-written line is hidden too.
 */
export function splitNext(text: string): { body: string; next: string[] } {
  const m = /(?:^|\n)[ \t]*\**Next:\**[ \t]*([^\n]*)\s*$/i.exec(text);
  if (!m) return { body: text, next: [] };
  const next = m[1]!
    .split('|')
    .map((s) => s.trim().replace(/^[-*"'\s]+|["'\s]+$/g, ''))
    .filter((s) => s.length > 1 && s.length <= 120)
    .slice(0, 3);
  return { body: text.slice(0, m.index).trimEnd(), next };
}
