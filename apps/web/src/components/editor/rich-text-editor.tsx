import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import {
  Bold,
  Braces,
  Code,
  Heading,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  ScissorsLineDashed,
  Sheet,
  Strikethrough,
  Underline,
  Undo2,
  MessageSquareText,
} from 'lucide-react';
import type { MergeFieldGroup, SavedReply } from '@app/shared';
import { useT } from '@/app/session';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from '@/components/ui/menu';
import { MergeField, PageBreak } from './extensions';
import { filterItems, suggestionExtension, type MenuItem, type SuggestionSource } from './suggestion';
import { isEmptyHtml, needsSourceView, unwrapMergeFields, wrapMergeFields, type EditorMode } from './html';

export type { EditorMode } from './html';
type View = 'visual' | 'markdown' | 'html';

export interface RichTextEditorProps {
  /** HTML. Templates keep placeholders as plain `{{path}}` text. */
  value: string;
  onChange: (html: string) => void;
  /** `document` adds big headings, tables, rules and page breaks. */
  mode?: EditorMode;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  placeholder?: string;
  /** Turns on the `{{` field picker and the Insert field button. */
  mergeFields?: MergeFieldGroup[];
  /** Turns on the `/` saved-reply menu; `insert` returns the rendered HTML. */
  replies?: { items: SavedReply[]; insert: (reply: SavedReply) => Promise<string> };
  /** ⌘/Ctrl+Enter. */
  onSubmitShortcut?: () => void;
  disabled?: boolean;
  className?: string;
}

const SAFE_LINK = /^(https?:\/\/|mailto:|tel:)/i;

/** Emitted HTML: chips back to `{{path}}`, and an empty editor is an empty string. */
const output = (editor: Editor) => {
  const html = unwrapMergeFields(editor.getHTML());
  return isEmptyHtml(html) ? '' : html;
};

