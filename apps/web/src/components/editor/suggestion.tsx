import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Extension, ReactRenderer, type Editor, type Range } from '@tiptap/react';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import { cn } from '@/lib/cn';

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  group?: string;
}

interface ListProps {
  items: MenuItem[];
  command: (item: MenuItem) => void;
  label: string;
  empty: string;
}
interface ListHandle {
  onKeyDown: (e: KeyboardEvent) => boolean;
}

const SuggestionList = forwardRef<ListHandle, ListProps>(function SuggestionList(
  { items, command, label, empty },
  ref,
) {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: (e) => {
      if (!items.length) return false;
      if (e.key === 'ArrowDown') return (setActive((i) => (i + 1) % items.length), true);
      if (e.key === 'ArrowUp') return (setActive((i) => (i - 1 + items.length) % items.length), true);
      if (e.key === 'Enter' || e.key === 'Tab') return (command(items[active]!), true);
      return false;
    },
  }));
  return (
    <div
      role="listbox"
      aria-label={label}
      className="anim-pop z-50 max-h-72 w-72 overflow-y-auto rounded-md border border-line bg-surface p-1 text-sm shadow-overlay"
    >
      {items.length ? (
        items.map((item, i) => (
          <div key={item.id}>
            {item.group && item.group !== items[i - 1]?.group ? (
              <p className="px-2 pt-1.5 pb-0.5 text-xs font-medium text-faint">{item.group}</p>
            ) : null}
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              // Keep focus in the editor so the typed trigger is still there to replace.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => command(item)}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'flex w-full items-baseline justify-between gap-3 rounded-sm px-2 py-1.5 text-start',
                i === active ? 'bg-hover text-ink' : 'text-muted',
              )}
            >
              <span className="truncate">{item.label}</span>
              {item.hint ? <span className="shrink-0 truncate text-xs text-faint">{item.hint}</span> : null}
            </button>
          </div>
        ))
      ) : (
        <p className="px-2 py-1.5 text-faint">{empty}</p>
      )}
    </div>
  );
});

export interface SuggestionSource {
  /** What the user types to open the menu: `/` or `{{`. */
  char: string;
  label: string;
  empty: string;
  items: (query: string) => MenuItem[] | Promise<MenuItem[]>;
  select: (editor: Editor, range: Range, item: MenuItem) => void;
}

/** A typed trigger that opens a filtered menu at the caret (slash commands, `{{` placeholders). */
export function suggestionExtension(name: string, source: () => SuggestionSource | null) {
  return Extension.create({
    name,
    addProseMirrorPlugins() {
      const initial = source();
      if (!initial) return [];
      return [
        Suggestion<MenuItem, MenuItem>({
          editor: this.editor,
          pluginKey: new PluginKey(name),
          char: initial.char,
          items: ({ query }) => source()?.items(query) ?? [],
          command: ({ editor, range, props }) => source()?.select(editor, range, props),
          render: () => {
            let renderer: ReactRenderer<ListHandle, ListProps> | null = null;
            let unmount: (() => void) | null = null;
            return {
              onStart: (props) => {
                const s = source();
                renderer = new ReactRenderer(SuggestionList, {
                  editor: props.editor,
                  props: {
                    items: props.items,
                    command: props.command,
                    label: s?.label ?? '',
                    empty: s?.empty ?? '',
                  },
                });
                unmount = props.mount(renderer.element);
              },
              onUpdate: (props) => renderer?.updateProps({ items: props.items, command: props.command }),
              onKeyDown: ({ event }) => {
                if (event.key === 'Escape') return false;
                return renderer?.ref?.onKeyDown(event) ?? false;
              },
              onExit: () => {
                unmount?.();
                renderer?.destroy();
                renderer = null;
              },
            };
          },
        }),
      ];
    },
  });
}

/** Case-insensitive filter on label, hint and group. */
export function filterItems(items: MenuItem[], query: string, limit = 50): MenuItem[] {
  const q = query.trim().toLowerCase();
  const hits = q
    ? items.filter((i) => `${i.label} ${i.hint ?? ''} ${i.group ?? ''}`.toLowerCase().includes(q))
    : items;
  return hits.slice(0, limit);
}
