type Labels = Record<string, { singular: string; plural: string }>;

const CHANGE =
  /\b(add|create|new|make|update|change|edit|set|move|rename|assign|delete|remove|log|schedule)\b/i;
const TIME =
  /\b(today|tomorrow|yesterday|week|month|quarter|year|overdue|due|soon|close|closing|last|next)\b/i;
const NUMBERS = /\b(how many|total|sum|count|average|value|revenue|pipeline|forecast|top|most|biggest)\b/i;
const SETUP = /\b(set up|setup|configure|field|fields|pipeline|stages?|roles?|modules?|preset)\b/i;

/**
 * Short status lines shown in turn while the assistant works, drawn from the question so they feel
 * like what it is doing ("Looking through opportunities", "Checking dates"). Record names come from
 * the workspace's own labels, never fixed English entity words.
 */
export function thinkingWords(question: string, labels: Labels): string[] {
  const q = question.toLowerCase();
  const words = ['Reading your question'];
  for (const l of Object.values(labels)) {
    const plural = l.plural.toLowerCase();
    const singular = l.singular.toLowerCase();
    if (plural && (q.includes(plural) || q.includes(singular))) words.push(`Looking through ${plural}`);
    if (words.length >= 3) break;
  }
  if (TIME.test(q)) words.push('Checking dates');
  if (NUMBERS.test(q)) words.push('Adding up the numbers');
  if (SETUP.test(q)) words.push('Looking at how the workspace is set up');
  if (CHANGE.test(q)) words.push('Drafting the changes for you to confirm');
  if (words.length === 1) words.push('Searching your records');
  words.push('Putting the answer together');
  return words;
}

/** While a decision is being carried out. */
export const DECISION_WORDS = [
  'Making the changes',
  'Recording them in the audit log',
  'Putting the answer together',
];