export function RichTextEditor({
  value,
  onChange,
  mode = 'basic',
  id,
  placeholder,
  mergeFields,
  replies,
  onSubmitShortcut,
  disabled,
  className,
  ...aria
}: RichTextEditorProps) {
  const t = useT();
  const [view, setView] = useState<View>(() => (needsSourceView(value, mode) ? 'html' : 'visual'));
  const [source, setSource] = useState(() => (needsSourceView(value, mode) ? value : ''));
  const emitted = useRef(value);
  // Extensions are built once; menus and handlers read the latest props through this holder.
  const latest = useRef({ mergeFields, replies, onChange, onSubmitShortcut, t });
  useLayoutEffect(() => {
    latest.current = { mergeFields, replies, onChange, onSubmitShortcut, t };
  });
  const hasFields = !!mergeFields;
  const hasReplies = !!replies;

  const extensions = useMemo(() => {
    const fieldSource = (): SuggestionSource | null => {
      const { mergeFields: groups, t: tr } = latest.current;
      if (!groups) return null;
      return {
        char: '{{',
        label: tr('editor.insertField'),
        empty: tr('editor.noFields'),
        items: (q) =>
          filterItems(
            groups.flatMap((g) =>
              g.fields.map((f) => ({ id: f.path, label: f.label, hint: f.path, group: g.label })),
            ),
            q,
          ),
        select: (editor, range, item) =>
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({ type: 'mergeField', attrs: { path: item.id } })
            .run(),
      };
    };
    const replySource = (): SuggestionSource | null => {
      const { replies: r, t: tr } = latest.current;
      if (!r) return null;
      return {
        char: '/',
        label: tr('editor.insertReply'),
        empty: tr('editor.noReplies'),
        items: (q) =>
          filterItems(
            r.items.map((x) => ({ id: x.uuid, label: x.name, hint: x.subject })),
            q,
          ),
        select: (editor, range, item: MenuItem) => {
          const reply = latest.current.replies?.items.find((x) => x.uuid === item.id);
          if (!reply) return;
          editor.chain().focus().deleteRange(range).run();
          void latest.current.replies
            ?.insert(reply)
            .then((html) => editor.chain().focus().insertContent(html).run());
        },
      };
    };
    return [
      StarterKit.configure({
        heading: { levels: mode === 'document' ? [1, 2, 3] : [3, 4] },
        horizontalRule: mode === 'document' ? {} : false,
        link: {
          openOnClick: false,
          autolink: true,
          protocols: ['mailto', 'tel'],
          isAllowedUri: (url) => SAFE_LINK.test(url),
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      Markdown,
      Placeholder.configure({ placeholder: () => placeholder ?? '' }),
      ...(mode === 'document' ? [TableKit.configure({ table: { resizable: false } }), PageBreak] : []),
      // eslint-disable-next-line react-hooks/refs -- the menu reads `latest` when it opens, not during render
      ...(hasFields ? [MergeField, suggestionExtension('mergeFieldMenu', fieldSource)] : []),
      // eslint-disable-next-line react-hooks/refs -- the menu reads `latest` when it opens, not during render
      ...(hasReplies ? [suggestionExtension('replyMenu', replySource)] : []),
    ];
    // The editor is built once per mode and feature set; later prop changes go through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, hasFields, hasReplies]);

  const editor = useEditor(
    {
      extensions,
      content: view === 'visual' ? wrapMergeFields(value) : '',
      editable: !disabled,
      immediatelyRender: true,
      editorProps: {
        attributes: {
          ...(id ? { id } : {}),
          role: 'textbox',
          'aria-multiline': 'true',
          ...(aria['aria-label'] ? { 'aria-label': aria['aria-label'] } : {}),
          ...(aria['aria-describedby'] ? { 'aria-describedby': aria['aria-describedby'] } : {}),
          ...(aria['aria-invalid'] ? { 'aria-invalid': 'true' } : {}),
          class: 'rte-content',
        },
        handleKeyDown: (_view, e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && latest.current.onSubmitShortcut) {
            latest.current.onSubmitShortcut();
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: ed }) => {
        const html = output(ed);
        emitted.current = html;
        latest.current.onChange(html);
      },
    },
    [extensions],
  );

  // Outside changes (a reset after sending, a loaded record) replace the content.
  useEffect(() => {
    if (!editor || value === emitted.current) return;
    emitted.current = value;
    if (view === 'visual') editor.commands.setContent(wrapMergeFields(value), { emitUpdate: false });
    else if (view === 'html') setSource(value);
  }, [editor, value, view]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const sourceLocked = view === 'html' && needsSourceView(source, mode);

  const switchTo = (next: View) => {
    if (!editor || next === view) return;
    if (next === 'html') setSource(view === 'visual' ? output(editor) : value);
    if (next === 'markdown') {
      if (view === 'html') editor.commands.setContent(wrapMergeFields(source), { emitUpdate: false });
      setSource(editor.getMarkdown());
    }
    if (next === 'visual')
      editor.commands.setContent(wrapMergeFields(view === 'html' ? source : value), { emitUpdate: false });
    setView(next);
  };

  const onSourceChange = (text: string) => {
    setSource(text);
    let html = text;
    if (view === 'markdown' && editor) {
      editor.commands.setContent(text, { contentType: 'markdown', emitUpdate: false });
      html = output(editor);
    }
    emitted.current = html;
    onChange(html);
  };

  if (!editor) return null;
  return (
    <div
      className={cn(
        'rte flex flex-col rounded-sm border border-line bg-surface transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary-soft',
        aria['aria-invalid'] && 'border-accent',
        disabled && 'opacity-60',
      )}
    >
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-1 py-1">
        {view === 'visual' ? (
          <Toolbar editor={editor} mode={mode} mergeFields={!!mergeFields} replies={!!replies} />
        ) : (
          <p className="px-1.5 text-xs text-faint">
            {view === 'markdown' ? t('editor.markdownHint') : t('editor.htmlHint')}
          </p>
        )}
        <div role="tablist" aria-label={t('editor.view')} className="ms-auto flex rounded-sm bg-subtle p-0.5">
          {(['visual', 'markdown', 'html'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              disabled={disabled || (sourceLocked && v !== 'html')}
              onClick={() => switchTo(v)}
              className={cn(
                'rounded-sm px-2 py-0.5 text-xs transition-colors disabled:opacity-50',
                view === v ? 'bg-surface font-medium text-ink shadow-raised' : 'text-muted hover:text-ink',
              )}
            >
              {t(`editor.views.${v}`)}
            </button>
          ))}
        </div>
      </div>
      {sourceLocked ? (
        <p className="border-b border-line bg-subtle px-3 py-1.5 text-xs text-muted">
          {t('editor.sourceOnly')}
        </p>
      ) : null}
      <div className={cn('min-h-32', className, view !== 'visual' && 'hidden')}>
        <EditorContent editor={editor} className="h-full" />
      </div>
      {view !== 'visual' ? (
        <textarea
          value={source}
          onChange={(e) => onSourceChange(e.target.value)}
          disabled={disabled}
          spellCheck={view === 'markdown'}
          aria-label={`${aria['aria-label'] ?? ''} (${t(`editor.views.${view}`)})`.trim()}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSubmitShortcut?.();
          }}
          className={cn(
            'min-h-32 w-full resize-y bg-transparent px-3 py-2 font-mono text-[13px] leading-relaxed text-ink focus:outline-none',
            className,
          )}
        />
      ) : null}
    </div>
  );
}

function ToolButton({
  label,
  shortcut,
  active,
  onClick,
  disabled,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip content={shortcut ? `${label} (${shortcut})` : label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-pressed={active ?? undefined}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={cn(active && 'bg-primary-soft text-primary')}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

const MOD = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘' : 'Ctrl+';

function Toolbar({
  editor,
  mode,
  mergeFields,
  replies,
}: {
  editor: Editor;
  mode: EditorMode;
  mergeFields: boolean;
  replies: boolean;
}) {
  const t = useT();
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      heading: e.isActive('heading'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      table: e.isActive('table'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();
  const heading = mode === 'document' ? 2 : 3;
  /** Typing the trigger opens the same menu the keyboard does. */
  const openMenu = (char: string) => {
    const before = editor.state.selection.$from.nodeBefore?.text?.slice(-1);
    chain()
      .insertContent(before && before !== ' ' ? ` ${char}` : char)
      .run();
  };
  const sep = <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />;
  return (
    <div role="toolbar" aria-label={t('editor.formatting')} className="flex flex-wrap items-center gap-0.5">
      <ToolButton
        label={t('editor.bold')}
        shortcut={`${MOD}B`}
        active={s.bold}
        onClick={() => chain().toggleBold().run()}
      >
        <Bold />
      </ToolButton>
      <ToolButton
        label={t('editor.italic')}
        shortcut={`${MOD}I`}
        active={s.italic}
        onClick={() => chain().toggleItalic().run()}
      >
        <Italic />
      </ToolButton>
      <ToolButton
        label={t('editor.underline')}
        shortcut={`${MOD}U`}
        active={s.underline}
        onClick={() => chain().toggleUnderline().run()}
      >
        <Underline />
      </ToolButton>
      <ToolButton label={t('editor.strike')} active={s.strike} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough />
      </ToolButton>
      {sep}
      <ToolButton
        label={t('editor.heading')}
        active={s.heading}
        onClick={() => chain().toggleHeading({ level: heading }).run()}
      >
        <Heading />
      </ToolButton>
      <ToolButton
        label={t('editor.bulletList')}
        active={s.bullet}
        onClick={() => chain().toggleBulletList().run()}
      >
        <List />
      </ToolButton>
      <ToolButton
        label={t('editor.orderedList')}
        active={s.ordered}
        onClick={() => chain().toggleOrderedList().run()}
      >
        <ListOrdered />
      </ToolButton>
      <ToolButton label={t('editor.quote')} active={s.quote} onClick={() => chain().toggleBlockquote().run()}>
        <Quote />
      </ToolButton>
      <ToolButton label={t('editor.code')} active={s.code} onClick={() => chain().toggleCode().run()}>
        <Code />
      </ToolButton>
      <LinkButton editor={editor} active={s.link} />
      {mode === 'document' ? (
        <>
          {sep}
          <TableMenu editor={editor} inTable={s.table} />
          <ToolButton label={t('editor.rule')} onClick={() => chain().setHorizontalRule().run()}>
            <Minus />
          </ToolButton>
          <ToolButton label={t('editor.pageBreak')} onClick={() => chain().insertPageBreak().run()}>
            <ScissorsLineDashed />
          </ToolButton>
        </>
      ) : null}
      {mergeFields || replies ? sep : null}
      {mergeFields ? (
        <ToolButton label={t('editor.insertField')} shortcut="{{" onClick={() => openMenu('{{')}>
          <Braces />
        </ToolButton>
      ) : null}
      {replies ? (
        <ToolButton label={t('editor.insertReply')} shortcut="/" onClick={() => openMenu('/')}>
          <MessageSquareText />
        </ToolButton>
      ) : null}
      {sep}
      <ToolButton
        label={t('editor.undo')}
        shortcut={`${MOD}Z`}
        disabled={!s.canUndo}
        onClick={() => chain().undo().run()}
      >
        <Undo2 />
      </ToolButton>
      <ToolButton
        label={t('editor.redo')}
        shortcut={`${MOD}⇧Z`}
        disabled={!s.canRedo}
        onClick={() => chain().redo().run()}
      >
        <Redo2 />
      </ToolButton>
    </div>
  );
}

function LinkButton({ editor, active }: { editor: Editor; active: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState('');
  const valid = SAFE_LINK.test(href.trim());
  const apply = () => {
    if (!valid) return;
    editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setHref((editor.getAttributes('link').href as string | undefined) ?? 'https://');
      }}
    >
      <Tooltip content={t('editor.link')}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('editor.link')}
            aria-pressed={active}
            className={cn(active && 'bg-primary-soft text-primary')}
          >
            <Link2 />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent className="w-80">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <Input
            value={href}
            onChange={(e) => setHref(e.target.value)}
            aria-label={t('editor.linkAddress')}
            aria-invalid={href.trim() && !valid ? true : undefined}
            autoFocus
          />
          <p className="text-xs text-faint">{t('editor.linkHelp')}</p>
          <div className="flex justify-end gap-2">
            {active ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  editor.chain().focus().extendMarkRange('link').unsetLink().run();
                  setOpen(false);
                }}
              >
                {t('editor.removeLink')}
              </Button>
            ) : null}
            <Button type="submit" size="sm" variant="primary" disabled={!valid}>
              {t('editor.applyLink')}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function TableMenu({ editor, inTable }: { editor: Editor; inTable: boolean }) {
  const t = useT();
  const chain = () => editor.chain().focus();
  const actions: [string, () => boolean][] = inTable
    ? [
        ['editor.table.addRow', () => chain().addRowAfter().run()],
        ['editor.table.addColumn', () => chain().addColumnAfter().run()],
        ['editor.table.deleteRow', () => chain().deleteRow().run()],
        ['editor.table.deleteColumn', () => chain().deleteColumn().run()],
        ['editor.table.toggleHeader', () => chain().toggleHeaderRow().run()],
        ['editor.table.delete', () => chain().deleteTable().run()],
      ]
    : [];
  if (!inTable)
    return (
      <ToolButton
        label={t('editor.table.insert')}
        onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      >
        <Sheet />
      </ToolButton>
    );
  return (
    <Popover>
      <Tooltip content={t('editor.table.edit')}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('editor.table.edit')}
            className="bg-primary-soft text-primary"
          >
            <Sheet />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent className="flex w-48 flex-col p-1">
        {actions.map(([key, run]) => (
          <button
            key={key}
            type="button"
            onClick={run}
            className="rounded-sm px-2 py-1.5 text-start text-sm hover:bg-hover"
          >
            {t(key)}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
