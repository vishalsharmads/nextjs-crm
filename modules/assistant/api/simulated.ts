import type { Block, ChatMessage, ChatRequest, ChatResult, StreamHandlers } from './providers';

/**
 * Scripted replies for trying the assistant out without an AI provider: no key, no tokens, no data
 * leaving the server. It still drives the real loop (it calls the real tools as the person, streams
 * text and proposes changes to confirm), so everything around the model can be tested for free.
 * Offered only where testing aids are allowed (development, tests and demo instances).
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

const STOP = new Set(
  'a an and any are can do does find for from get give have how i in is it list me my of on or show tell the to was what when where which who why with you your all about there this that these those'.split(
    ' ',
  ),
);

/** A pause before each step and between words, so the busy state and streaming can be seen. */
const STEP_MS = process.env.NODE_ENV === 'test' ? 0 : 700;
const WORD_MS = process.env.NODE_ENV === 'test' ? 0 : 12;
const pause = (ms: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

let seq = 0;
const use = (name: string, input: Obj): Block => ({
  type: 'tool_use',
  id: `sim_${Date.now().toString(36)}_${(seq++).toString(36)}`,
  name,
  input,
});

interface Turn {
  question: string;
  /** The page on screen when the question was asked: a record, or a list (`uuid` empty). */
  page: { entity: string; uuid: string } | null;
  /** Images attached to the question. */
  images: number;
  /** Tools called since the question, oldest first, with their results. */
  calls: { name: string; input: Obj; result?: string; error?: boolean }[];
}

function turnOf(messages: ChatMessage[]): Turn {
  let at = -1;
  for (let i = messages.length - 1; i >= 0 && at < 0; i--)
    if (messages[i]!.role === 'user' && messages[i]!.content.some((b) => b.type === 'text')) at = i;
  const question =
    at < 0 ? '' : messages[at]!.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ');
  const calls: (Turn['calls'][number] & { id: string })[] = [];
  for (const m of messages.slice(at + 1))
    for (const b of m.content) {
      if (b.type === 'tool_use') calls.push({ id: b.id, name: b.name, input: b.input });
      if (b.type === 'tool_result') {
        const call = calls.find((c) => c.id === b.tool_use_id);
        if (call) Object.assign(call, { result: b.content, error: !!b.is_error });
      }
    }
  // The note about the record on screen is for the model, not part of the question.
  const rec = /\(The person is looking at ([a-z][a-z0-9_]*) ([0-9a-f-]{36})\.\)\s*$/.exec(question);
  const list = /\(The person is looking at the list of ([a-z][a-z0-9_]*) records\.\)\s*$/.exec(question);
  return {
    question: question.replace(/\n\n\(The person is looking at [^)]*\)\s*$/, ''),
    page: rec ? { entity: rec[1]!, uuid: rec[2]! } : list ? { entity: list[1]!, uuid: '' } : null,
    images: at < 0 ? 0 : messages[at]!.content.filter((b) => b.type === 'image').length,
    calls,
  };
}

const parse = (s: string | undefined): unknown => {
  try {
    return s ? (JSON.parse(s) as unknown) : null;
  } catch {
    return null;
  }
};

const nameOf = (o: Obj) =>
  [o.name, o.title, o.fullName, [o.firstName, o.lastName].filter(Boolean).join(' ')]
    .find((v): v is string => typeof v === 'string' && !!v.trim())
    ?.trim() ?? '(no name)';

const cell = (v: unknown) =>
  String(v ?? '')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .slice(0, 60) || '—';

interface RecordType {
  entity: string;
  singular: string;
  plural: string;
}

function typesFrom(turn: Turn): RecordType[] {
  const schema = parse(turn.calls.find((c) => c.name === 'describe_schema')?.result);
  const types = isObj(schema) && Array.isArray(schema.recordTypes) ? schema.recordTypes : [];
  return types.filter(isObj).map((t) => ({
    entity: String(t.entity),
    singular: String(t.singular ?? t.entity),
    plural: String(t.plural ?? t.entity),
  }));
}

