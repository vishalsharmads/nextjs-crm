/**
 * Copy for the "Cut to measure" 3D story page (/story). Every line that depends on the visitor's industry
 * comes from `storyCopy`, which runs at build time (the default industry) and in the browser (when the
 * visitor picks another one). Keep it free of runtime imports so the page script stays small.
 */
import type { Industry } from './industries';

export const STORY_DEFAULT = 'healthcare-clinics';

/** Made-up example businesses, one per industry. Labelled as examples on the page. */
const businessNames: Record<string, string> = {
  'real-estate': 'Harbour Realty',
  'healthcare-clinics': 'Harbour Dental',
  'law-firms': 'Harbour Legal',
  'financial-advisers': 'Harbour Wealth',
  'construction-trades': 'Harbour Builders',
  'education-training': 'Harbour Academy',
  'recruitment-staffing': 'Harbour Talent',
  'immigration-visa': 'Harbour Visas',
  coworking: 'Harbour Works',
};

/**
 * Each example business's brand color, as its workspace would be branded. All are dark enough for white
 * button text (AA on the light workspace).
 */
const accents: Record<string, string> = {
  'real-estate': '#0f766e',
  'healthcare-clinics': '#1d4ed8',
  'law-firms': '#1e3a8a',
  'financial-advisers': '#047857',
  'construction-trades': '#c2410c',
  'education-training': '#7e22ce',
  'recruitment-staffing': '#be185d',
  'immigration-visa': '#0369a1',
  coworking: '#a16207',
};
const DEFAULT_ACCENT = '#0f766e';

/** Stage colors on the workspace board, first stage to last (like the product's named stage colors). */
const STAGE_TONES = ['#64748b', '#0ea5e9', '#8b5cf6', '#f59e0b', '#10b981'];

/** The slice of an industry the story uses; passed to the browser as JSON. */
export type StoryIndustry = Pick<
  Industry,
  'slug' | 'name' | 'short' | 'vocab' | 'stages' | 'modules' | 'day' | 'cards'
> & {
  business: string;
  /** Brand color of the example workspace, `#rrggbb`. */
  accent: string;
};

export function toStoryIndustry(i: Industry): StoryIndustry {
  const { slug, name, short, vocab, stages, modules, day, cards } = i;
  return {
    slug,
    name,
    short,
    vocab,
    stages,
    modules,
    day,
    cards,
    business: businessNames[i.slug] ?? 'Harbour & Co',
    accent: accents[i.slug] ?? DEFAULT_ACCENT,
  };
}

/** Modules every business gets beside its industry's own five; they fill the nine panels of the cloth. */
export const coreModules = ['Tasks', 'Inbox', 'Calendar', 'Assistant'];

const lower = (s: string) => s.toLowerCase();

/** Text for every `data-t` slot on the page, for one industry. */
export function storyCopy(i: StoryIndustry): Record<string, string> {
  const { vocab, stages } = i;
  const last = stages[stages.length - 1];
  return {
    industry: i.name,
    short: i.short,
    business: i.business,
    contacts: vocab.contacts,
    deals: vocab.deals,
    deal: vocab.deal,
    company: vocab.company,
    // Act 1: the measure
    a1: `We’re ${i.business}. Here’s our website.`,
    q2: 'What do you call the people you help?',
    a2: `${vocab.contacts}. And the work we win, ${lower(vocab.deals)}.`,
    q3: `What happens between the first call and done?`,
    a3: stages.join(' → '),
    q4: 'Who does what?',
    a4: 'The front desk books, the team delivers, the manager bills.',
    done1: `Thanks. I’ve read your website once and picked up your services, logo and colors. Here’s what I’d set up.`,
    m1: `${vocab.contacts}, not contacts`,
    m2: `${stages.length} stages, in your words`,
    m3: 'Three roles, each seeing only its own work',
    m4: `${i.modules.length + coreModules.length} modules switched on`,
    m5: 'Your logo and colors',
    // Act 2: the pattern and the cut
    p1: `Contacts → ${vocab.contacts}`,
    p2: `Organizations → ${vocab.company}`,
    p3: `Deals → ${vocab.deals}`,
    p4: `Pipeline: ${stages.join(' · ')}`,
    p5: 'Roles: Front desk, Team, Manager',
    p6: 'Branding from your website',
    morphFromA: 'Contacts',
    morphFromB: 'Deals',
    // Act 5: the fitting
    board: `${vocab.deals} board`,
    ws: `${i.business}’s workspace: the ${lower(vocab.deals)} board in its own stages, its own words in the menu, and its brand color.`,
    // Act 6: the gold thread
    q6a: `Which ${lower(vocab.deals)} have been stuck in ${stages[1]} for more than two weeks?`,
    a6a: `Three. Here they are, oldest first, with the last note on each.`,
    q6b: 'Draft a friendly follow-up to each.',
    a6b: `Three drafts ready, in your tone. Open one to edit or send.`,
    q6c: `Add a Follow-up stage after ${last}.`,
    c6: `Add stage “Follow-up” after “${last}” in the ${vocab.deals} pipeline`,
    a6c: 'Done. The change is in the audit log, marked as made by the assistant.',
    // Act 7: the label
    label: i.business,
  };
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The product screen for one industry, as HTML: the workspace's name and brand color, its words in the
 * menu, and its board in its own stages with its records (each one stage on, as the 3D board leaves them).
 * Everything is escaped.
 */
export function workspaceHtml(i: StoryIndustry): string {
  const n = i.stages.length;
  const initials = i.business
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w))
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const modules = i.modules
    .map((m) => m.name)
    .filter((m) => !/pipeline/i.test(m))
    .slice(0, 3);
  const nav = (label: string, on = false) => `<span class="ws-nav${on ? ' is-on' : ''}">${esc(label)}</span>`;
  const columns = i.stages
    .map((stage, s) => {
      const cards = i.cards
        .filter((c) => Math.min(n - 1, c.stage < n - 1 ? c.stage + 1 : c.stage) === s)
        .map((c) => `<span class="ws-card"><b>${esc(c.name)}</b><span>${esc(c.detail)}</span></span>`)
        .join('');
      const count = (cards.match(/ws-card/g) ?? []).length;
      return `<span class="ws-col" style="--tone:${STAGE_TONES[s % STAGE_TONES.length]}"><span class="ws-col-head"><i></i>${esc(stage)}<em>${count}</em></span>${cards}</span>`;
    })
    .join('');
  return `<span class="ws" style="--ws-accent:${i.accent}">
  <span class="ws-top"><span class="ws-logo">${esc(initials)}</span><strong>${esc(i.business)}</strong><span class="ws-search">Search or jump to…</span><span class="ws-me">AR</span></span>
  <span class="ws-body">
    <span class="ws-side">${nav('Home')}${nav(i.vocab.contacts)}${nav(i.vocab.deals, true)}${nav('Tasks')}${nav('Calendar')}${nav('Reports')}<span class="ws-group">Modules</span>${modules.map((m) => nav(m)).join('')}${nav('Assistant')}</span>
    <span class="ws-main">
      <span class="ws-head"><strong>${esc(i.vocab.deals)}</strong><span class="ws-btn">+ New ${esc(i.vocab.deal)}</span></span>
      <span class="ws-board" style="--cols:${n}">${columns}</span>
    </span>
  </span>
</span>`;
}
