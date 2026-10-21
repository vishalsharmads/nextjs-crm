import type { ReactNode } from 'react';
import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from './button';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  title,
  description,
  children,
  footer,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <D.Portal>
      <D.Overlay className="anim-fade fixed inset-0 z-40 bg-overlay" />
      <D.Content
        className={cn(
          'anim-pop fixed inset-x-0 top-[12vh] z-50 mx-auto flex max-h-[76vh] w-[calc(100vw-2rem)] max-w-lg flex-col rounded-lg border border-line bg-surface shadow-2xl',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-2">
          <div>
            <D.Title className="text-base font-semibold">{title}</D.Title>
            {description ? (
              <D.Description className="mt-0.5 text-sm text-muted">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">{title}</D.Description>
            )}
          </div>
          <D.Close asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close">
              <X />
            </Button>
          </D.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
        ) : null}
      </D.Content>
    </D.Portal>
  );
}

/** Side sheet (record peek, forms). Slides from the inline end; becomes full width on phones. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'max-w-xl',
  headerActions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  headerActions?: ReactNode;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="anim-fade fixed inset-0 z-40 bg-overlay md:bg-transparent" />
        <D.Content
          className={cn(
            'anim-sheet fixed inset-y-0 end-0 z-50 flex w-full flex-col border-s border-line bg-surface shadow-2xl',
            width,
          )}
        >
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
            <div className="min-w-0">
              <D.Title className="truncate text-base font-semibold">{title}</D.Title>
              {description ? (
                <D.Description className="truncate text-xs text-muted">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{title}</D.Description>
              )}
            </div>
            <div className="flex items-center gap-1">
              {headerActions}
              <D.Close asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Close">
                  <X />
                </Button>
              </D.Close>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer ? (
            <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
          ) : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
