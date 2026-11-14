import { z } from 'zod';
import { contrastRatio } from '@app/shared';
import type { Brief } from './setup';
import type { Preview } from './preview';

/**
 * AI setup's proposal (phase 10b): the approved brief turned into items the admin reviews and
 * picks, each with a readable preview (paths point into the item's payload, so the same edits
 * the confirm card uses apply here) and a payload the build step applies.
 */
export type Area = 'branding' | 'preset' | 'names' | 'pipeline' | 'fields' | 'roles' | 'reports' | 'next';

export interface ProposalItem {
  id: string;
  area: Area;
  title: string;
  detail?: string;
  /** Shown but not built (suggestions to do next). */
  advice?: boolean;
  preview: Preview;
  payload: Record<string, unknown>;
}

/** Report definitions the assistant derives from the reports the business asked for. */
export const reportsSchema = z.object({
  reports: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(150),
        definition: z.object({
          entity: z.enum(['contact', 'organization', 'deal', 'lead', 'activity']),
          groupBy: z.string().regex(/^(cf\.)?[a-z][a-z0-9_]{0,63}$/),
          metric: z.enum(['count', 'sum', 'avg']).default('count'),
          metricField: z
            .string()
            .regex(/^(cf\.)?[a-z][a-z0-9_]{0,63}$/)
            .nullish(),
          dateBucket: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional(),
          chart: z.enum(['bar', 'line', 'pie', 'table']).default('bar'),
        }),
      }),
    )
    .max(8)
    .default([]),
});
export type ProposedReport = z.infer<typeof reportsSchema>['reports'][number];

/** A key from a label: lowercase words joined by underscores, starting with a letter. */
export function keyOf(label: string, used = new Set<string>()): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 'f_$1')
      .slice(0, 40) || 'field';
  let key = base;
  for (let i = 2; used.has(key); i++) key = `${base}_${i}`;
  used.add(key);
  return key;
}

/** Mixes a colour toward black (amount > 0) or white (amount < 0). */
function shade(hex: string, amount: number): string {
  const h = hex.replace('#', '');
  const towards = amount > 0 ? 0 : 255;
  const t = Math.abs(amount);
  const out = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16);
    return Math.round(c + (towards - c) * t)
      .toString(16)
      .padStart(2, '0');
  });
  return `#${out.join('')}`.toUpperCase();
}

/**
 * The brand colour, darkened (or lightened, for a dark background) until text on it reads at AA
 * contrast (4.5:1) in white or black, so a pale or neon website colour still makes a readable app.
 */
export function readableBrand(hex: string, against: 'light' | 'dark' = 'light'): string {
  let c = hex.toUpperCase();
  for (let i = 0; i < 20; i++) {
    const best = Math.max(contrastRatio(c, '#FFFFFF'), contrastRatio(c, '#000000'));
    // On a dark canvas the colour must also stand out from it.
    const onCanvas = against === 'dark' ? contrastRatio(c, '#111111') >= 3 : true;
    if (best >= 4.5 && onCanvas) return c;
    c = shade(c, against === 'dark' ? -0.08 : 0.08);
  }
  return c;
}

const WON = /\b(won|win|signed|closed[ -]won|paid|completed|enrolled|hired|placed|booked|converted)\b/i;
const LOST = /\b(lost|declined|rejected|cancel(l)?ed|closed[ -]lost|dropped|no[ -]show|withdrawn)\b/i;

interface Site {
  name?: string | null;
  logos?: string[];
  colors?: string[];
}

