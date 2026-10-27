import { Node, mergeAttributes } from '@tiptap/react';

/** A `{{path}}` placeholder shown as one chip; it is stored as plain Handlebars text. */
export const MergeField = Node.create({
  name: 'mergeField',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      path: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-merge-field') ?? '',
        renderHTML: (attrs) => ({ 'data-merge-field': attrs.path as string }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-merge-field]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'rte-merge' }),
      `{{${node.attrs.path as string}}}`,
    ];
  },
  renderText({ node }) {
    return `{{${node.attrs.path as string}}}`;
  },
  renderMarkdown(node: { attrs?: { path?: string } }) {
    return `{{${node.attrs?.path ?? ''}}}`;
  },
});

/** Where a printed document starts a new page. Stored as `<hr data-page-break="">`. */
export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  priority: 1100,
  parseHTML() {
    return [{ tag: 'hr[data-page-break]' }];
  },
  renderHTML() {
    return ['hr', { 'data-page-break': '' }];
  },
  renderMarkdown() {
    return '<hr data-page-break="">';
  },
  addCommands() {
    return {
      insertPageBreak:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageBreak: { insertPageBreak: () => ReturnType };
  }
}
