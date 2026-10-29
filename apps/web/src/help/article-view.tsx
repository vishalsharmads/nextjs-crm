import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import {
  CORE_PERMISSIONS,
  SETTINGS_GROUPS,
  SETTINGS_HELP,
  type SettingsGroup,
  type ToolInfo,
} from '@app/shared';
import { marked } from 'marked';
import { apiGet } from '@/lib/api';
import { useCan } from '@/app/session';
import type { HelpArticle } from './registry';

/** Module permissions, read from the manifests so module help lists them too. */
const manifests = import.meta.glob<{ key: string; permissions?: { key: string; description: string }[] }>(
  '../../../../modules/*/manifest.json',
  { import: 'default', eager: true },
);
const ALL_PERMISSIONS = [
  ...CORE_PERMISSIONS,
  ...Object.values(manifests).flatMap((m) => m.permissions ?? []),
];

/** Fill `{{var}}` with vocabulary and branding; values are escaped (articles themselves are ours). */
export function interpolate(text: string, vars: Record<string, string>, escape = true): string {
  const esc = (s: string) => (escape ? s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`) : s);
  return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (m, k: string) => (k in vars ? esc(vars[k]!) : m));
}

const MARKER = /<!--\s*generated:([a-z-]+)(?::([a-z0-9_.-]+))?\s*-->/g;

/**
 * A workspace note from the blueprint, as Markdown. Blueprints can be uploaded by admins, so any
 * HTML in the note is escaped first and shows as text.
 */
function noteHtml(note: string, vars: Record<string, string>) {
  const safe = note.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const html = marked.parse(safe, { async: false, gfm: true });
  // Markdown links and images can still carry `javascript:` or `data:`: keep web, mail and in-app links only.
  return interpolate(
    html.replace(/\s(href|src)="([^"]*)"/g, (m, attr: string, url: string) =>
      /^(https?:|mailto:|\/(?!\/)|#)/i.test(url.replace(/&#?\w+;/g, '').trim()) ? m : ` ${attr}="#"`,
    ),
    vars,
  );
}

/** An article as segments of HTML and generated tables, in order, then any workspace note. */
export function ArticleView({
  article,
  vars,
  note,
}: {
  article: HelpArticle;
  vars: Record<string, string>;
  note?: string | undefined;
}) {
  const parts = useMemo(() => {
    const out: ReactNode[] = [];
    let last = 0;
    let i = 0;
    for (const m of article.html.matchAll(MARKER)) {
      out.push(html(article.html.slice(last, m.index), vars, i++));
      out.push(<Generated key={`g${i++}`} kind={m[1]!} arg={m[2]} vars={vars} />);
      last = m.index! + m[0].length;
    }
    out.push(html(article.html.slice(last), vars, i));
    return out;
  }, [article, vars]);
  return (
    <div className="rte-prose text-sm">
      {parts}
      {note ? (
        <section aria-label="For your workspace" className="mt-4 rounded-md border border-line bg-subtle p-3">
          <h3>For your workspace</h3>
          <div dangerouslySetInnerHTML={{ __html: noteHtml(note, vars) }} />
        </section>
      ) : null}
    </div>
  );
}

const html = (chunk: string, vars: Record<string, string>, key: number) =>
  chunk.trim() ? <div key={key} dangerouslySetInnerHTML={{ __html: interpolate(chunk, vars) }} /> : null;

function Generated({
  kind,
  arg,
  vars,
}: {
  kind: string;
  arg?: string | undefined;
  vars: Record<string, string>;
}) {
  if (kind === 'settings' && arg && arg in SETTINGS_GROUPS)
    return <SettingsTable group={arg as SettingsGroup} vars={vars} />;
  if (kind === 'permissions') return <PermissionsTable prefix={arg ?? ''} />;
  if (kind === 'tools') return <ToolsTable />;
  return null;
}

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
  default?: unknown;
  properties?: Record<string, JsonSchema>;
}

/** Allowed values in plain words, read from the setting's schema. */
function allowed(s: JsonSchema): string {
  if (s.enum) return s.enum.map(String).join(', ');
  if (s.anyOf?.every((x) => 'const' in x))
    return s.anyOf.map((x) => String((x as { const: unknown }).const)).join(', ');
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === 'boolean') return 'On or off';
  if (type === 'integer' || type === 'number') {
    if (s.minimum !== undefined && s.maximum !== undefined) return `${s.minimum} to ${s.maximum}`;
    return 'A number';
  }
  if (type === 'array') return s.maxItems ? `A list, up to ${s.maxItems}` : 'A list';
  if (type === 'object') return 'Several values';
  return s.maxLength ? `Text, up to ${s.maxLength} characters` : 'Text';
}

function shown(v: unknown): string {
  if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) return '—';
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (Array.isArray(v)) return v.map(String).join(', ');
  if (typeof v === 'object') return '—';
  return String(v);
}

/** Every setting of a group: what it does, allowed values and default, straight from the code. */
function SettingsTable({ group, vars }: { group: SettingsGroup; vars: Record<string, string> }) {
  const schema = z.toJSONSchema(SETTINGS_GROUPS[group], {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchema;
  const help = SETTINGS_HELP[group] as Record<string, { label: string; description: string }>;
  return (
    <div className="my-3 overflow-x-auto">
      <table>
        <thead>
          <tr>
            <th>Setting</th>
            <th>What it does</th>
            <th>Allowed</th>
            <th>Default</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(help).map(([key, h]) => {
            const s = schema.properties?.[key] ?? {};
            return (
              <tr key={key}>
                <td className="font-medium">{interpolate(h.label, vars, false)}</td>
                <td>{interpolate(h.description, vars, false)}</td>
                <td>{allowed(s)}</td>
                <td>{shown(s.default)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Permissions with a key prefix (`core.deals`), from the catalog the server enforces. */
function PermissionsTable({ prefix }: { prefix: string }) {
  const rows = ALL_PERMISSIONS.filter((p) => p.key.startsWith(prefix));
  if (!rows.length) return null;
  return (
    <div className="my-3 overflow-x-auto">
      <table>
        <thead>
          <tr>
            <th>Permission</th>
            <th>Allows</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.key}>
              <td>
                <code>{p.key}</code>
              </td>
              <td>{p.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The tools AI clients and the assistant can use, from the server's tool registry. */
function ToolsTable() {
  const can = useCan();
  const tools = useQuery({
    queryKey: ['tools'],
    queryFn: () => apiGet<{ data: ToolInfo[] }>('/tools').then((r) => r.data),
    enabled: can('core.settings.manage'),
  });
  if (!tools.data) return null;
  return (
    <div className="my-3 overflow-x-auto">
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          {tools.data.map((t) => (
            <tr key={t.name}>
              <td className="font-medium">
                {t.title}
                {t.write ? <span className="ms-1 text-xs text-muted">(changes data)</span> : null}
              </td>
              <td>{t.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
