import { useState, useSyncExternalStore } from 'react';
import { Button } from './button';
import { Dialog, DialogContent } from './dialog';
import { Field, Input } from './input';

export interface ConfirmOptions {
  title: string;
  description?: string;
  /** The button's verb ("Delete", "Void"); the toast that follows should use the same verb. */
  action: string;
  /** Destructive actions use the danger style. */
  danger?: boolean;
  cancel?: string;
}

interface Pending extends ConfirmOptions {
  /** Set for askText: the labelled input shown in the dialog. */
  input?: { label: string };
  resolve: (value: string | null) => void;
}

let current: Pending | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/**
 * Ask before doing something that is hard to undo, in the app's own dialog (themed, focus-trapped,
 * keyboard reachable) instead of the browser's `window.confirm`. Resolves true on confirm.
 */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  return open(opts).then((v) => v !== null);
}

/** Like confirmAction, with a labelled text box; resolves to the text, or null when cancelled. */
export function askText(opts: ConfirmOptions & { label: string }): Promise<string | null> {
  return open({ ...opts, input: { label: opts.label } });
}

function open(opts: Omit<Pending, 'resolve'>): Promise<string | null> {
  current?.resolve(null);
  return new Promise((resolve) => {
    current = { ...opts, resolve };
    notify();
  });
}

function settle(value: string | null) {
  const p = current;
  current = null;
  notify();
  p?.resolve(value);
}

/** Mounted once next to the toaster. */
export function ConfirmHost() {
  const pending = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  return (
    <Dialog open={!!pending} onOpenChange={(isOpen) => !isOpen && settle(null)}>
      {pending ? <ConfirmBody key={pending.title} pending={pending} /> : null}
    </Dialog>
  );
}

function ConfirmBody({ pending }: { pending: Pending }) {
  const [text, setText] = useState('');
  const submit = () => settle(pending.input ? text : '');
  return (
    <DialogContent
      title={pending.title}
      description={pending.description}
      footer={
        <>
          <Button onClick={() => settle(null)}>{pending.cancel ?? 'Cancel'}</Button>
          <Button variant={pending.danger ? 'danger' : 'primary'} autoFocus={!pending.input} onClick={submit}>
            {pending.action}
          </Button>
        </>
      }
    >
      {pending.input ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label={pending.input.label}>
            {(props) => <Input {...props} autoFocus value={text} onChange={(e) => setText(e.target.value)} />}
          </Field>
        </form>
      ) : null}
    </DialogContent>
  );
}