export function buildProposal(
  brief: Brief,
  site: Site | null,
  reports: ProposedReport[],
  presets: { key: string; name: string }[],
): ProposalItem[] {
  const items: ProposalItem[] = [];

  // Branding: the business's own name, words, logo and colours (made readable).
  const primary = site?.colors?.[0] ? readableBrand(site.colors[0]) : null;
  const accent = site?.colors?.[1] ? readableBrand(site.colors[1]) : null;
  const tagline = brief.summary.split(/(?<=[.!?])\s/)[0]?.slice(0, 140) ?? '';
  items.push({
    id: 'branding',
    area: 'branding',
    title: `Brand it as ${brief.businessName}`,
    detail: primary
      ? 'Your name, logo and colours, adjusted where needed so text stays readable.'
      : 'Your name and words.',
    preview: {
      records: [],
      fields: [
        { label: 'App name', value: brief.businessName, edit: ['appName'] },
        ...(tagline ? [{ label: 'Tagline', value: tagline, edit: ['tagline'] }] : []),
        ...(primary ? [{ label: 'Main colour', value: primary }] : []),
        ...(accent ? [{ label: 'Accent colour', value: accent }] : []),
        ...(site?.logos?.[0] ? [{ label: 'Logo', value: 'From your website' }] : []),
        ...(site?.logos?.[0]
          ? [{ label: 'Use the logo', value: 'Yes', edit: ['useLogo'], kind: 'boolean' as const }]
          : []),
      ],
    },
    payload: {
      appName: brief.businessName,
      tagline,
      primary,
      primaryDark: site?.colors?.[0] ? readableBrand(site.colors[0], 'dark') : null,
      accent,
      logoUrl: site?.logos?.[0] ?? null,
      useLogo: !!site?.logos?.[0],
    },
  });

  const preset = brief.presetKey ? presets.find((p) => p.key === brief.presetKey) : undefined;
  if (preset)
    items.push({
      id: 'preset',
      area: 'preset',
      title: `Add the ${preset.name} preset`,
      detail:
        'Ready-made fields, pipeline, roles and reports for your industry, added next to anything you already have.',
      preview: { records: [], fields: [{ label: 'Preset', value: preset.name }] },
      payload: { key: preset.key },
    });

  const names = Object.entries(brief.vocabulary).filter(([, v]) => v?.singular && v.plural) as [
    string,
    { singular: string; plural: string },
  ][];
  if (names.length)
    items.push({
      id: 'names',
      area: 'names',
      title: 'Use your own words for records',
      preview: {
        records: [],
        fields: [],
        lists: [
          {
            label: 'Names',
            path: ['names'],
            items: names.map(([e, v]) => ({
              label: `${v.plural}`,
              detail: `Instead of the standard name for ${e} records`,
            })),
          },
        ],
      },
      payload: { names: names.map(([entity, v]) => ({ entity, ...v })) },
    });

  // The pipeline: their stages in order, with a won and a lost stage.
  if (brief.stages.length) {
    const stages = brief.stages.filter((s) => s.name.trim()).map((s) => ({ name: s.name.trim() }));
    if (!stages.some((s) => WON.test(s.name))) stages.push({ name: 'Won' });
    if (!stages.some((s) => LOST.test(s.name))) stages.push({ name: 'Lost' });
    // Named after the business, so it never collides with a pipeline the workspace already has.
    const pipelineName = `${brief.businessName} sales`.slice(0, 100);
    items.push({
      id: 'pipeline',
      area: 'pipeline',
      title: `A ${brief.businessName} pipeline`,
      detail: 'Your process as stages; untick any you do not want.',
      preview: {
        records: [],
        fields: [{ label: 'Name', value: pipelineName, edit: ['name'] }],
        lists: [
          {
            label: 'Stages',
            path: ['stages'],
            items: stages.map((s) => ({
              label: s.name,
              detail: WON.test(s.name) ? 'Counts as won' : LOST.test(s.name) ? 'Counts as lost' : undefined,
            })),
          },
        ],
      },
      payload: { name: pipelineName, stages },
    });
  }

  if (brief.track.length)
    items.push({
      id: 'fields',
      area: 'fields',
      title: 'Fields for what you need to record',
      preview: {
        records: [],
        fields: [],
        lists: [
          {
            label: 'Fields',
            path: ['fields'],
            items: brief.track.map((t) => ({
              label: t.label,
              detail: `${t.type.replace('_', ' ')} · ${t.entity} records`,
            })),
          },
        ],
      },
      payload: { fields: brief.track },
    });

  if (brief.roles.length)
    items.push({
      id: 'roles',
      area: 'roles',
      title: 'Roles for your team',
      detail: 'Each can view, add and update records; only admins can delete or change settings.',
      preview: {
        records: [],
        fields: [],
        lists: [
          {
            label: 'Roles',
            path: ['roles'],
            items: brief.roles.map((r) => ({ label: r.name, detail: r.does })),
          },
        ],
      },
      payload: { roles: brief.roles },
    });

  if (reports.length)
    items.push({
      id: 'reports',
      area: 'reports',
      title: 'Reports you asked for',
      preview: {
        records: [],
        fields: [],
        lists: [
          {
            label: 'Reports',
            path: ['reports'],
            items: reports.map((r) => ({
              label: r.name,
              detail: `${r.definition.metric === 'count' ? 'Count' : r.definition.metric === 'sum' ? 'Sum' : 'Average'} · ${r.definition.entity} records by ${r.definition.groupBy.replace(/_/g, ' ')} · ${r.definition.chart}`,
            })),
          },
        ],
      },
      payload: { reports },
    });

  if (brief.automations.length || brief.problems.length)
    items.push({
      id: 'next',
      area: 'next',
      title: 'Next, with the assistant',
      detail: 'Set these up together in the assistant chat once the setup is built, then bring in your data.',
      advice: true,
      preview: {
        records: [],
        fields: [],
        lists: [
          {
            label: 'Routines and fixes',
            path: ['todo'],
            items: [...brief.automations, ...brief.problems.map((p) => `Fix: ${p}`)].map((label) => ({
              label,
            })),
          },
        ],
      },
      payload: { todo: [...brief.automations, ...brief.problems] },
    });

  return items;
}

