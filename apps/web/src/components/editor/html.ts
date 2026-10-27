import { MERGE_FIELD_RE } from '@app/shared';

export type EditorMode = 'basic' | 'document';

const BASIC_TAGS = new Set([
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'a',
  'blockquote',
  'code',
  'pre',
  'h3',
  'h4',
]);
const DOCUMENT_TAGS = new Set([...BASIC_TAGS, 'h1', 'h2', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
/** Attributes the visual editor keeps; anything else would be dropped on save. */
const KEPT_ATTRIBUTES = new Set(['href', 'target', 'rel', 'colspan', 'rowspan', 'data-page-break']);

/**
 * Whether the visual editor would change this markup: Handlebars block helpers, placeholders inside
 * attributes, classes or styles, and tags it does not know. Such content opens in the HTML view.
 */
export function needsSourceView(html: string, mode: EditorMode): boolean {
  if (/\{\{\s*[#^/]|\{\{\s*else\b|\{\{\{/.test(html)) return true;
  if (/=\s*"[^"]*\{\{/.test(html)) return true;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const allowed = mode === 'document' ? DOCUMENT_TAGS : BASIC_TAGS;
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    if (!allowed.has(el.tagName.toLowerCase())) return true;
    for (const attr of Array.from(el.attributes)) if (!KEPT_ATTRIBUTES.has(attr.name)) return true;
  }
  return false;
}

/** Turn `{{path}}` text into merge-field nodes the editor shows as chips. Attributes are untouched. */
export function wrapMergeFields(html: string): string {
  if (!html.includes('{{')) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const text of texts) {
    const value = text.nodeValue ?? '';
    if (!new RegExp(MERGE_FIELD_RE.source).test(value)) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of value.matchAll(new RegExp(MERGE_FIELD_RE.source, 'g'))) {
      frag.append(value.slice(last, m.index));
      const span = doc.createElement('span');
      span.setAttribute('data-merge-field', m[1]!);
      span.textContent = `{{${m[1]}}}`;
      frag.append(span);
      last = m.index + m[0].length;
    }
    frag.append(value.slice(last));
    text.replaceWith(frag);
  }
  return doc.body.innerHTML;
}

/** Merge-field chips back to plain `{{path}}` text, the form templates are stored in. */
export function unwrapMergeFields(html: string): string {
  return html.replace(
    /<span data-merge-field="([^"]*)"[^>]*>[\s\S]*?<\/span>/g,
    (_, path: string) => `{{${path.replace(/&quot;/g, '"').replace(/&amp;/g, '&')}}}`,
  );
}

/** True for an editor that holds nothing but empty paragraphs. */
export function isEmptyHtml(html: string): boolean {
  return !html.replace(/<p>(\s|<br\s*\/?>)*<\/p>/g, '').trim();
}
