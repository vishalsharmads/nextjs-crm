import type { APIRoute } from 'astro';
import { industries } from '../data/industries';
import { articles } from '../data/articles';
import { features, homeFaq, site as info } from '../data/site';

/** A plain-text map of the site for AI assistants and answer engines (llms.txt convention). */
export const GET: APIRoute = ({ site }) => {
  const url = (p: string) => new URL(p, site).toString();
  const lines = [
    `# ${info.name}`,
    '',
    `> ${info.description}`,
    '',
    '## Key facts',
    ...homeFaq.map((f) => `- ${f.q} ${f.a}`),
    '',
    '## Industries',
    ...industries.map(
      (i) => `- [CRM for ${i.name.toLowerCase()}](${url(`/industries/${i.slug}`)}): ${i.answer}`,
    ),
    '',
    '## Features',
    ...features.map((f) => `- [${f.name}](${url(`/features#${f.slug}`)}): ${f.body}`),
    '',
    '## Guides',
    ...articles.map((a) => `- [${a.title}](${url(`/resources/${a.slug}`)}): ${a.answer}`),
    '',
    '## Pages',
    `- [Pricing](${url('/pricing')}): fixed quote, unlimited users, no per-seat fees.`,
    `- [For agencies](${url('/white-label')}): resell Bespoq as a white-label CRM.`,
    `- [Book a demo](${url('/demo')})`,
    `- [Admin cost calculator](${url('/roi-calculator')})`,
    '',
  ];
  return new Response(lines.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