function mentioned(question: string, types: RecordType[]): RecordType | undefined {
  const q = question.toLowerCase();
  return types.find((t) =>
    [t.plural, t.singular, t.entity].some((w) => w && new RegExp(`\\b${w.toLowerCase()}`).test(q)),
  );
}

const keywords = (question: string) =>
  question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .sort((a, b) => b.length - a.length)[0];

const TASK =
  /\b(?:create|add|make|set up|new)\b.*\btask\b(?:\s*(?:to|for|:|called|named))?\s*(.*)|\bremind me to\s+(.*)/i;
const CONFIGURE = /\b(configur\w*|settings?|set ?up|customi[sz]e|what can you (change|do))\b/i;
const TAG = /\b(?:add|create|make)\b.*\btag\b\s*(?:called|named|:)?\s*["']?([^"'.?!]+)/i;
const GREETING = /^\s*(hi|hello|hey|thanks|thank you|good (morning|afternoon|evening))\b/i;

function answerList(turn: Turn, types: RecordType[]): string {
  const last = turn.calls.at(-1)!;
  if (last.error) return `That lookup was refused: ${cell(last.result)}. Try another question.`;
  const data = parse(last.result);
  const rows = (
    isObj(data) && Array.isArray(data.data)
      ? data.data
      : isObj(data) && Array.isArray(data.results)
        ? data.results
        : []
  ).filter(isObj);
  const type = types.find((t) => t.entity === last.input.entity);
  const plural = (type?.plural ?? 'records').toLowerCase();
  const total =
    isObj(data) && isObj(data.meta) && typeof data.meta.total === 'number' ? data.meta.total : rows.length;
  if (!rows.length) return `I found no ${plural} for that.\n\nNext: Show all ${plural} | Search for a name`;
  const search = last.name === 'search_records';
  const lines = rows
    .slice(0, 5)
    .map((r) =>
      search
        ? `| ${cell(nameOf(r))} | ${cell(types.find((t) => t.entity === r.type)?.singular ?? r.type)} | ${cell(r.subtitle)} |`
        : `| ${cell(nameOf(r))} | ${cell(isObj(r.owner) ? r.owner.name : '')} | ${cell(String(r.updatedAt ?? '').slice(0, 10))} |`,
    );
  return [
    `I found **${total}** ${search ? 'matching records' : plural}${rows.length > 5 ? ', here are the first 5' : ''}:`,
    '',
    search ? '| Name | Type | Details |' : '| Name | Owner | Updated |',
    '|---|---|---|',
    ...lines,
    '',
    '_Simulated reply for testing: no AI was used._',
    '',
    `Next: Show more ${plural} | Create a task to follow up | Which ones changed this week?`,
  ].join('\n');
}

/** The scripted interview: four questions most CRM setups need answered, then done. */
const SETUP_QUESTIONS = [
  {
    question: 'Which steps does a customer go through, from first contact to paying you?',
    why: 'These become the stages of your pipeline.',
    suggestions: ['Enquiry', 'Meeting or demo', 'Proposal sent', 'Negotiation', 'Won', 'Lost'],
    multi: true,
  },
  {
    question: 'What do you most need to know about each customer?',
    why: 'These become fields on their record.',
    suggestions: ['Budget', 'Source', 'Industry', 'Renewal date', 'Preferred contact time'],
    multi: true,
  },
  {
    question: 'Who in your team works with customers?',
    why: 'This shapes the roles and what each person sees.',
    suggestions: ['Sales', 'Account management', 'Support', 'Managers only'],
    multi: true,
  },
  {
    question: 'What would you like to see at a glance every week?',
    why: 'This becomes your dashboard and reports.',
    suggestions: ['Deals by stage', 'Revenue by month', 'New customers', 'Overdue tasks'],
    multi: true,
  },
];

/** Scripted AI setup replies, so the whole flow works without a provider. */
function setupReply(req: ChatRequest): string | null {
  const prompt = req.messages
    .flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])))
    .join('\n');
  if (req.system.startsWith('[setup:interview]')) {
    const answered = (prompt.match(/"q":/g) ?? []).length;
    const next = SETUP_QUESTIONS[answered];
    return JSON.stringify(next ? { done: false, ...next } : { done: true });
  }
  if (req.system.startsWith('[setup:brief]')) {
    const details = /Business details: (\{.*\})/.exec(prompt)?.[1];
    let profile: Obj = {};
    try {
      profile = details ? (JSON.parse(details) as Obj) : {};
    } catch {
      profile = {};
    }
    const name = typeof profile.businessName === 'string' ? profile.businessName : 'Your business';
    return JSON.stringify({
      businessName: name,
      summary: `${name}${typeof profile.offerings === 'string' ? ` offers ${profile.offerings}` : ''}. (Simulated brief: no AI was used.)`,
      industry: typeof profile.industry === 'string' ? profile.industry : '',
      presetKey: null,
      offerings: typeof profile.offerings === 'string' ? [profile.offerings] : [],
      customerTypes: [],
      channels: ['Website', 'Referral'],
      stages: [{ name: 'Enquiry' }, { name: 'Proposal sent' }, { name: 'Won' }, { name: 'Lost' }],
      track: [
        { entity: 'deal', label: 'Budget', type: 'currency' },
        { entity: 'contact', label: 'Source', type: 'select', options: ['Website', 'Referral'] },
      ],
      roles: [{ name: 'Sales', does: 'Works deals' }],
      vocabulary: {},
      problems: typeof profile.problems === 'string' ? [profile.problems] : [],
      reports: ['Deals by stage'],
      automations: ['Remind the owner when a deal has had no activity for a week'],
    });
  }
  return null;
}

