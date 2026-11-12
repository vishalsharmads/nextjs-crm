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
  return { question: question.replace(/\n\n\(The person is looking at [^)]*\)\s*$/, ''), calls };
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

function decide(req: ChatRequest): Block[] {
  if (!req.tools.length) return [{ type: 'text', text: 'ready' }];
  const has = (name: string) => req.tools.some((t) => t.name === name);
  const turn = turnOf(req.messages);
  const last = turn.calls.at(-1);
  const types = typesFrom(turn);

  if (!last) {
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
    if (has('describe_schema')) return [use('describe_schema', {})];
  }

  if (last?.name === 'describe_schema') {
    const type = mentioned(turn.question, types);
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