/** The setup draft (preset engine format) for the names, pipeline, fields and roles chosen. */
export function draftOf(items: ProposalItem[]) {
  const by = (area: Area) => items.find((i) => i.area === area)?.payload;
  const draft: Record<string, unknown> = {};

  const names = by('names')?.names as { entity: string; singular: string; plural: string }[] | undefined;
  if (names?.length)
    draft.vocabulary = Object.fromEntries(
      names.map((n) => [n.entity, { singular: n.singular, plural: n.plural }]),
    );

  const pipeline = by('pipeline') as { name: string; stages: { name: string }[] } | undefined;
  if (pipeline?.stages.length) {
    const used = new Set<string>();
    const open = pipeline.stages.filter((s) => !WON.test(s.name) && !LOST.test(s.name)).length || 1;
    let n = 0;
    // A pipeline has at most one won and one lost stage: the first that reads like each.
    const wonAt = pipeline.stages.findIndex((s) => WON.test(s.name));
    const lostAt = pipeline.stages.findIndex((s) => LOST.test(s.name));
    draft.pipelines = [
      {
        key: keyOf(`${pipeline.name} setup`, new Set()),
        name: pipeline.name,
        entity: 'deal',
        stages: pipeline.stages.map((s, i) => {
          const won = i === wonAt;
          const lost = i === lostAt;
          const probability = won ? 100 : lost ? 0 : Math.min(90, Math.round((++n / (open + 1)) * 100));
          return {
            key: keyOf(s.name, used),
            name: s.name,
            probability,
            ...(won ? { is_won: true } : {}),
            ...(lost ? { is_lost: true } : {}),
          };
        }),
      },
    ];
  }

  const fields = by('fields')?.fields as Brief['track'] | undefined;
  if (fields?.length) {
    const custom: Record<string, unknown[]> = {};
    const used: Record<string, Set<string>> = {};
    for (const f of fields) {
      if (!f.label.trim()) continue;
      used[f.entity] ??= new Set();
      const optionKeys = new Set<string>();
      (custom[f.entity] ??= []).push({
        key: keyOf(f.label, used[f.entity]),
        label: f.label.trim(),
        type: f.type,
        ...((f.type === 'select' || f.type === 'multi_select') && f.options?.length
          ? { options: f.options.map((o) => ({ key: keyOf(o, optionKeys), label: o })) }
          : {}),
      });
    }
    draft.custom_fields = custom;
  }

  const roles = by('roles')?.roles as Brief['roles'] | undefined;
  if (roles?.length) {
    const used = new Set<string>(['admin']);
    draft.roles = roles
      .filter((r) => r.name.trim())
      .map((r) => ({
        key: keyOf(r.name, used),
        name: r.name.trim(),
        permissions: ['contacts', 'organizations', 'deals', 'leads', 'activities'].flatMap((res) =>
          ['view', 'create', 'update'].map((a) => `core.${res}.${a}`),
        ),
      }));
  }
  return draft;
}