function decide(req: ChatRequest): Block[] {
  const setup = setupReply(req);
  if (setup) return [{ type: 'text', text: setup }];
  if (!req.tools.length) return [{ type: 'text', text: 'ready' }];
  const has = (name: string) => req.tools.some((t) => t.name === name);
  const turn = turnOf(req.messages);
  const last = turn.calls.at(-1);
  const types = typesFrom(turn);

  if (!last) {
    if (turn.images)
      return [
        {
          type: 'text',
          text: `I received ${turn.images === 1 ? 'your image' : `your ${turn.images} images`}. Simulated replies cannot look at pictures; with a model that reads images, I would describe ${turn.images === 1 ? 'it' : 'them'} and answer your question.\n\nNext: Show my contacts | What should I follow up on today?`,
        },
      ];
    if (GREETING.test(turn.question))
      return [
        {
          type: 'text',
          text: 'Hello! This is the simulated assistant: it answers from your records without using AI.\n\nNext: What should I follow up on today? | Create a task to call back tomorrow',
        },
      ];
    const task = TASK.exec(turn.question);
    if (task && has('create_task')) {
      const subject =
        (task[1] || task[2] || 'Follow up')
          .trim()
          .replace(/[.?!]+$/, '')
          .slice(0, 200) || 'Follow up';
      return [
        { type: 'text', text: 'I will create this task once you confirm.' },
        use('create_task', { subject: subject[0]!.toUpperCase() + subject.slice(1), priority: 'normal' }),
      ];
    }
    // Configuration (admins with setup on): a tag to show the confirm step, or what can be changed.
    const tag = TAG.exec(turn.question);
    if (tag && has('config_change')) {
      const name = tag[1]!.trim().slice(0, 60);
      return [
        use('config_change', {
          method: 'post',
          path: '/tags',
          body: { name },
          summary: `Add the tag "${name}"`,
        }),
      ];
    }
    if (CONFIGURE.test(turn.question) && has('config_overview')) return [use('config_overview', {})];
    // On a record page, a question about "this" reads that record.
    if (
      turn.page?.uuid &&
      /\b(this|it|summari[sz]e|next|changed)\b/i.test(turn.question) &&
      has('get_record')
    )
      return [use('get_record', { entity: turn.page.entity, uuid: turn.page.uuid })];
    if (has('describe_schema')) return [use('describe_schema', {})];
  }

  if (last?.name === 'get_record') {
    if (last.error) return [{ type: 'text', text: `I could not read this record: ${cell(last.result)}.` }];
    const r = parse(last.result);
    const rec = isObj(r) ? r : {};
    const facts = Object.entries(rec)
      .filter(
        ([k, v]) => !['uuid', 'custom', 'id'].includes(k) && v !== null && v !== '' && typeof v !== 'object',
      )
      .slice(0, 6)
      .map(([k, v]) => `- **${k.replace(/([A-Z])/g, ' $1').toLowerCase()}**: ${cell(v)}`);
    return [
      {
        type: 'text',
        text: [
          `Here is a summary of **${cell(nameOf(rec))}**:`,
          '',
          ...facts,
          '',
          '_Simulated reply for testing: no AI was used._',
          '',
          'Next: What changed on this recently? | Create a task to follow up',
        ].join('\n'),
      },
    ];
  }

  if (last?.name === 'describe_schema') {
    const type = mentioned(turn.question, types) ?? types.find((t) => t.entity === turn.page?.entity);
    if (type && has('list_records')) return [use('list_records', { entity: type.entity, pageSize: 5 })];
    const word = keywords(turn.question);
    if (word && has('search_records')) return [use('search_records', { query: word, limit: 5 })];
    return [
      {
        type: 'text',
        text: `I could not tell which records you mean. Try naming one of these: ${types.map((t) => t.plural.toLowerCase()).join(', ')}.\n\nNext: ${types
          .slice(0, 3)
          .map((t) => `Show my ${t.plural.toLowerCase()}`)
          .join(' | ')}`,
      },
    ];
  }

  if (last && (last.name === 'list_records' || last.name === 'search_records'))
    return [{ type: 'text', text: answerList(turn, types) }];

  if (last?.name === 'config_overview') {
    const data = parse(last.result);
    const areas = isObj(data) && Array.isArray(data.areas) ? data.areas.filter(isObj) : [];
    return [
      {
        type: 'text',
        text: [
          'Here is what I can configure for you, each change only after you confirm it:',
          '',
          ...areas.map((a) => `- **${cell(a.title)}**`),
          '',
          'I never delete anything, and never touch security, compliance, users, API keys, webhooks or email accounts.',
          '',
          '_Simulated reply for testing: no AI was used._',
          '',
          'Next: Add a tag called Priority | Show my contacts',
        ].join('\n'),
      },
    ];
  }

  if (last?.name === 'config_change')
    return [
      {
        type: 'text',
        text: last.error
          ? `That change was not made: ${cell(last.result)}.`
          : 'Done: the change is made and recorded in the audit log.',
      },
    ];

  if (last?.name === 'create_task')
    return [
      {
        type: 'text',
        text: last.error
          ? `The task was not created: ${cell(last.result)}.`
          : 'Done: the task is created and assigned to you.\n\nNext: What should I follow up on today? | Create another task',
      },
    ];

  return [
    {
      type: 'text',
      text: 'That is as far as the simulated assistant goes. Try asking for a list of records.',
    },
  ];
}

export async function simulate(req: ChatRequest, on?: StreamHandlers): Promise<ChatResult> {
  await pause(STEP_MS);
  const content = decide(req);
  if (on)
    for (const b of content)
      if (b.type === 'text')
        for (const part of b.text.split(/(\s+)/)) {
          on.text(part);
          await pause(WORD_MS);
        }
  return { content, usage: { input: 0, output: 0 } };
}
